import { createHash, randomUUID } from 'node:crypto';
import * as fsp from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_TTL_SECONDS = Object.freeze({
  rss: 300,
  html: 3 * 24 * 60 * 60,
  'eh-image': 5 * 60,
  media: 7 * 24 * 60 * 60,
});
const DEFAULT_MAX_BYTES = 5 * 1024 ** 3;
const SAFE_HEADERS = new Set(['content-type', 'content-length', 'etag', 'last-modified', 'cache-control']);

function canonicalUrl(value) {
  return new URL(value).toString();
}

function keyFor(url, kind) {
  return createHash('sha256').update(`${kind}\n${canonicalUrl(url)}`).digest('hex');
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

export function createResponseCache({
  root = process.env.GATEWAY_CACHE_DIR || '/var/cache/rsshub-gateway',
  maxBytes = Number.parseInt(process.env.GATEWAY_CACHE_MAX_BYTES || '', 10) || DEFAULT_MAX_BYTES,
  ttlSeconds = {},
  now = () => Date.now(),
} = {}) {
  const cacheRoot = path.resolve(root);
  const indexPath = path.join(cacheRoot, 'index.json');
  const entries = new Map();
  const inflight = new Map();
  const ttl = { ...DEFAULT_TTL_SECONDS, ...ttlSeconds };
  const byteLimit = positiveNumber(maxBytes, DEFAULT_MAX_BYTES);
  let totalBytes = 0;
  let persistChain = Promise.resolve();
  let touchTimer;

  async function writeIndex() {
    const payload = JSON.stringify({ version: 1, entries: [...entries.values()] });
    const tempPath = `${indexPath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await fsp.writeFile(tempPath, payload, 'utf8');
      await fsp.rename(tempPath, indexPath);
    } catch {
      await fsp.rm(tempPath, { force: true }).catch(() => {});
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
      parsed = JSON.parse(await fsp.readFile(indexPath, 'utf8'));
    } catch {
      parsed = { entries: [] };
    }
    const records = Array.isArray(parsed?.entries)
      ? parsed.entries
      : Object.values(parsed?.entries || {});
    for (const record of records) {
      if (!record || !/^[a-f0-9]{64}$/.test(record.key) || record.file !== `${record.key}.body`
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

  async function readEntry(url, kind, allowExpired) {
    await ready;
    const key = keyFor(url, kind);
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
    const ordered = [...entries.values()].sort((left, right) => left.lastAccessAt - right.lastAccessAt);
    for (const entry of ordered) {
      if (totalBytes <= byteLimit) break;
      entries.delete(entry.key);
      totalBytes -= entry.size;
      await fsp.rm(path.join(cacheRoot, entry.file), { force: true }).catch(() => {});
    }
  }

  async function store(url, kind, loaded) {
    const body = normalizeBody(loaded.body);
    if (loaded.cacheable === false || !body || loaded.status < 200 || loaded.status >= 300 || body.buffer.length > byteLimit) return;
    await ready;
    await fsp.mkdir(cacheRoot, { recursive: true });
    const key = keyFor(url, kind);
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
      await evict();
      await persistIndex();
    } catch {
      await fsp.rm(tempPath, { force: true }).catch(() => {});
    }
  }

  async function getOrLoad(url, kind, loader, { allowStale = true } = {}) {
    const fresh = await readEntry(url, kind, false);
    if (fresh) return resultFromEntry(fresh.entry, fresh.body, 'HIT');
    const stale = allowStale ? await readEntry(url, kind, true) : null;
    const key = keyFor(url, kind);
    if (inflight.has(key)) return inflight.get(key);

    const operation = (async () => {
      try {
        const loaded = await loader();
        if (loaded?.refreshFailed && stale) return resultFromEntry(stale.entry, stale.body, 'STALE');
        if (loaded?.status >= 200 && loaded.status < 300) await store(url, kind, loaded);
        return { ...loaded, state: 'MISS' };
      } catch (error) {
        if (stale) return resultFromEntry(stale.entry, stale.body, 'STALE');
        throw error;
      }
    })();
    inflight.set(key, operation);
    try {
      return await operation;
    } finally {
      if (inflight.get(key) === operation) inflight.delete(key);
    }
  }

  async function peek(url, kind) {
    const entry = await readEntry(url, kind, false);
    return { hit: Boolean(entry) };
  }

  return { getOrLoad, peek, keyFor, root: cacheRoot };
}

export { DEFAULT_MAX_BYTES, DEFAULT_TTL_SECONDS };
