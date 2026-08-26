import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import path from 'node:path';
import { DEFAULT_CACHE_ROOT } from './options.js';
import { atomicWriteJson, isSha256Hex, positiveInteger, safeJsonParse, sha256Hex } from './http-utils.js';

const DEFAULT_TTL_SECONDS = Object.freeze({
  rss: 300,
  html: 3 * 24 * 60 * 60,
  'eh-image': 5 * 60,
  media: 7 * 24 * 60 * 60,
  'media-variant': 7 * 24 * 60 * 60,
});
const DEFAULT_MAX_BYTES = 5 * 1024 ** 3;
const DEFAULT_EVICTION_PRIORITY = Object.freeze({
  rss: 0,
  html: 1,
  media: 2,
  'media-variant': 3,
});
const SAFE_HEADERS = new Set(['content-type', 'content-length', 'etag', 'last-modified', 'cache-control']);

function canonicalUrl(value) {
  return new URL(value).toString();
}

function normalizedNamespace(value) {
  return String(value || 'public').trim() || 'public';
}

function keyFor(url, kind, namespace = 'public') {
  return sha256Hex(`${kind}\n${normalizedNamespace(namespace)}\n${canonicalUrl(url)}`);
}

function normalizedHeaders(headers) {
  const entries = headers instanceof Headers
    ? [...headers.entries()]
    : Object.entries(headers || {});
  return Object.fromEntries(entries
    .map(([name, value]) => [String(name).toLowerCase(), String(value)])
    .filter(([name, value]) => SAFE_HEADERS.has(name) && value));
}

function normalizeBody(body) {
  if (typeof body === 'string') return { value: body, buffer: Buffer.from(body, 'utf8'), type: 'string' };
  if (Buffer.isBuffer(body)) return { value: body, buffer: body, type: 'buffer' };
  return null;
}

function positiveNumber(value, fallback) {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function resultFromEntry(entry, body, state) {
  return {
    state,
    status: entry.status,
    headers: { ...entry.headers },
    body: entry.bodyType === 'string' ? body.toString('utf8') : body,
  };
}

export {
  keyFor,
  canonicalUrl,
  normalizedNamespace,
  normalizedHeaders,
  normalizeBody,
  positiveNumber,
  resultFromEntry,
  SAFE_HEADERS,
  DEFAULT_TTL_SECONDS,
  DEFAULT_MAX_BYTES,
  DEFAULT_EVICTION_PRIORITY,
  DEFAULT_CACHE_ROOT,
};

export function createResponseCache({
  root = process.env.GATEWAY_CACHE_DIR || DEFAULT_CACHE_ROOT,
  maxBytes = positiveInteger(process.env.GATEWAY_CACHE_MAX_BYTES, DEFAULT_MAX_BYTES),
  ttlSeconds = {},
  evictionPriority = {},
  now = () => Date.now(),
} = {}) {
  const cacheRoot = path.resolve(root);
  const indexPath = path.join(cacheRoot, 'index.json');
  const entries = new Map();
  const inflight = new Map();
  const storeInflight = new Map();
  const loadStates = new Map();
  const ttl = { ...DEFAULT_TTL_SECONDS, ...ttlSeconds };
  const priority = { ...DEFAULT_EVICTION_PRIORITY, ...evictionPriority };
  const byteLimit = positiveNumber(maxBytes, DEFAULT_MAX_BYTES);
  function kindPriority(kind) {
    const value = priority[String(kind || 'html')];
    return Number.isInteger(value) ? value : DEFAULT_EVICTION_PRIORITY.html;
  }
  let totalBytes = 0;
  const counters = {
    hits: 0,
    staleHits: 0,
    misses: 0,
    bytesStored: 0,
    rangeReads: 0,
    rangeBytes: 0,
    storeFailures: 0,
  };
  let persistChain = Promise.resolve();
  let touchTimer;
  let operationSequence = 0;

  async function writeIndex() {
    try {
      await atomicWriteJson(indexPath, { version: 1, entries: [...entries.values()] }, { mode: null, dirMode: 0o755 });
    } catch {
      // Best-effort index persistence.
    }
  }

  function persistIndex() {
    persistChain = persistChain.then(writeIndex, writeIndex);
    return persistChain;
  }

  function scheduleTouchPersist() {
    if (touchTimer) return;
    touchTimer = setTimeout(() => {
      touchTimer = undefined;
      persistIndex();
    }, 1000);
    touchTimer.unref?.();
  }

  async function initialize() {
    await fsp.mkdir(cacheRoot, { recursive: true }).catch(() => {});
    let parsed;
    try {
      const content = await fsp.readFile(indexPath, 'utf8');
      parsed = safeJsonParse(content, { entries: [] });
    } catch {
      parsed = { entries: [] };
    }
    const records = Array.isArray(parsed?.entries)
      ? parsed.entries
      : Object.values(parsed?.entries || {});
    for (const record of records) {
      if (!record || !isSha256Hex(record.key) || record.file !== `${record.key}.body`
        || !Number.isFinite(record.size) || record.size < 0
        || !['string', 'buffer'].includes(record.bodyType)) continue;
      try {
        const stat = await fsp.stat(path.join(cacheRoot, record.file));
        if (!stat.isFile() || stat.size !== record.size) continue;
        entries.set(record.key, record);
        totalBytes += record.size;
      } catch {
        // Missing cache files are treated as misses.
      }
    }
    const knownFiles = new Set([...entries.values()].map((entry) => entry.file));
    const files = await fsp.readdir(cacheRoot).catch(() => []);
    for (const file of files) {
      if (!/^[a-f0-9]{64}\.body$/.test(file) && !file.endsWith('.tmp')) continue;
      if (knownFiles.has(file)) continue;
      await fsp.rm(path.join(cacheRoot, file), { force: true }).catch(() => {});
    }
    await evict();
  }

  const ready = initialize();

  async function readEntry(url, kind, namespace, allowExpired) {
    await ready;
    const key = keyFor(url, kind, namespace);
    const entry = entries.get(key);
    if (!entry) return null;
    const fresh = now() < entry.expiresAt;
    if (!fresh && !allowExpired) return null;
    try {
      const body = await fsp.readFile(path.join(cacheRoot, entry.file));
      entry.lastAccessAt = now();
      scheduleTouchPersist();
      return { entry, body, fresh };
    } catch {
      entries.delete(key);
      totalBytes -= entry.size;
      await persistIndex();
      return null;
    }
  }

  async function evict() {
    if (totalBytes <= byteLimit) return;
    const ordered = [...entries.values()].sort((left, right) => (
      kindPriority(left.kind) - kindPriority(right.kind)
      || left.lastAccessAt - right.lastAccessAt
    ));
    for (const entry of ordered) {
      if (totalBytes <= byteLimit) break;
      entries.delete(entry.key);
      totalBytes -= entry.size;
      await fsp.rm(path.join(cacheRoot, entry.file), { force: true }).catch(() => {});
    }
  }

  async function store(url, kind, namespace, loaded) {
    const body = normalizeBody(loaded.body);
    if (loaded.cacheable === false || !body || loaded.status < 200 || loaded.status >= 300 || body.buffer.length > byteLimit) return;
    await ready;
    await fsp.mkdir(cacheRoot, { recursive: true });
    const key = keyFor(url, kind, namespace);
    const file = `${key}.body`;
    const tempPath = path.join(cacheRoot, `${file}.${process.pid}.${randomUUID()}.tmp`);
    try {
      await fsp.writeFile(tempPath, body.buffer);
      await fsp.rename(tempPath, path.join(cacheRoot, file));
      const previous = entries.get(key);
      if (previous) totalBytes -= previous.size;
      const createdAt = now();
      const entry = {
        key,
        kind,
        url: canonicalUrl(url),
        file,
        size: body.buffer.length,
        bodyType: body.type,
        status: loaded.status,
        headers: normalizedHeaders(loaded.headers),
        createdAt,
        expiresAt: createdAt + (positiveNumber(Number(ttl[kind]), DEFAULT_TTL_SECONDS.html) * 1000),
        lastAccessAt: createdAt,
      };
      entries.set(key, entry);
      totalBytes += entry.size;
      counters.bytesStored += entry.size;
      await evict();
      await persistIndex();
    } catch {
      counters.storeFailures += 1;
      await fsp.rm(tempPath, { force: true }).catch(() => {});
    }
  }

  function beginLoad(key) {
    const state = loadStates.get(key) || {
      active: 0,
      lastForegroundCompletion: 0,
      foregroundStore: null,
    };
    state.active += 1;
    loadStates.set(key, state);
    return { state, startedAt: ++operationSequence };
  }

  function finishLoad(key, state) {
    state.active -= 1;
    if (state.active === 0 && !storeInflight.has(key)) loadStates.delete(key);
  }

  async function storeInOrder(key, storeTask, shouldSkip) {
    const previous = storeInflight.get(key) || Promise.resolve();
    const current = previous.catch(() => {}).then(async () => {
      if (!shouldSkip()) await storeTask();
    });
    storeInflight.set(key, current);
    try {
      await current;
    } finally {
      if (storeInflight.get(key) === current) {
        storeInflight.delete(key);
        const state = loadStates.get(key);
        if (state?.active === 0) loadStates.delete(key);
      }
    }
  }

  async function getOrLoad(url, kind, loader, {
    allowStale = true,
    namespace = 'public',
    bypassInflight = false,
    ignoreFresh = false,
    deferStore = false,
  } = {}) {
    const cacheNamespace = normalizedNamespace(namespace);
    const key = keyFor(url, kind, cacheNamespace);
    const fresh = ignoreFresh ? null : await readEntry(url, kind, cacheNamespace, false);
    if (fresh) {
      counters.hits += 1;
      return resultFromEntry(fresh.entry, fresh.body, 'HIT');
    }
    if (bypassInflight) {
      const pendingForegroundStore = loadStates.get(key)?.foregroundStore;
      if (pendingForegroundStore) {
        await pendingForegroundStore.catch(() => {});
        const stored = await readEntry(url, kind, cacheNamespace, false);
        if (stored) {
          counters.hits += 1;
          return resultFromEntry(stored.entry, stored.body, 'HIT');
        }
      }
    }
    const stale = allowStale ? await readEntry(url, kind, cacheNamespace, true) : null;
    if (!bypassInflight && inflight.has(key)) return inflight.get(key);
    const loadOrder = beginLoad(key);

    const operation = (async () => {
      try {
        const loaded = await loader();
        if (loaded?.refreshFailed && stale) {
          counters.staleHits += 1;
          return resultFromEntry(stale.entry, stale.body, 'STALE');
        }
        if (loaded?.status >= 200 && loaded.status < 300) {
          if (bypassInflight) loadOrder.state.lastForegroundCompletion = ++operationSequence;
          const storeTask = async () => {
            const cacheLoaded = typeof loaded.cacheBody === 'function' ? await loaded.cacheBody() : loaded;
            await store(url, kind, cacheNamespace, cacheLoaded);
          };
          const shouldSkip = () => !bypassInflight
            && loadOrder.state.lastForegroundCompletion > loadOrder.startedAt;
          if (deferStore) {
            const storePromise = storeInOrder(key, storeTask, shouldSkip);
            if (bypassInflight) {
              loadOrder.state.foregroundStore = storePromise;
              void storePromise.then(() => {
                if (loadOrder.state.foregroundStore === storePromise) loadOrder.state.foregroundStore = null;
              }, () => {
                if (loadOrder.state.foregroundStore === storePromise) loadOrder.state.foregroundStore = null;
              });
            }
            void storePromise.catch(() => {});
          }
          else await storeInOrder(key, storeTask, shouldSkip);
        }
        counters.misses += 1;
        return { ...loaded, state: 'MISS' };
      } catch (error) {
        if (stale) {
          counters.staleHits += 1;
          return resultFromEntry(stale.entry, stale.body, 'STALE');
        }
        throw error;
      }
    })();
    if (!bypassInflight) inflight.set(key, operation);
    try {
      return await operation;
    } finally {
      if (!bypassInflight && inflight.get(key) === operation) inflight.delete(key);
      finishLoad(key, loadOrder.state);
    }
  }

  async function peek(url, kind, { namespace = 'public' } = {}) {
    const entry = await readEntry(url, kind, normalizedNamespace(namespace), false);
    return { hit: Boolean(entry) };
  }

  async function readRange(url, kind, { namespace = 'public' } = {}) {
    await ready;
    const cacheNamespace = normalizedNamespace(namespace);
    const key = keyFor(url, kind, cacheNamespace);
    const entry = entries.get(key);
    if (!entry || now() >= entry.expiresAt) return null;
    entry.lastAccessAt = now();
    scheduleTouchPersist();
    counters.hits += 1;
    return {
      entry,
      size: entry.size,
      createStream(start = 0, end = entry.size - 1) {
        const rangeStart = Math.max(0, Number(start) || 0);
        const rangeEnd = Number.isInteger(end) ? Math.min(end, entry.size - 1) : entry.size - 1;
        if (rangeStart > rangeEnd) return null;
        const filePath = path.join(cacheRoot, entry.file);
        try {
          // Eager stat closes most of the eviction race: createReadStream reports
          // a missing file asynchronously, after the 206 has already committed.
          const stat = fs.statSync(filePath);
          if (!stat.isFile() || stat.size !== entry.size) return null;
        } catch {
          return null;
        }
        counters.rangeReads += 1;
        counters.rangeBytes += Math.min(rangeEnd, entry.size - 1) - rangeStart + 1;
        try {
          return fs.createReadStream(filePath, { start: rangeStart, end: rangeEnd });
        } catch {
          return null;
        }
      },
    };
  }

  function stats() {
    return {
      entries: entries.size,
      bytes: totalBytes,
      byteLimit,
      counters: { ...counters },
      inflight: inflight.size,
      storeInflight: storeInflight.size,
      activeLoads: [...loadStates.values()].reduce((sum, state) => sum + state.active, 0),
      root: cacheRoot,
    };
  }

  return { getOrLoad, peek, readRange, keyFor, stats, root: cacheRoot };
}
