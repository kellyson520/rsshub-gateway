import fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { Readable } from 'node:stream';
import { randomUUID, randomBytes, createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { brotliCompressSync, constants as zlibConstants, gzipSync } from 'node:zlib';
import * as cheerio from 'cheerio';
import sharp from 'sharp';

export function safeJsonParse(value, fallback = null) {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'object' && !Buffer.isBuffer(value)) return value;
  try {
    const text = Buffer.isBuffer(value) ? value.toString('utf8') : String(value);
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

export function readSecret() {
  const file = process.env.GATEWAY_SECRET_FILE;
  if (file) {
    try {
      return fs.readFileSync(file, 'utf8').trim();
    } catch {
      // Fall through to env or default.
    }
  }
  if (process.env.GATEWAY_SECRET) return process.env.GATEWAY_SECRET;
  return 'development-only-secret';
}

export function readSources() {
  const file = process.env.SOURCE_CONFIG_FILE;
  if (!file) return {};
  try {
    const content = fs.readFileSync(file, 'utf8');
    return safeJsonParse(content, {});
  } catch {
    return {};
  }
}

export function publicBaseUrl(req) {
  const scheme = req.headers['x-forwarded-proto'] || 'https';
  return `${scheme}://${req.headers.host || 'localhost:1300'}`;
}

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

export function writeText(res, status, body, contentType = 'text/plain; charset=utf-8', headers = {}) {
  res.writeHead(status, { 'content-type': contentType, ...headers, 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

export function writeBuffer(res, status, body, contentType, headers = {}) {
  const output = Buffer.isBuffer(body) ? body : Buffer.from(body || '');
  res.writeHead(status, { 'content-type': contentType, ...headers, 'content-length': output.length });
  res.end(output);
}

export function writeJson(res, status, payload) {
  writeText(res, status, JSON.stringify(payload), 'application/json; charset=utf-8');
}

export function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export async function readJsonBody(req) {
  const raw = await readRequestBody(req);
  return JSON.parse(raw);
}

export function isBearerAuthorized(reqOrHeader, expectedToken) {
  if (!expectedToken) return false;
  const header = reqOrHeader && typeof reqOrHeader === 'object' && reqOrHeader.headers
    ? reqOrHeader.headers.authorization
    : reqOrHeader;
  const expected = `Bearer ${expectedToken}`;
  const provided = String(header || '').trim();
  return constantTimeEquals(provided, expected);
}

export function safeHost(url, fallback = 'unknown') {
  try {
    return new URL(String(url || '')).hostname.toLowerCase();
  } catch {
    return fallback;
  }
}

export function isHostOrSubdomain(hostname, base) {
  const h = String(hostname || '').toLowerCase();
  const b = String(base || '').toLowerCase();
  if (!h || !b) return false;
  return h === b || h.endsWith(`.${b}`);
}

export function matchesHost(hostname, hosts) {
  const h = String(hostname || '').toLowerCase();
  if (!h) return false;
  const list = Array.isArray(hosts) ? hosts : (hosts ? [hosts] : []);
  return list.some((base) => isHostOrSubdomain(h, base));
}

export const HOTLINK_REFERERS = Object.freeze({
  'javbus.com': 'https://www.javbus.com/',
  'javbus.one': 'https://www.javbus.com/',
  'jpgcdn.com': 'https://www.javbus.com/',
  'mgstage.com': 'https://www.mgstage.com/',
  'dmm.co.jp': 'https://www.dmm.co.jp/',
  'javdb.com': 'https://javdb.com/',
  'jdbstatic.com': 'https://javdb.com/',
  'missav.ai': 'https://missav.ai/',
  'missav.com': 'https://missav.com/',
  'jable.tv': 'https://jable.tv/',
});

export function refererFor(url, referers = HOTLINK_REFERERS) {
  const hostname = safeHost(url, '');
  if (!hostname) return undefined;
  const table = referers && typeof referers === 'object' ? referers : HOTLINK_REFERERS;
  for (const [base, referer] of Object.entries(table)) {
    if (isHostOrSubdomain(hostname, base)) return referer;
  }
  return undefined;
}

export function parseHostList(value) {
  if (!value) return [];
  const parsed = safeJsonParse(value, null);
  if (Array.isArray(parsed)) {
    return dedupe(parsed.map(String).map((host) => host.trim().toLowerCase()).filter(Boolean));
  }
  return dedupe(String(value).split(',').map((host) => host.trim().toLowerCase()).filter(Boolean));
}

export function mediaFileName(target, contentType) {
  try {
    const pathname = new URL(target).pathname;
    const base = pathname.split('/').pop() || 'download';
    if (base.includes('.')) return base;
    const extension = String(contentType || '').split('/')[1] || 'bin';
    return `${base}.${extension}`;
  } catch {
    return 'download.bin';
  }
}

export function writeGatewayError(res, error) {
  const headers = {
    'x-gateway-source': error.source,
    'x-gateway-attempts': String(error.attempts),
  };
  if (error.retryAfter !== undefined) headers['retry-after'] = String(clamp(error.retryAfter, 0, 60));
  writeText(res, error.status, 'upstream unavailable\n', 'text/plain; charset=utf-8', headers);
}

export const DEFAULT_READ_LIMIT_BYTES = 4 * 1024 * 1024;

export async function readLimited(response, limit = DEFAULT_READ_LIMIT_BYTES) {
  // browser-fetch 响应体是 Buffer（同步可迭代）：直接返回，避免按字节迭代。
  if (Buffer.isBuffer(response.body)) {
    if (response.body.length > limit) throw new Error('upstream response too large');
    return response.body.toString('utf8');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body ?? []) {
    size += chunk.length;
    if (size > limit) throw new Error('upstream response too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export async function readBinaryLimited(response, limit) {
  if (Buffer.isBuffer(response.body)) {
    if (response.body.length > limit) throw new Error('upstream media response too large');
    return response.body;
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body ?? []) {
    size += chunk.length;
    if (size > limit) throw new Error('upstream media response too large');
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export const DEFAULT_CACHE_TTL_SECONDS = Object.freeze({
  rss: 300,
  html: 3 * 24 * 60 * 60,
  'eh-image': 5 * 60,
  media: 7 * 24 * 60 * 60,
  'media-variant': 7 * 24 * 60 * 60,
});
export const DEFAULT_CACHE_MAX_BYTES = 5 * 1024 ** 3;
export const DEFAULT_EVICTION_PRIORITY = Object.freeze({
  rss: 0,
  html: 1,
  media: 2,
  'media-variant': 3,
});
export const CACHE_SAFE_HEADERS = Object.freeze(new Set(['content-type', 'content-length', 'etag', 'last-modified', 'cache-control']));
export const CACHE_INDEX_VERSION = 1;
export const CACHE_BODY_EXTENSION = '.body';
export const CACHE_BODY_PATTERN = /^[a-f0-9]{64}\.body$/;

export function isCacheBodyFile(filename) {
  return CACHE_BODY_PATTERN.test(String(filename || ''));
}

export function cacheBodyFile(key) {
  return `${key}${CACHE_BODY_EXTENSION}`;
}

export function isValidCacheIndexRecord(record) {
  if (!record || typeof record !== 'object') return false;
  if (!isSha256Hex(record.key)) return false;
  if (record.file !== cacheBodyFile(record.key)) return false;
  if (!Number.isFinite(record.size) || record.size < 0) return false;
  return ['string', 'buffer'].includes(record.bodyType);
}

export function canonicalUrl(value) {
  return new URL(value).toString();
}

export function normalizedNamespace(value) {
  return String(value || 'public').trim() || 'public';
}

export function cacheKeyFor(url, kind, namespace = 'public') {
  return sha256Hex(`${kind}\n${normalizedNamespace(namespace)}\n${canonicalUrl(url)}`);
}

export function normalizeCacheHeaders(headers, safeHeaders = CACHE_SAFE_HEADERS) {
  const entries = headers instanceof Headers
    ? [...headers.entries()]
    : Object.entries(headers || {});
  return Object.fromEntries(entries
    .map(([name, value]) => [String(name).toLowerCase(), String(value)])
    .filter(([name, value]) => safeHeaders.has(name) && value));
}

export function normalizeCacheBody(body) {
  if (typeof body === 'string') return { value: body, buffer: Buffer.from(body, 'utf8'), type: 'string' };
  if (Buffer.isBuffer(body)) return { value: body, buffer: body, type: 'buffer' };
  return null;
}

export function resultFromCacheEntry(entry, body, state) {
  if (!entry) return null;
  return {
    state,
    status: entry.status,
    headers: { ...entry.headers },
    body: entry.bodyType === 'string' ? body.toString('utf8') : body,
  };
}

export function createResponseCache({
  root = process.env.GATEWAY_CACHE_DIR || DEFAULT_CACHE_ROOT,
  maxBytes = positiveInteger(process.env.GATEWAY_CACHE_MAX_BYTES, DEFAULT_CACHE_MAX_BYTES),
  ttlSeconds = {},
  evictionPriority = {},
  now = () => Date.now(),
  fsImpl,
} = {}) {
  const fileSystem = fsImpl || fs;
  const fsPromises = fsImpl?.promises || fsp;
  const cacheRoot = path.resolve(root);
  const indexPath = path.join(cacheRoot, 'index.json');
  const entries = new Map();
  const inflight = new Map();
  const storeInflight = new Map();
  const loadStates = new Map();
  const ttl = { ...DEFAULT_CACHE_TTL_SECONDS, ...ttlSeconds };
  const priority = { ...DEFAULT_EVICTION_PRIORITY, ...evictionPriority };
  const byteLimit = positiveNumber(maxBytes, DEFAULT_CACHE_MAX_BYTES);
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
      await atomicWriteJson(indexPath, { version: CACHE_INDEX_VERSION, entries: [...entries.values()] }, { mode: null, dirMode: 0o755, fsImpl });
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
    await fsPromises.mkdir(cacheRoot, { recursive: true }).catch(() => {});
    let parsed;
    try {
      const content = await fsPromises.readFile(indexPath, 'utf8');
      parsed = safeJsonParse(content, { entries: [] });
    } catch {
      parsed = { entries: [] };
    }
    const records = Array.isArray(parsed?.entries)
      ? parsed.entries
      : Object.values(parsed?.entries || {});
    for (const record of records) {
      if (!isValidCacheIndexRecord(record)) continue;
      try {
        const stat = await fsPromises.stat(path.join(cacheRoot, record.file));
        if (!stat.isFile() || stat.size !== record.size) continue;
        entries.set(record.key, record);
        totalBytes += record.size;
      } catch {
        // Missing cache files are treated as misses.
      }
    }
    const knownFiles = new Set([...entries.values()].map((entry) => entry.file));
    const files = await fsPromises.readdir(cacheRoot).catch(() => []);
    for (const file of files) {
      if (!isCacheBodyFile(file) && !file.endsWith('.tmp')) continue;
      if (knownFiles.has(file)) continue;
      await fsPromises.rm(path.join(cacheRoot, file), { force: true }).catch(() => {});
    }
    await evict();
  }

  const ready = initialize();

  async function readEntry(url, kind, namespace, allowExpired) {
    await ready;
    const key = cacheKeyFor(url, kind, namespace);
    const entry = entries.get(key);
    if (!entry) return null;
    const fresh = now() < entry.expiresAt;
    if (!fresh && !allowExpired) return null;
    try {
      const body = await fsPromises.readFile(path.join(cacheRoot, entry.file));
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
      await fsPromises.rm(path.join(cacheRoot, entry.file), { force: true }).catch(() => {});
    }
  }

  async function store(url, kind, namespace, loaded) {
    const body = normalizeCacheBody(loaded.body);
    if (loaded.cacheable === false || !body || loaded.status < 200 || loaded.status >= 300 || body.buffer.length > byteLimit) return;
    await ready;
    await fsPromises.mkdir(cacheRoot, { recursive: true });
    const key = cacheKeyFor(url, kind, namespace);
    const file = cacheBodyFile(key);
    const tempPath = path.join(cacheRoot, `${file}.${process.pid}.${randomUUID()}.tmp`);
    try {
      await fsPromises.writeFile(tempPath, body.buffer);
      await fsPromises.rename(tempPath, path.join(cacheRoot, file));
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
        headers: normalizeCacheHeaders(loaded.headers),
        createdAt,
        expiresAt: createdAt + (positiveNumber(Number(ttl[kind]), DEFAULT_CACHE_TTL_SECONDS.html) * 1000),
        lastAccessAt: createdAt,
      };
      entries.set(key, entry);
      totalBytes += entry.size;
      counters.bytesStored += entry.size;
      await evict();
      await persistIndex();
    } catch {
      counters.storeFailures += 1;
      await fsPromises.rm(tempPath, { force: true }).catch(() => {});
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
    const key = cacheKeyFor(url, kind, cacheNamespace);
    const fresh = ignoreFresh ? null : await readEntry(url, kind, cacheNamespace, false);
    if (fresh) {
      counters.hits += 1;
      return resultFromCacheEntry(fresh.entry, fresh.body, 'HIT');
    }
    if (bypassInflight) {
      const pendingForegroundStore = loadStates.get(key)?.foregroundStore;
      if (pendingForegroundStore) {
        await pendingForegroundStore.catch(() => {});
        const stored = await readEntry(url, kind, cacheNamespace, false);
        if (stored) {
          counters.hits += 1;
          return resultFromCacheEntry(stored.entry, stored.body, 'HIT');
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
          return resultFromCacheEntry(stale.entry, stale.body, 'STALE');
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
          return resultFromCacheEntry(stale.entry, stale.body, 'STALE');
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
    const key = cacheKeyFor(url, kind, cacheNamespace);
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
          const stat = fileSystem.statSync(filePath);
          if (!stat.isFile() || stat.size !== entry.size) return null;
        } catch {
          return null;
        }
        counters.rangeReads += 1;
        counters.rangeBytes += Math.min(rangeEnd, entry.size - 1) - rangeStart + 1;
        try {
          return fileSystem.createReadStream(filePath, { start: rangeStart, end: rangeEnd });
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

  return { getOrLoad, peek, readRange, keyFor: cacheKeyFor, stats, root: cacheRoot };
}

export const CHUNK_STATUSES = Object.freeze(new Set(['pending', 'done']));
export const DEFAULT_DOWNLOAD_SESSION_TTL_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_MAX_DOWNLOAD_SESSIONS = 64;

export function isValidChunkRecord(chunk) {
  return Boolean(
    chunk
    && typeof chunk === 'object'
    && Number.isInteger(chunk.index)
    && chunk.index >= 0
    && Number.isFinite(chunk.start)
    && Number.isFinite(chunk.end)
    && Number.isFinite(chunk.size)
    && typeof chunk.url === 'string'
    && CHUNK_STATUSES.has(chunk.status)
    && Number.isFinite(chunk.updatedAt),
  );
}

export function isValidSessionRecord(session, now = Date.now()) {
  return Boolean(
    session
    && typeof session === 'object'
    && typeof session.id === 'string'
    && session.id
    && typeof session.target === 'string'
    && session.target
    && Number.isFinite(session.size)
    && Number.isFinite(session.chunkSize)
    && Number.isFinite(session.createdAt)
    && Number.isFinite(session.expiresAt)
    && session.expiresAt > now
    && Array.isArray(session.chunks)
    && session.chunks.length > 0
    && session.chunks.every(isValidChunkRecord),
  );
}

export const CACHE_RESPONSE_HEADERS = Object.freeze(['content-type', 'content-length', 'etag', 'last-modified', 'cache-control']);

export function responseHeaders(response) {
  const headers = {};
  for (const name of CACHE_RESPONSE_HEADERS) {
    const value = response.headers.get(name);
    if (value) headers[name] = value;
  }
  return headers;
}

export function responseFromCachedDocument(result) {
  return new Response(result.body, { status: result.status, headers: result.headers });
}

export function documentCacheKind(url, kind) {
  if (kind !== 'html') return kind;
  try {
    const target = new URL(url);
    if (target.hostname === 'e-hentai.org' && /^\/s\/[^/]+\/[^/]+\/?$/.test(target.pathname)) return 'eh-image';
  } catch {
    // Keep the caller's cache kind for malformed diagnostic URLs.
  }
  return kind;
}

export function cacheStateLog(url, kind, state, logger) {
  try {
    const line = { event: 'gateway_cache', host: new URL(url).hostname, kind, state };
    if (logger) logger.info('gateway_cache', line);
    else console.log(JSON.stringify(line));
  } catch {
    // Cache diagnostics must never affect the response.
  }
}

export async function fetchCachedDocument({ cache, fetcher, requestUrl, cacheUrl = requestUrl, request, kind, logger }) {
  if (!cache) return fetcher(requestUrl, request);
  const cacheKind = documentCacheKind(cacheUrl, kind);
  const result = await cache.getOrLoad(cacheUrl, cacheKind, async () => {
    const response = await fetcher(requestUrl, request);
    const body = await readLimited(response);
    const contentType = response.headers.get('content-type') || '';
    const cacheable = cacheKind === 'html' || cacheKind === 'eh-image'
      ? contentType.includes('html')
      : contentType.includes('xml') || contentType.includes('rss') || contentType.includes('atom');
    return {
      status: response.status,
      headers: responseHeaders(response),
      body,
      cacheable: response.ok && cacheable,
      refreshFailed: [408, 425, 429].includes(response.status) || response.status >= 500,
    };
  }, {
    allowStale: cacheKind !== 'eh-image',
    bypassInflight: request?.priority === 'foreground',
  });
  cacheStateLog(cacheUrl, cacheKind, result.state, logger);
  return responseFromCachedDocument(result);
}

export function clamp(value, minimum, maximum) {
  const n = Number(value);
  if (!Number.isFinite(n)) return minimum;
  return Math.min(Math.max(n, minimum), maximum);
}

export function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function nonNegativeInteger(value, fallback = 0) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

export function boundedInteger(value, fallback, minimum, maximum) {
  return clamp(positiveInteger(value, fallback), minimum, maximum);
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

export function withDeadline(promise, timeoutMs, fallback = undefined) {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      resolve({ value: fallback, timedOut: true });
    }, Math.max(Number(timeoutMs) || 0, 0));
    Promise.resolve(promise).then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ value, timedOut: false });
      },
      () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ value: fallback, timedOut: false });
      },
    );
  });
}

export function dedupe(items, mapper = (x) => x) {
  if (!items) return [];
  const list = Array.isArray(items) || items instanceof Set ? items : [items];
  const seen = new Set();
  const result = [];
  for (const item of list) {
    const key = mapper(item);
    if (key !== undefined && key !== null && !seen.has(key)) {
      seen.add(key);
      result.push(item);
    }
  }
  return result;
}

export function parseStatusList(value, fallback = []) {
  if (value === null || value === undefined) {
    return Array.isArray(fallback) ? [...fallback] : (fallback instanceof Set ? [...fallback] : []);
  }
  const items = Array.isArray(value) || value instanceof Set
    ? [...value]
    : String(value).split(',');
  return dedupe(items
    .map((item) => Number.parseInt(String(item).trim(), 10))
    .filter((status) => Number.isInteger(status) && status >= 100 && status <= 599));
}

export function parseProbeTargets(value, legacyProbeUrl) {
  const parsed = safeJsonParse(value, null);
  if (parsed && typeof parsed === 'object') {
    const list = (input) => {
      if (!input) return [];
      return (Array.isArray(input) ? input : [input]).map(String).filter(Boolean);
    };
    return {
      public: list(parsed.public),
      sticky: list(parsed.sticky),
      hosts: parsed.hosts && typeof parsed.hosts === 'object' ? parsed.hosts : {},
    };
  }
  return {
    public: [String(legacyProbeUrl || 'https://e-hentai.org/').trim()],
    sticky: ['https://www.iwara.tv/', 'https://x.com/'],
    hosts: {},
  };
}

export const IMAGE_VARIANT_WIDTHS = Object.freeze([1280, 1920, 2560]);
export const SUPPORTED_IMAGE_VARIANT_TYPES = Object.freeze(new Set(['image/jpeg', 'image/png', 'image/webp']));
export const IMAGE_VARIANT_CACHE_VERSION = 'v1';

export const DEFAULT_WEBP_OPTIONS = Object.freeze({
  quality: 92,
  nearLossless: true,
  effort: 4,
  smartSubsample: false,
});

export function normalizedImageContentType(contentType) {
  return String(contentType || '').split(';', 1)[0].trim().toLowerCase();
}

export function originalImageResult(body, contentType) {
  return {
    body,
    contentType,
    usedVariant: false,
  };
}

export function unsupportedImageVariantWidthError() {
  const error = new Error('unsupported image variant width');
  error.code = 'IMAGE_VARIANT_UNSUPPORTED_WIDTH';
  return error;
}

export function isValidImageVariantWidth(width) {
  return IMAGE_VARIANT_WIDTHS.includes(Number(width));
}

export function isSupportedImageVariantType(contentType) {
  return SUPPORTED_IMAGE_VARIANT_TYPES.has(normalizedImageContentType(contentType));
}

export function requestedImageVariantWidth(searchParams) {
  if (!searchParams.has('w')) return { width: undefined };
  const values = searchParams.getAll('w');
  const value = values.length === 1 ? values[0] : '';
  const width = Number(value);
  if (!IMAGE_VARIANT_WIDTHS.includes(width) || String(width) !== value) return { error: true };
  return { width };
}

export async function encodeWebp({ body, width, options = DEFAULT_WEBP_OPTIONS }) {
  const image = sharp(body, { failOn: 'error' });
  const metadata = await image.metadata();
  if (metadata.pages && metadata.pages > 1) return body;
  return image
    .rotate()
    .resize({ width, withoutEnlargement: true })
    .webp(options)
    .toBuffer();
}

export async function createImageVariant({ body, contentType, width, encoder = encodeWebp }) {
  const normalizedContentType = normalizedImageContentType(contentType);
  if (!IMAGE_VARIANT_WIDTHS.includes(Number(width))) throw unsupportedImageVariantWidthError();
  if (!SUPPORTED_IMAGE_VARIANT_TYPES.has(normalizedContentType) || !Buffer.isBuffer(body) || body.length === 0) {
    return originalImageResult(body, contentType);
  }

  try {
    const variant = await encoder({ body, width: Number(width), options: DEFAULT_WEBP_OPTIONS });
    if (!Buffer.isBuffer(variant) || variant.length >= body.length) return originalImageResult(body, contentType);
    return { body: variant, contentType: 'image/webp', usedVariant: true };
  } catch {
    return originalImageResult(body, contentType);
  }
}

export function imageVariantCacheUrl(target, width) {
  const cacheUrl = new URL(target);
  cacheUrl.hash = `rsshub-gateway-${IMAGE_VARIANT_CACHE_VERSION}-w${width}`;
  return cacheUrl.toString();
}

export function mediaSrcset(media, widths = IMAGE_VARIANT_WIDTHS) {
  if (!media || typeof media !== 'string') return '';
  try {
    const list = Array.isArray(widths) ? widths : IMAGE_VARIANT_WIDTHS;
    return list.map((width) => {
      const variant = new URL(media);
      variant.searchParams.set('w', String(width));
      return `${variant.toString()} ${width}w`;
    }).join(', ');
  } catch {
    return '';
  }
}

export function numericStyle(style, property, fallback) {
  const match = String(style || '').match(new RegExp(`${property}\\s*:\\s*(-?\\d+(?:\\.\\d+)?)px`, 'i'));
  const value = Number(match?.[1]);
  return Number.isFinite(value) ? clamp(Math.round(value), 1, 5000) : fallback;
}

export const BENCHMARK_LOCAL_HOSTS = Object.freeze(new Set(['127.0.0.1', 'localhost', '[::1]']));
export const DEFAULT_MEDIA_CONCURRENCY = 8;
export const DEFAULT_BENCHMARK_VARIANT_WIDTH = 1920;

export function localGatewayUrl(value, localHosts = BENCHMARK_LOCAL_HOSTS) {
  let target;
  try {
    target = new URL(value);
  } catch {
    target = null;
  }
  if (!target || !['http:', 'https:'].includes(target.protocol) || !localHosts.has(target.hostname)
    || target.username || target.password || !target.pathname.startsWith('/_gateway/item/')) {
    const error = new Error('a local gateway item URL is required');
    error.code = 'BENCHMARK_LOCAL_GATEWAY_REQUIRED';
    throw error;
  }
  return target;
}

export function mediaUrls(html, baseUrl) {
  const urls = new Set();
  for (const match of String(html || '').matchAll(/<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi)) {
    try {
      const target = new URL(match[1], baseUrl);
      if (target.origin === baseUrl.origin && target.pathname.startsWith('/_gateway/media/')) urls.add(target.toString());
    } catch {
      // Ignore malformed or external markup.
    }
  }
  return [...urls];
}

export function numericContentLength(response) {
  if (!response || !response.headers) return 0;
  return nonNegativeInteger(response.headers.get ? response.headers.get('content-length') : response.headers['content-length'], 0);
}

export function variantUrl(original, width = DEFAULT_BENCHMARK_VARIANT_WIDTH) {
  const target = new URL(original);
  target.searchParams.set('w', String(width));
  return target.toString();
}

export async function benchmarkGallery({ gatewayUrl, fetchImpl = fetch, now = () => Date.now() } = {}) {
  const itemUrl = localGatewayUrl(gatewayUrl);
  const startedAt = now();
  const itemResponse = await fetchImpl(itemUrl, { headers: { 'accept-encoding': 'identity' } });
  const html = await itemResponse.text();
  const htmlMs = Math.max(0, now() - startedAt);
  const originals = mediaUrls(html, itemUrl);

  const sourceSizes = await mapWithConcurrency(originals, DEFAULT_MEDIA_CONCURRENCY, async (url) => {
    try {
      const response = await fetchImpl(url, { method: 'HEAD', headers: { 'accept-encoding': 'identity' } });
      return numericContentLength(response);
    } catch {
      return 0;
    }
  });
  const mediaStartedAt = now();
  const variants = await mapWithConcurrency(originals.map((u) => variantUrl(u)), DEFAULT_MEDIA_CONCURRENCY, async (url) => {
    try {
      const response = await fetchImpl(url, { headers: { 'accept-encoding': 'identity' } });
      const body = Buffer.from(await response.arrayBuffer());
      return { status: response.status, bytes: body.length, completedAt: Math.max(0, now() - mediaStartedAt) };
    } catch {
      return { status: 0, bytes: 0, completedAt: Math.max(0, now() - mediaStartedAt) };
    }
  });
  const statusCounts = {};
  for (const result of variants) statusCounts[result.status] = (statusCounts[result.status] || 0) + 1;
  const originalBytes = sourceSizes.reduce((total, bytes) => total + bytes, 0);
  const variantBytes = variants.reduce((total, result) => total + result.bytes, 0);
  const variantSavedPercent = originalBytes > 0
    ? Number((((originalBytes - variantBytes) / originalBytes) * 100).toFixed(2))
    : 0;
  const firstScreenCount = Math.min(8, variants.length);
  const quarterCount = Math.ceil(variants.length / 4);

  return {
    htmlMs,
    firstScreenMs: durationCheckpoint(variants, firstScreenCount),
    quarterReadyMs: durationCheckpoint(variants, quarterCount),
    allReadyMs: durationCheckpoint(variants, variants.length),
    originalBytes,
    variantBytes,
    variantSavedPercent,
    statusCounts,
  };
}

export const EH_GALLERY_PATH = /^\/g\/[^/]+\/[^/]+\/?$/;
export const EH_IMAGE_PATH = /^\/s\/[^/]+\/[^/]+(?:\/)?$/;

export const EHVIEWER_RANKING_PERIODS = Object.freeze({
  day: { query: '15', label: '昨日热度' },
  month: { query: '13', label: '本月热度' },
  year: { query: '12', label: '年度热度' },
  all: { query: '11', label: '总热度' },
});
export const RANKING_PERIODS = EHVIEWER_RANKING_PERIODS;

export const EHVIEWER_MAX_ITEMS = 50;
export const EHVIEWER_MATCH_HOSTS = Object.freeze(['e-hentai.org', 'ehgt.org']);
export const DEFAULT_EHVIEWER_UNAVAILABLE_MESSAGE = 'E-Hentai 内容暂时无法读取，请稍后重试或打开原始来源。';

export function isEhentaiPage(value, pattern) {
  try {
    const parsed = new URL(value);
    const regex = pattern instanceof RegExp ? pattern : EH_GALLERY_PATH;
    return parsed.hostname === 'e-hentai.org' && regex.test(parsed.pathname);
  } catch {
    return false;
  }
}

export function isEhImagePageTarget(value) {
  return isEhentaiPage(value, EH_IMAGE_PATH);
}

export function isEhGalleryUrl(value) {
  return isEhentaiPage(value, EH_GALLERY_PATH);
}

export function ehviewerGalleryPageUrls(html, galleryUrl) {
  const base = new URL(galleryUrl);
  const result = [base.toString()];
  const $ = cheerio.load(String(html || ''), { decodeEntities: false });
  $('.gtb a[href]').each((_, element) => {
    try {
      const candidate = new URL($(element).attr('href'), base);
      candidate.hash = '';
      if (isEhGalleryUrl(candidate) && candidate.pathname === base.pathname) {
        const value = candidate.toString();
        if (!result.includes(value)) result.push(value);
      }
    } catch {
      // Ignore malformed and cross-gallery pagination links.
    }
  });
  return result;
}

export function ehviewerImagePageUrls(html, galleryUrl) {
  const $ = cheerio.load(String(html || ''), { decodeEntities: false });
  const result = [];
  $('#gdt a[href]').each((_, element) => {
    try {
      const candidate = new URL($(element).attr('href'), galleryUrl);
      candidate.hash = '';
      if (isEhentaiPage(candidate, EH_IMAGE_PATH)) {
        const value = candidate.toString();
        if (!result.includes(value)) result.push(value);
      }
    } catch {
      // Ignore malformed and cross-host links.
    }
  });
  return result;
}

export function ehviewerFirstImagePageUrl(html, galleryUrl) {
  if (!isEhGalleryUrl(galleryUrl)) return '';
  return ehviewerImagePageUrls(html, galleryUrl)[0] || '';
}

export function ehviewerRankingTarget(period = 'day') {
  const config = EHVIEWER_RANKING_PERIODS[period];
  if (!config) throw new Error(`unknown ranking period: ${period}`);
  return `https://e-hentai.org/toplist.php?tl=${config.query}`;
}

export function ehviewerPublicUrl(value, host, matchHosts = EHVIEWER_MATCH_HOSTS) {
  try {
    const url = new URL(value, 'https://e-hentai.org');
    return matchesHost(url.hostname, matchHosts) && (url.hostname === host || url.hostname.endsWith(`.${host}`))
      ? url.toString()
      : '';
  } catch {
    return '';
  }
}

export function parseEhviewerRankingHtml(html, { period = 'day' } = {}) {
  if (!EHVIEWER_RANKING_PERIODS[period]) throw new Error(`unknown ranking period: ${period}`);
  const $ = cheerio.load(String(html), { decodeEntities: false });
  const items = [];
  $('table.gltc tbody tr').each((_, element) => {
    if (items.length >= EHVIEWER_MAX_ITEMS) return false;
    const row = $(element);
    const link = ehviewerPublicUrl(row.find('.glname a').first().attr('href'), 'e-hentai.org');
    if (!link || !EH_GALLERY_PATH.test(new URL(link).pathname)) return;
    const thumbnailImage = row.find('.glthumb img').first();
    const title = row.find('.glname .glink').first().text().trim()
      || thumbnailImage.attr('title')?.trim()
      || thumbnailImage.attr('alt')?.trim()
      || row.find('.glname a').first().text().trim();
    if (!title) return;
    const thumbnail = ehviewerPublicUrl(
      thumbnailImage.attr('data-src') || thumbnailImage.attr('src'),
      'ehgt.org',
    );
    const categories = row.find('.gt').map((__, category) => $(category).attr('title')?.replace(/^:/, '') || $(category).text().trim()).get().filter(Boolean);
    const author = row.find('.glhide div a').first().text().trim();
    const pageCount = row.find('.glhide div').map((__, value) => $(value).text().trim()).get().find((value) => /\bpages?\b/i.test(value)) || '';
    const rank = row.children().first().find('p').first().text().trim();
    const date = asDate(row.find('[id^="posted_"]').first().text());
    items.push({ title, link, author, date, categories, thumbnail, rank, pageCount });
  });
  return { period, items };
}

export function renderEhviewerRankingFeed({ period = 'day', items = [] } = {}) {
  const config = EHVIEWER_RANKING_PERIODS[period];
  if (!config) throw new Error(`unknown ranking period: ${period}`);
  const entries = items.slice(0, EHVIEWER_MAX_ITEMS).map((item) => {
    const description = [
      item.rank ? `<p>排名：${escapeXml(item.rank)}</p>` : '',
      item.author ? `<p>作者：${escapeXml(item.author)}</p>` : '',
      item.pageCount ? `<p>篇幅：${escapeXml(item.pageCount)}</p>` : '',
      item.date ? `<p>发布时间：${escapeXml(item.date)}</p>` : '',
      item.categories?.length ? `<p>分类：${escapeXml(item.categories.join(', '))}</p>` : '',
      item.thumbnail ? `<p><img src="${escapeXml(item.thumbnail)}" alt="${escapeXml(item.title)}"></p>` : '',
    ].join('');
    return `<item><title>${escapeXml(item.title)}</title><link>${escapeXml(item.link)}</link><guid isPermaLink="true">${escapeXml(item.link)}</guid>${item.date ? `<pubDate>${escapeXml(item.date)}</pubDate>` : ''}<description>${cdata(description)}</description><content:encoded>${cdata(description)}</content:encoded></item>`;
  }).join('');
  return `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel><title>EhViewer ${escapeXml(config.label)}</title><link>${escapeXml(ehviewerRankingTarget(period))}</link><description>E-Hentai ${escapeXml(config.label)}</description>${entries}</channel></rss>`;
}

export function parseByteRange(value, size) {
  const match = String(value || '').trim().match(/^bytes=(\d*)-(\d*)$/);
  if (!match) return null;
  const [, startText, endText] = match;
  if (startText === '' && endText === '') return null;
  if (startText === '') {
    const suffix = Number.parseInt(endText, 10);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return { unsatisfiable: true };
    const start = Math.max(0, size - suffix);
    return start >= size ? { unsatisfiable: true } : { start, end: size - 1 };
  }
  const start = Number.parseInt(startText, 10);
  if (!Number.isSafeInteger(start) || start < 0 || start >= size) return { unsatisfiable: true };
  const end = endText === '' ? size - 1 : Math.min(Number.parseInt(endText, 10), size - 1);
  if (end < start) return { unsatisfiable: true };
  return { start, end };
}

export async function mapWithConcurrency(items, concurrency, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  async function run() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, run));
  return results;
}

export function createConcurrencyLimiter(limit) {
  let active = 0;
  const waiters = [];
  return async (task) => {
    if (active >= limit) await new Promise((resolve) => waiters.push(resolve));
    active += 1;
    try {
      return await task();
    } finally {
      active -= 1;
      waiters.shift()?.();
    }
  };
}

export function sha256Hex(value) {
  return createHash('sha256').update(String(value ?? '')).digest('hex');
}

export function isSha256Hex(value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

export function hmacSha256(value, secret, encoding) {
  const hmac = createHmac('sha256', secret).update(String(value ?? ''));
  return encoding ? hmac.digest(encoding) : hmac.digest();
}

export function isSignatureMatch(actual, expected) {
  try {
    const actualBuf = Buffer.isBuffer(actual) ? actual : Buffer.from(String(actual ?? ''), 'base64url');
    const expectedBuf = Buffer.isBuffer(expected) ? expected : Buffer.from(String(expected ?? ''), 'base64url');
    return actualBuf.length === expectedBuf.length && timingSafeEqual(actualBuf, expectedBuf);
  } catch {
    return false;
  }
}

export const EGRESS_SCOPES = Object.freeze(new Set(['public', 'session', 'sticky']));
export const DEFAULT_TTL_SECONDS = 15 * 60;
export const MEDIA_CACHE_TTL_SECONDS = 24 * 60 * 60;

export const ALLOWED_HOSTS = Object.freeze([
  'iwara.tv',
  'x.com',
  'twitter.com',
  'twimg.com',
  'instagram.com',
  'cdninstagram.com',
  'fbcdn.net',
  'v2ex.com',
  't.me',
  'telesco.pe',
  'e-hentai.org',
  'ehgt.org',
  'hath.network',
  'nhentai.net',
  'hitomi.la',
  'pururin.io',
  'pururin.com',
  'hanime.tv',
  'hentai.tv',
  'hentai-foundry.com',
  '8muses.com',
  'rule34.xxx',
  'gelbooru.com',
  'danbooru.donmai.us',
  'donmai.us',
  'sankakucomplex.com',
  'hiyobi.me',
  'pornhub.com',
  'phncdn.com',
  'xvideos.com',
  'xv-cdn.com',
  'missav.com',
  'missav.ai',
  'missav.ws',
  'missav.live',
  'fourhoi.com',
  'javdb.com',
  'jdbstatic.com',
  'javbus.com',
  'javbus.one',
  'jpgcdn.com',
  'mgstage.com',
  'jable.tv',
  'dmm.co.jp',
  'ggjav.com',
  'ggjav.tv',
  'airav.wiki',
  'airav.io',
  'netflav.com',
  '1024cdn.sx',
  '1025cdn.sx',
  '1026cdn.sx',
  '2024cdn.sx',
  '91porn.com',
  'cdn77.org',
  'playno1.com',
  'onlyfans.com',
  'blogspot.com',
  'bitfan.id',
  '141jav.com',
  'imgur.com',
  'i.imgur.com',
  'cdn.discordapp.com',
  'media.discordapp.net',
  'i.redd.it',
  'preview.redd.it',
  'v.redd.it',
  'external-preview.redd.it',
  'redditmedia.com',
  'ytimg.com',
  'static.flickr.com',
  'live.staticflickr.com',
  'cdn.myanimelist.net',
  's4.anilist.co',
  'image.tmdb.org',
  'media.steampowered.com',
  'i.ebayimg.com',
  'i.postimg.cc',
  'githubusercontent.com',
  'googleusercontent.com',
  'mzstatic.com',
  'm.media-amazon.com',
  'images.unsplash.com',
  'wikia.nocookie.net',
  'upload.wikimedia.org',
  'steamstatic.com',
  'scdn.co',
  'sndcdn.com',
  'cdn.telegram.org',
  'tiktok.com',
  'tiktokcdn.com',
  'tiktokcdn-us.com',
  'tiktokcdn-eu.com',
  'cloudinary.com',
  'images.weserv.nl',
  'wsrv.nl',
  'pixiv.net',
  'pximg.net',
  'sspai.com',
  'joeytoday.com',
  'share-text.org',
  'imgdd.cc',
  'hdslb.com',
  'biliimg.com',
  'sinaimg.cn',
  'zhimg.com',
  'doubanio.com',
  'music.126.net',
  'xhscdn.com',
  'linux.do',
  'ldstatic.com',
  'linuxdo.org',
  'chikubi.jp',
  'wnacg.com',
  'wnacg.org',
  'sehuatang.net',
  'uraaka-joshi.com',
  'skeb.jp',
  'imgix.net',
  'kemono.su',
  'kemono.party',
  'kemono.cr',
  'coomer.su',
  'coomer.party',
  'coomer.st',
  'fanbox.cc',
]);

export function routeMetadata(metadata = {}) {
  const result = {};
  if (metadata?.egressScope !== undefined) {
    if (!EGRESS_SCOPES.has(metadata.egressScope)) throw new Error('unsupported egress scope');
    result.egressScope = metadata.egressScope;
  }
  if (metadata?.source !== undefined) {
    const source = String(metadata.source).trim().toLowerCase();
    if (!/^[a-z][a-z0-9_-]{0,31}$/.test(source)) throw new Error('unsupported route source');
    result.source = source;
  }
  return result;
}

export function isAllowedTarget(value, allowedHosts = ALLOWED_HOSTS) {
  let target;
  try {
    target = value instanceof URL ? value : new URL(value);
  } catch {
    return false;
  }
  // 白名单内的站点允许 http（个别源站仅提供 http，如 playno1.com）；
  // 白名单本身即是 SSRF 闸门，非白名单主机无论协议一律拒绝。
  if ((target.protocol !== 'https:' && target.protocol !== 'http:') || target.username || target.password) {
    return false;
  }
  if (/^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/.test(target.hostname) || target.hostname.includes(':')) {
    return false;
  }
  const hostname = target.hostname.toLowerCase();
  const isHathHost = isHostOrSubdomain(hostname, 'hath.network');
  const isHathMedia = isHathHost
    && (target.pathname.startsWith('/h/') || target.pathname.startsWith('/om/') || /^\/c\d+\//.test(target.pathname));
  const isHathPortMedia = isHathHost
    && (target.pathname.startsWith('/h/') || target.pathname.startsWith('/om/'));
  const port = Number.parseInt(target.port, 10);
  const isValidHathMediaPort = !target.port || (isHathPortMedia && Number.isInteger(port) && port >= 1024 && port <= 65535);
  if ((isHathHost && !isHathMedia) || (target.port && !isValidHathMediaPort)) {
    return false;
  }
  return matchesHost(hostname, allowedHosts);
}

export function isTargetSignatureValid(token, secret) {
  const [payload, signature] = String(token || '').split('.');
  if (!payload || !signature || !secret) return false;
  return isSignatureMatch(signature, hmacSha256(payload, secret));
}

export function createSignedTarget(url, secret, ttlSeconds = DEFAULT_TTL_SECONDS, now = Math.floor(Date.now() / 1000), metadata = {}) {
  const target = new URL(url);
  if (!isAllowedTarget(target)) {
    throw new Error('target host is not allowed');
  }
  const payload = base64UrlEncode(JSON.stringify({ url: target.toString(), exp: now + ttlSeconds, ...routeMetadata(metadata) }));
  const signature = hmacSha256(payload, secret, 'base64url');
  return `${payload}.${signature}`;
}

export function createMediaSignedTarget(url, secret, now = Math.floor(Date.now() / 1000), metadata = {}) {
  const expiresAt = (Math.floor(now / MEDIA_CACHE_TTL_SECONDS) + 1) * MEDIA_CACHE_TTL_SECONDS;
  return createSignedTarget(url, secret, expiresAt - now, now, metadata);
}

export function verifySignedTarget(token, secret, now = Math.floor(Date.now() / 1000)) {
  const [payload, signature] = String(token).split('.');
  if (!payload || !signature) {
    throw new Error('malformed target token');
  }
  if (!isSignatureMatch(signature, hmacSha256(payload, secret))) {
    throw new Error('invalid target signature');
  }
  const data = safeJsonParse(base64UrlDecode(payload), null);
  if (!data || typeof data !== 'object'
    || Object.keys(data).some((key) => !['url', 'exp', 'egressScope', 'source'].includes(key))
    || !Number.isInteger(data.exp) || data.exp <= now || !isAllowedTarget(data.url)) {
    throw new Error('target expired or disallowed');
  }
  return { url: new URL(data.url).toString(), exp: data.exp, ...routeMetadata(data) };
}

export function signedGatewayUrl(baseUrl, kind, target, opts = {}, extraSignedMetadata) {
  let secret;
  let ttlSeconds = DEFAULT_TTL_SECONDS;
  let now = Math.floor(Date.now() / 1000);
  let signedTargetMetadata = extraSignedMetadata;
  if (typeof opts === 'string') {
    secret = opts;
  } else if (opts && typeof opts === 'object') {
    secret = opts.secret;
    if (opts.ttlSeconds !== undefined) ttlSeconds = opts.ttlSeconds;
    if (opts.now !== undefined) now = opts.now;
    if (opts.signedTargetMetadata !== undefined) signedTargetMetadata = opts.signedTargetMetadata;
  }
  if (!isAllowedTarget(target)) return String(target ?? '');
  const token = kind === 'media'
    ? createMediaSignedTarget(target, secret, now, signedTargetMetadata)
    : createSignedTarget(target, secret, ttlSeconds, now, signedTargetMetadata);
  return `${String(baseUrl || '').replace(/\/$/, '')}/_gateway/${kind}/${token}`;
}

export function resolveGatewayUrl(baseUrl, kind, value, sourceUrl, opts, extraSignedMetadata) {
  if (!value) return '';
  try {
    const target = new URL(value, sourceUrl);
    return signedGatewayUrl(baseUrl, kind, target.toString(), opts, extraSignedMetadata);
  } catch {
    return '';
  }
}

export function matchesFeedFilters(item = {}, filters = {}) {
  if (!filters || typeof filters !== 'object' || !item || typeof item !== 'object') return false;
  const { title = '', description = '', author = '' } = item;
  if (Array.isArray(filters.keywordBlacklist) && filters.keywordBlacklist.length > 0) {
    const t = String(title || '').toLowerCase();
    const d = String(description || '').toLowerCase();
    for (const rawKw of filters.keywordBlacklist) {
      const kw = String(rawKw || '').trim().toLowerCase();
      if (kw && (t.includes(kw) || d.includes(kw))) {
        return true;
      }
    }
  }
  if (Array.isArray(filters.authorBlacklist) && filters.authorBlacklist.length > 0) {
    const a = String(author || '').trim().toLowerCase();
    for (const rawAuthor of filters.authorBlacklist) {
      const blAuthor = String(rawAuthor || '').trim().toLowerCase();
      if (blAuthor && a === blAuthor) {
        return true;
      }
    }
  }
  return false;
}

export function rewriteFeedHtml(html, options = {}, cheerioParser) {
  if (html === null || html === undefined || typeof html !== 'string' || !html) {
    return '';
  }
  if (!cheerioParser) {
    return String(html);
  }
  const $ = cheerioParser.load(String(html), { decodeEntities: false }, false);
  $('a[href]').each((_, element) => {
    const href = $(element).attr('href');
    try {
      if (href) {
        $(element).attr('href', signedGatewayUrl(options.baseUrl, 'item', new URL(href).toString(), options));
      }
    } catch {
      // Preserve relative and malformed links in feed content.
    }
  });
  $('img,video,audio,source').each((_, element) => {
    for (const attribute of ['src', 'poster', 'data-original', 'data-src', 'data-lazy-src', 'data-lazy']) {
      const value = $(element).attr(attribute);
      if (!value) continue;
      try {
        $(element).attr(attribute, signedGatewayUrl(options.baseUrl, 'media', new URL(value).toString(), options));
      } catch {
        // Preserve relative and malformed media URLs.
      }
    }
    const srcset = $(element).attr('srcset');
    if (srcset) {
      const rewritten = String(srcset).split(',').map((candidate) => {
        const parts = candidate.trim().split(/\s+/);
        if (!parts.length) return candidate;
        try {
          parts[0] = signedGatewayUrl(options.baseUrl, 'media', new URL(parts[0]).toString(), options);
        } catch {
          // Preserve unparseable srcset candidates.
        }
        return parts.join(' ');
      }).join(', ');
      $(element).attr('srcset', rewritten);
    }
  });
  return $.root().html() ?? '';
}

export const DEFAULT_PAGE_STATE_DEFERRED = 'deferred';
export const DEFAULT_PAGE_STATE_RESOLVED = 'resolved';
export const DEFAULT_FIRST_DETAIL_BUDGET_MS = 1_200;

export function createInitialReaderManifest({ imageUrls = [], maxPages = imageUrls.length } = {}) {
  const unique = dedupe(imageUrls).slice(0, Math.max(Number(maxPages) || 0, 0));
  return {
    pages: unique.map((mediaTarget, index) => ({
      pageNumber: index + 1,
      detailTarget: mediaTarget,
      mediaTarget,
      state: DEFAULT_PAGE_STATE_DEFERRED,
    })),
    totalPages: unique.length,
    complete: false,
  };
}

export function mergeResolvedPage(manifest, page) {
  if (!manifest || !Array.isArray(manifest.pages) || !page) return manifest;
  const pages = manifest.pages.map((candidate) => {
    if (candidate.pageNumber !== page.pageNumber || candidate.detailTarget !== page.detailTarget) return candidate;
    return { ...candidate, mediaTarget: page.mediaTarget, state: DEFAULT_PAGE_STATE_RESOLVED };
  });
  return { ...manifest, pages };
}

export function isManifestComplete(manifest) {
  if (!manifest || !Array.isArray(manifest.pages) || manifest.pages.length === 0) return false;
  return manifest.pages.every((page) => page.state === DEFAULT_PAGE_STATE_RESOLVED);
}

export const withForegroundDeadline = withDeadline;

export const DEFAULT_UPSTREAM_ERROR_STATUS = 502;
export const DEFAULT_UPSTREAM_SOURCE = 'unknown';
export const DEFAULT_UPSTREAM_PROXY = 'http://127.0.0.1:7890';
export const DEFAULT_UPSTREAM_TIMEOUT = 30_000;
export const DEFAULT_UPSTREAM_MAX_ATTEMPTS = 3;
export const DEFAULT_MAX_REDIRECTS = 5;

export function parseRetryAfter(response, defaultMax = 60) {
  const value = response?.headers?.get?.('retry-after') ?? response?.headers?.['retry-after'];
  if (value === null || value === undefined || value === '') return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? clamp(parsed, 0, defaultMax) : undefined;
}

export function upstreamRetryDelay(attempt, first = 250, rest = 750) {
  return attempt === 1 ? first : rest;
}

export function responseWithLease(response, lease) {
  if (!lease) return response;
  let released = false;
  const release = (result = {}) => {
    if (released) return;
    released = true;
    lease.release({ status: response.status, ...result });
  };
  if (!response.body) {
    release();
    return response;
  }
  const reader = response.body.getReader();
  const body = new ReadableStream({
    async pull(controller) {
      try {
        const item = await reader.read();
        if (item.done) {
          release();
          controller.close();
          return;
        }
        controller.enqueue(item.value);
      } catch (error) {
        release({ error });
        controller.error(error);
      }
    },
    async cancel(reason) {
      await reader.cancel(reason).catch(() => {});
      release({ error: reason });
    },
  });
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

export class GatewayUpstreamError extends Error {
  constructor(message, { code, source = DEFAULT_UPSTREAM_SOURCE, status = DEFAULT_UPSTREAM_ERROR_STATUS, attempts = 0, retryAfter } = {}) {
    super(message);
    this.name = 'GatewayUpstreamError';
    this.code = code;
    this.source = source;
    this.status = status;
    this.attempts = attempts;
    if (retryAfter !== undefined) this.retryAfter = retryAfter;
  }
}

export const DEFAULT_FAILURE_THRESHOLD = 3;
export const DEFAULT_COOLDOWN_MS = 30_000;

export const CIRCUIT_STATE_CLOSED = 'closed';
export const CIRCUIT_STATE_OPEN = 'open';
export const CIRCUIT_STATE_HALF_OPEN = 'half-open';

export class CircuitBreaker {
  constructor({ failureThreshold = DEFAULT_FAILURE_THRESHOLD, cooldownMs = DEFAULT_COOLDOWN_MS, now = () => Date.now() } = {}) {
    this.failureThreshold = failureThreshold;
    this.cooldownMs = cooldownMs;
    this.now = now;
    this.entries = new Map();
  }

  state(key) {
    const entry = this.entries.get(key);
    if (!entry) return CIRCUIT_STATE_CLOSED;
    if (entry.state === CIRCUIT_STATE_OPEN && this.now() - entry.openedAt >= this.cooldownMs) return CIRCUIT_STATE_HALF_OPEN;
    return entry.state;
  }

  canRequest(key) {
    const entry = this.entries.get(key);
    if (!entry || entry.state === CIRCUIT_STATE_CLOSED) return true;
    if (entry.state === CIRCUIT_STATE_OPEN) {
      if (this.now() - entry.openedAt < this.cooldownMs) return false;
      entry.state = CIRCUIT_STATE_HALF_OPEN;
      entry.probeInFlight = true;
      return true;
    }
    return !entry.probeInFlight;
  }

  recordFailure(key) {
    const entry = this.entries.get(key) || { state: CIRCUIT_STATE_CLOSED, failures: 0, openedAt: 0, probeInFlight: false };
    entry.failures += 1;
    entry.probeInFlight = false;
    if (entry.state === CIRCUIT_STATE_HALF_OPEN || entry.failures >= this.failureThreshold) {
      entry.state = CIRCUIT_STATE_OPEN;
      entry.openedAt = this.now();
    }
    this.entries.set(key, entry);
  }

  recordSuccess(key) {
    this.entries.delete(key);
  }

  openKeys() {
    return [...this.entries.entries()]
      .filter(([key, entry]) => this.state(key) === CIRCUIT_STATE_OPEN)
      .map(([key]) => key)
      .sort();
  }

  clearAll() {
    this.entries.clear();
  }

  stats() {
    const byState = { [CIRCUIT_STATE_CLOSED]: 0, [CIRCUIT_STATE_OPEN]: 0, [CIRCUIT_STATE_HALF_OPEN]: 0 };
    for (const [key, entry] of this.entries.entries()) {
      byState[this.state(key)] += 1;
    }
    return { byState, open: byState[CIRCUIT_STATE_OPEN], openKeys: this.openKeys() };
  }
}

export const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10_000;
export const DEFAULT_SIGNALS = Object.freeze(['SIGTERM', 'SIGINT']);

export function stopAcceptingServers(servers = []) {
  for (const server of servers) {
    if (!server) continue;
    try {
      server.close?.();
    } catch {
      // The server may already be closed; draining continues regardless.
    }
    if (typeof server.closeIdleConnections === 'function') {
      server.closeIdleConnections();
    }
  }
}

export function drainServers(servers = []) {
  return Promise.all(servers.map((server) => new Promise((resolve) => {
    if (!server || typeof server.close !== 'function' || server.listening === false) {
      resolve();
      return;
    }
    server.once('close', resolve);
  })));
}

export function installGracefulShutdown({
  servers = [],
  timeoutMs = DEFAULT_SHUTDOWN_TIMEOUT_MS,
  signals = DEFAULT_SIGNALS,
  logger = { info() {}, warn() {}, error() {} },
  exitImpl = (code) => process.exit(code),
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
} = {}) {
  let draining = false;

  function shutdown(signal = 'SIGTERM') {
    if (draining) return false;
    draining = true;
    logger?.info?.('shutdown_draining', { signal, timeoutMs });
    stopAcceptingServers(servers);
    const force = setTimeoutImpl(() => {
      logger?.warn?.('shutdown_timeout', { timeoutMs });
      exitImpl(1);
    }, timeoutMs);
    if (force?.unref) force.unref();
    void drainServers(servers).then(() => {
      clearTimeoutImpl(force);
      logger?.info?.('shutdown_drained');
      exitImpl(0);
    });
    return true;
  }

  const handlers = new Map();
  for (const signal of signals) {
    const handler = () => shutdown(signal);
    process.on(signal, handler);
    handlers.set(signal, handler);
  }

  return {
    isDraining: () => draining,
    serverCount: () => servers.filter(Boolean).length,
    shutdown,
    dispose: () => {
      for (const [signal, handler] of handlers) {
        process.removeListener(signal, handler);
      }
      handlers.clear();
    },
  };
}

export const DEFAULT_FETCHD_BASE_URL = 'http://127.0.0.1:7899';
export const DEFAULT_FETCHD_TIMEOUT_MS = 20_000;
export const MAX_FETCHD_TIMEOUT_MS = 65_000;
export const FETCHD_TIMEOUT_SLACK_MS = 5_000;

export function createFetchdClient({
  baseUrl = process.env.IWARA_FETCHD_URL || DEFAULT_FETCHD_BASE_URL,
  fetchImpl = fetch,
} = {}) {
  const endpoint = `${String(baseUrl).replace(/\/$/, '')}/fetch`;
  return async function fetchdFetch(url, {
    method = 'GET',
    headers = {},
    body,
    timeout = DEFAULT_FETCHD_TIMEOUT_MS,
  } = {}) {
    let response;
    let payload;
    try {
      response = await fetchImpl(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url, method, headers, body, timeout }),
        signal: AbortSignal.timeout(Math.min(timeout + FETCHD_TIMEOUT_SLACK_MS, MAX_FETCHD_TIMEOUT_MS)),
      });
      payload = await response.json();
    } catch (error) {
      throw new GatewayUpstreamError(`browser fetch unavailable: ${error.message}`, {
        code: 'FETCHD_UNAVAILABLE',
        source: 'fetchd',
        status: 502,
        attempts: 1,
      });
    }
    if (!response.ok || payload.error) {
      throw new GatewayUpstreamError(payload.error || `browser fetch returned ${response.status}`, {
        code: 'FETCHD_ERROR',
        source: 'fetchd',
        status: 502,
        attempts: 1,
      });
    }
    const bodyBuffer = payload.body ? Buffer.from(payload.body, 'base64') : Buffer.alloc(0);
    return {
      status: Number(payload.status) || 502,
      headers: new Headers(payload.headers || {}),
      body: bodyBuffer,
      ok: Number(payload.status) >= 200 && Number(payload.status) < 300,
      json: async () => JSON.parse(bodyBuffer.toString('utf8')),
      text: async () => bodyBuffer.toString('utf8'),
    };
  };
}

export async function fetchdJson(fetchdFetch, url, {
  method = 'GET',
  headers = {},
  body,
  timeout = 20_000,
} = {}) {
  const response = await fetchdFetch(url, { method, headers, body, timeout });
  if (!response.ok) {
    throw new GatewayUpstreamError(`upstream returned ${response.status}`, {
      code: 'UPSTREAM_RETRYABLE_STATUS',
      source: new URL(url).hostname,
      status: response.status,
      attempts: 1,
    });
  }
  return response.json();
}

export const DEFAULT_SITE_FAILURE_THRESHOLD = 3;
export const DEFAULT_SITE_FAILURE_WINDOW_MS = 60_000;

export function failureKey(laneId, host) {
  return `${String(laneId)}\n${String(host).toLowerCase()}`;
}

export function createSiteFailureTracker({
  threshold = DEFAULT_SITE_FAILURE_THRESHOLD,
  windowMs = DEFAULT_SITE_FAILURE_WINDOW_MS,
  now = () => Date.now(),
} = {}) {
  const states = new Map();

  function key(laneId, host) {
    return failureKey(laneId, host);
  }

  function record(laneId, host, status) {
    const k = key(laneId, host);
    const current = now();
    let state = states.get(k);
    if (!state || current - state.lastAt > windowMs) {
      state = { count: 0, firstAt: current, lastAt: current, trippedAt: undefined };
      states.set(k, state);
    }
    state.lastAt = current;
    state.count += 1;
    if (state.count >= threshold && state.count % threshold === 0) {
      state.trippedAt = current;
      return true;
    }
    return false;
  }

  function reset(laneId, host) {
    states.delete(key(laneId, host));
  }

  function blocked(laneId, host) {
    return Boolean(states.get(key(laneId, host))?.trippedAt !== undefined);
  }

  function stats() {
    const cutoff = now() - windowMs;
    return [...states.entries()]
      .filter(([, state]) => state.trippedAt !== undefined || state.lastAt >= cutoff)
      .map(([k, state]) => {
        const [laneId, host] = k.split('\n');
        return { laneId, host, count: state.count, trippedAt: state.trippedAt || null };
      });
  }

  function clearAll() {
    states.clear();
  }

  return { record, reset, clearAll, blocked, stats };
}

export const MIN_CHUNK_SIZE = 256 * 1024;
export const MAX_CHUNK_SIZE = 16 * 1024 * 1024;
export const MAX_CHUNKS = 256;
export const DEFAULT_TARGET_SECONDS = 10;

export function sizeTier(totalBytes) {
  if (totalBytes <= 64 * 1024 * 1024) return 1024 * 1024;
  if (totalBytes <= 512 * 1024 * 1024) return 4 * 1024 * 1024;
  if (totalBytes <= 2 * 1024 ** 3) return 8 * 1024 * 1024;
  return MAX_CHUNK_SIZE;
}

export function adaptiveChunkSize(totalBytes, {
  min = MIN_CHUNK_SIZE,
  max = MAX_CHUNK_SIZE,
  bytesPerSecond,
  targetSeconds = DEFAULT_TARGET_SECONDS,
} = {}) {
  if (!Number.isSafeInteger(totalBytes) || totalBytes <= 0) return min;
  let size = sizeTier(totalBytes);
  if (Number.isFinite(bytesPerSecond) && bytesPerSecond > 0) {
    const bandwidthSize = bytesPerSecond * Math.max(1, Number(targetSeconds) || DEFAULT_TARGET_SECONDS);
    size = Math.min(size, bandwidthSize);
  }
  return Math.min(max, Math.max(min, align64k(size)));
}

export function chunkSizeFor(totalBytes, chunks, {
  min = MIN_CHUNK_SIZE,
  max = MAX_CHUNK_SIZE,
  bytesPerSecond,
  targetSeconds,
  maxChunks = MAX_CHUNKS,
} = {}) {
  if (!Number.isSafeInteger(totalBytes) || totalBytes <= 0) {
    return { count: 1, size: Math.max(min, MIN_CHUNK_SIZE) };
  }
  const preferred = adaptiveChunkSize(totalBytes, { min, max, bytesPerSecond, targetSeconds });
  const naturalCount = Math.max(1, Math.ceil(totalBytes / preferred));
  const requested = Number.isInteger(chunks) && chunks >= 1 ? Math.min(chunks, maxChunks) : 0;
  const minimumCoveringCount = Math.max(1, Math.ceil(totalBytes / max));
  let count = requested > 0 ? Math.max(requested, minimumCoveringCount) : naturalCount;
  count = Math.min(count, Math.ceil(totalBytes / min));
  const size = Math.min(max, Math.max(min, align64k(totalBytes / count)));
  return { count, size };
}

export function planChunks(totalBytes, {
  chunkSize,
  chunks,
  min = MIN_CHUNK_SIZE,
  max = MAX_CHUNK_SIZE,
  bytesPerSecond,
  targetSeconds,
} = {}) {
  const safeTotal = Number.isSafeInteger(totalBytes) && totalBytes > 0 ? totalBytes : 0;
  if (safeTotal === 0) return [];
  const plan = chunkSizeFor(safeTotal, chunks, { min, max, bytesPerSecond, targetSeconds });
  const effectiveSize = Number.isInteger(chunkSize) && chunkSize > 0 ? chunkSize : plan.size;
  const list = [];
  let index = 0;
  for (let offset = 0; offset < safeTotal; offset += effectiveSize) {
    const end = Math.min(offset + effectiveSize - 1, safeTotal - 1);
    list.push({
      index,
      start: offset,
      end,
      size: end - offset + 1,
    });
    index += 1;
  }
  return list;
}

export const REDACT_KEYS = new Set([
  'authorization',
  'cookie',
  'token',
  'password',
  'secret',
  'proxyurl',
  'username',
  'credentials',
]);

export const REDACT_VALUE = '[redacted]';

export function redactValue(key, value) {
  const normalized = String(key).toLowerCase();
  if (REDACT_KEYS.has(normalized)) return REDACT_VALUE;
  if (normalized.includes('token') || normalized.includes('password') || normalized.includes('secret')) return REDACT_VALUE;
  if (typeof value === 'string' && /(bearer\s+[a-z0-9._-]+|basic\s+[a-z0-9+/=]+|cookie\s*[:=][^;]+)/i.test(value)) {
    return value.replace(/(bearer\s+)[a-z0-9._-]+/gi, '$1[redacted]')
      .replace(/(basic\s+)[a-z0-9+/=]+/gi, '$1[redacted]')
      .replace(/(cookie\s*[:=]\s*)[^;]+/gi, '$1[redacted]');
  }
  return value;
}

export function redactFields(fields) {
  const output = {};
  for (const [key, value] of Object.entries(fields || {})) {
    output[key] = redactValue(key, value);
  }
  return output;
}

export const LOG_LEVELS = Object.freeze({ debug: 10, info: 20, warn: 30, error: 40 });
export const DEFAULT_LOG_LEVEL = 'info';

export function createNoopLogger() {
  const noop = () => {};
  return {
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    child: () => createNoopLogger(),
    sink: noop,
    threshold: 100,
  };
}

export function createLogger({
  level = process.env.GATEWAY_LOG_LEVEL || DEFAULT_LOG_LEVEL,
  sink = (line) => process.stdout.write(`${line}\n`),
  redact = true,
  now = () => Date.now(),
} = {}) {
  const levels = LOG_LEVELS;
  const threshold = levels[level] ?? levels.info;

  function write(event, fields = {}, levelName = 'info') {
    if ((levels[levelName] ?? levels.info) < threshold) return;
    const payload = {
      event,
      level: levelName,
      ts: new Date(now()).toISOString(),
      ...(redact ? redactFields(fields) : fields),
    };
    try {
      sink(JSON.stringify(payload));
    } catch {
      // Logging must never break request handling.
    }
  }

  function child(context = {}) {
    return {
      debug: (event, fields = {}) => write(event, { ...context, ...fields }, 'debug'),
      info: (event, fields = {}) => write(event, { ...context, ...fields }, 'info'),
      warn: (event, fields = {}) => write(event, { ...context, ...fields }, 'warn'),
      error: (event, fields = {}) => write(event, { ...context, ...fields }, 'error'),
    };
  }

  return {
    debug: (event, fields) => write(event, fields, 'debug'),
    info: (event, fields) => write(event, fields, 'info'),
    warn: (event, fields) => write(event, fields, 'warn'),
    error: (event, fields) => write(event, fields, 'error'),
    child,
    sink,
    threshold,
  };
}

export const DEFAULT_PUBLIC_HOSTS = Object.freeze([
  'e-hentai.org',
  'ehgt.org',
  'hath.network',
  'nhentai.net',
  'hitomi.la',
  'pururin.io',
  'pururin.com',
  'hanime.tv',
  'hentai.tv',
  'hentai-foundry.com',
  '8muses.com',
  'rule34.xxx',
  'gelbooru.com',
  'donmai.us',
  'sankakucomplex.com',
  'hiyobi.me',
  'pornhub.com',
  'phncdn.com',
  'xvideos.com',
  'xv-cdn.com',
  'missav.com',
  'missav.ai',
  'missav.ws',
  'fourhoi.com',
  'javdb.com',
  'jdbstatic.com',
  'javbus.com',
  'javbus.one',
  'jpgcdn.com',
  'mgstage.com',
  'jable.tv',
  'dmm.co.jp',
  'ggjav.com',
  'ggjav.tv',
  'airav.wiki',
  'airav.io',
  'netflav.com',
  '1024cdn.sx',
  '1025cdn.sx',
  '1026cdn.sx',
  '2024cdn.sx',
  '91porn.com',
  'cdn77.org',
  'playno1.com',
  'onlyfans.com',
  'blogspot.com',
  'bitfan.id',
  '141jav.com',
]);

export const DEFAULT_PUBLIC_REQUEST_HOSTS = Object.freeze([
  ...DEFAULT_PUBLIC_HOSTS,
  'iwara.tv',
  't.me',
  'telesco.pe',
  'x.com',
  'twitter.com',
  'twimg.com',
  'instagram.com',
  'cdninstagram.com',
  'fbcdn.net',
  'danbooru.donmai.us',
  'pixiv.net',
  'pximg.net',
]);

export const EGRESS_POLICIES = Object.freeze({
  PUBLIC: 'public',
  STICKY: 'sticky',
});

export function resolveEgressPublicHosts(envValue, fallback = DEFAULT_PUBLIC_HOSTS) {
  return Object.freeze(dedupe([
    ...fallback,
    ...parseHostList(envValue),
  ]));
}

export function resolveEgressPublicRequestHosts(envRequestValue, envPublicValue, fallback = DEFAULT_PUBLIC_REQUEST_HOSTS) {
  return Object.freeze(dedupe([
    ...fallback,
    ...parseHostList(envRequestValue),
    ...parseHostList(envPublicValue),
  ]));
}

export function isPublicEgressTarget(value, publicHosts = DEFAULT_PUBLIC_HOSTS) {
  const hostname = safeHost(value, '');
  return Boolean(hostname) && matchesHost(hostname, publicHosts);
}

export function isPublicRequestTarget(value, publicRequestHosts = DEFAULT_PUBLIC_REQUEST_HOSTS) {
  const hostname = safeHost(value, '');
  return Boolean(hostname) && matchesHost(hostname, publicRequestHosts);
}

export function egressPolicyForUrl(value, publicHosts = DEFAULT_PUBLIC_HOSTS) {
  return isPublicEgressTarget(value, publicHosts) ? EGRESS_POLICIES.PUBLIC : EGRESS_POLICIES.STICKY;
}

export function egressPolicyForRequest(value, { scope = 'auto', publicHosts = DEFAULT_PUBLIC_HOSTS, publicRequestHosts = DEFAULT_PUBLIC_REQUEST_HOSTS } = {}) {
  if (scope === 'session' || scope === 'sticky') return EGRESS_POLICIES.STICKY;
  if (scope === 'public' && isPublicRequestTarget(value, publicRequestHosts)) return EGRESS_POLICIES.PUBLIC;
  return egressPolicyForUrl(value, publicHosts);
}

export const DEFAULT_RESUMABLE_MAX_ATTEMPTS = 3;
export const DEFAULT_RESUMABLE_BACKOFF_MS = 100;

export function isResumableStatus(status) {
  return Number.isInteger(status) && (status === 200 || status === 206);
}

export function pipeAttempt(stream, res, onBytes, onAbort) {
  return new Promise((resolve) => {
    let bytes = 0;
    let pending = 0;
    let sourceDone = false;
    let paused = false;
    let error = null;

    const settle = () => {
      if (sourceDone && pending === 0) {
        res.off?.('drain', onDrain);
        cleanupListeners();
        resolve({ bytes, error });
      }
    };

    const onDrain = () => {
      if (paused) {
        paused = false;
        stream.resume();
      }
    };

    const finish = (err) => {
      if (sourceDone) return;
      sourceDone = true;
      if (err) error = err;
      settle();
    };

    res.on?.('drain', onDrain);
    stream.on('end', () => finish());
    stream.on('error', (err) => finish(err));
    stream.on('aborted', () => finish(new Error('upstream stream aborted')));
    const onClientClose = () => {
      finish(new Error('client response closed'));
      stream.destroy();
      onAbort?.();
    };
    res.on?.('close', onClientClose);
    const cleanupListeners = () => {
      res.off?.('close', onClientClose);
    };
    stream.on('data', (chunk) => {
      if (res.destroyed || res.writableEnded) {
        onClientClose();
        return;
      }
      pending += 1;
      let counted = false;
      const writable = res.write(chunk, (writeError) => {
        pending -= 1;
        if (writeError) {
          if (!error) error = writeError;
        } else if (!counted) {
          counted = true;
          bytes += chunk.length;
          onBytes?.(bytes);
        }
        settle();
      });
      if (!writable) {
        paused = true;
        stream.pause();
      }
    });
    stream.resume();
  });
}

export async function pumpResumableRange({
  response,
  fetchRange,
  res,
  start,
  end,
  maxAttempts = DEFAULT_RESUMABLE_MAX_ATTEMPTS,
  backoffMs = DEFAULT_RESUMABLE_BACKOFF_MS,
  onBytes,
  onResume,
  onComplete,
  onTruncated,
} = {}) {
  const expectedBytes = end - start + 1;
  let current = response;
  let written = 0;
  let resumed = 0;
  let fetches = 1;
  let attempt = 0;

  while (written < expectedBytes && !res.destroyed && !res.writableEnded) {
    if (attempt > 0) {
      if (fetches >= maxAttempts) break;
      await sleep(backoffMs * attempt);
      let next;
      try {
        next = await fetchRange(`bytes=${start + written}-${end}`);
      } catch {
        next = null;
      }
      fetches += 1;
      if (!next?.ok || !next?.body) {
        attempt += 1;
        continue;
      }
      current = next;
      resumed += 1;
      onResume?.(written, attempt);
    }
    if (!current?.body) break;
    const stream = Readable.fromWeb(current.body);
    const { bytes, error } = await pipeAttempt(stream, res, (n) => onBytes?.(written + n), () => {
      stream.destroy();
      current.body?.cancel?.().catch(() => {});
    });
    written += bytes;
    attempt += 1;
    if (written >= expectedBytes) break;
  }

  if (written >= expectedBytes && !res.writableEnded) {
    onComplete?.({ written, resumed });
    res.end?.();
  } else if (!res.destroyed && !res.writableEnded) {
    onTruncated?.({ written, resumed });
    res.destroy?.();
  }
  return { written, resumed };
}

export const DEFAULT_RENDER_URL = '';
export const DEFAULT_RENDER_TIMEOUT_MS = 30_000;
export const MIN_RENDER_TIMEOUT_MS = 5_000;
export const RENDER_HEALTH_TIMEOUT_MS = 3_000;
export const RENDER_BUFFER_TIMEOUT_MS = 10_000;

export function createBrowserRenderClient({
  renderUrl = DEFAULT_RENDER_URL,
  fetchImpl = fetch,
  defaultTimeoutMs = DEFAULT_RENDER_TIMEOUT_MS,
} = {}) {
  async function fetchRenderedHtml(url, { timeoutMs } = {}) {
    const base = String(renderUrl || '').replace(/\/$/, '');
    if (!base) return null;
    const budget = Math.max(MIN_RENDER_TIMEOUT_MS, Number(timeoutMs) || defaultTimeoutMs);
    let response;
    try {
      response = await fetchImpl(`${base}/render`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: String(url), timeoutMs: budget }),
        signal: AbortSignal.timeout(budget + RENDER_BUFFER_TIMEOUT_MS),
      });
    } catch {
      return null;
    }
    if (!response.ok) return null;
    let payload;
    try {
      payload = await response.json();
    } catch {
      return null;
    }
    if (typeof payload?.html !== 'string') return null;
    return {
      html: payload.html,
      finalUrl: String(payload.finalUrl || url),
      status: Number(payload.status) || 200,
    };
  }

  async function health() {
    const base = String(renderUrl || '').replace(/\/$/, '');
    if (!base) return { ok: false, renderUrl: '' };
    try {
      const response = await fetchImpl(`${base}/healthz`, { signal: AbortSignal.timeout(RENDER_HEALTH_TIMEOUT_MS) });
      return { ok: response.ok, renderUrl: base };
    } catch {
      return { ok: false, renderUrl: base };
    }
  }

  return { fetchRenderedHtml, health };
}

export const DEFAULT_PYTHON_BIN = 'python3';
export const DEFAULT_IMPERSONATE = 'chrome131';
export const DEFAULT_MAX_BODY = 4 * 1024 * 1024;
export const DEFAULT_REQUEST_TIMEOUT_MS = 20_000;
export const MAX_REQUEST_TIMEOUT_MS = 65_000;
export const REQUEST_TIMEOUT_SLACK_MS = 5_000;

export function buildBrowserFetchPayload(url, {
  method = 'GET',
  headers = {},
  body,
  timeout = 20_000,
  impersonate: requestImpersonate,
  redirect,
  proxy,
  maxBody: requestMaxBody,
} = {}, defaultImpersonate = DEFAULT_IMPERSONATE, defaultMaxBody = DEFAULT_MAX_BODY) {
  const payload = {
    url: String(url),
    method,
    headers: Object.fromEntries(
      Object.entries(headers || {}).map(([name, value]) => [String(name), String(value)]),
    ),
    timeout,
    maxBody: requestMaxBody || defaultMaxBody,
  };
  if (body !== undefined) payload.body = typeof body === 'string' ? body : String(body);
  if (requestImpersonate) payload.impersonate = requestImpersonate;
  else payload.impersonate = defaultImpersonate;
  if (redirect) payload.redirect = redirect;
  if (proxy) payload.proxy = proxy;
  return payload;
}

export function browserFetchLineError(message, { code = 'FETCHD_UNAVAILABLE', status = 502 } = {}) {
  return new GatewayUpstreamError(message, { code, source: 'fetchd', status, attempts: 1 });
}

export function browserRequestTimeoutMs(timeout) {
  return Math.min(
    Number.isFinite(timeout) ? timeout + REQUEST_TIMEOUT_SLACK_MS : DEFAULT_REQUEST_TIMEOUT_MS + REQUEST_TIMEOUT_SLACK_MS,
    MAX_REQUEST_TIMEOUT_MS,
  );
}

export function messageToResponse(message) {
  const body = message?.body ? Buffer.from(message.body, 'base64') : Buffer.alloc(0);
  return {
    status: Number(message?.status) || 502,
    headers: new Headers(message?.headers || {}),
    body,
    ok: Number(message?.status) >= 200 && Number(message?.status) < 300,
    json: async () => JSON.parse(body.toString('utf8')),
    text: async () => body.toString('utf8'),
  };
}

export const DEFAULT_LEASE_BACKFILL_MAX_CONCURRENCY = 2;
export const DEFAULT_LEASE_BACKFILL_EVICTION_BUDGET = 128 * 1024 ** 2;
export const DEFAULT_LEASE_BACKFILL_VIDEO_CACHE_MAX_FILE_BYTES = 256 * 1024 ** 2;

export const DEFAULT_EGRESS_CONTROLLER_URL = 'http://127.0.0.1:9090';
export const DEFAULT_EGRESS_LISTENER_BASE_URL = 'http://127.0.0.1';
export const DEFAULT_EGRESS_LANE_COUNT = 12;
export const DEFAULT_EGRESS_SESSION_LANE_COUNT = 12;
export const DEFAULT_EGRESS_SESSION_LISTENER_BASE_PORT = 7921;
export const DEFAULT_EGRESS_PROBE_TIMEOUT_MS = 5_000;
export const DEFAULT_EGRESS_PROBE_CACHE_MS = 5 * 60_000;
export const EGRESS_PUBLIC_GROUP = 'PUBLIC';
export const EGRESS_GROUP_TYPES = new Set(['Selector', 'URLTest', 'Fallback', 'LoadBalance', 'Relay', 'Compatible', 'URLTest']);
export const EGRESS_RESERVED_NAMES = new Set(['DIRECT', 'REJECT', 'GLOBAL', 'PASS']);

export function createLeaseBackfillQueue({
  mediaTransport,
  fetchExternal,
  resolveMediaUrl = async () => null,
  leaseStore,
  cache,
  isVideoTarget = () => false,
  probeSize,
  maxConcurrency = DEFAULT_LEASE_BACKFILL_MAX_CONCURRENCY,
  evictionBudget = DEFAULT_LEASE_BACKFILL_EVICTION_BUDGET,
  videoCacheMaxFileBytes = DEFAULT_LEASE_BACKFILL_VIDEO_CACHE_MAX_FILE_BYTES,
  logger = { info() {}, warn() {}, error() {} },
} = {}) {
  const limit = boundedInteger(maxConcurrency, DEFAULT_LEASE_BACKFILL_MAX_CONCURRENCY, 0, 8);
  const active = new Map();
  const stops = new Map();
  const stats = { running: 0, completed: 0, failed: 0, skipped: 0, bytesFilled: 0 };
  let running = 0;

  function sizeFor(lease) {
    if (typeof probeSize === 'function') return probeSize(lease);
    if (mediaTransport?.probeSize) {
      return mediaTransport.probeSize(lease.targetUrl, { namespace: 'public' });
    }
    return null;
  }

  function cacheHeadroom() {
    return calculateCacheHeadroom(cache?.stats?.(), evictionBudget);
  }

  async function run(lease) {
    const target = String(lease.targetUrl || '');
    const stop = stops.get(target) || { stopped: false };
    let host = 'unknown';
    try {
      host = new URL(target).hostname;
    } catch {
      // Diagnostics must never fail backfill.
    }
    try {
      const size = await sizeFor(lease);
      if (!Number.isSafeInteger(size) || size <= 0) {
        stats.skipped += 1;
        logger.info('lease_backfill_skipped', { host, reason: 'unknown-size' });
        return;
      }
      const expected = Math.min(size, videoCacheMaxFileBytes);
      if (cacheHeadroom() < expected) {
        stats.skipped += 1;
        logger.info('lease_backfill_skipped', { host, reason: 'cache-full' });
        return;
      }
      const resolved = await resolveMediaUrl(target);
      if (!resolved?.url) {
        stats.skipped += 1;
        logger.info('lease_backfill_skipped', { host, reason: 'unresolved' });
        return;
      }
      mediaTransport?.rememberVideoSize?.(target, size);
      await mediaTransport.fillVideoSlices(
        target,
        resolved.url,
        size,
        'public',
        { start: 0, end: size - 1 },
        videoCacheMaxFileBytes,
        { shouldStop: () => stop.stopped },
      );
      stats.bytesFilled += expected;
      stats.completed += 1;
      logger.info('lease_backfill_completed', { host, size });
    } catch (error) {
      stats.failed += 1;
      logger.warn('lease_backfill_failed', { host, error: error.message });
    } finally {
      active.delete(target);
      stops.delete(target);
      running -= 1;
      stats.running = running;
    }
  }

  function enqueue(lease) {
    if (!lease || !isVideoTarget(lease.targetUrl) || !lease.resolvedUrl) {
      stats.skipped += 1;
      return Promise.resolve();
    }
    const target = String(lease.targetUrl || '');
    const existing = active.get(target);
    if (existing) return existing;
    if (limit > 0 && running >= limit) {
      stats.skipped += 1;
      return Promise.resolve();
    }
    if (!stops.has(target)) stops.set(target, { stopped: false, usernames: new Set() });
    const stop = stops.get(target);
    stop.usernames.add(lease.username);
    running += 1;
    stats.running = running;
    const task = run(lease);
    active.set(target, task);
    return task;
  }

  function cancel(username) {
    const name = String(username);
    for (const [target, stop] of stops) {
      stop.usernames.delete(name);
      if (!stop.usernames.size) {
        stop.stopped = true;
        stops.delete(target);
      }
    }
  }

  return {
    enqueue,
    cancel,
    stats: () => ({ ...stats }),
  };
}

export function createMihomoEgressAdapter({
  controllerUrl = DEFAULT_EGRESS_CONTROLLER_URL,
  listenerBaseUrl = DEFAULT_EGRESS_LISTENER_BASE_URL,
  laneCount = DEFAULT_EGRESS_LANE_COUNT,
  sessionLaneCount = DEFAULT_EGRESS_SESSION_LANE_COUNT,
  sessionListenerBasePort = DEFAULT_EGRESS_SESSION_LISTENER_BASE_PORT,
  fetchImpl = fetch,
  probeUrl,
  probeTargets,
  probeFetchImpl = fetch,
  probeTimeoutMs = DEFAULT_EGRESS_PROBE_TIMEOUT_MS,
  probeCacheMs = DEFAULT_EGRESS_PROBE_CACHE_MS,
  now = () => Date.now(),
  onEvent,
  ProxyAgentImpl,
} = {}) {
  const Agent = ProxyAgentImpl;
  const controller = String(controllerUrl).replace(/\/$/, '');
  const lanesLimit = positiveInteger(laneCount, DEFAULT_EGRESS_LANE_COUNT);
  const sessionLanesLimit = positiveInteger(sessionLaneCount, DEFAULT_EGRESS_SESSION_LANE_COUNT);
  const sessionPort = boundedInteger(sessionListenerBasePort, DEFAULT_EGRESS_SESSION_LISTENER_BASE_PORT, 1, 65_535);
  const sourceProbeUrl = String(probeUrl || '').trim();
  const sourceProbeTargets = normalizeProbeTargets(probeTargets, sourceProbeUrl);
  const PROBE_SCOPES = ['public', 'sticky'].filter((scope) => (sourceProbeTargets[scope] || []).length);
  const REQUIRED_PROBE_SCOPE = PROBE_SCOPES.includes('public') ? 'public' : PROBE_SCOPES[0];
  const sourceProbeTimeoutMs = boundedInteger(probeTimeoutMs, DEFAULT_EGRESS_PROBE_TIMEOUT_MS, 1, 30_000);
  const sourceProbeCacheMs = boundedInteger(probeCacheMs, DEFAULT_EGRESS_PROBE_CACHE_MS, 1, 60 * 60_000);
  let lastLanes = [];
  let degraded = false;
  const probeResults = new Map();
  const unhealthySessionNodes = new Map();
  const sessionSlots = Array.from({ length: sessionLanesLimit }, (_, index) => ({
    id: sessionLaneId(index),
    group: sessionLaneGroup(index),
    proxyUrl: listenerUrl(listenerBaseUrl, index, sessionPort),
    proxyName: undefined,
    dispatcher: undefined,
    unhealthy: false,
  }));

  async function request(path, options) {
    const response = await fetchImpl(`${controller}${path}`, {
      ...options,
      headers: { ...(options?.body ? { 'content-type': 'application/json' } : {}), ...options?.headers },
    });
    if (!response.ok) throw new Error(`mihomo controller returned ${response.status}`);
    if (response.status === 204) return {};
    return response.json();
  }

  function healthyNodes(payload, providersPayload, { includeGenericFailures = false } = {}) {
    const proxies = payload?.proxies || {};
    const publicGroup = proxies[EGRESS_PUBLIC_GROUP];
    const names = Array.isArray(publicGroup?.all) ? publicGroup.all : [];
    const providerDetails = new Map();
    for (const provider of Object.values(providersPayload?.providers || {})) {
      for (const detail of provider?.proxies || []) {
        if (detail?.name) providerDetails.set(detail.name, detail);
      }
    }
    return names.filter((name) => {
      const detail = proxies[name] || providerDetails.get(name);
      return Boolean(detail)
        && !EGRESS_RESERVED_NAMES.has(name)
        && !isSubscriptionMetadataName(name)
        && !String(name).startsWith('EGRESS_LANE_')
        && !String(name).startsWith('SESSION_LANE_')
        && !EGRESS_GROUP_TYPES.has(detail.type)
        && (includeGenericFailures || detail.alive !== false);
    });
  }

  async function probeTarget(target, dispatcher, method, laneId) {
    const response = await probeFetchImpl(target, {
      method,
      dispatcher,
      redirect: 'manual',
      headers: { 'x-probe-lane': laneId },
      signal: AbortSignal.timeout(sourceProbeTimeoutMs),
    });
    const ok = response.status >= 200 && response.status < 400;
    await response.body?.cancel();
    return ok;
  }

  async function probeLane(lane, scope) {
    const targets = sourceProbeTargets[scope] || [];
    if (!targets.length) return true;
    const cacheKey = `${lane.proxyName}:${scope}`;
    const cached = probeResults.get(cacheKey);
    if (cached && now() - cached.at < sourceProbeCacheMs) return cached.ok;
    let ok = false;
    for (const target of targets) {
      let targetOk = false;
      try {
        targetOk = await probeTarget(target, lane.dispatcher, 'HEAD', lane.id);
      } catch {
        targetOk = false;
      }
      if (!targetOk) {
        try {
          targetOk = await probeTarget(target, lane.dispatcher, 'GET', lane.id);
        } catch {
          targetOk = false;
        }
      }
      if (targetOk) {
        ok = true;
        break;
      }
    }
    probeResults.set(cacheKey, { at: now(), ok });
    return ok;
  }

  async function bindAndProbe(node, index) {
    const group = laneGroup(index);
    await request(`/proxies/${encodeURIComponent(group)}`, {
      method: 'PUT',
      body: JSON.stringify({ name: node }),
    });
    const lane = {
      id: laneId(index),
      proxyName: node,
      proxyUrl: listenerUrl(listenerBaseUrl, index),
      dispatcher: Agent ? new Agent(listenerUrl(listenerBaseUrl, index)) : undefined,
      healthyScopes: new Set(),
    };
    for (const scope of PROBE_SCOPES) {
      if (await probeLane(lane, scope)) lane.healthyScopes.add(scope);
    }
    if (PROBE_SCOPES.length && !lane.healthyScopes.has(REQUIRED_PROBE_SCOPE)) {
      await lane.dispatcher?.close?.().catch(() => {});
      return { lane: undefined, index };
    }
    return { lane, index };
  }

  async function proxyCandidates() {
    const payload = await request('/proxies');
    const publicNames = payload?.proxies?.[EGRESS_PUBLIC_GROUP]?.all || [];
    const needsProviderDetails = publicNames.some((name) => !payload?.proxies?.[name]);
    const providersPayload = needsProviderDetails ? await request('/providers/proxies') : undefined;
    const primaryNodes = healthyNodes(payload, providersPayload);
    const fallbackNodes = sourceProbeUrl
      ? healthyNodes(payload, providersPayload, { includeGenericFailures: true })
        .filter((node) => !primaryNodes.includes(node))
        .slice(0, Math.max(lanesLimit, sessionLanesLimit))
      : [];
    return [...primaryNodes, ...fallbackNodes];
  }

  async function verifyGroups() {
    try {
      const payload = await request('/proxies');
      const names = new Set(Object.keys(payload?.proxies || {}));
      const missing = [];
      for (let index = 0; index < lanesLimit; index += 1) {
        if (!names.has(laneGroup(index))) missing.push(laneGroup(index));
      }
      for (let index = 0; index < sessionLanesLimit; index += 1) {
        if (!names.has(sessionLaneGroup(index))) missing.push(sessionLaneGroup(index));
      }
      return { ready: missing.length === 0, missing };
    } catch (error) {
      return { ready: false, missing: [], error: error?.message || 'mihomo controller unavailable' };
    }
  }

  async function refreshPublicLanes() {
    try {
      const nodes = await proxyCandidates();
      const nextLanes = [];
      let cursor = 0;
      let freeIndexes = Array.from({ length: lanesLimit }, (_, index) => index);
      while (cursor < nodes.length && freeIndexes.length) {
        const batchNodes = nodes.slice(cursor, cursor + freeIndexes.length);
        const batchIndexes = freeIndexes.splice(0, batchNodes.length);
        cursor += batchNodes.length;
        const results = await Promise.all(batchNodes.map((node, offset) => bindAndProbe(node, batchIndexes[offset])));
        for (const result of results) {
          if (result.lane) nextLanes.push(result.lane);
          else freeIndexes.push(result.index);
        }
      }
      nextLanes.sort((left, right) => Number.parseInt(left.id.slice(5), 10) - Number.parseInt(right.id.slice(5), 10));
      if (PROBE_SCOPES.length && !nextLanes.length && lastLanes.length) {
        degraded = true;
        safeEvent(onEvent, { state: 'degraded', lanes: lastLanes.length, code: 'EGRESS_SOURCE_PROBE_FAILED' });
        return lastLanes;
      }
      const retained = new Set(nextLanes.map((lane) => lane.dispatcher));
      for (const lane of lastLanes) {
        if (!retained.has(lane.dispatcher)) {
          void lane.dispatcher?.close?.().catch(() => {});
        }
      }
      lastLanes = nextLanes;
      degraded = nextLanes.length === 0;
      safeEvent(onEvent, { state: degraded ? 'empty' : 'refresh', lanes: nextLanes.length });
      return lastLanes;
    } catch (error) {
      degraded = true;
      safeEvent(onEvent, { state: 'degraded', lanes: lastLanes.length, code: error.code || 'MIHOMO_CONTROLLER_ERROR' });
      return lastLanes;
    }
  }

  function sessionSnapshot(slot) {
    if (!slot.proxyName || !slot.dispatcher || slot.unhealthy) return undefined;
    return {
      id: slot.id,
      proxyName: slot.proxyName,
      proxyUrl: slot.proxyUrl,
      dispatcher: slot.dispatcher,
      healthyScopes: slot.healthyScopes ? [...slot.healthyScopes] : undefined,
    };
  }

  function sessionLanes() {
    return sessionSlots.map(sessionSnapshot).filter(Boolean);
  }

  function sessionSlotFor(laneId) {
    return sessionSlots.find((slot) => slot.id === String(laneId || '').trim());
  }

  async function assignSessionLane(laneId, node) {
    const slot = sessionSlotFor(laneId);
    const proxyName = String(node || '').trim();
    if (!slot) throw new Error(`unknown session lane: ${laneId}`);
    if (!proxyName) throw new Error('session lane proxy is required');
    if (slot.proxyName === proxyName && slot.dispatcher && !slot.unhealthy) return sessionSnapshot(slot);
    await request(`/proxies/${encodeURIComponent(slot.group)}`, {
      method: 'PUT',
      body: JSON.stringify({ name: proxyName }),
    });
    await slot.dispatcher?.close?.().catch(() => {});
    const dispatcher = Agent ? new Agent(slot.proxyUrl) : undefined;
    const healthy = await probeLane({ id: slot.id, proxyName, dispatcher }, 'sticky');
    if (!healthy) {
      await dispatcher?.close?.().catch(() => {});
      slot.proxyName = undefined;
      slot.dispatcher = undefined;
      slot.healthyScopes = undefined;
      return undefined;
    }
    slot.proxyName = proxyName;
    slot.dispatcher = dispatcher;
    slot.unhealthy = false;
    slot.healthyScopes = new Set(['sticky']);
    unhealthySessionNodes.delete(proxyName);
    return sessionSnapshot(slot);
  }

  async function refreshSessionLanes() {
    try {
      const nodes = await proxyCandidates();
      const occupied = new Set(sessionSlots
        .filter((slot) => slot.proxyName && !slot.unhealthy)
        .map((slot) => slot.proxyName));
      for (const slot of sessionSlots) {
        if (slot.proxyName && !slot.unhealthy) continue;
        const node = nodes.find((candidate) => {
          if (occupied.has(candidate)) return false;
          const bannedAt = unhealthySessionNodes.get(candidate);
          if (bannedAt === undefined) return true;
          return now() - bannedAt >= sourceProbeCacheMs;
        });
        if (!node) continue;
        const assigned = await assignSessionLane(slot.id, node);
        if (assigned) occupied.add(node);
      }
      safeEvent(onEvent, { state: 'session-refresh', lanes: sessionLanes().length });
      return sessionLanes();
    } catch (error) {
      safeEvent(onEvent, { state: 'session-degraded', lanes: sessionLanes().length, code: error.code || 'MIHOMO_CONTROLLER_ERROR' });
      return sessionLanes();
    }
  }

  async function markSessionLaneUnhealthy(laneId) {
    const slot = sessionSlotFor(laneId);
    if (!slot) return false;
    if (slot.proxyName) unhealthySessionNodes.set(slot.proxyName, now());
    slot.unhealthy = true;
    slot.healthyScopes = undefined;
    await slot.dispatcher?.close?.().catch(() => {});
    slot.proxyName = undefined;
    slot.dispatcher = undefined;
    safeEvent(onEvent, { state: 'session-unhealthy', lane: slot.id });
    return true;
  }

  async function releaseSessionLane(laneId) {
    const slot = sessionSlotFor(laneId);
    if (!slot) return false;
    await slot.dispatcher?.close?.().catch(() => {});
    slot.proxyName = undefined;
    slot.dispatcher = undefined;
    slot.unhealthy = false;
    slot.healthyScopes = undefined;
    return true;
  }

  return {
    refresh: refreshPublicLanes,
    refreshPublicLanes,
    refreshSessionLanes,
    verifyGroups,
    sessionLanes,
    assignSessionLane,
    releaseSessionLane,
    markSessionLaneUnhealthy,
    lanes: () => lastLanes,
    ready: () => Promise.resolve(lastLanes),
    stats: () => ({ degraded, lanes: lastLanes.length, sessionLanes: sessionLanes().length }),
    close: async () => {
      const allDispatchers = [
        ...lastLanes.map((lane) => lane.dispatcher),
        ...sessionSlots.map((slot) => slot.dispatcher),
      ].filter(Boolean);
      await Promise.all(allDispatchers.map((dispatcher) => dispatcher.close?.().catch(() => {})));
    },
  };
}

export function resolveGatewayOptions(options = {}, env = process.env) {
  const logger = options.logger || createLogger();
  const secret = options.secret || readSecret();
  const sourceConfig = options.sourceConfig || readSources();
  const ehPrefetchConcurrency = boundedInteger(
    options.ehPrefetchConcurrency ?? env.EH_PREFETCH_CONCURRENCY,
    DEFAULT_EH_PREFETCH_CONCURRENCY,
    1,
    DEFAULT_EGRESS_MAX_TOTAL_CONCURRENCY,
  );
  const ehMaxPrefetchPages = boundedInteger(
    options.ehMaxPrefetchPages ?? env.EH_MAX_PREFETCH_PAGES,
    DEFAULT_EH_MAX_PREFETCH_PAGES,
    1,
    DEFAULT_EH_MAX_PREFETCH_PAGES,
  );
  const egressLaneCount = boundedInteger(
    options.egressLaneCount ?? env.EGRESS_LANE_COUNT,
    DEFAULT_EGRESS_LANE_COUNT,
    1,
    DEFAULT_EGRESS_LANE_COUNT,
  );
  const egressSessionLaneCount = boundedInteger(
    options.egressSessionLaneCount ?? env.EGRESS_SESSION_LANE_COUNT,
    DEFAULT_EGRESS_SESSION_LANE_COUNT,
    1,
    DEFAULT_EGRESS_SESSION_LANE_COUNT,
  );
  const egressSessionListenerBasePort = boundedInteger(
    options.egressSessionListenerBasePort ?? env.EGRESS_SESSION_LISTENER_BASE_PORT,
    DEFAULT_EGRESS_SESSION_LISTENER_BASE_PORT,
    1024,
    65_524,
  );
  const egressMinConcurrencyPerLane = boundedInteger(
    options.egressMinConcurrencyPerLane ?? env.EGRESS_MIN_CONCURRENCY_PER_LANE,
    DEFAULT_EGRESS_MIN_CONCURRENCY_PER_LANE,
    1,
    12,
  );
  const egressMaxConcurrencyPerLane = boundedInteger(
    options.egressMaxConcurrencyPerLane ?? env.EGRESS_MAX_CONCURRENCY_PER_LANE,
    DEFAULT_EGRESS_MAX_CONCURRENCY_PER_LANE,
    egressMinConcurrencyPerLane,
    24,
  );
  const egressMaxTotalConcurrency = boundedInteger(
    options.egressMaxTotalConcurrency ?? env.EGRESS_MAX_TOTAL_CONCURRENCY,
    DEFAULT_EGRESS_MAX_TOTAL_CONCURRENCY,
    egressMinConcurrencyPerLane,
    96,
  );
  const ehPrefetchMaxConcurrency = boundedInteger(
    options.ehPrefetchMaxConcurrency ?? env.EH_PREFETCH_MAX_CONCURRENCY,
    DEFAULT_EH_PREFETCH_MAX_CONCURRENCY,
    ehPrefetchConcurrency,
    egressMaxTotalConcurrency,
  );
  const egressRefreshIntervalMs = boundedInteger(
    options.egressRefreshIntervalMs ?? env.EGRESS_REFRESH_INTERVAL_MS,
    DEFAULT_EGRESS_REFRESH_INTERVAL_MS,
    5_000,
    10 * 60_000,
  );
  const egressProbeUrl = options.egressProbeUrl ?? env.EGRESS_PROBE_URL ?? 'https://e-hentai.org/';
  const egressProbeTimeoutMs = boundedInteger(
    options.egressProbeTimeoutMs ?? env.EGRESS_PROBE_TIMEOUT_MS,
    5_000,
    1_000,
    30_000,
  );
  const egressProbeCacheMs = boundedInteger(
    options.egressProbeCacheMs ?? env.EGRESS_PROBE_CACHE_MS,
    5 * 60_000,
    10_000,
    60 * 60_000,
  );
  const egressProbeTargets = parseProbeTargets(
    options.egressProbeTargets ?? env.EGRESS_PROBE_TARGETS,
    egressProbeUrl,
  );
  const egressSiteFailureThreshold = boundedInteger(
    options.egressSiteFailureThreshold ?? env.EGRESS_SITE_FAILURE_THRESHOLD,
    3,
    1,
    100,
  );
  const egressSiteFailureWindowMs = boundedInteger(
    options.egressSiteFailureWindowMs ?? env.EGRESS_SITE_FAILURE_WINDOW_MS,
    60_000,
    1_000,
    24 * 60 * 60_000,
  );
  const egressSiteBlockCooldownMs = boundedInteger(
    options.egressSiteBlockCooldownMs ?? env.EGRESS_SITE_BLOCK_COOLDOWN_MS,
    60_000,
    0,
    24 * 60 * 60_000,
  );
  const egressBlockedStatuses = new Set(
    parseStatusList(options.egressBlockedStatuses ?? env.EGRESS_BLOCKED_STATUSES, DEFAULT_BLOCKED_STATUSES),
  );
  const controllerUrl = options.egressControllerUrl || env.EGRESS_CONTROLLER_URL;
  const ehMediaPrefetchConcurrency = boundedInteger(
    options.ehMediaPrefetchConcurrency ?? env.EH_MEDIA_PREFETCH_CONCURRENCY,
    DEFAULT_EH_MEDIA_PREFETCH_CONCURRENCY,
    1,
    egressMaxTotalConcurrency,
  );
  const ehMediaPrefetchMinConcurrency = boundedInteger(
    options.ehMediaPrefetchMinConcurrency ?? env.EH_MEDIA_PREFETCH_MIN_CONCURRENCY,
    DEFAULT_EH_MEDIA_PREFETCH_MIN_CONCURRENCY,
    1,
    egressMaxTotalConcurrency,
  );
  const ehMediaPrefetchMaxConcurrency = boundedInteger(
    options.ehMediaPrefetchMaxConcurrency ?? env.EH_MEDIA_PREFETCH_MAX_CONCURRENCY,
    DEFAULT_EH_MEDIA_PREFETCH_MAX_CONCURRENCY,
    ehMediaPrefetchMinConcurrency,
    egressMaxTotalConcurrency,
  );
  const ehMediaPrefetchPerOriginConcurrency = boundedInteger(
    options.ehMediaPrefetchPerOriginConcurrency ?? env.EH_MEDIA_PREFETCH_PER_ORIGIN,
    DEFAULT_EH_MEDIA_PREFETCH_PER_ORIGIN,
    1,
    48,
  );
  const ehMediaForegroundWarmCount = boundedInteger(
    options.ehMediaForegroundWarmCount ?? env.EH_MEDIA_FOREGROUND_WARM_COUNT,
    DEFAULT_EH_MEDIA_FOREGROUND_WARM_COUNT,
    1,
    24,
  );
  const ehMediaForegroundWarmConcurrency = boundedInteger(
    options.ehMediaForegroundWarmConcurrency ?? env.EH_MEDIA_FOREGROUND_WARM_CONCURRENCY,
    DEFAULT_EH_MEDIA_FOREGROUND_WARM_CONCURRENCY,
    1,
    ehMediaForegroundWarmCount,
  );
  const ehFirstPaintCount = boundedInteger(
    options.ehFirstPaintCount ?? env.EH_FIRST_PAINT_COUNT,
    DEFAULT_EH_FIRST_PAINT_COUNT,
    1,
    24,
  );
  const ehColdStartEnabled = parseBooleanOption(
    options.ehColdStartEnabled ?? env.EH_COLD_START_ENABLED,
    true,
  );
  const ehFirstDetailBudgetMs = boundedInteger(
    options.ehFirstDetailBudgetMs ?? env.EH_FIRST_DETAIL_BUDGET_MS,
    DEFAULT_FIRST_DETAIL_BUDGET_MS,
    100,
    1_800,
  );
  const mediaCacheMaxFileBytes = boundedInteger(
    options.mediaCacheMaxFileBytes ?? env.GATEWAY_MEDIA_CACHE_MAX_FILE_BYTES,
    DEFAULT_MEDIA_CACHE_MAX_FILE_BYTES,
    1 * 1024 ** 2,
    256 * 1024 ** 2,
  );
  const videoCacheMaxFileBytes = boundedInteger(
    options.videoCacheMaxFileBytes ?? env.GATEWAY_VIDEO_CACHE_MAX_FILE_BYTES,
    DEFAULT_VIDEO_CACHE_MAX_FILE_BYTES,
    8 * 1024 ** 2,
    1024 ** 3,
  );
  const mediaBrowserCacheSeconds = boundedInteger(
    options.mediaBrowserCacheSeconds ?? env.GATEWAY_MEDIA_BROWSER_CACHE_SECONDS,
    DEFAULT_MEDIA_BROWSER_CACHE_SECONDS,
    60,
    86_400,
  );
  const imageVariantConcurrency = boundedInteger(
    options.imageVariantConcurrency ?? env.GATEWAY_IMAGE_VARIANT_CONCURRENCY,
    2,
    1,
    12,
  );
  const imageVariantMaxSourceBytes = boundedInteger(
    options.imageVariantMaxSourceBytes ?? env.GATEWAY_IMAGE_VARIANT_MAX_SOURCE_BYTES,
    mediaCacheMaxFileBytes,
    1 * 1024 ** 2,
    mediaCacheMaxFileBytes,
  );
  const htmlBrotliMinBytes = boundedInteger(
    options.htmlBrotliMinBytes ?? env.GATEWAY_HTML_BROTLI_MIN_BYTES,
    DEFAULT_HTML_BROTLI_MIN_BYTES,
    256,
    16 * 1024 ** 2,
  );
  const htmlBrotliQuality = boundedInteger(
    options.htmlBrotliQuality ?? env.GATEWAY_HTML_BROTLI_QUALITY,
    DEFAULT_HTML_BROTLI_QUALITY,
    1,
    11,
  );
  const imageVariantLimiter = createConcurrencyLimiter(imageVariantConcurrency);
  const leaseBackfillEnabled = parseBooleanOption(
    options.leaseBackfillEnabled ?? env.GATEWAY_LEASE_BACKFILL,
    true,
  );
  const leaseBackfillConcurrency = boundedInteger(
    options.leaseBackfillConcurrency ?? env.GATEWAY_LEASE_BACKFILL_CONCURRENCY,
    2,
    0,
    8,
  );
  const leaseProxyPort = boundedInteger(
    options.leaseProxyPort ?? env.GATEWAY_LEASE_PROXY_PORT,
    0,
    0,
    65_535,
  );
  const leaseProxyPublicUrl = String(
    options.leaseProxyPublicUrl ?? env.GATEWAY_LEASE_PROXY_PUBLIC_URL ?? '',
  );
  const leaseTtlMs = boundedInteger(
    options.leaseTtlMs ?? env.GATEWAY_LEASE_TTL_MS,
    30 * 60_000,
    60_000,
    24 * 60 * 60_000,
  );
  const leaseMaxBytes = boundedInteger(
    options.leaseMaxBytes ?? env.GATEWAY_LEASE_MAX_BYTES,
    2 * 1024 ** 3,
    1024 * 1024,
    64 * 1024 ** 3,
  );
  const slowSourceThresholdMs = resolveSlowSourceThresholdMs(
    options.slowSourceThresholdMs ?? env.GATEWAY_SLOW_SOURCE_MS,
    DEFAULT_SLOW_SOURCE_THRESHOLD_MS,
  );
  const leaseMaxConcurrency = boundedInteger(
    options.leaseMaxConcurrency ?? env.GATEWAY_LEASE_MAX_CONCURRENCY,
    8,
    1,
    32,
  );
  const egressProxyBaseUrl = options.egressProxyBaseUrl || env.EGRESS_PROXY_BASE_URL;
  const sessionAffinityRoot = options.sessionAffinityRoot || env.GATEWAY_CACHE_DIR || DEFAULT_CACHE_ROOT;
  const sessionAffinityFile = options.sessionAffinityFile || env.SESSION_AFFINITY_FILE;
  const downloadSessionFile = options.downloadSessionFile || env.GATEWAY_DOWNLOAD_SESSION_FILE;
  const videoPrefetchEnabled = parseBooleanOption(
    options.videoPrefetchEnabled ?? env.GATEWAY_VIDEO_PREFETCH,
    true,
  );
  const videoPrefetchConcurrency = boundedInteger(
    options.videoPrefetchConcurrency ?? env.GATEWAY_VIDEO_PREFETCH_CONCURRENCY,
    DEFAULT_VIDEO_PREFETCH_CONCURRENCY,
    1,
    8,
  );
  const feedPrefetchPaths = parseFeedPrefetchPaths(
    options.feedPrefetchPaths ?? env.GATEWAY_FEED_PREFETCH_PATHS,
    dedupe,
  );
  const feedPrefetchIntervalMs = boundedInteger(
    options.feedPrefetchIntervalMs ?? env.GATEWAY_FEED_PREFETCH_INTERVAL_MS,
    DEFAULT_FEED_PREFETCH_INTERVAL_MS,
    10_000,
    86_400_000,
  );
  const feedPrefetchConcurrency = boundedInteger(
    options.feedPrefetchConcurrency ?? env.GATEWAY_FEED_PREFETCH_CONCURRENCY,
    DEFAULT_FEED_PREFETCH_CONCURRENCY,
    1,
    8,
  );
  const feedPrefetchMaxRetries = boundedInteger(
    options.feedPrefetchMaxRetries ?? env.GATEWAY_FEED_PREFETCH_MAX_RETRIES,
    DEFAULT_FEED_PREFETCH_MAX_RETRIES,
    0,
    5,
  );
  return {
    logger,
    secret,
    sourceConfig,
    ehPrefetchConcurrency,
    ehMaxPrefetchPages,
    egressLaneCount,
    egressSessionLaneCount,
    egressSessionListenerBasePort,
    egressMinConcurrencyPerLane,
    egressMaxConcurrencyPerLane,
    egressMaxTotalConcurrency,
    ehPrefetchMaxConcurrency,
    egressRefreshIntervalMs,
    egressProbeUrl,
    egressProbeTimeoutMs,
    egressProbeCacheMs,
    egressProbeTargets,
    egressSiteFailureThreshold,
    egressSiteFailureWindowMs,
    egressSiteBlockCooldownMs,
    egressBlockedStatuses,
    egressProxyBaseUrl,
    controllerUrl,
    sessionAffinityRoot,
    sessionAffinityFile,
    downloadSessionFile,
    videoPrefetchEnabled,
    videoPrefetchConcurrency,
    feedPrefetchPaths,
    feedPrefetchIntervalMs,
    feedPrefetchConcurrency,
    feedPrefetchMaxRetries,
    ehMediaPrefetchConcurrency,
    ehMediaPrefetchMinConcurrency,
    ehMediaPrefetchMaxConcurrency,
    ehMediaPrefetchPerOriginConcurrency,
    ehMediaForegroundWarmCount,
    ehMediaForegroundWarmConcurrency,
    ehFirstPaintCount,
    ehColdStartEnabled,
    ehFirstDetailBudgetMs,
    mediaCacheMaxFileBytes,
    videoCacheMaxFileBytes,
    mediaBrowserCacheSeconds,
    imageVariantConcurrency,
    imageVariantMaxSourceBytes,
    htmlBrotliMinBytes,
    htmlBrotliQuality,
    imageVariantLimiter,
    slowSourceThresholdMs,
    leaseBackfillEnabled,
    leaseBackfillConcurrency,
    leaseProxyPort,
    leaseProxyPublicUrl,
    leaseTtlMs,
    leaseMaxBytes,
    leaseMaxConcurrency,
  };
}

export function isSubscriptionMetadataName(name) {
  const value = String(name || '').trim().toLowerCase();
  return value.includes('剩余流量')
    || value.includes('距离下次重置')
    || value.includes('套餐到期')
    || value.includes('官网地址')
    || value.includes('更新订阅')
    || value.includes('update subscription')
    || value.includes('remaining traffic')
    || value.includes('subscription expires')
    || value.includes('reset remaining');
}

export function boundedPositiveInteger(value, fallback, maximum) {
  return boundedInteger(value, fallback, 1, maximum);
}

export function toUrlList(value) {
  if (!value) return [];
  const list = Array.isArray(value) ? value : [value];
  return list.map(String).filter(Boolean);
}

export function normalizeProbeTargets(value, legacyProbeUrl) {
  if (value && typeof value === 'object') {
    return {
      public: toUrlList(value.public),
      sticky: toUrlList(value.sticky),
      hosts: value.hosts && typeof value.hosts === 'object' ? value.hosts : {},
    };
  }
  if (!legacyProbeUrl) {
    return { public: [], sticky: [], hosts: {} };
  }
  return {
    public: toUrlList(legacyProbeUrl),
    sticky: [],
    hosts: {},
  };
}

export function laneId(index) {
  return `lane-${String(index + 1).padStart(2, '0')}`;
}

export function laneGroup(index) {
  return `EGRESS_LANE_${String(index + 1).padStart(2, '0')}`;
}

export function sessionLaneId(index) {
  return `session-lane-${String(index + 1).padStart(2, '0')}`;
}

export function sessionLaneGroup(index) {
  return `SESSION_LANE_${String(index + 1).padStart(2, '0')}`;
}

export function listenerUrl(baseUrl, index, basePort = 7901) {
  const target = new URL(baseUrl);
  target.port = String(basePort + index);
  return target.toString().replace(/\/$/, '');
}

export const DEFAULT_MEDIA_PREFETCH_INITIAL_CONCURRENCY = 6;
export const DEFAULT_MEDIA_PREFETCH_MIN_CONCURRENCY = 3;
export const DEFAULT_MEDIA_PREFETCH_MAX_CONCURRENCY = 12;
export const DEFAULT_MEDIA_PREFETCH_PER_ORIGIN_CONCURRENCY = 2;
export const DEFAULT_MEDIA_PREFETCH_MAX_RETRIES = 2;
export const DEFAULT_MEDIA_PREFETCH_SUCCESS_RAMP_AFTER = 6;
export const DEFAULT_MEDIA_PREFETCH_QUEUE_TTL_MS = 24 * 60 * 60 * 1000;
export const MAX_MEDIA_PREFETCH_QUEUE_ITEMS = 2_000;
export const MAX_MEDIA_PREFETCH_PER_ORIGIN_CONCURRENCY = 48;

export const MEDIA_PREFETCH_QUEUE_VERSION = 1;

export function mediaPrefetchRetryDelay(attempts, jitter = 0) {
  const base = 250 * (2 ** Math.max(0, Number(attempts) || 0));
  return Math.min(2_000, base + Math.floor(Number(jitter) || 0));
}

export function isValidMediaPrefetchRecord(record, now = Date.now(), ttlMs = DEFAULT_MEDIA_PREFETCH_QUEUE_TTL_MS) {
  if (!record || typeof record !== 'object') return false;
  if (typeof record.target !== 'string' || !record.target) return false;
  if (!Number.isFinite(record.enqueuedAt) || record.enqueuedAt <= 0) return false;
  if (now - record.enqueuedAt > ttlMs) return false;
  return Number.isInteger(record.attempts) && record.attempts >= 0;
}

export function calculateCacheHeadroom(cacheStats = {}, evictionBudget = DEFAULT_LEASE_BACKFILL_EVICTION_BUDGET) {
  const used = Number(cacheStats?.bytes) || 0;
  const limitBytes = Number(cacheStats?.byteLimit) || 0;
  if (limitBytes <= 0) return Infinity;
  return Math.max(0, limitBytes - used) + Math.max(0, Number(evictionBudget) || 0);
}

export function mediaOriginFor(target, allowedHosts = ALLOWED_HOSTS) {
  try {
    const parsed = new URL(target);
    return isAllowedTarget(parsed, allowedHosts) ? parsed.host.toLowerCase() : '';
  } catch {
    return '';
  }
}

export const DEFAULT_FEED_PREFETCH_INTERVAL_MS = 900_000;
export const DEFAULT_FEED_PREFETCH_CONCURRENCY = 2;
export const DEFAULT_FEED_PREFETCH_MAX_RETRIES = 2;
export const DEFAULT_FEED_PREFETCH_RETRY_BACKOFF_MS = 5_000;
export const MAX_FEED_PREFETCH_CONCURRENCY = 8;
export const MAX_FEED_PREFETCH_RETRIES = 5;
export const MAX_FEED_PREFETCH_INTERVAL_CAP_MS = 4 * 60 * 60_000;

export function feedPrefetchBackoffMultiplier(consecutiveFailures) {
  const failures = Math.max(0, Number(consecutiveFailures) || 0);
  return Math.min(16, Math.pow(2, failures));
}

export function feedPrefetchEffectiveInterval(baseInterval, multiplier = 1, maxCap = MAX_FEED_PREFETCH_INTERVAL_CAP_MS) {
  const interval = Number(baseInterval) || DEFAULT_FEED_PREFETCH_INTERVAL_MS;
  const mult = Math.max(1, Number(multiplier) || 1);
  return Math.min(interval * mult, maxCap);
}

export function feedPrefetchRetryDelay(attempts, backoffMs = DEFAULT_FEED_PREFETCH_RETRY_BACKOFF_MS) {
  const count = Math.max(1, Number(attempts) || 1);
  return (Number(backoffMs) || DEFAULT_FEED_PREFETCH_RETRY_BACKOFF_MS) * count;
}

export function initialFeedPathStats(paused = false) {
  return {
    queued: 0,
    completed: 0,
    failed: 0,
    attempts: 0,
    consecutiveFailures: 0,
    backoffMultiplier: 1,
    lastStatus: null,
    lastAttemptAt: 0,
    lastDurationMs: null,
    paused: Boolean(paused),
  };
}

export function createMediaPrefetchQueue(options = {}) {
  const queueFile = path.resolve(options.queueFile || path.join(DEFAULT_CACHE_ROOT, 'media-prefetch.json'));
  const initialConcurrency = boundedInteger(options.initialConcurrency, DEFAULT_MEDIA_PREFETCH_INITIAL_CONCURRENCY, 1, DEFAULT_MEDIA_PREFETCH_MAX_CONCURRENCY);
  const minConcurrency = boundedInteger(options.minConcurrency, DEFAULT_MEDIA_PREFETCH_MIN_CONCURRENCY, 1, DEFAULT_MEDIA_PREFETCH_MAX_CONCURRENCY);
  const maxConcurrency = boundedInteger(options.maxConcurrency, DEFAULT_MEDIA_PREFETCH_MAX_CONCURRENCY, minConcurrency, DEFAULT_MEDIA_PREFETCH_MAX_CONCURRENCY);
  const perOriginConcurrency = boundedInteger(options.perOriginConcurrency, DEFAULT_MEDIA_PREFETCH_PER_ORIGIN_CONCURRENCY, 1, MAX_MEDIA_PREFETCH_PER_ORIGIN_CONCURRENCY);
  const maxRetries = boundedInteger(options.maxRetries, DEFAULT_MEDIA_PREFETCH_MAX_RETRIES, 0, 4);
  const successRampAfter = boundedInteger(options.successRampAfter, DEFAULT_MEDIA_PREFETCH_SUCCESS_RAMP_AFTER, 1, 100);
  const queueTtlMs = Number.isFinite(options.queueTtlMs) && options.queueTtlMs > 0
    ? options.queueTtlMs
    : DEFAULT_MEDIA_PREFETCH_QUEUE_TTL_MS;
  const now = options.now || (() => Date.now());
  const sleepFn = options.sleep || sleep;
  const random = options.random || Math.random;
  const fetchMedia = options.fetchMedia || (async () => ({ status: 204, cacheState: 'MISS' }));
  const onEvent = options.onEvent;
  const minimumConcurrencyProvider = options.minimumConcurrencyProvider;
  const capacityProvider = options.capacityProvider;
  const persistEnabled = options.persist !== false;

  let currentConcurrency = clamp(initialConcurrency, minConcurrency, maxConcurrency);
  let active = 0;
  let delayed = 0;
  let successStreak = 0;
  let completed = 0;
  let failures = 0;
  const pending = [];
  const records = new Map();
  const activeByOrigin = new Map();
  const earlyTargets = [];
  const idleWaiters = [];
  let persistChain = Promise.resolve();
  let initialized = false;

  function providerValue(provider, fallback) {
    try {
      const value = Number(provider?.());
      return Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
    } catch {
      return fallback;
    }
  }

  function isIdle() {
    return initialized && active === 0 && delayed === 0 && pending.length === 0;
  }

  function notifyIdle() {
    if (!isIdle()) return;
    while (idleWaiters.length) idleWaiters.shift()();
  }

  function schedulePersist() {
    if (!persistEnabled) return Promise.resolve();
    const items = [...records.values()].map((rec) => ({ ...rec }));
    persistChain = persistChain.then(async () => {
      await atomicWriteJson(queueFile, { version: MEDIA_PREFETCH_QUEUE_VERSION, items }, { mode: null, dirMode: 0o755 });
    }, async () => {}).catch(() => {});
    return persistChain;
  }

  function emit(event) {
    safeEvent(onEvent, {
      ...event,
      concurrency: currentConcurrency,
      queued: records.size,
      active,
    });
  }

  function addTargets(targets) {
    for (const value of targets || []) {
      const target = String(value || '');
      const origin = mediaOriginFor(target);
      if (!origin || records.has(target) || records.size >= MAX_MEDIA_PREFETCH_QUEUE_ITEMS) continue;
      records.set(target, { target, enqueuedAt: now(), attempts: 0 });
      pending.push(target);
      emit({ state: 'queued', host: origin });
    }
    void schedulePersist();
    drain();
  }

  function nextTargetIndex() {
    for (let index = 0; index < pending.length; index += 1) {
      const target = pending[index];
      const origin = mediaOriginFor(target);
      if ((activeByOrigin.get(origin) || 0) < perOriginConcurrency) return index;
    }
    return -1;
  }

  function releaseOrigin(origin) {
    const count = (activeByOrigin.get(origin) || 1) - 1;
    if (count <= 0) activeByOrigin.delete(origin);
    else activeByOrigin.set(origin, count);
  }

  function reduceConcurrency(host, status) {
    currentConcurrency = Math.max(minConcurrency, currentConcurrency - 1);
    successStreak = 0;
    emit({ state: 'backoff', host, status });
  }

  function recordSuccess(host, cacheState) {
    if (cacheState === 'HIT' || cacheState === 'STALE') {
      emit({ state: 'hit', host });
      return;
    }
    successStreak += 1;
    if (successStreak >= successRampAfter) {
      currentConcurrency = Math.min(maxConcurrency, currentConcurrency + 1);
      successStreak = 0;
      emit({ state: 'ramp', host });
    } else {
      emit({ state: 'success', host });
    }
  }

  async function runTarget(target) {
    const recordEntry = records.get(target);
    const host = mediaOriginFor(target);
    active += 1;
    activeByOrigin.set(host, (activeByOrigin.get(host) || 0) + 1);
    let retry = false;
    let retryDelay = 0;
    let result;
    try {
      result = await fetchMedia(target);
      const status = Number(result?.status);
      if (isSuccessfulStatus(status)) {
        completed += 1;
        records.delete(target);
        recordSuccess(host, result?.cacheState);
      } else if (isRetryableStatus(status) && recordEntry && recordEntry.attempts < maxRetries) {
        recordEntry.attempts += 1;
        retry = true;
        retryDelay = mediaPrefetchRetryDelay(recordEntry.attempts, random() * 100);
        reduceConcurrency(host, status);
        emit({ state: 'retry', host, status, attempt: recordEntry.attempts });
      } else {
        failures += 1;
        records.delete(target);
        reduceConcurrency(host, status);
        emit({ state: 'failed', host, status });
      }
    } catch (error) {
      const status = Number(error?.status) || 504;
      if (recordEntry && recordEntry.attempts < maxRetries) {
        recordEntry.attempts += 1;
        retry = true;
        retryDelay = mediaPrefetchRetryDelay(recordEntry.attempts, random() * 100);
        reduceConcurrency(host, status);
        emit({ state: 'retry', host, status, attempt: recordEntry.attempts });
      } else {
        failures += 1;
        records.delete(target);
        reduceConcurrency(host, status);
        emit({ state: 'failed', host, status });
      }
    } finally {
      active -= 1;
      releaseOrigin(host);
      void schedulePersist();
    }

    if (retry && records.has(target)) {
      delayed += 1;
      await sleepFn(retryDelay);
      delayed -= 1;
      if (records.has(target)) pending.push(target);
      void schedulePersist();
    }
    drain();
    notifyIdle();
  }

  function drain() {
    if (!initialized) return;
    const dynamicMinimum = Math.max(minConcurrency, providerValue(minimumConcurrencyProvider, 0));
    const dynamicCapacity = Math.max(dynamicMinimum, providerValue(capacityProvider, maxConcurrency));
    const effectiveMaximum = Math.min(maxConcurrency, dynamicCapacity);
    currentConcurrency = clamp(currentConcurrency, dynamicMinimum, effectiveMaximum);
    while (active < currentConcurrency) {
      const index = nextTargetIndex();
      if (index < 0) break;
      const target = pending.splice(index, 1)[0];
      void runTarget(target);
    }
    notifyIdle();
  }

  async function initialize() {
    if (!persistEnabled) {
      initialized = true;
      if (earlyTargets.length) addTargets(earlyTargets.splice(0));
      drain();
      notifyIdle();
      return;
    }
    await fsp.mkdir(path.dirname(queueFile), { recursive: true }).catch(() => {});
    try {
      const content = await fsp.readFile(queueFile, 'utf8');
      const parsed = safeJsonParse(content, null);
      for (const item of Array.isArray(parsed?.items) ? parsed.items : []) {
        if (!isValidMediaPrefetchRecord(item, now(), queueTtlMs)) continue;
        const target = String(item.target);
        if (!mediaOriginFor(target) || records.size >= MAX_MEDIA_PREFETCH_QUEUE_ITEMS || records.has(target)) continue;
        records.set(target, { target, enqueuedAt: item.enqueuedAt, attempts: boundedInteger(item?.attempts, 0, 0, maxRetries) });
        pending.push(target);
      }
    } catch {
      // A missing or corrupt queue is equivalent to an empty queue.
    }
    initialized = true;
    if (earlyTargets.length) addTargets(earlyTargets.splice(0));
    drain();
    notifyIdle();
  }

  const ready = initialize();

  function enqueue(targets) {
    const list = Array.isArray(targets) ? targets : (targets ? [targets] : []);
    if (!initialized) earlyTargets.push(...list);
    else addTargets(list);
  }

  async function idle() {
    await ready;
    if (!isIdle()) await new Promise((resolve) => idleWaiters.push(resolve));
    await persistChain;
  }

  function stats() {
    return {
      queued: records.size,
      pending: pending.length,
      active,
      delayed,
      completed,
      failures,
      concurrency: currentConcurrency,
    };
  }

  return { enqueue, idle, ready: () => ready, stats };
}

export function createFeedPrefetchQueue({
  paths = [],
  intervalMs = DEFAULT_FEED_PREFETCH_INTERVAL_MS,
  concurrency = DEFAULT_FEED_PREFETCH_CONCURRENCY,
  maxRetries = DEFAULT_FEED_PREFETCH_MAX_RETRIES,
  retryBackoffMs = DEFAULT_FEED_PREFETCH_RETRY_BACKOFF_MS,
  fetchFeed = async () => ({ ok: false, status: 503 }),
  logger = { info() {}, warn() {}, error() {} },
  now = () => Date.now(),
  sleep: sleepFn = sleep,
} = {}) {
  const idleSleep = (delay) => new Promise((resolve) => {
    const timer = setTimeout(resolve, delay);
    timer.unref?.();
  });
  const limit = Math.min(MAX_FEED_PREFETCH_CONCURRENCY, Math.max(1, Math.floor(Number(concurrency) || DEFAULT_FEED_PREFETCH_CONCURRENCY)));
  const retries = Math.min(MAX_FEED_PREFETCH_RETRIES, Math.max(0, Math.floor(Number(maxRetries) || 0)));
  const interval = Math.max(1_000, Number(intervalMs) || DEFAULT_FEED_PREFETCH_INTERVAL_MS);
  const configured = dedupe(paths.map(String).filter(Boolean));
  const pending = new Map();
  const pathStats = new Map();
  const pausedPaths = new Set();
  const idleWaiters = [];
  let inFlight = 0;
  let completed = 0;
  let failed = 0;
  let lastRunAt = 0;
  let running = false;
  let wake = null;

  function notifyIdle() {
    if (pending.size !== 0 || inFlight !== 0) return;
    while (idleWaiters.length) idleWaiters.shift()();
  }

  function idle() {
    if (pending.size === 0 && inFlight === 0) return Promise.resolve();
    return new Promise((resolve) => idleWaiters.push(resolve));
  }

  function record(feedPath, patch) {
    const entry = pathStats.get(feedPath) || initialFeedPathStats();
    pathStats.set(feedPath, { ...entry, ...patch, paused: pausedPaths.has(feedPath) });
    return pathStats.get(feedPath);
  }

  function togglePause(feedPath, paused) {
    const key = String(feedPath || '').trim();
    if (!key) return false;
    const shouldPause = paused === undefined ? !pausedPaths.has(key) : Boolean(paused);
    if (shouldPause) {
      pausedPaths.add(key);
      pending.delete(key);
    } else {
      pausedPaths.delete(key);
    }
    record(key, { paused: shouldPause });
    return shouldPause;
  }

  function effectiveInterval(key) {
    const entry = pathStats.get(key);
    return feedPrefetchEffectiveInterval(interval, entry?.backoffMultiplier);
  }

  function enqueue(feedPath, { force = false } = {}) {
    const key = String(feedPath || '').trim();
    if (!key) return { queued: 0, skipped: 1 };
    if (pausedPaths.has(key)) return { queued: 0, skipped: 1, reason: 'paused' };
    if (pending.has(key)) return { queued: 0, skipped: 1, reason: 'already-pending' };
    const entry = pathStats.get(key);
    const pathInterval = effectiveInterval(key);
    if (!force && entry?.lastAttemptAt && now() - entry.lastAttemptAt < pathInterval) {
      return { queued: 0, skipped: 1, reason: 'within-interval' };
    }
    pending.set(key, { path: key, attempts: 0, retryAt: 0 });
    record(key, { queued: (pathStats.get(key)?.queued || 0) + 1 });
    if (wake) {
      const resolve = wake;
      wake = null;
      resolve();
    }
    return { queued: 1, skipped: 0 };
  }

  function runCycle() {
    lastRunAt = now();
    let enqueued = 0;
    for (const feedPath of configured) {
      const result = enqueue(feedPath);
      if (result.queued) enqueued += 1;
    }
    return { paths: configured.length, enqueued, queueLength: pending.size };
  }

  function nextPath() {
    const timestamp = now();
    for (const [key, item] of pending) {
      if (item.retryAt <= timestamp) return { key, item };
    }
    return null;
  }

  async function runItem(key, item) {
    const startedAt = now();
    item.attempts += 1;
    record(key, { attempts: item.attempts, lastAttemptAt: startedAt });
    let result;
    try {
      result = await fetchFeed(key);
    } catch (error) {
      result = { ok: false, status: 0, error: error.message };
    }
    const durationMs = now() - startedAt;
    if (result?.notReady) {
      pending.set(key, { ...item, retryAt: now() + 1000 });
      return;
    }
    if (result?.ok) {
      completed += 1;
      pending.delete(key);
      record(key, {
        completed: (pathStats.get(key)?.completed || 0) + 1,
        consecutiveFailures: 0,
        backoffMultiplier: 1,
        lastStatus: result.status,
        lastDurationMs: durationMs,
        lastAttemptAt: startedAt,
      });
      logger.info('feed_prefetch_completed', { path: key, status: result.status, durationMs });
      notifyIdle();
      return;
    }
    if (item.attempts > retries) {
      failed += 1;
      const currentFailures = (pathStats.get(key)?.consecutiveFailures || 0) + 1;
      const nextMultiplier = feedPrefetchBackoffMultiplier(currentFailures);
      record(key, {
        failed: (pathStats.get(key)?.failed || 0) + 1,
        consecutiveFailures: currentFailures,
        backoffMultiplier: nextMultiplier,
        lastStatus: result.status || 0,
        lastDurationMs: durationMs,
      });
      logger.warn('feed_prefetch_failed', {
        path: key,
        status: result.status,
        error: result.error,
        attempts: item.attempts,
        consecutiveFailures: currentFailures,
        backoffMultiplier: nextMultiplier,
      });
      notifyIdle();
      return;
    }
    item.retryAt = now() + feedPrefetchRetryDelay(item.attempts, retryBackoffMs);
    pending.set(key, item);
  }

  async function drainLoop() {
    while (running) {
      if (pending.size === 0) {
        if (inFlight === 0) notifyIdle();
        await new Promise((resolve) => {
          wake = resolve;
          const timer = setTimeout(resolve, 100);
          timer.unref?.();
        });
        continue;
      }
      let spawned = 0;
      while (spawned < limit && inFlight < limit) {
        const next = nextPath();
        if (!next) break;
        pending.delete(next.key);
        inFlight += 1;
        spawned += 1;
        runItem(next.key, next.item)
          .catch((error) => {
            logger.error('feed_prefetch_internal', { error: error.message });
          })
          .finally(() => {
            inFlight -= 1;
            notifyIdle();
          });
      }
      await idleSleep(spawned === 0 ? 20 : 1);
    }
  }

  function start() {
    if (running) return;
    running = true;
    void drainLoop();
  }

  function stop() {
    running = false;
  }

  function stats() {
    return {
      enabled: configured.length > 0,
      configured: configured.length,
      queueLength: pending.size,
      inFlight,
      completed,
      failed,
      lastRunAt,
      paths: Object.fromEntries([...pathStats.entries()].map(([feedPath, entry]) => [feedPath, { ...entry }])),
    };
  }

  return { enqueue, togglePause, runCycle, idle, start, stop, stats };
}

export const DEFAULT_BROWSER_FETCH_HOSTS = Object.freeze([
  'javbus.com',
  'javdb.com',
  'airav.wiki',
  'airav.io',
  'jable.tv',
  'missav.ws',
  'missav.ai',
  'missav.com',
  'missav.live',
  'ggjav.com',
  'ggjav.tv',
  'wnacg.com',
  'wnacg.org',
  'chikubi.jp',
  'skeb.jp',
  'fanbox.cc',
  'kemono.su',
  'kemono.cr',
  'coomer.su',
  'coomer.st',
  'sehuatang.net',
  'linux.do',
]);

export function parseBrowserFetchHosts(envValue, fallback = DEFAULT_BROWSER_FETCH_HOSTS) {
  if (!envValue) return [...fallback];
  const list = parseHostList(envValue);
  return list.length > 0 ? list : [...fallback];
}

export function browserFetchHost(url, hosts = DEFAULT_BROWSER_FETCH_HOSTS) {
  const host = safeHost(url, '');
  return Boolean(host) && matchesHost(host, hosts);
}

export const BROWSER_FETCH_HOSTS = Object.freeze(
  parseBrowserFetchHosts(process.env.GATEWAY_BROWSER_FETCH_HOSTS),
);

export function isBrowserFetchTarget(url, hosts = BROWSER_FETCH_HOSTS) {
  return browserFetchHost(url, hosts);
}

export function createRequestService({
  sourceConfig = {},
  client,
  fetchImpl,
  egressPool,
  browserFetch,
  fetchdFetch,
  fetchExternal,
  fetchRssHub,
  logger = createLogger(),
  createUpstreamClientImpl,
  createBrowserFetchClientImpl,
} = {}) {
  const upstreamClient = client || (createUpstreamClientImpl
    ? createUpstreamClientImpl({ sourceConfig, fetchImpl, egressPool })
    : null);
  const browser = browserFetch || (createBrowserFetchClientImpl
    ? createBrowserFetchClientImpl()
    : null);
  const resolvedFetchdFetch = fetchdFetch || browser?.fetchdFetch;
  const resolvedFetchExternal = fetchExternal || ((url, request) => upstreamClient?.fetchExternal(url, request));
  const resolvedFetchRssHub = fetchRssHub || ((path, request) => upstreamClient?.fetchRssHub(path, undefined, request?.headers, request));

  function fetchJsonViaFetchd(url, request) {
    const startedAt = Date.now();
    const host = safeHost(url);
    return fetchdJson(resolvedFetchdFetch, url, request).catch((error) => {
      logger.debug('request_json_failed', { host, error: error.message, durationMs: Date.now() - startedAt });
      throw error;
    });
  }

  function fetchExternalInstrumented(url, request) {
    const startedAt = Date.now();
    const host = safeHost(url);
    if (browserFetchHost(url, BROWSER_FETCH_HOSTS)) {
      let allowed = false;
      try {
        allowed = isAllowedTarget(url);
      } catch {
        allowed = false;
      }
      if (!allowed) return Promise.reject(new Error('external target is not allowed'));
      const browserRequest = { ...(request || {}), redirect: 'follow' };
      return browser.fetch(url, browserRequest).then((response) => {
        logger.debug('request_external_browser', { host, status: response?.status, durationMs: Date.now() - startedAt });
        return response;
      }).catch((error) => {
        logger.warn('request_external_browser_fallback', { host, error: error.message });
        return resolvedFetchExternal(url, request).then((response) => {
          logger.debug('request_external', { host, status: response?.status, durationMs: Date.now() - startedAt });
          return response;
        });
      });
    }
    return resolvedFetchExternal(url, request).then((response) => {
      logger.debug('request_external', { host, status: response?.status, durationMs: Date.now() - startedAt });
      return response;
    });
  }

  function fetchRssHubInstrumented(path, request) {
    const startedAt = Date.now();
    return resolvedFetchRssHub(path, request).then((response) => {
      logger.debug('request_rsshub', { path, status: response?.status, durationMs: Date.now() - startedAt });
      return response;
    });
  }

  return {
    client: upstreamClient,
    browserFetch: browser,
    fetchdFetch: resolvedFetchdFetch,
    fetchExternal: fetchExternalInstrumented,
    fetchRssHub: fetchRssHubInstrumented,
    fetchJsonViaFetchd,
    openCircuits: () => upstreamClient?.openCircuits?.(),
  };
}

export const BASIC_AUTH_HEADER_RE = /^Basic\s+([A-Za-z0-9+/=]+)$/i;

export function parseProxyAuth(header) {
  if (!header) return null;
  const match = String(header).match(BASIC_AUTH_HEADER_RE);
  if (!match) return null;
  const decoded = Buffer.from(match[1], 'base64').toString('utf8');
  const separator = decoded.indexOf(':');
  if (separator < 0) return null;
  return { username: decoded.slice(0, separator), password: decoded.slice(separator + 1) };
}

export function parseAuthority(value) {
  const match = String(value || '').match(/^([^:]+):(\d+)$/);
  if (!match) return null;
  return { hostname: match[1].toLowerCase(), port: positiveInteger(match[2], 0) };
}

export const DEFAULT_CACHE_ROOT = '/var/cache/rsshub-gateway';
export const DEFAULT_EH_PREFETCH_CONCURRENCY = 8;
export const DEFAULT_EH_PREFETCH_MAX_CONCURRENCY = 36;
export const DEFAULT_EH_MAX_PREFETCH_PAGES = 300;
export const DEFAULT_EH_MEDIA_PREFETCH_CONCURRENCY = 6;
export const DEFAULT_EH_MEDIA_PREFETCH_MIN_CONCURRENCY = 3;
export const DEFAULT_EH_MEDIA_PREFETCH_MAX_CONCURRENCY = 12;
export const DEFAULT_EH_MEDIA_PREFETCH_PER_ORIGIN = 2;
export const DEFAULT_EH_MEDIA_FOREGROUND_WARM_COUNT = 8;
export const DEFAULT_EH_MEDIA_FOREGROUND_WARM_CONCURRENCY = 8;
export const DEFAULT_EH_FIRST_PAINT_COUNT = 1;
export const DEFAULT_EGRESS_MIN_CONCURRENCY_PER_LANE = 3;
export const DEFAULT_EGRESS_MAX_CONCURRENCY_PER_LANE = 6;
export const DEFAULT_EGRESS_MAX_TOTAL_CONCURRENCY = 48;
export const DEFAULT_EGRESS_REFRESH_INTERVAL_MS = 60_000;
export const DEFAULT_MEDIA_CACHE_MAX_FILE_BYTES = 32 * 1024 ** 2;
export const DEFAULT_VIDEO_CACHE_MAX_FILE_BYTES = 256 * 1024 ** 2;
export const DEFAULT_MEDIA_BROWSER_CACHE_SECONDS = 300;
export const DEFAULT_VIDEO_PREFETCH_CONCURRENCY = 4;
export const DEFAULT_IMAGE_VARIANT_CONCURRENCY = 2;
export const DEFAULT_LEASE_BACKFILL_CONCURRENCY = 2;
export const DEFAULT_SLOW_SOURCE_THRESHOLD_MS = 5_000;

export function resolveSlowSourceThresholdMs(raw, fallback = DEFAULT_SLOW_SOURCE_THRESHOLD_MS) {
  const value = Number(raw ?? fallback);
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : Math.floor(Number(fallback));
}

export function parseFeedPrefetchPaths(raw, dedupeFn = dedupe) {
  const list = Array.isArray(raw)
    ? raw.map(String).filter(Boolean)
    : String(raw ?? '').split(',').map((v) => v.trim()).filter(Boolean);
  return typeof dedupeFn === 'function' ? dedupeFn(list) : list;
}

export function parseBooleanOption(raw, fallback = true) {
  if (raw === undefined || raw === null) return fallback;
  if (typeof raw === 'boolean') return raw;
  return String(raw).toLowerCase() !== 'false';
}

export const DEFAULT_EGRESS_SUCCESS_RAMP_AFTER = 6;
export const DEFAULT_EGRESS_COOLDOWN_MS = 500;
export const DEFAULT_EGRESS_BACKGROUND_RESERVE_PER_LANE = 1;
export const DEFAULT_EGRESS_EWMA_ALPHA = 0.2;
export const DEFAULT_EGRESS_MAX_LATENCY_SAMPLE_MS = 10_000;

export function poolError(message, code) {
  return Object.assign(new Error(message), { code });
}

export function createEgressPool(options = {}) {
  const minConcurrencyPerLane = positiveInteger(options.minConcurrencyPerLane, DEFAULT_EGRESS_MIN_CONCURRENCY_PER_LANE);
  const maxConcurrencyPerLane = boundedInteger(options.maxConcurrencyPerLane, DEFAULT_EGRESS_MAX_CONCURRENCY_PER_LANE, minConcurrencyPerLane, 128);
  const successRampAfter = positiveInteger(options.successRampAfter, DEFAULT_EGRESS_SUCCESS_RAMP_AFTER);
  const cooldownMs = nonNegativeInteger(options.cooldownMs, DEFAULT_EGRESS_COOLDOWN_MS);
  const backgroundReservePerLane = nonNegativeInteger(options.backgroundReservePerLane, DEFAULT_EGRESS_BACKGROUND_RESERVE_PER_LANE);
  const blockedStatuses = new Set([...(options.blockedStatuses || DEFAULT_BLOCKED_STATUSES)].map(Number));
  const siteFailureThreshold = positiveInteger(options.siteFailureThreshold, 3);
  const siteFailureWindowMs = Math.max(1_000, positiveInteger(options.siteFailureWindowMs, 60_000));
  const siteBlockCooldownMs = nonNegativeInteger(options.siteBlockCooldownMs, 60_000);
  const scopeOverrides = options.scopeOverrides && typeof options.scopeOverrides === 'object' ? options.scopeOverrides : {};
  const now = options.now || (() => Date.now());
  const onEvent = options.onEvent;
  const siteTracker = options.siteTracker || createSiteFailureTracker({
    threshold: siteFailureThreshold,
    windowMs: siteFailureWindowMs,
    now,
  });
  const laneStates = new Map();
  const waiters = [];
  let cursor = 0;
  let wakeTimer;

  function createState(lane, previous) {
    if (previous) {
      previous.proxyName = String(lane.proxyName || lane.id);
      previous.proxyUrl = String(lane.proxyUrl || '');
      previous.dispatcher = lane.dispatcher;
      if (lane.healthyScopes) previous.healthyScopes = new Set(lane.healthyScopes);
      if (!previous.siteHealth) previous.siteHealth = new Map();
      return previous;
    }
    return {
      id: String(lane.id),
      proxyName: String(lane.proxyName || lane.id),
      proxyUrl: String(lane.proxyUrl || ''),
      dispatcher: lane.dispatcher,
      active: 0,
      targetConcurrency: minConcurrencyPerLane,
      successStreak: 0,
      cooldownUntil: 0,
      siteHealth: new Map(),
      healthyScopes: lane.healthyScopes ? new Set(lane.healthyScopes) : null,
      ewmaMs: 0,
      samples: 0,
    };
  }

  function emit(event) {
    safeEvent(onEvent, event);
  }

  function setLanes(lanes = []) {
    const next = new Map();
    for (const lane of lanes) {
      if (!lane?.id) continue;
      next.set(String(lane.id), createState(lane, laneStates.get(String(lane.id))));
    }
    laneStates.clear();
    for (const [id, lane] of next) laneStates.set(id, lane);
    if (!laneStates.size) {
      while (waiters.length) waiters.shift().reject(poolError('no healthy egress lanes are available', 'EGRESS_POOL_EMPTY'));
      emit({ state: 'empty', lanes: 0 });
    }
    drain();
  }

  function availableLanes(priority = 'foreground') {
    const timestamp = now();
    return [...laneStates.values()].filter((lane) => {
      const reserve = priority === 'background'
        ? Math.min(backgroundReservePerLane, Math.max(0, lane.targetConcurrency - 1))
        : 0;
      return lane.active < Math.max(0, lane.targetConcurrency - reserve) && lane.cooldownUntil <= timestamp;
    });
  }

  function effectiveScope(host, scope) {
    if (host && scopeOverrides[String(host).toLowerCase()]) {
      return scopeOverrides[String(host).toLowerCase()];
    }
    return scope || 'public';
  }

  function laneHealthyForScope(lane, scope) {
    if (!lane.healthyScopes || lane.healthyScopes.has(scope)) return true;
    return false;
  }

  function chooseLane({ priority = 'foreground', galleryShard, host, scope } = {}) {
    const requestScope = effectiveScope(host, scope);
    const timestamp = now();
    const hostKey = String(host || '').toLowerCase();
    const lanes = availableLanes(priority).filter((lane) => laneHealthyForScope(lane, requestScope));
    if (!lanes.length) return undefined;
    const unblocked = lanes.filter((lane) => {
      const until = lane.siteHealth.get(hostKey);
      return until === undefined || until <= timestamp;
    });
    let candidates = unblocked;
    if (!unblocked.length) {
      candidates = lanes;
      emit({ state: 'site-degraded', host: hostKey, scope: requestScope });
    }
    if (Number.isInteger(galleryShard) && galleryShard >= 0) {
      const allLanes = [...laneStates.values()].filter((lane) => lane.cooldownUntil <= now());
      const hinted = allLanes[galleryShard % allLanes.length];
      if (hinted && candidates.includes(hinted)) return hinted;
    }
    candidates.sort((left, right) => left.active - right.active || left.id.localeCompare(right.id));
    const leastActive = candidates[0].active;
    const tied = candidates.filter((lane) => lane.active === leastActive);
    const measured = tied.filter((lane) => lane.samples > 0);
    if (!measured.length || measured.length < tied.length) {
      const lane = tied[cursor % tied.length];
      cursor = (cursor + 1) % Math.max(1, tied.length);
      return lane;
    }
    const fastest = Math.min(...measured.map((lane) => lane.ewmaMs));
    const fastestLanes = measured.filter((lane) => lane.ewmaMs === fastest);
    const lane = fastestLanes[cursor % fastestLanes.length];
    cursor = (cursor + 1) % Math.max(1, fastestLanes.length);
    return lane;
  }

  function scheduleWake() {
    if (wakeTimer || !waiters.length) return;
    const nextCooldown = [...laneStates.values()]
      .map((lane) => lane.cooldownUntil)
      .filter((value) => value > now())
      .sort((left, right) => left - right)[0];
    if (!nextCooldown) return;
    wakeTimer = setTimeout(() => {
      wakeTimer = undefined;
      drain();
    }, Math.max(1, nextCooldown - now()));
  }

  function recordResult(lane, result = {}, durationMs = 0) {
    const status = Number(result.status);
    const hostKey = result.host ? String(result.host).toLowerCase() : undefined;
    if (isSuccessfulStatus(status)) {
      lane.ewmaMs = lane.samples ? lane.ewmaMs * (1 - DEFAULT_EGRESS_EWMA_ALPHA) + durationMs * DEFAULT_EGRESS_EWMA_ALPHA : durationMs;
      lane.samples += 1;
      if (hostKey) {
        siteTracker.reset(lane.id, hostKey);
        lane.siteHealth.delete(hostKey);
      }
      lane.successStreak += 1;
      if (lane.successStreak >= successRampAfter) {
        lane.targetConcurrency = Math.min(maxConcurrencyPerLane, lane.targetConcurrency + 1);
        lane.successStreak = 0;
        emit({ state: 'ramp', laneId: lane.id, targetConcurrency: lane.targetConcurrency });
      }
      return;
    }
    if (isRetryableStatus(status) || result.error) {
      lane.successStreak = 0;
      lane.targetConcurrency = Math.max(minConcurrencyPerLane, lane.targetConcurrency - 1);
      lane.cooldownUntil = now() + cooldownMs;
      emit({ state: 'backoff', laneId: lane.id, status: Number.isInteger(status) ? status : 504, targetConcurrency: lane.targetConcurrency });
    }
    if (hostKey && blockedStatuses.has(status)) {
      if (siteTracker.record(lane.id, hostKey, status)) {
        lane.siteHealth.set(hostKey, now() + siteBlockCooldownMs);
        emit({ state: 'site-blocked', laneId: lane.id, host: hostKey, status });
      }
    }
  }

  function makeLease(lane, context = {}) {
    lane.active += 1;
    const startedAt = now();
    let released = false;
    return {
      laneId: lane.id,
      proxyName: lane.proxyName,
      proxyUrl: lane.proxyUrl,
      dispatcher: lane.dispatcher,
      host: context.host,
      release(result) {
        if (released) return;
        released = true;
        lane.active = Math.max(0, lane.active - 1);
        const durationMs = clamp(now() - startedAt, 0, DEFAULT_EGRESS_MAX_LATENCY_SAMPLE_MS);
        recordResult(lane, { ...result, host: result.host || context.host }, durationMs);
        drain();
      },
    };
  }

  function drain() {
    while (waiters.length) {
      const indexes = waiters.map((_, index) => index).sort((left, right) => (
        (waiters[left].priority === 'background' ? 1 : 0)
        - (waiters[right].priority === 'background' ? 1 : 0)
        || left - right
      ));
      let selectedIndex = -1;
      let selectedLane;
      for (const index of indexes) {
        const lane = chooseLane({ priority: waiters[index].priority, galleryShard: waiters[index].context.galleryShard, host: waiters[index].context.host, scope: waiters[index].context.scope });
        if (lane) {
          selectedIndex = index;
          selectedLane = lane;
          break;
        }
      }
      if (selectedIndex < 0) break;
      const waiter = waiters.splice(selectedIndex, 1)[0];
      waiter.resolve(makeLease(selectedLane));
    }
    scheduleWake();
  }

  function acquire(context = {}) {
    const priority = context.priority === 'background' ? 'background' : 'foreground';
    const lane = chooseLane({ priority, galleryShard: context.galleryShard, host: context.host, scope: context.scope });
    if (lane) return Promise.resolve(makeLease(lane, context));
    if (!laneStates.size) return Promise.reject(poolError('no healthy egress lanes are available', 'EGRESS_POOL_EMPTY'));
    return new Promise((resolve, reject) => {
      waiters.push({ resolve, reject, context, priority });
      scheduleWake();
    });
  }

  setLanes(options.lanes || []);

  return {
    acquire,
    setLanes,
    capacity: () => [...laneStates.values()].reduce((total, lane) => total + lane.targetConcurrency, 0),
    minimumCapacity: () => laneStates.size * minConcurrencyPerLane,
    stats: () => ({
      active: [...laneStates.values()].reduce((total, lane) => total + lane.active, 0),
      lanes: [...laneStates.values()].map((lane) => ({
        id: lane.id,
        active: lane.active,
        targetConcurrency: lane.targetConcurrency,
        siteBlocked: [...lane.siteHealth.keys()],
        healthyScopes: lane.healthyScopes ? [...lane.healthyScopes] : null,
        samples: lane.samples,
        ewmaMs: lane.samples ? Math.round(lane.ewmaMs) : undefined,
      })),
    }),
  };
}

export const DEFAULT_FETCHER_PORT = 8000;
export const DEFAULT_FETCHER_HOST = '0.0.0.0';
export const DEFAULT_REGISTER_RETRIES = 10;
export const DEFAULT_REGISTER_RETRY_DELAY_MS = 2000;
export const DEFAULT_REGISTER_TIMEOUT_MS = 5000;
export const DEFAULT_UNREGISTER_TIMEOUT_MS = 3000;
export const DEFAULT_ROUTES_FILE = 'gateway-routes.yaml';
export const DEFAULT_SIDECAR_TIMEOUT_MS = 60_000;

export function createFetcherServer({ fetcher, health = () => ({ ok: true }), name = 'fetcher', httpServerImpl } = {}) {
  const createServerFn = httpServerImpl || http.createServer;
  return createServerFn(async (req, res) => {
    const url = new URL(req.url || '/', 'http://localhost');
    if (req.method === 'GET' && url.pathname === '/healthz') {
      writeJson(res, 200, { ok: true, ...health() });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/fetch') {
      let body;
      try {
        body = await readJsonBody(req);
      } catch {
        writeJson(res, 400, { error: 'invalid json body' });
        return;
      }
      try {
        const result = await fetcher.handleFetch(body);
        writeJson(res, 200, result);
      } catch (error) {
        const status = error instanceof HttpError ? error.status : 502;
        writeJson(res, status, { error: error.message });
      }
      return;
    }
    writeJson(res, 404, { error: 'not found' });
  });
}

export function listenFetcher(server, port = DEFAULT_FETCHER_PORT, host = DEFAULT_FETCHER_HOST, name = 'fetcher') {
  return new Promise((resolve) => server.listen(port, host, resolve))
    .then(() => {
      process.stdout.write(JSON.stringify({ event: `${name}_listening`, port, ts: new Date().toISOString() }) + '\n');
    });
}

export async function registerDispatcherRoutes({
  url,
  token,
  routes,
  name = 'fetcher',
  retries = DEFAULT_REGISTER_RETRIES,
  retryDelayMs = DEFAULT_REGISTER_RETRY_DELAY_MS,
  fetchImpl = fetch,
  timeoutMs = DEFAULT_REGISTER_TIMEOUT_MS,
} = {}) {
  if (!url || !token || !Array.isArray(routes) || routes.length === 0) return false;
  const payload = JSON.stringify({ routes });
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      const response = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: payload,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) throw new Error(`gateway returned ${response.status}`);
      process.stdout.write(JSON.stringify({
        event: `${name}_routes_registered`,
        routes: routes.length,
        ts: new Date().toISOString(),
      }) + '\n');
      return true;
    } catch (error) {
      if (attempt >= retries) {
        process.stderr.write(JSON.stringify({
          event: `${name}_routes_registration_failed`,
          error: error.message,
          ts: new Date().toISOString(),
        }) + '\n');
        return false;
      }
      await sleep(retryDelayMs);
    }
  }
  return false;
}

export async function unregisterDispatcherRoutes({
  url,
  token,
  routeIds,
  name = 'fetcher',
  fetchImpl = fetch,
  timeoutMs = DEFAULT_UNREGISTER_TIMEOUT_MS,
} = {}) {
  if (!url || !token || !Array.isArray(routeIds) || routeIds.length === 0) return;
  try {
    await fetchImpl(url, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ routeIds }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    process.stdout.write(JSON.stringify({
      event: `${name}_routes_unregistered`,
      routes: routeIds.length,
      ts: new Date().toISOString(),
    }) + '\n');
  } catch (error) {
    process.stderr.write(JSON.stringify({
      event: `${name}_routes_unregister_failed`,
      error: error.message,
      ts: new Date().toISOString(),
    }) + '\n');
  }
}

export const DEFAULT_ADAPTER_UNAVAILABLE_MESSAGE = '该来源暂时无法读取，请稍后重试或打开原始来源。';

export const defaultAdapter = {
  name: 'unknown',
  publiclyReadable: false,
  headers: () => ({}),
  isAuthenticationChallenge: () => false,
  readerTarget: (url) => String(url),
  isGalleryUrl: () => false,
  galleryPageUrls: () => [],
  imagePageUrls: () => [],
  firstImagePageUrl: () => '',
  unavailableMessage: () => DEFAULT_ADAPTER_UNAVAILABLE_MESSAGE,
};

export function resolveSourceMode(source, config = {}) {
  if (source === 'iwara') return config.cookie ? 'authenticated' : 'public';
  if (source === 'x') return config.authToken ? 'authenticated' : 'public';
  if (source === 'instagram') return config.cookie ? 'authenticated' : 'public';
  return 'public';
}

export function matchAdapter(url, adapterList = [], fallback = defaultAdapter) {
  const hostname = safeHost(url, '');
  if (!hostname) {
    return { ...fallback };
  }
  return { ...fallback, ...adapterList.find((adapter) => adapter.matches(hostname)) };
}

export function getAdapterSourceNames(adapterList = []) {
  return adapterList.map((adapter) => adapter.name).filter(Boolean);
}

export function isKnownAdapterTarget(url, adapterList = [], fallback = defaultAdapter) {
  const adapter = matchAdapter(url, adapterList, fallback);
  return Boolean(adapter && adapter.name !== 'unknown');
}

export const X_MATCH_HOSTS = Object.freeze(['x.com', 'twitter.com', 'twimg.com']);
export const DEFAULT_X_UNAVAILABLE_MESSAGE = 'X 内容暂时无法读取。公开内容可能受登录或访问限制。';
export const X_AUTH_FLOW_LOGIN_PATTERN = /\/i\/flow\/login(?:[/?#]|$)/i;

export function isXReaderUnavailable(html, cheerioParser) {
  if (typeof html !== 'string' || !html) return false;
  if (!cheerioParser) {
    return !html.includes('data-testid="tweet"')
      && !html.includes('<article')
      && (html.includes('/i/flow/login') || (html.includes('name="password"') && html.includes('autocomplete="username"')));
  }
  const $ = cheerioParser.load(html);
  return $('[data-testid="tweet"], article').length === 0
    && $('form[action*="login"], form input[name="text"][autocomplete="username"], form input[name="password"], a[href*="/i/flow/login"]').length > 0;
}

export function xHeaders(config = {}, { includeCredentials = false } = {}) {
  if (!includeCredentials) return {};
  const cookies = [];
  if (config.authToken) cookies.push(`auth_token=${config.authToken}`);
  if (config.ct0) cookies.push(`ct0=${config.ct0}`);
  return cookies.length ? { cookie: cookies.join('; ') } : {};
}

export const INSTAGRAM_MATCH_HOSTS = Object.freeze(['instagram.com', 'cdninstagram.com', 'fbcdn.net']);
export const DEFAULT_INSTAGRAM_UNAVAILABLE_MESSAGE = 'Instagram 内容暂时无法读取。公开内容可能受登录或访问限制。';
export const INSTAGRAM_AUTH_LOGIN_PATTERN = /\/(?:accounts\/login|login)(?:[/?#]|$)/i;

export function isInstagramReaderUnavailable(html, cheerioParser) {
  if (typeof html !== 'string' || !html) return false;
  if (!cheerioParser) {
    return !html.includes('<article')
      && html.includes('name="username"')
      && html.includes('name="password"');
  }
  const $ = cheerioParser.load(html);
  return $('article').length === 0
    && $('form input[name="username"], form input[name="password"]').length > 0;
}

export function telegramReaderTarget(value, matchHosts = TELEGRAM_MATCH_HOSTS) {
  try {
    const url = new URL(value);
    if (isTelegramChannelPostUrl(url, matchHosts)) {
      url.searchParams.set('embed', '1');
    }
    return url.toString();
  } catch {
    return String(value || '');
  }
}

export const TELEGRAM_MATCH_HOSTS = Object.freeze(['t.me']);
export const DEFAULT_TELEGRAM_UNAVAILABLE_MESSAGE = 'Telegram 内容暂时无法读取，请稍后重试或打开原始来源。';

export function isTelegramChannelPostUrl(value, matchHosts = TELEGRAM_MATCH_HOSTS) {
  try {
    const url = new URL(value);
    const parts = url.pathname.split('/').filter(Boolean);
    return matchesHost(url.hostname, matchHosts) && parts.length === 2 && /^\d+$/.test(parts[1]);
  } catch {
    return false;
  }
}

export const PIXIV_DEFAULT_REFERER = 'https://www.pixiv.net/';
export const PIXIV_MATCH_HOSTS = Object.freeze(['pixiv.net', 'pximg.net']);
export const DEFAULT_PIXIV_UNAVAILABLE_MESSAGE = 'Pixiv 内容暂时无法读取，请稍后重试或打开原始来源。';

export function pixivHeaders(config = {}, { includeCredentials = false, defaultReferer = PIXIV_DEFAULT_REFERER } = {}) {
  const result = { referer: config?.referer || defaultReferer };
  if (includeCredentials && config?.cookie) result.cookie = config.cookie;
  return result;
}

export const DEFAULT_ADULT_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
export const DEFAULT_ADULT_ACCEPT_LANGUAGE = 'zh-CN,zh;q=0.9,ja;q=0.8,en;q=0.7';

export const ADULT_DOMAINS = Object.freeze([
  'jable.tv',
  'missav.ws',
  'missav.ai',
  'missav.com',
  'missav.live',
  'javbus.com',
  'javbus.one',
  'javdb.com',
  'airav.wiki',
  'airav.io',
  'ggjav.com',
  'ggjav.tv',
  'wnacg.com',
  'wnacg.org',
  'chikubi.jp',
  'skeb.jp',
  'fanbox.cc',
  'kemono.su',
  'kemono.party',
  'kemono.cr',
  'coomer.su',
  'coomer.party',
  'coomer.st',
  'sehuatang.net',
  'uraaka-joshi.com',
  'netflav.com',
  '91porn.com',
]);

export function adultMediaHeaders({ userAgent = DEFAULT_ADULT_USER_AGENT, acceptLanguage = DEFAULT_ADULT_ACCEPT_LANGUAGE } = {}) {
  return {
    'User-Agent': userAgent,
    'Accept-Language': acceptLanguage,
  };
}

export const DEFAULT_ADULT_UNAVAILABLE_MESSAGE = '该视频/漫画页面暂时无法直接读取，请稍后刷新或点击打开原始来源。';
export const ADULT_CHALLENGE_SUBSTRINGS = Object.freeze([
  'Just a moment...',
  'cf-challenge',
  'ddos-guard',
  'cloudflare-static',
]);

export function isAdultMediaChallenge({ status, headers, body } = {}) {
  if (status === 401 || status === 403) return true;
  if (status < 200 || status >= 300 || typeof body !== 'string') return false;
  return ADULT_CHALLENGE_SUBSTRINGS.some((substr) => body.includes(substr));
}

export const SLICE_ALIGN = 64 * 1024;
export const DEFAULT_SLICE_SIZE = 4 * 1024 * 1024;
export const DEFAULT_SLICE_LOOKAHEAD_BYTES = 16 * 1024 * 1024;
export const DEFAULT_KNOWN_SIZE_TTL_MS = 24 * 60 * 60_000;
export const DEFAULT_KNOWN_SIZE_CAP = 10_000;
export const DEFAULT_PREFETCH_STATES_CAP = 1000;

export function defaultSessionNamespace(session) {
  return session?.fingerprint ? `session:${session.fingerprint}` : `session:${session?.id || 'unknown'}`;
}

export function defaultNamespaceFor(scope, session, sessionNamespaceFn = defaultSessionNamespace) {
  return scope === 'session' ? sessionNamespaceFn(session) : scope;
}

export function sliceRanges(start, end, size, {
  sliceSize = DEFAULT_SLICE_SIZE,
  lookahead = DEFAULT_SLICE_LOOKAHEAD_BYTES,
} = {}) {
  const slice = Math.max(SLICE_ALIGN, Math.ceil(sliceSize / SLICE_ALIGN) * SLICE_ALIGN);
  const from = Math.max(0, Number(start) || 0);
  const endValue = end === undefined || end === null ? size - 1 : Number(end);
  const to = Number.isFinite(endValue) ? Math.min(size - 1, endValue) : size - 1;
  if (from > to || !Number.isSafeInteger(size) || size <= 0) return { slice, ranges: [] };
  const firstIndex = Math.floor(from / slice);
  const prefetchEnd = Math.min(size - 1, Math.max(to, firstIndex * slice + lookahead - 1));
  const lastIndex = Math.floor(prefetchEnd / slice);
  const ranges = [];
  for (let index = firstIndex; index <= lastIndex; index += 1) {
    ranges.push({ start: index * slice, end: Math.min(size - 1, index * slice + slice - 1), index });
  }
  return { slice, ranges };
}

export function unavailableMediaResponse() {
  return new Response('video unavailable\n', {
    status: 502,
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  });
}

export function createMediaTransport({
  cache,
  fetchExternal,
  resolveMediaUrl,
  isVideoTarget = () => false,
  makeImageVariant,
  variantLimiter = async (task) => task(),
  imageVariantMaxSourceBytes = 32 * 1024 ** 2,
  mediaCacheMaxFileBytes = 32 * 1024 ** 2,
  videoCacheMaxFileBytes = 256 * 1024 ** 2,
  sliceSize = 4 * 1024 * 1024,
  sliceLookaheadBytes = 16 * 1024 * 1024,
  sliceFillConcurrency = 4,
  prefetchConcurrency = sliceFillConcurrency,
  mediaBrowserCacheSeconds = 300,
  createSignedChunk,
  routeRequest,
  resolveSession = async () => null,
  sessionNamespace = defaultSessionNamespace,
  namespaceFor = defaultNamespaceFor,
  adapterFor = () => ({ name: 'unknown' }),
  onImageWarmup,
  logger = { info() {}, warn() {}, error() {} },
  onMetric = () => {},
  knownSizeTtlMs = 24 * 60 * 60_000,
  knownSizeCap = 10_000,
  now = () => Date.now(),
} = {}) {
  const knownVideoSizes = new Map();
  const videoPrefetchInflight = new Map();
  const videoPrefetchStates = new Map();
  const PREFETCH_STATES_CAP = 1000;
  const KNOWN_SIZE_CAP = knownSizeCap;
  function rememberVideoSize(target, size) {
    const timestamp = now();
    const existing = knownVideoSizes.get(target);
    if (existing) {
      existing.size = size;
      existing.at = timestamp;
      return;
    }
    knownVideoSizes.set(target, { size, at: timestamp });
    if (knownVideoSizes.size > KNOWN_SIZE_CAP) {
      knownVideoSizes.delete(knownVideoSizes.keys().next().value);
    }
  }

  function knownVideoSize(target) {
    const entry = knownVideoSizes.get(target);
    if (!entry) return undefined;
    if (now() - entry.at > knownSizeTtlMs) {
      knownVideoSizes.delete(target);
      return undefined;
    }
    return entry.size;
  }

  async function readBinaryLimited(response, limit) {
    if (Buffer.isBuffer(response.body)) {
      if (response.body.length > limit) throw new Error('upstream media response too large');
      return response.body;
    }
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body ?? []) {
      size += chunk.length;
      if (size > limit) throw new Error('upstream media response too large');
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }

  function transportCacheStateLog(url, kind, state) {
    try {
      logger.info('gateway_cache', { host: new URL(url).hostname, kind, state });
    } catch {
      // Cache diagnostics must never affect the response.
    }
  }

  async function load({ target, kind = 'media', namespace = 'public', range, maxBytes, request }) {
    const requestOptions = { ...request, range, circuit: false };
    const foreground = request?.priority === 'foreground';
    if (!cache || range) {
      return { response: await fetchExternal(target, requestOptions), cacheState: 'BYPASS' };
    }
    const result = await cache.getOrLoad(target, kind, async () => {
      const remote = await fetchExternal(target, requestOptions);
      const contentType = remote.headers.get('content-type') || '';
      const contentLength = nonNegativeInteger(remote.headers.get('content-length'), null);
      const cacheable = remote.ok
        && (contentType.toLowerCase().startsWith('image/') || contentType.toLowerCase().startsWith('video/'))
        && contentLength !== null
        && contentLength <= maxBytes;
      if (!cacheable) {
        return { passthrough: remote, cacheable: false };
      }
      if (foreground) {
        const cacheCopy = remote.clone();
        return {
          passthrough: remote,
          status: remote.status,
          headers: responseHeaders(remote),
          cacheable: true,
          cacheBody: async () => ({
            status: remote.status,
            headers: responseHeaders(remote),
            body: await readBinaryLimited(cacheCopy, maxBytes),
            cacheable: true,
          }),
        };
      }
      return {
        status: remote.status,
        headers: responseHeaders(remote),
        body: await readBinaryLimited(remote, maxBytes),
        cacheable: true,
      };
    }, { namespace, bypassInflight: foreground, deferStore: foreground });
    transportCacheStateLog(target, kind, result.state);
    return {
      response: result.passthrough || responseFromCachedDocument(result),
      cacheState: result.state,
    };
  }

  async function readRange({ target, namespace = 'public', range }) {
    if (!cache) return null;
    const ranged = await cache.readRange(target, 'media', { namespace });
    if (!ranged) return null;
    const parsed = parseByteRange(range, ranged.size);
    if (!parsed) return null;
    if (parsed.unsatisfiable) {
      return new Response(null, {
        status: 416,
        headers: {
          'content-range': `bytes */${ranged.size}`,
          'content-type': ranged.entry.headers['content-type'] || 'application/octet-stream',
        },
      });
    }
    const stream = ranged.createStream(parsed.start, parsed.end);
    if (!stream) return null;
    const headers = {
      'content-type': ranged.entry.headers['content-type'] || 'application/octet-stream',
      'content-length': String(parsed.end - parsed.start + 1),
      'content-range': `bytes ${parsed.start}-${parsed.end}/${ranged.size}`,
      'accept-ranges': 'bytes',
    };
    for (const name of ['etag', 'last-modified']) {
      const value = ranged.entry.headers[name];
      if (value) headers[name] = value;
    }
    return new Response(Readable.toWeb(stream), { status: 206, headers });
  }

  async function readCached(target, kind = 'media', namespace = 'public', { bypassInflight = false } = {}) {
    if (!cache) return null;
    const miss = new Error('gateway cache miss');
    miss.code = 'GATEWAY_CACHE_MISS';
    try {
      const result = await cache.getOrLoad(target, kind, async () => { throw miss; }, {
        allowStale: kind !== 'eh-image',
        namespace,
        bypassInflight,
        ignoreFresh: bypassInflight,
      });
      return responseFromCachedDocument(result);
    } catch (error) {
      if (error?.code !== 'GATEWAY_CACHE_MISS') throw error;
      return null;
    }
  }

  async function cacheMedia(target, namespace, response, { bypassInflight = false } = {}) {
    if (!cache) return response;
    const contentType = response.headers.get('content-type') || '';
    const contentLength = nonNegativeInteger(response.headers.get('content-length'), null);
    const mediaType = contentType.toLowerCase();
    const mediaBytes = mediaType.startsWith('video/') ? videoCacheMaxFileBytes : mediaCacheMaxFileBytes;
    const cacheable = response.ok
      && (mediaType.startsWith('image/') || mediaType.startsWith('video/'))
      && contentLength !== null
      && contentLength <= mediaBytes;
    if (!cacheable) return response;
    if (bypassInflight) {
      const cacheCopy = response.clone();
      const result = await cache.getOrLoad(target, 'media', async () => ({
        passthrough: response,
        status: response.status,
        headers: responseHeaders(response),
        cacheable: true,
        cacheBody: async () => ({
          status: response.status,
          headers: responseHeaders(response),
          body: await readBinaryLimited(cacheCopy, mediaBytes),
          cacheable: true,
        }),
      }), {
        namespace,
        bypassInflight: true,
        ignoreFresh: true,
        deferStore: true,
      });
      transportCacheStateLog(target, 'media', result.state);
      return result.passthrough || responseFromCachedDocument(result);
    }
    const body = await readBinaryLimited(response, mediaBytes);
    const result = await cache.getOrLoad(target, 'media', async () => ({
      status: response.status,
      headers: responseHeaders(response),
      body,
      cacheable: true,
    }), { namespace, bypassInflight });
    transportCacheStateLog(target, 'media', result.state);
    return responseFromCachedDocument(result);
  }

  async function mediaVariant(source, target, width, namespace) {
    const original = source.response;
    if (!original?.ok || !original.body) return source;
    if (!(original.headers.get('content-type') || '').toLowerCase().startsWith('image/')) return source;

    let variant;
    let sourceBytes = 0;
    const startedAt = Date.now();
    try {
      const body = await readBinaryLimited(original.clone(), imageVariantMaxSourceBytes);
      sourceBytes = body.length;
      variant = await variantLimiter(() => makeImageVariant({
        body,
        contentType: original.headers.get('content-type') || '',
        width,
      }));
    } catch {
      onMetric('image_variant_fallback', {
        source: source.adapter?.name || 'unknown',
        width,
        reason: 'transform-failed',
        durationMs: Date.now() - startedAt,
      });
      return source;
    }
    if (!variant?.usedVariant || !Buffer.isBuffer(variant.body)) {
      onMetric('image_variant_fallback', {
        source: source.adapter?.name || 'unknown',
        width,
        reason: 'not-smaller',
        durationMs: Date.now() - startedAt,
      });
      return source;
    }
    onMetric('image_variant_generated', {
      source: source.adapter?.name || 'unknown',
      width,
      sourceBytes,
      variantBytes: variant.body.length,
      durationMs: Date.now() - startedAt,
    });

    const headers = responseHeaders(original);
    headers['content-type'] = variant.contentType;
    headers['content-length'] = String(variant.body.length);
    const cacheUrl = imageVariantCacheUrl(target, width);
    if (!cache) {
      return {
        ...source,
        response: new Response(variant.body, { status: original.status, statusText: original.statusText, headers }),
      };
    }

    const result = await cache.getOrLoad(cacheUrl, 'media-variant', async () => ({
      status: original.status,
      headers,
      body: variant.body,
      cacheable: true,
    }), { namespace });
    transportCacheStateLog(target, 'media-variant', result.state);
    return { ...source, response: responseFromCachedDocument(result) };
  }

  function maybeWarmupImageVariants(target, namespace, response, variantWidth) {
    if (variantWidth !== undefined || typeof onImageWarmup !== 'function') return;
    if (!response?.ok) return;
    const contentType = response.headers.get('content-type') || '';
    if (!contentType.toLowerCase().startsWith('image/')) return;
    queueMicrotask(() => {
      onImageWarmup(target, namespace).catch(() => {
        // Background variant warmup must never affect the served response.
      });
    });
  }

  function sliceKey(target, start) {
    return `${String(target)}#slice=${start}`;
  }

  async function fetchSliceIntoCache(target, resolvedUrl, namespace, part, { priority }) {
    if (!cache) return { status: 'failed' };
    const key = sliceKey(target, part.start);
    const existing = await cache.readRange(key, 'media', { namespace });
    if (existing && existing.size === part.end - part.start + 1) return { status: 'cached' };
    try {
      await cache.getOrLoad(key, 'media', async () => {
        const response = await fetchExternal(resolvedUrl, {
          range: `bytes=${part.start}-${part.end}`,
          circuit: false,
          priority,
        });
        if (!response?.ok) throw new Error(`slice ${part.start} fetch failed`);
        const body = await readBinaryLimited(response, sliceSize + 64 * 1024);
        if (body.length !== part.end - part.start + 1) {
          throw new Error(`slice ${part.start} short body`);
        }
        return {
          status: response.status,
          headers: responseHeaders(response),
          body,
          cacheable: true,
        };
      }, { namespace });
      return { status: 'stored' };
    } catch {
      return { status: 'failed' };
    }
  }

  async function readSliceRange(target, namespace, range, size) {
    if (!cache) return null;
    const parsed = parseByteRange(range, size);
    if (!parsed) return null;
    if (parsed.unsatisfiable) {
      return new Response(null, {
        status: 416,
        headers: {
          'content-range': `bytes */${size}`,
          'content-type': 'application/octet-stream',
        },
      });
    }
    const plan = sliceRanges(parsed.start, parsed.end, size, {
      sliceSize,
      lookahead: Math.max(1, parsed.end - parsed.start + 1),
    });
    const slices = [];
    for (const part of plan.ranges) {
      const ranged = await cache.readRange(sliceKey(target, part.start), 'media', { namespace });
      if (!ranged || ranged.size !== part.end - part.start + 1) return null;
      slices.push({ ranged, part });
    }
    if (!slices.length) return null;
    const headers = {
      'content-type': slices[0].ranged.entry.headers['content-type'] || 'application/octet-stream',
      'content-length': String(parsed.end - parsed.start + 1),
      'content-range': `bytes ${parsed.start}-${parsed.end}/${size}`,
      'accept-ranges': 'bytes',
    };
    for (const name of ['etag', 'last-modified']) {
      const value = slices[0].ranged.entry.headers[name];
      if (value) headers[name] = value;
    }
    async function* bytes() {
      for (let index = 0; index < slices.length; index += 1) {
        const { ranged, part } = slices[index];
        const from = index === 0 ? parsed.start - part.start : 0;
        const to = index === slices.length - 1 ? parsed.end - part.start : part.end - part.start;
        const stream = ranged.createStream(from, to);
        if (!stream) throw new Error('slice stream unavailable');
        for await (const chunk of stream) yield chunk;
      }
    }
    return new Response(Readable.toWeb(Readable.from(bytes())), { status: 206, headers });
  }

  async function fillVideoSlices(target, resolvedUrl, size, namespace, parsed, maxSliceBytes = videoCacheMaxFileBytes, options = {}) {
    if (!cache) return;
    const { shouldStop } = options;
    const plan = sliceRanges(parsed.start, parsed.end, size, { sliceSize, lookahead: sliceLookaheadBytes });
    if (!plan.ranges.length || plan.ranges[0].start >= maxSliceBytes) return;
    const missing = [];
    for (const part of plan.ranges) {
      if (part.start >= maxSliceBytes) break;
      if (shouldStop?.()) return;
      const existing = await cache.readRange(sliceKey(target, part.start), 'media', { namespace });
      if (!existing || existing.size !== part.end - part.start + 1) missing.push(part);
    }
    if (!missing.length) return;
    let next = 0;
    async function worker() {
      while (next < missing.length) {
        if (shouldStop?.()) return;
        const part = missing[next];
        next += 1;
        try {
          await fetchSliceIntoCache(target, resolvedUrl, namespace, part, { priority: 'background' });
        } catch {
          // Slice fill failures are background noise; the upstream path still works.
        }
      }
    }
    const workers = [];
    for (let index = 0; index < Math.min(sliceFillConcurrency, missing.length); index += 1) {
      workers.push(worker());
    }
    await Promise.all(workers);
  }

  async function prefetchVideoFile(target, { size, shouldStop } = {}) {
    if (!cache || !isVideoTarget(target)) return 0;
    const inflight = videoPrefetchInflight.get(target);
    if (inflight) return inflight;
    const state = { status: 'running', fetched: 0, failed: 0, total: null, startedAt: now(), completedAt: null };
    videoPrefetchStates.set(target, state);
    if (videoPrefetchStates.size > PREFETCH_STATES_CAP) {
      videoPrefetchStates.delete(videoPrefetchStates.keys().next().value);
    }
    const promise = (async () => {
      try {
        const resolved = await resolveMediaUrl(target);
        if (!resolved?.url) return 0;
        let fileSize = Number.isSafeInteger(size) && size > 0 ? size : knownVideoSize(target);
        if (!(Number.isSafeInteger(fileSize) && fileSize > 0)) {
          const probe = await fetchExternal(resolved.url, {
            range: 'bytes=0-0',
            circuit: false,
            priority: 'background',
          });
          const probeRange = (probe.headers.get('content-range') || '').match(/\/(\d+)\s*$/);
          const probedSize = probeRange ? Number(probeRange[1]) : null;
          await probe.body?.cancel();
          if (!(Number.isSafeInteger(probedSize) && probedSize > 0)) return 0;
          fileSize = probedSize;
        }
        rememberVideoSize(target, fileSize);
        const plan = sliceRanges(0, fileSize - 1, fileSize, { sliceSize, lookahead: fileSize });
        if (!plan.ranges.length) return 0;
        state.total = plan.ranges.length;
        let next = 0;
        async function worker() {
          while (next < plan.ranges.length) {
            if (shouldStop?.()) return;
            const part = plan.ranges[next];
            next += 1;
            if (part.start >= videoCacheMaxFileBytes) continue;
            const existing = await cache.readRange(sliceKey(target, part.start), 'media', { namespace: 'public' });
            if (existing && existing.size === part.end - part.start + 1) continue;
            try {
              const result = await fetchSliceIntoCache(target, resolved.url, 'public', part, { priority: 'background' });
              if (result.status === 'cached') continue;
              if (result.status === 'stored') state.fetched += 1;
              else state.failed += 1;
            } catch {
              // Background prefetch failures must never surface.
              state.failed += 1;
            }
          }
        }
        const workers = [];
        for (let index = 0; index < Math.min(prefetchConcurrency, plan.ranges.length); index += 1) {
          workers.push(worker());
        }
        await Promise.all(workers);
        if (state.failed > 0) {
          logger.warn('media_prefetch_partial', { target, fetched: state.fetched, failed: state.failed, total: plan.ranges.length });
        }
        if (state.fetched > 0) onMetric('media_prefetch_slices', { count: state.fetched, total: plan.ranges.length });
        return state.fetched;
      } finally {
        state.status = 'done';
        state.completedAt = now();
        videoPrefetchInflight.delete(target);
      }
    })();
    videoPrefetchInflight.set(target, promise);
    return promise;
  }

  function prefetchStatus(target) {
    const state = videoPrefetchStates.get(target);
    if (!state) return null;
    return {
      status: state.status,
      fetchedSlices: state.fetched,
      totalSlices: state.total,
      failedSlices: state.failed,
      startedAt: state.startedAt,
      completedAt: state.completedAt,
    };
  }

  async function assembleSliceRange(target, resolvedUrl, namespace, parsed, size) {
    if (!cache) return null;
    const plan = sliceRanges(parsed.start, parsed.end, size, {
      sliceSize,
      lookahead: Math.max(1, parsed.end - parsed.start + 1),
    });
    if (plan.ranges.length < 2 || plan.ranges.some((part) => part.start >= videoCacheMaxFileBytes)) return null;
    const parts = [];
    for (const part of plan.ranges) {
      const existing = await cache.readRange(sliceKey(target, part.start), 'media', { namespace });
      const ranged = existing && existing.size === part.end - part.start + 1 ? existing : null;
      const item = { part, ranged, error: null, ready: null, settle: null };
      if (!ranged) item.ready = new Promise((resolve) => { item.settle = resolve; });
      parts.push(item);
    }
    let nextMissing = 0;
    async function worker() {
      while (nextMissing < parts.length) {
        const item = parts[nextMissing];
        nextMissing += 1;
        if (item.ranged) continue;
        try {
          const result = await fetchSliceIntoCache(target, resolvedUrl, namespace, item.part, { priority: 'foreground' });
          if (result.status === 'failed') throw new Error(`slice ${item.part.start} fetch failed`);
          const stored = await cache.readRange(sliceKey(target, item.part.start), 'media', { namespace });
          if (!stored || stored.size !== item.part.end - item.part.start + 1) {
            throw new Error(`slice ${item.part.start} not stored`);
          }
          item.ranged = stored;
        } catch (error) {
          item.error = error;
        } finally {
          item.settle?.();
        }
      }
    }
    const missingCount = parts.filter((item) => !item.ranged).length;
    if (missingCount) {
      for (let index = 0; index < clamp(sliceFillConcurrency, 1, missingCount); index += 1) {
        void worker();
      }
    }
    // Resolve every missing slice before committing to a 206 with a fixed
    // content-length: a mid-stream failure would otherwise truncate a body the
    // client already trusts. On any failure, fall back to the single-range
    // fetch path instead of emitting a corrupt range response.
    await Promise.all(parts.filter((item) => !item.ranged).map((item) => item.ready));
    if (parts.some((item) => !item.ranged)) return null;
    async function* bytes() {
      for (let index = 0; index < parts.length; index += 1) {
        const item = parts[index];
        if (!item.ranged) {
          await item.ready;
          if (item.error) throw item.error;
        }
        const from = index === 0 ? parsed.start - item.part.start : 0;
        const to = index === parts.length - 1 ? parsed.end - item.part.start : item.part.end - item.part.start;
        const stream = item.ranged.createStream(from, to);
        if (!stream) throw new Error('slice stream unavailable');
        for await (const chunk of stream) yield chunk;
      }
    }
    const headers = {
      'content-type': parts[0].ranged.entry.headers['content-type'] || 'video/mp4',
      'content-length': String(parsed.end - parsed.start + 1),
      'content-range': `bytes ${parsed.start}-${parsed.end}/${size}`,
      'accept-ranges': 'bytes',
    };
    for (const name of ['etag', 'last-modified']) {
      const value = parts[0].ranged.entry.headers[name];
      if (value) headers[name] = value;
    }
    onMetric('media_range_assembled', { count: parts.length });
    return new Response(Readable.toWeb(Readable.from(bytes())), { status: 206, headers });
  }

  async function serveIwaraVideo(target, requestOptions, routeMetadata) {
    if (requestOptions.range) {
      const ranged = await readRange({ target, namespace: 'public', range: requestOptions.range });
      if (ranged) return { adapter: { name: 'iwara' }, egressScope: 'public', response: ranged };
      const rawRange = String(requestOptions.range || '').match(/^bytes=(\d+)-(\d+)$/);
      const rawLength = rawRange ? Number(rawRange[2]) - Number(rawRange[1]) + 1 : 0;
      let knownSize = knownVideoSize(target);
      if (!(Number.isSafeInteger(knownSize) && knownSize > 0) && rawLength >= sliceSize) {
        const resolvedForProbe = await resolveMediaUrl(target);
        if (resolvedForProbe?.url) {
          const probe = await fetchExternal(resolvedForProbe.url, {
            range: 'bytes=0-0',
            circuit: false,
            priority: 'background',
          });
          const probeRange = (probe.headers.get('content-range') || '').match(/\/(\d+)\s*$/);
          const probedSize = probeRange ? Number(probeRange[1]) : null;
          await probe.body?.cancel();
          if (Number.isSafeInteger(probedSize) && probedSize > 0) {
            knownSize = probedSize;
            rememberVideoSize(target, probedSize);
          }
        }
      }
      if (Number.isSafeInteger(knownSize) && knownSize > 0) {
        const sliced = await readSliceRange(target, 'public', requestOptions.range, knownSize);
        if (sliced) return { adapter: { name: 'iwara' }, egressScope: 'public', response: sliced };
        const parsed = parseByteRange(requestOptions.range, knownSize);
        if (parsed && !parsed.unsatisfiable) {
          const resolved = await resolveMediaUrl(target);
          if (resolved?.url) {
            const assembled = await assembleSliceRange(target, resolved.url, 'public', parsed, knownSize);
            if (assembled) return { adapter: { name: 'iwara' }, egressScope: 'public', response: assembled };
            fillVideoSlices(target, resolved.url, knownSize, 'public', parsed).catch(() => {
              // Background slice fill must never affect the served response.
            });
          }
        }
      }
      const resolved = await resolveMediaUrl(target);
      if (!resolved?.url) return { adapter: { name: 'iwara' }, egressScope: 'public', response: unavailableMediaResponse() };
      const remote = await fetchExternal(resolved.url, { ...requestOptions, circuit: false, priority: 'foreground' });
      if (cache && remote.ok) {
        const contentRange = remote.headers.get('content-range') || '';
        const match = contentRange.match(/\/(\d+)\s*$/);
        const size = match ? Number(match[1]) : null;
        if (Number.isSafeInteger(size) && size > 0) {
          rememberVideoSize(target, size);
          const parsed = parseByteRange(requestOptions.range, size);
          if (parsed && !parsed.unsatisfiable) {
            // First play-through of a cacheable video: fill the covering slices
            // (plus a lookahead window) in the background with parallel range
            // requests so every later seek is served from the gateway cache
            // instead of repeating upstream range fetches.
            fillVideoSlices(target, resolved.url, size, 'public', parsed).catch(() => {
              // Background slice fill must never affect the served response.
            });
          }
        }
      }
      return { adapter: { name: 'iwara' }, egressScope: 'public', response: remote };
    }
    const cached = await readCached(target, 'media', 'public', { bypassInflight: true });
    if (cached) return { adapter: { name: 'iwara' }, egressScope: 'public', response: cached };
    const resolved = await resolveMediaUrl(target);
    if (!resolved?.url) return { adapter: { name: 'iwara' }, egressScope: 'public', response: unavailableMediaResponse() };
    const remote = await fetchExternal(resolved.url, { ...requestOptions, circuit: false, priority: 'foreground' });
    if (!remote.ok) return { adapter: { name: 'iwara' }, egressScope: 'public', response: remote };
    const source = {
      adapter: { name: 'iwara' },
      egressScope: 'public',
      response: await cacheMedia(target, 'public', remote, { bypassInflight: true }),
    };
    return source;
  }

  async function serve(target, requestOptions = {}, routeMetadata = {}, variantWidth) {
    if (isVideoTarget(target)) return serveIwaraVideo(target, requestOptions, routeMetadata);
    const adapter = routeMetadata.adapter || adapterFor(target);
    const bypassInflight = requestOptions?.priority === 'foreground';
    const requestedScope = routeMetadata.egressScope === 'session'
      ? 'session'
      : (routeMetadata.egressScope === 'sticky' ? 'sticky' : 'public');
    if (requestedScope === 'session') {
      const session = routeMetadata.session || await resolveSession(adapter);
      if (!session) return { adapter, unavailable: true, egressScope: 'session' };
      const namespace = namespaceFor('session', session);
      if (requestOptions.range) {
        const ranged = await readRange({ target, namespace, range: requestOptions.range });
        if (ranged) return { adapter, egressScope: 'session', session, response: ranged };
        return routeRequest(target, requestOptions, routeMetadata);
      }
      if (variantWidth && cache) {
        const cachedVariant = await readCached(imageVariantCacheUrl(target, variantWidth), 'media-variant', namespace, { bypassInflight });
        if (cachedVariant) {
          onMetric('image_variant_hit', { source: adapter.name, width: variantWidth });
          return { adapter, egressScope: 'session', session, response: cachedVariant };
        }
      }
      const cached = await readCached(target, 'media', namespace, { bypassInflight });
      if (cached) {
        const source = { adapter, egressScope: 'session', session, response: cached };
        if (variantWidth) return mediaVariant(source, target, variantWidth, namespace);
        maybeWarmupImageVariants(target, namespace, cached, variantWidth);
        return source;
      }
      const routed = await routeRequest(target, requestOptions, routeMetadata);
      const source = { ...routed, response: await cacheMedia(target, namespace, routed.response, { bypassInflight }) };
      if (variantWidth) return mediaVariant(source, target, variantWidth, namespace);
      maybeWarmupImageVariants(target, namespace, source.response, variantWidth);
      return source;
    }

    if (requestOptions.range) {
      const ranged = await readRange({ target, namespace: 'public', range: requestOptions.range });
      if (ranged) return { adapter, egressScope: requestedScope, response: ranged };
      return routeRequest(target, requestOptions, routeMetadata);
    }
    if (variantWidth && cache) {
      const cachedVariant = await readCached(imageVariantCacheUrl(target, variantWidth), 'media-variant', 'public', { bypassInflight });
      if (cachedVariant) {
        onMetric('image_variant_hit', { source: adapter.name, width: variantWidth });
        return { adapter, egressScope: 'public', response: cachedVariant };
      }
    }
    const publicCached = await readCached(target, 'media', 'public', { bypassInflight });
    if (publicCached) {
      const source = { adapter, egressScope: 'public', response: publicCached };
      if (variantWidth) return mediaVariant(source, target, variantWidth, 'public');
      maybeWarmupImageVariants(target, 'public', publicCached, variantWidth);
      return source;
    }
    const routed = await routeRequest(target, requestOptions, routeMetadata);
    if (routed.unavailable) return routed;
    const namespace = namespaceFor(routed.egressScope, routed.session);
    const source = { ...routed, response: await cacheMedia(target, namespace, routed.response, { bypassInflight }) };
    if (variantWidth) return mediaVariant(source, target, variantWidth, namespace);
    maybeWarmupImageVariants(target, namespace, source.response, variantWidth);
    return source;
  }

  async function probeSize(target, { namespace = 'public' } = {}) {
    if (cache) {
      const ranged = await cache.readRange(target, 'media', { namespace });
      if (ranged) return ranged.size;
    }
    try {
      const probeUrl = isVideoTarget(target)
        ? (await resolveMediaUrl(target))?.url
        : target;
      if (!probeUrl) return null;
      const probe = await fetchExternal(probeUrl, {
        range: 'bytes=0-0',
        circuit: false,
        priority: 'background',
      });
      const contentRange = probe.headers.get('content-range') || '';
      const match = contentRange.match(/\/(\d+)\s*$/);
      if (!match) return null;
      const size = Number(match[1]);
      if (Number.isSafeInteger(size) && size > 0) rememberVideoSize(target, size);
      return size;
    } catch {
      return null;
    }
  }

  function chunkManifest({ target, size, chunks, secret, baseUrl, metadata = {} }) {
    const urls = [];
    for (let index = 0; index < chunks.count; index += 1) {
      const start = index * chunks.size;
      const end = Math.min(size - 1, start + chunks.size - 1);
      const token = createSignedChunk({
        url: target,
        start,
        end,
        secret,
        metadata: { ...metadata },
      });
      urls.push(`${String(baseUrl).replace(/\/$/, '')}/_gateway/chunk/${token}`);
    }
    return { size, chunkSize: chunks.size, count: chunks.count, urls };
  }

  return {
    load,
    readCached,
    readRange,
    cacheMedia,
    mediaVariant,
    serve,
    probeSize,
    chunkManifest,
    imageVariantCacheUrl,
    fillVideoSlices,
    prefetchVideoFile,
    prefetchStatus,
    sliceKey,
    rememberVideoSize,
    knownVideoSize,
  };
}

export const DEFAULT_PREFETCH_WAIT_MS = 30_000;
export const MAX_PREFETCH_WAIT_MS = 60_000;

export function writeEncodedText(res, req, status, body, contentType = 'text/plain; charset=utf-8', headers = {}) {
  const encoded = encodeTextResponse({
    body,
    contentType,
    acceptEncoding: req?.headers?.['accept-encoding'],
    method: 'GET',
    headers,
  });
  res.writeHead(status, { 'content-type': contentType, ...encoded.headers });
  if (req?.method === 'HEAD') res.end();
  else res.end(encoded.body);
}

export function positiveNumber(value, fallback) {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function sourceHeaders(url, sources = {}, { includeCredentials = false, credentials, adapterFor = () => ({ headers: () => ({}) }) } = {}) {
  const adapter = adapterFor(url);
  const referer = refererFor(url);
  return {
    'user-agent': 'rsshub-gateway/0.1',
    ...(referer ? { referer } : {}),
    ...adapter.headers(credentials ?? sources[adapter.name], { includeCredentials }),
  };
}

export function parseThumbnailTile(style, sourceUrl, baseUrl, secret, signedTargetMetadata, { gatewayUrl = resolveGatewayUrl } = {}) {
  const value = String(style || '');
  const image = value.match(/url\(\s*["']?([^"')]+)["']?\s*\)/i)?.[1];
  const media = gatewayUrl(baseUrl, 'media', image, sourceUrl, secret, signedTargetMetadata);
  if (!media) return null;
  const position = value.match(/\)\s*(-?\d+(?:\.\d+)?)px\s+(-?\d+(?:\.\d+)?)(px)?/i);
  const x = Number(position?.[1] || 0);
  const y = position?.[3] || Number(position?.[2]) === 0 ? Number(position?.[2] || 0) : 0;
  const width = numericStyle(value, 'width', 200);
  const height = numericStyle(value, 'height', 289);
  return {
    media,
    x: Number.isFinite(x) ? Math.max(Math.min(Math.round(x), 0), -5000) : 0,
    y: Number.isFinite(y) ? Math.max(Math.min(Math.round(y), 0), -5000) : 0,
    width,
    height,
  };
}

export const LINUXDO_MATCH_HOSTS = Object.freeze(['linux.do']);
export const DEFAULT_LINUXDO_UNAVAILABLE_MESSAGE = 'LINUX DO 话题内容暂时无法读取，请稍后重试或打开原始来源。';
export const LINUXDO_SITE_BASE = 'https://linux.do';

export function isLinuxdoTopicTarget(value) {
  try {
    const target = new URL(value);
    return target.protocol === 'https:'
      && (target.hostname === 'linux.do' || target.hostname === 'www.linux.do')
      && /^\/t\/(?:[^/]+\/)?\d+/.test(target.pathname);
  } catch {
    return false;
  }
}

export function linuxdoTopicId(value) {
  const match = String(value).match(/\/t\/(?:[^/]+\/)?(\d+)/);
  return match ? match[1] : '';
}

export function linuxdoTopicPageUrl(topicId, slug = 'topic', siteBase = LINUXDO_SITE_BASE) {
  return `${siteBase}/t/${slug}/${topicId}`;
}

export async function fetchLinuxdoTopicDetail(fetchJson, topicId, siteBase = LINUXDO_SITE_BASE) {
  const cleanId = String(topicId).replace(/\.json$/, '');
  return fetchJson(`${siteBase}/t/${encodeURIComponent(cleanId)}.json`, {
    headers: {
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
      referer: `${siteBase}/`,
    },
    timeout: 25_000,
  });
}

export const IWARA_API_BASE = 'https://api.iwara.tv';
export const IWARA_SITE_BASE = 'https://iwara.tv';
export const IWARA_MATCH_HOSTS = Object.freeze(['iwara.tv']);
export const DEFAULT_IWARA_UNAVAILABLE_MESSAGE = 'Iwara 内容暂时无法读取，请稍后重试或打开原始来源。';

export function isIwaraVideoTarget(value) {
  try {
    const target = new URL(value);
    return target.protocol === 'https:'
      && (target.hostname === 'iwara.tv' || target.hostname === 'www.iwara.tv')
      && /^\/video\/[^/]+/.test(target.pathname);
  } catch {
    return false;
  }
}

export function iwaraVideoId(value) {
  const match = String(value).match(/\/video\/([^/]+)/);
  return match ? decodeURIComponent(match[1]) : '';
}

export function iwaraThumbnailUrl(fileId, index = 0) {
  const frame = String(index).padStart(2, '0');
  return `https://i.iwara.tv/image/thumbnail/${fileId}/thumbnail-${frame}.jpg`;
}

export function selectIwaraVariant(variants = []) {
  const numeric = variants
    .map((variant, index) => ({ variant, index, score: Number.parseInt(String(variant.name), 10) }))
    .filter((entry) => Number.isFinite(entry.score))
    .sort((left, right) => right.score - left.score || left.index - right.index);
  const best = numeric[0]?.variant || variants[0];
  const source = best?.src?.view || best?.src?.download;
  return source ? { url: source.startsWith('//') ? `https:${source}` : source } : null;
}

export function iwaraVideoPageUrl(video, siteBase = IWARA_SITE_BASE) {
  return `${siteBase}/video/${video.id}/${video.slug || ''}`;
}

export async function fetchIwaraUser(fetchJson, username, { token, apiBase = IWARA_API_BASE } = {}) {
  const headers = token ? { authorization: `Bearer ${token}` } : {};
  let data = null;
  try {
    data = await fetchJson(`${apiBase}/profile/${encodeURIComponent(username)}`, { headers });
  } catch (error) {
    if (error?.status !== 404) throw error;
  }
  if (data?.user?.id) return data.user;
  const needle = String(username).toLowerCase();
  let results = [];
  try {
    const search = await fetchJson(`${apiBase}/autocomplete/users?query=${encodeURIComponent(username)}`, { headers });
    results = Array.isArray(search?.results) ? search.results : [];
  } catch {
    return null;
  }
  return results.find((user) => user?.username && String(user.username).toLowerCase() === needle)
    || results.find((user) => user?.name && String(user.name).trim().toLowerCase() === needle)
    || null;
}

export async function fetchIwaraVideos(fetchJson, userId, { kind = 'video', token, apiBase = IWARA_API_BASE } = {}) {
  const params = new URLSearchParams({ user: userId, limit: '32' });
  const endpoint = kind === 'image' ? '/images' : '/videos';
  const data = await fetchJson(`${apiBase}${endpoint}?${params}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  return Array.isArray(data?.results) ? data.results : [];
}

export async function fetchIwaraVideoDetail(fetchJson, videoId, { token, apiBase = IWARA_API_BASE } = {}) {
  return fetchJson(`${apiBase}/video/${encodeURIComponent(videoId)}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
}

export async function refreshIwaraAccessToken(fetchJson, refreshToken, { now = Date.now, apiBase = IWARA_API_BASE } = {}) {
  if (!refreshToken) throw new Error('iwara refresh token is required');
  const data = await fetchJson(`${apiBase}/user/token`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${refreshToken}`,
      'content-type': 'application/json',
    },
    timeout: 15_000,
  });
  const token = data?.accessToken || data?.token;
  if (!token) throw new Error('iwara refresh response missing access token');
  let expiresMs = jwtExpiryMs(token, { now });
  if (expiresMs == null) {
    const expires = Number(data.expires);
    if (Number.isFinite(expires)) {
      if (expires >= 1e12) {
        expiresMs = Math.max(0, expires - now());
      } else if (expires >= 1e9) {
        expiresMs = Math.max(0, expires * 1000 - now());
      } else {
        expiresMs = Math.max(0, expires * 1000);
      }
    }
  }
  return {
    token: String(token),
    refreshToken: data.refreshToken ? String(data.refreshToken) : String(refreshToken),
    expiresMs: expiresMs || 60 * 60 * 1000,
  };
}

export async function resolveIwaraVideoStream(fetchJson, detail) {
  if (!detail?.fileUrl) return null;
  const variants = await fetchJson(detail.fileUrl, { timeout: 25_000 });
  const selected = selectIwaraVariant(Array.isArray(variants) ? variants : []);
  if (!selected) return null;
  return {
    url: selected.url,
    contentType: detail.file?.mime || 'video/mp4',
  };
}

export const CHUNK_METADATA_KEYS = Object.freeze(new Set(['egressScope', 'source', 'sessionId', 'index']));

export function createSignedChunk({ url, start, end, secret, now: nowValue = Math.floor(Date.now() / 1000), ttlSeconds = 24 * 60 * 60, metadata = {} }) {
  const payload = base64UrlEncode(JSON.stringify({
    url: new URL(url).toString(),
    start: Number(start),
    end: Number(end),
    exp: nowValue + ttlSeconds,
    ...metadata,
  }));
  const signature = hmacSha256(payload, secret, 'base64url');
  return `${payload}.${signature}`;
}

export function verifySignedChunk(token, secret, now = Math.floor(Date.now() / 1000), {
  allowedHosts = ALLOWED_HOSTS,
  egressScopes = EGRESS_SCOPES,
  isAllowed = isAllowedTarget,
} = {}) {
  const [payload, signature] = String(token).split('.');
  if (!payload || !signature) throw new Error('malformed chunk token');
  if (!isSignatureMatch(signature, hmacSha256(payload, secret))) {
    throw new Error('invalid chunk signature');
  }
  const data = safeJsonParse(base64UrlDecode(payload), null);
  if (!data || typeof data !== 'object' || !Number.isInteger(data.exp) || data.exp <= now) {
    throw new Error('chunk expired or malformed');
  }
  if (!Number.isInteger(data.start) || !Number.isInteger(data.end) || data.start < 0 || data.end < data.start) {
    throw new Error('invalid chunk range');
  }
  if (Object.keys(data).some((key) => !['url', 'exp', 'start', 'end', ...CHUNK_METADATA_KEYS].includes(key))) {
    throw new Error('chunk metadata is not allowed');
  }
  if (data.egressScope !== undefined && !egressScopes.has(data.egressScope)) {
    throw new Error('chunk egress scope is not allowed');
  }
  if (data.source !== undefined && !/^[a-z][a-z0-9_-]{0,31}$/.test(String(data.source))) {
    throw new Error('chunk source is not allowed');
  }
  let targetAllowed = false;
  try {
    targetAllowed = isAllowed(data.url, allowedHosts);
  } catch {
    targetAllowed = false;
  }
  if (!targetAllowed) throw new Error('chunk target is not allowed');
  return data;
}

export const DOWNLOAD_SESSION_VERSION = 1;

export function buildDownloadSession({ id, target, size, chunkSize, chunks, now = Date.now(), ttlMs = DEFAULT_DOWNLOAD_SESSION_TTL_MS }) {
  const timestamp = Number.isFinite(now) ? now : Date.now();
  const session = {
    id: String(id || ''),
    target: String(target || ''),
    size: Number(size),
    chunkSize: Number(chunkSize),
    createdAt: timestamp,
    expiresAt: timestamp + ttlMs,
    doneBytes: 0,
    chunks: (Array.isArray(chunks) ? chunks : []).map((chunk) => ({
      index: Number(chunk.index),
      start: Number(chunk.start),
      end: Number(chunk.end),
      size: Number(chunk.size),
      url: String(chunk.url || ''),
      status: 'pending',
      updatedAt: timestamp,
    })),
  };
  if (!session.id) throw new Error('download session id is required');
  return session;
}

export function restoreDownloadSessionRecord(record) {
  if (!record || typeof record !== 'object') return null;
  const rawChunks = Array.isArray(record.chunks) ? record.chunks : [];
  return {
    id: record.id,
    target: record.target,
    size: record.size,
    chunkSize: record.chunkSize,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    doneBytes: rawChunks
      .filter((chunk) => chunk?.status === 'done')
      .reduce((total, chunk) => total + (Number(chunk?.size) || 0), 0),
    chunks: rawChunks.map((chunk) => ({
      index: chunk?.index,
      start: chunk?.start,
      end: chunk?.end,
      size: chunk?.size,
      url: chunk?.url,
      status: chunk?.status,
      updatedAt: chunk?.updatedAt,
    })),
  };
}

export function createDownloadSessionStore({
  now = Date.now,
  ttlMs = DEFAULT_DOWNLOAD_SESSION_TTL_MS,
  maxSessions = DEFAULT_MAX_DOWNLOAD_SESSIONS,
  file,
} = {}) {
  const sessions = new Map();
  const targetFile = file ? path.resolve(file) : null;
  let persistChain = Promise.resolve();

  function purgeExpired() {
    const timestamp = typeof now === 'function' ? now() : Date.now();
    for (const [id, session] of sessions) {
      if (session.expiresAt <= timestamp) sessions.delete(id);
    }
  }

  async function writeRecords() {
    try {
      await atomicWriteJson(targetFile, { version: DOWNLOAD_SESSION_VERSION, sessions: [...sessions.values()] }, { mode: 0o600, dirMode: 0o700 });
    } catch {
      // Best-effort persistence.
    }
  }

  function persist() {
    if (!targetFile) return Promise.resolve();
    persistChain = persistChain.then(writeRecords, writeRecords);
    return persistChain;
  }

  async function load() {
    if (!targetFile) return;
    let payload;
    try {
      const content = await fsp.readFile(targetFile, 'utf8');
      payload = safeJsonParse(content, null);
    } catch {
      return;
    }
    if (payload?.version !== DOWNLOAD_SESSION_VERSION || !Array.isArray(payload.sessions)) return;
    const current = typeof now === 'function' ? now() : Date.now();
    for (const record of payload.sessions) {
      if (!isValidSessionRecord(record, current)) continue;
      const restored = restoreDownloadSessionRecord(record);
      if (restored) sessions.set(restored.id, restored);
    }
  }

  const ready = load();

  async function create({ id, target, size, chunkSize, chunks }) {
    await ready;
    purgeExpired();
    const timestamp = typeof now === 'function' ? now() : Date.now();
    const session = buildDownloadSession({ id, target, size, chunkSize, chunks, now: timestamp, ttlMs });
    sessions.set(session.id, session);
    while (sessions.size > maxSessions) {
      const oldest = [...sessions.values()].sort((left, right) => left.createdAt - right.createdAt)[0];
      sessions.delete(oldest.id);
    }
    await persist();
    return session;
  }

  async function get(id) {
    await ready;
    purgeExpired();
    return sessions.get(String(id || ''));
  }

  async function revoke(idOrTarget) {
    await ready;
    purgeExpired();
    const query = String(idOrTarget || '').trim();
    if (!query) return { revoked: 0 };
    let count = 0;
    if (sessions.has(query)) {
      sessions.delete(query);
      count += 1;
    }
    for (const [id, session] of sessions) {
      if (session.target === query) {
        sessions.delete(id);
        count += 1;
      }
    }
    if (count > 0) {
      await persist();
    }
    return { revoked: count };
  }

  async function markChunkDone(id, index) {
    if (!Number.isInteger(index) || index < 0) return false;
    await ready;
    const session = await get(id);
    if (!session) return false;
    const chunk = session.chunks.find((entry) => entry.index === index);
    if (!chunk || chunk.status === 'done') return false;
    chunk.status = 'done';
    chunk.updatedAt = typeof now === 'function' ? now() : Date.now();
    session.doneBytes += chunk.size;
    await persist();
    return true;
  }

  async function stats() {
    await ready;
    purgeExpired();
    let totalBytes = 0;
    let doneBytes = 0;
    for (const session of sessions.values()) {
      totalBytes += session.size;
      doneBytes += session.doneBytes;
    }
    return { sessions: sessions.size, totalBytes, doneBytes };
  }

  return {
    create,
    get,
    revoke,
    markChunkDone,
    stats,
    flush: () => persistChain,
    file: targetFile,
  };
}

export async function loadCachedMedia({ cache, fetcher, target, range, maxBytes, request }) {
  const requestOptions = { ...request, range, circuit: false };
  const foreground = request?.priority === 'foreground';
  if (!cache || range) {
    return { response: await fetcher(target, requestOptions), cacheState: 'BYPASS' };
  }
  const result = await cache.getOrLoad(target, 'media', async () => {
    const remote = await fetcher(target, requestOptions);
    const contentType = remote.headers.get('content-type') || '';
    const contentLength = nonNegativeInteger(remote.headers.get('content-length'), null);
    const cacheable = remote.ok
      && contentType.toLowerCase().startsWith('image/')
      && contentLength !== null
      && contentLength <= maxBytes;
    if (!cacheable) {
      return { passthrough: remote, cacheable: false };
    }
    if (foreground && typeof remote.clone === 'function') {
      const cacheCopy = remote.clone();
      return {
        passthrough: remote,
        status: remote.status,
        headers: responseHeaders(remote),
        cacheable: true,
        cacheBody: async () => ({
          status: remote.status,
          headers: responseHeaders(remote),
          body: await readBinaryLimited(cacheCopy, maxBytes),
          cacheable: true,
        }),
      };
    }
    if (foreground && remote.body && typeof remote.body[Symbol.asyncIterator] !== 'function'
      && typeof remote.body[Symbol.iterator] === 'function') {
      return {
        status: remote.status,
        headers: responseHeaders(remote),
        body: await readBinaryLimited(remote, maxBytes),
        cacheable: true,
      };
    }
    return {
      status: remote.status,
      headers: responseHeaders(remote),
      body: await readBinaryLimited(remote, maxBytes),
      cacheable: true,
    };
  }, { bypassInflight: foreground, deferStore: foreground });
  cacheStateLog(target, 'media', result.state);
  return {
    response: result.passthrough || responseFromCachedDocument(result),
    cacheState: result.state,
  };
}

export async function fetchCachedMedia(options) {
  return (await loadCachedMedia(options)).response;
}

export async function warmEhMedia({ pages, cache, fetcher, maxBytes, count, concurrency }) {
  const targets = dedupe((pages || []).map((page) => page?.mediaTarget).filter(Boolean)).slice(0, count);
  if (!cache || !targets.length) return { targets, failedTargets: [] };
  const results = await mapWithConcurrency(targets, concurrency, async (target) => {
    try {
      const loaded = await loadCachedMedia({ cache, fetcher, target, maxBytes });
      await loaded.response.body?.cancel();
      return { target, failed: !loaded.response.ok };
    } catch {
      return { target, failed: true };
    }
  });
  return { targets, failedTargets: results.filter((result) => result.failed).map((result) => result.target) };
}

export async function discoverEhGallery({
  adapter,
  target,
  initialHtml,
  fetchExternal,
  concurrency,
  maxPages,
}) {
  const galleryUrls = adapter.galleryPageUrls(initialHtml, target);
  const galleryResults = await mapWithConcurrency(galleryUrls, concurrency, async (galleryUrl, index) => {
    if (index === 0) return { url: galleryUrl, body: initialHtml, ok: true, status: 200 };
    try {
      const remote = await fetchExternal(adapter.readerTarget(galleryUrl), { galleryShard: index });
      const body = await readLimited(remote);
      const contentType = remote.headers.get('content-type') || '';
      if (!remote.ok || !contentType.includes('html')) {
        return { url: galleryUrl, body: '', ok: false, status: remote.status, failure: { kind: 'gallery', pageNumber: index + 1 } };
      }
      return { url: galleryUrl, body, ok: true, status: remote.status };
    } catch {
      return { url: galleryUrl, body: '', ok: false, status: 502, failure: { kind: 'gallery', pageNumber: index + 1 } };
    }
  });

  const imageUrls = [];
  const seen = new Set();
  const failures = galleryResults.filter((result) => !result.ok).map((result) => ({
    pageNumber: result.failure.pageNumber,
    message: failureMessage(result.failure.kind, result.failure.pageNumber),
  }));
  for (const result of galleryResults) {
    if (!result.ok) continue;
    for (const imageUrl of adapter.imagePageUrls(result.body, result.url)) {
      if (!seen.has(imageUrl)) {
        seen.add(imageUrl);
        imageUrls.push(imageUrl);
      }
    }
  }

  const truncated = imageUrls.length > maxPages;
  const selectedImageUrls = imageUrls.slice(0, maxPages);
  if (truncated) failures.push({ message: '画廊页数超过网关预处理上限，后续页面未读取' });
  return {
    galleryResults,
    selectedImageUrls,
    imageUrls,
    failures,
    truncated,
    totalPages: imageUrls.length,
    status: galleryResults.find((result) => !result.ok)?.status || 200,
    title: extractEhGalleryTitle({ url: target, html: initialHtml }),
  };
}

export const DEFAULT_SESSION_AFFINITY_VERSION = 1;
export const DEFAULT_SESSION_AFFINITY_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1_000;

export function normalizedLaneIds(value) {
  const items = (Array.isArray(value) ? value : [])
    .map((laneId) => String(laneId || '').trim())
    .filter(Boolean);
  return dedupe(items).sort();
}

export function normalizedCredentials(credentials = {}) {
  return canonicalHeadersString(credentials);
}

export function fingerprintFor(source, credentials, secret) {
  return hmacSha256(
    `${String(source || '').trim().toLowerCase()}\n${normalizedCredentials(credentials)}`,
    secret,
    'hex',
  );
}

export function proxyIdentityHash(value) {
  return value ? sha256Hex(value) : '';
}

export function chooseLane(fingerprint, laneIds, unhealthyLanes = new Set()) {
  const candidates = laneIds.filter((laneId) => !unhealthyLanes.has(laneId));
  if (!candidates.length) {
    const error = new Error('no healthy session lane is available');
    error.code = 'SESSION_LANE_UNAVAILABLE';
    throw error;
  }
  return candidates.reduce((best, laneId) => {
    if (!best) return laneId;
    const laneScore = sha256Hex(`${fingerprint}\n${laneId}`);
    const bestScore = sha256Hex(`${fingerprint}\n${best}`);
    return laneScore > bestScore ? laneId : best;
  }, '');
}

export function isValidAffinityRecord(record, now = Date.now(), maxAgeMs = DEFAULT_SESSION_AFFINITY_MAX_AGE_MS) {
  return Boolean(
    record
    && isSha256Hex(record.fingerprint)
    && typeof record.source === 'string'
    && record.source
    && typeof record.laneId === 'string'
    && record.laneId
    && Number.isFinite(record.createdAt)
    && Number.isFinite(record.updatedAt)
    && record.updatedAt <= now
    && now - record.updatedAt <= maxAgeMs,
  );
}

export const DEFAULT_POLLER_INTERVAL_MS = 60_000;
export const DEFAULT_POLLER_JITTER_RATIO = 0.2;
export const MIN_TASK_INTERVAL_MS = 10;
export const MAX_JITTER_RATIO = 0.5;

export function createPoller({
  intervalMs = DEFAULT_POLLER_INTERVAL_MS,
  jitterRatio = DEFAULT_POLLER_JITTER_RATIO,
  now = () => Date.now(),
  logger = { debug() {}, info() {}, warn() {}, error() {} },
} = {}) {
  const tasks = new Map();
  let running = false;
  let timer;

  function register(name, fn, { interval: taskIntervalMs, runImmediately = false } = {}) {
    if (tasks.has(name)) return tasks.get(name);
    const task = {
      name: String(name),
      fn,
      intervalMs: Math.max(MIN_TASK_INTERVAL_MS, Number(taskIntervalMs) || intervalMs),
      jitterRatio: clamp(Number(jitterRatio) || 0, 0, MAX_JITTER_RATIO),
      runImmediately: Boolean(runImmediately),
      lastRunAt: 0,
      lastDurationMs: 0,
      failures: 0,
      consecutiveFailures: 0,
      ticks: 0,
    };
    tasks.set(task.name, task);
    return task;
  }

  async function runTask(task) {
    const startedAt = now();
    try {
      await task.fn();
      task.consecutiveFailures = 0;
    } catch (error) {
      task.failures += 1;
      task.consecutiveFailures += 1;
      logger?.warn?.('poller_task_failed', { task: task.name, failures: task.failures, error: error?.message });
    }
    task.lastRunAt = now();
    task.lastDurationMs = task.lastRunAt - startedAt;
    task.ticks += 1;
  }

  function scheduleNext() {
    if (!running) return;
    const scheduled = [...tasks.values()];
    if (!scheduled.length) return;
    const timestamp = now();
    const earliest = Math.min(...scheduled.map((task) => (
      task.lastRunAt > 0 ? task.lastRunAt + task.intervalMs - timestamp : task.intervalMs
    )));
    const base = Math.max(10, earliest);
    const jitter = base * jitterRatio;
    const delay = Math.max(10, base + Math.random() * jitter);
    timer = setTimeout(() => {
      timer = undefined;
      tick().finally(scheduleNext);
    }, delay);
    timer.unref?.();
  }

  async function tick() {
    const timestamp = now();
    for (const task of tasks.values()) {
      if (!running) return;
      if (timestamp - task.lastRunAt < task.intervalMs) continue;
      try {
        await runTask(task);
      } catch {
        // runTask already captures failures; never let one task stop the loop.
      }
    }
  }

  function start() {
    if (running) return;
    running = true;
    for (const task of tasks.values()) {
      if (task.runImmediately && !task.lastRunAt) {
        runTask(task).catch(() => {});
      }
    }
    scheduleNext();
  }

  function stop() {
    running = false;
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
  }

  function unregister(name) {
    const deleted = tasks.delete(String(name));
    if (!tasks.size && running) {
      stop();
    }
    return deleted;
  }

  function stats() {
    return {
      running,
      tasks: [...tasks.values()].map((task) => ({
        name: task.name,
        ticks: task.ticks,
        failures: task.failures,
        consecutiveFailures: task.consecutiveFailures,
        lastRunAt: task.lastRunAt,
        lastDurationMs: task.lastDurationMs,
      })),
    };
  }

  return { register, unregister, start, stop, tick, stats };
}

export function constantTimeEquals(left, right) {
  try {
    const leftBuf = Buffer.isBuffer(left) ? left : Buffer.from(String(left ?? ''));
    const rightBuf = Buffer.isBuffer(right) ? right : Buffer.from(String(right ?? ''));
    return leftBuf.length === rightBuf.length && timingSafeEqual(leftBuf, rightBuf);
  } catch {
    return false;
  }
}

export function normalizeHeaderMap(headers = {}) {
  const entries = headers instanceof Headers
    ? [...headers.entries()]
    : (Array.isArray(headers) ? headers : Object.entries(headers || {}));
  return entries
    .map(([name, value]) => [String(name || '').trim().toLowerCase(), String(value || '').trim()])
    .filter(([name, value]) => name && value)
    .sort(([left], [right]) => left.localeCompare(right));
}

export function canonicalHeadersString(headers = {}) {
  return normalizeHeaderMap(headers)
    .map(([name, value]) => `${name}=${value}`)
    .join('\n');
}

export function safeEvent(onEvent, event) {
  try {
    onEvent?.(event);
  } catch {
    // Diagnostics must never fail runtime logic.
  }
}

export function base64UrlEncode(value) {
  if (value === null || value === undefined) return '';
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8');
  return buffer.toString('base64url');
}

export function base64UrlDecode(value, fallback = '') {
  if (value === null || value === undefined) return fallback;
  try {
    return Buffer.from(String(value), 'base64url').toString('utf8');
  } catch {
    return fallback;
  }
}

export function decodeJwtPayload(value) {
  const parts = String(value || '').split('.');
  if (parts.length < 2) return null;
  const decoded = base64UrlDecode(parts[1], '');
  const payload = safeJsonParse(decoded, null);
  return payload && typeof payload === 'object' ? payload : null;
}

export function jwtExpiryMs(value, { now = Date.now } = {}) {
  const payload = decodeJwtPayload(value);
  const exp = Number(payload?.exp);
  if (Number.isFinite(exp)) return Math.max(0, exp * 1000 - now());
  return null;
}

export function asDate(value) {
  const normalized = String(value || '').trim().replace(' ', 'T');
  const date = normalized ? new Date(`${normalized}Z`) : null;
  return date && Number.isNaN(date.getTime()) ? '' : date?.toUTCString() || '';
}

export function cleanText(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[character]));
}

export function escapeXml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&apos;',
  }[character]));
}

export const XML_NAMED_ENTITIES = Object.freeze({
  amp: '&',
  apos: "'",
  gt: '>',
  lt: '<',
  quot: '"',
});

export function isValidXmlCodePoint(codePoint) {
  return codePoint === 0x9 || codePoint === 0xa || codePoint === 0xd
    || (codePoint >= 0x20 && codePoint <= 0xd7ff)
    || (codePoint >= 0xe000 && codePoint <= 0xfffd)
    || (codePoint >= 0x10000 && codePoint <= 0x10ffff);
}

export function decodeEntity(entity) {
  if (entity === null || entity === undefined) return entity;
  const named = String(entity || '').match(/^&([a-z]+);$/i);
  if (named) return XML_NAMED_ENTITIES[named[1].toLowerCase()] || entity;
  const numeric = String(entity || '').match(/^&#(?:x([0-9a-f]+)|([0-9]+));$/i);
  if (!numeric) return entity;
  const codePoint = Number.parseInt(numeric[1] || numeric[2], numeric[1] ? 16 : 10);
  if (!Number.isSafeInteger(codePoint) || !isValidXmlCodePoint(codePoint)) return entity;
  return String.fromCodePoint(codePoint);
}

export function decodeTextEntities(value) {
  return String(value ?? '').replace(/&(?:amp|apos|gt|lt|quot);|&#(?:x[0-9a-f]+|[0-9]+);/gi, decodeEntity);
}

export function normalizeNumericEntities(xml) {
  return String(xml ?? '').replace(/&#(?:x([0-9a-f]+)|([0-9]+));/gi, (entity, hexadecimal, decimal) => {
    const codePoint = Number.parseInt(hexadecimal || decimal, hexadecimal ? 16 : 10);
    if (!Number.isSafeInteger(codePoint) || !isValidXmlCodePoint(codePoint) || [0x22, 0x26, 0x27, 0x3c, 0x3e].includes(codePoint)) {
      return entity;
    }
    return String.fromCodePoint(codePoint);
  });
}

export function withoutCredentials(headers = {}) {
  return Object.fromEntries(Object.entries(headers || {})
    .filter(([name]) => !/^(cookie|authorization)$/i.test(name)));
}

export function isAuthenticationRedirect(response) {
  if (!response || typeof response !== 'object') return false;
  const status = Number(response.status);
  if (status < 300 || status >= 400) return false;
  const location = typeof response.headers?.get === 'function'
    ? (response.headers.get('location') || '')
    : (response.headers?.location || '');
  return /(?:\/login|\/signin|\/i\/flow\/login|accounts\/login)(?:[/?#]|$)/i.test(location);
}

export async function isAuthenticationChallenge(response, url, callback) {
  if (response?.status === 401 || isAuthenticationRedirect(response)) return true;
  if (typeof callback !== 'function') return false;
  try {
    return Boolean(await callback({ response, url }));
  } catch {
    return false;
  }
}

export const RETRYABLE_STATUSES = Object.freeze(new Set([408, 425, 429]));
export const DEFAULT_BLOCKED_STATUSES = Object.freeze(new Set([401, 403, 407, 429]));

export function isRetryableStatus(status) {
  return Number.isInteger(status) && (RETRYABLE_STATUSES.has(status) || (status >= 500 && status <= 599));
}

export function isSuccessfulStatus(status) {
  return Number.isInteger(status) && status >= 200 && status <= 299;
}

export function isClientAbortError(error) {
  if (!error) return false;
  const message = String(error.message || '').toLowerCase();
  const code = String(error.code || '').toUpperCase();
  return code === 'ECONNRESET'
    || code === 'ERR_STREAM_PREMATURE_CLOSE'
    || code === 'ABORT_ERR'
    || message.includes('client response closed')
    || message.includes('aborted');
}

export const DEFAULT_HTML_BROTLI_MIN_BYTES = 4 * 1024;
export const DEFAULT_HTML_BROTLI_QUALITY = 4;
export const DEFAULT_TEXT_COMPRESS_MIN_BYTES = 1024;
export const DEFAULT_GZIP_LEVEL = 6;

export const COMPRESSIBLE_CONTENT_TYPES = Object.freeze([
  'text/',
  'application/xml',
  'application/rss+xml',
  'application/atom+xml',
  'application/xhtml+xml',
  'application/json',
  'application/javascript',
  'application/manifest+json',
  'image/svg+xml',
]);

export function isCompressibleContentType(contentType) {
  const value = String(contentType || '').toLowerCase();
  return COMPRESSIBLE_CONTENT_TYPES.some((prefix) => value.includes(prefix));
}

export function acceptsCoding(value, coding) {
  return String(value || '').split(',').some((part) => {
    const [name, ...parameters] = part.trim().toLowerCase().split(';');
    if (name.trim() !== coding) return false;
    const quality = parameters
      .map((parameter) => parameter.trim().split('=', 2))
      .find(([key]) => key === 'q')?.[1];
    return quality === undefined || Number(quality) > 0;
  });
}

export function acceptsBrotli(value) {
  return acceptsCoding(value, 'br');
}

export function acceptsGzip(value) {
  return acceptsCoding(value, 'gzip');
}

export function asBuffer(body) {
  return Buffer.isBuffer(body) ? body : Buffer.from(body || '');
}

export function withVary(headers = {}) {
  const existing = headers.vary || headers.Vary;
  if (!existing) return 'Accept-Encoding';
  const values = String(existing).split(',').map((value) => value.trim()).filter(Boolean);
  if (!values.some((value) => value.toLowerCase() === 'accept-encoding')) values.push('Accept-Encoding');
  return values.join(', ');
}

export function encodeTextResponse({
  body,
  contentType = 'text/plain; charset=utf-8',
  acceptEncoding,
  method = 'GET',
  headers = {},
  minBytes = DEFAULT_TEXT_COMPRESS_MIN_BYTES,
  quality = DEFAULT_HTML_BROTLI_QUALITY,
} = {}) {
  const source = asBuffer(body);
  const resultHeaders = { ...headers, 'content-length': String(source.length) };
  delete resultHeaders['content-encoding'];
  delete resultHeaders['Content-Encoding'];
  const compressible = isCompressibleContentType(contentType);
  if (compressible && source.length >= minBytes) {
    resultHeaders.vary = withVary(resultHeaders);
  }
  if (method === 'HEAD' || !compressible || source.length < minBytes
    || (!acceptsBrotli(acceptEncoding) && !acceptsGzip(acceptEncoding))) {
    return { body: source, headers: resultHeaders, encoding: undefined };
  }
  try {
    if (acceptsBrotli(acceptEncoding)) {
      const encoded = brotliCompressSync(source, {
        params: { [zlibConstants.BROTLI_PARAM_QUALITY]: quality },
      });
      if (encoded.length < source.length) {
        resultHeaders['content-encoding'] = 'br';
        resultHeaders['content-length'] = String(encoded.length);
        return { body: encoded, headers: resultHeaders, encoding: 'br' };
      }
    }
    if (acceptsGzip(acceptEncoding)) {
      const encoded = gzipSync(source, { level: DEFAULT_GZIP_LEVEL });
      if (encoded.length < source.length) {
        resultHeaders['content-encoding'] = 'gzip';
        resultHeaders['content-length'] = String(encoded.length);
        return { body: encoded, headers: resultHeaders, encoding: 'gzip' };
      }
    }
  } catch {
    // Compression must never fail the response.
  }
  return { body: source, headers: resultHeaders, encoding: undefined };
}

export function encodeHtmlResponse({
  body,
  contentType = 'text/html; charset=utf-8',
  acceptEncoding,
  method = 'GET',
  headers = {},
  minBytes = DEFAULT_HTML_BROTLI_MIN_BYTES,
  quality = DEFAULT_HTML_BROTLI_QUALITY,
} = {}) {
  const source = asBuffer(body);
  const resultHeaders = { ...headers, 'content-length': String(source.length) };
  delete resultHeaders['content-encoding'];
  delete resultHeaders['Content-Encoding'];
  if (String(contentType).toLowerCase().includes('text/html') && source.length >= minBytes) {
    resultHeaders.vary = withVary(resultHeaders);
  }
  if (method === 'HEAD' || !String(contentType).toLowerCase().includes('text/html')
    || source.length < minBytes || (!acceptsBrotli(acceptEncoding) && !acceptsGzip(acceptEncoding))) {
    return { body: source, headers: resultHeaders };
  }
  try {
    if (acceptsBrotli(acceptEncoding)) {
      const encoded = brotliCompressSync(source, {
        params: { [zlibConstants.BROTLI_PARAM_QUALITY]: quality },
      });
      if (encoded.length < source.length) {
        resultHeaders['content-encoding'] = 'br';
        resultHeaders['content-length'] = String(encoded.length);
        return { body: encoded, headers: resultHeaders };
      }
    }
    if (acceptsGzip(acceptEncoding)) {
      const encoded = gzipSync(source, { level: DEFAULT_GZIP_LEVEL });
      if (encoded.length < source.length) {
        resultHeaders['content-encoding'] = 'gzip';
        resultHeaders['content-length'] = String(encoded.length);
        return { body: encoded, headers: resultHeaders };
      }
    }
  } catch {
    // Compression must never fail the response.
  }
  return { body: source, headers: resultHeaders };
}

export const ALIGN_64K = 64 * 1024;

export function align64k(value) {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return ALIGN_64K;
  return Math.max(1, Math.ceil(num / ALIGN_64K)) * ALIGN_64K;
}

export function promLabel(value) {
  return String(value ?? '').replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', '\\n');
}

export function sourceMetricName(source) {
  const name = String(source || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 32);
  return name ? `source_${name}_duration_seconds` : null;
}

export function downloadSessionView(session) {
  if (!session || typeof session !== 'object') return null;
  const chunks = Array.isArray(session.chunks) ? session.chunks : [];
  return {
    id: session.id,
    size: session.size,
    chunkSize: session.chunkSize,
    count: chunks.length,
    doneChunks: chunks.filter((chunk) => chunk?.status === 'done').length,
    doneBytes: session.doneBytes ?? 0,
    urls: chunks.map((chunk) => chunk?.url).filter(Boolean),
    chunks: chunks.map((chunk) => ({
      index: chunk?.index,
      start: chunk?.start,
      end: chunk?.end,
      size: chunk?.size,
      status: chunk?.status,
      url: chunk?.url,
    })),
  };
}

export function withPrefetchStatus(view, target, prefetchStatus) {
  if (!view || typeof view !== 'object') return view;
  return { ...view, prefetch: typeof prefetchStatus === 'function' ? (prefetchStatus(target) ?? null) : null };
}

export function failureMessage(kind, pageNumber) {
  if (kind === 'gallery') return `画廊分页 ${pageNumber} 暂时无法读取`;
  return `第 ${pageNumber} 页暂时无法读取`;
}

export function extractEhGalleryTitle({ url, html }) {
  const str = String(html || '');
  const gnMatch = str.match(/<h1[^>]*id=["']gn["'][^>]*>([\s\S]*?)<\/h1>/i);
  if (gnMatch) {
    const text = cleanText(gnMatch[1].replace(/<[^>]+>/g, ''));
    if (text) return text;
  }
  const titleMatch = str.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (titleMatch) {
    const text = cleanText(titleMatch[1].replace(/<[^>]+>/g, ''));
    if (text) return text;
  }
  return cleanText(url) || url;
}

export const EH_METADATA_LABELS = Object.freeze({
  Posted: '发布',
  Parent: '父项',
  Visible: '可见',
  Language: '语言',
  'File Size': '文件大小',
  Length: '篇幅',
  Favorited: '收藏',
});

export function tileStyle(tile) {
  if (!tile || typeof tile !== 'object') return '';
  const width = Number(tile.width) || 0;
  const height = Number(tile.height) || 0;
  return `width:${width}px;height:${height}px;overflow:hidden`;
}

export function tileImage(tile, className = '', alt = '', loading = 'lazy') {
  if (!tile || typeof tile !== 'object' || !tile.media) return '';
  const x = Number(tile.x) || 0;
  const y = Number(tile.y) || 0;
  return `<img class="${escapeHtml(className)}" src="${escapeHtml(tile.media)}" alt="${escapeHtml(alt)}" loading="${escapeHtml(loading)}" style="transform:translate(${x}px,${y}px)">`;
}

export const DEFAULT_LEASE_TTL_MS = 30 * 60 * 1000;
export const DEFAULT_LEASE_MAX_BYTES = 2 * 1024 ** 3;
export const DEFAULT_LEASE_MAX_CONCURRENCY = 8;
export const DEFAULT_LEASE_UPSTREAM_PROXY_HOST = '127.0.0.1';
export const DEFAULT_LEASE_UPSTREAM_PROXY_PORT = 7890;
export const DEFAULT_LEASE_PROXY_HOST = '0.0.0.0';
export const DEFAULT_LEASE_FAILURES_CAP = 10_000;
export const DEFAULT_LEASE_FAILURE_WINDOW_MS = 60_000;
export const DEFAULT_LEASE_FAILURE_THRESHOLD = 8;
export const DEFAULT_LEASE_HANDSHAKE_MAX_BYTES = 64 * 1024;

export function createLeaseStore({ now = Date.now, randomIdFn } = {}) {
  const leases = new Map();

  function randomToken(bytes) {
    if (typeof randomIdFn === 'function') return randomIdFn(bytes);
    return randomBytes(bytes).toString('base64url');
  }

  function createLease({
    targetUrl,
    resolvedUrl,
    allowHosts,
    ttlMs = DEFAULT_LEASE_TTL_MS,
    maxBytes = DEFAULT_LEASE_MAX_BYTES,
    maxConcurrency = DEFAULT_LEASE_MAX_CONCURRENCY,
    metadata = {},
  }) {
    const createdAt = typeof now === 'function' ? now() : Date.now();
    const lease = {
      username: randomToken(12),
      password: randomToken(18),
      targetUrl: String(targetUrl),
      resolvedUrl: String(resolvedUrl || targetUrl),
      allowHosts: dedupe((allowHosts || []).map((host) => String(host).toLowerCase())),
      createdAt,
      expiresAt: createdAt + ttlMs,
      maxBytes: Number.isFinite(maxBytes) && maxBytes > 0 ? maxBytes : DEFAULT_LEASE_MAX_BYTES,
      maxConcurrency: Number.isInteger(maxConcurrency) && maxConcurrency >= 1 && maxConcurrency <= 32
        ? maxConcurrency
        : DEFAULT_LEASE_MAX_CONCURRENCY,
      usedBytes: 0,
      activeConnections: 0,
      completedConnections: 0,
      revoked: false,
      source: metadata.source || 'unknown',
    };
    leases.set(lease.username, lease);
    return lease;
  }

  function verify(username, password) {
    const currentNow = typeof now === 'function' ? now() : Date.now();
    const lease = leases.get(String(username));
    if (!lease || lease.revoked || currentNow >= lease.expiresAt) {
      return null;
    }
    if (!constantTimeEquals(password, lease.password)) {
      return null;
    }
    return lease;
  }

  function revoke(username) {
    const lease = leases.get(String(username));
    if (lease) lease.revoked = true;
    return lease || null;
  }

  function revokeExpired() {
    const currentNow = typeof now === 'function' ? now() : Date.now();
    const expired = [];
    for (const lease of leases.values()) {
      if (lease.revoked || currentNow >= lease.expiresAt) {
        leases.delete(lease.username);
        expired.push(lease.username);
      }
    }
    return expired;
  }

  function get(username) {
    return leases.get(String(username)) || null;
  }

  function activeCount() {
    return leases.size;
  }

  function stats() {
    let active = 0;
    let expired = 0;
    let revoked = 0;
    const currentNow = typeof now === 'function' ? now() : Date.now();
    for (const lease of leases.values()) {
      if (lease.revoked) revoked += 1;
      else if (currentNow >= lease.expiresAt) expired += 1;
      else active += 1;
    }
    return {
      leases: leases.size,
      active,
      expired,
      revoked,
    };
  }

  function publicView(lease, options = {}) {
    return publicLeaseView(lease, options, now);
  }

  return {
    createLease,
    verify,
    revoke,
    revokeExpired,
    get,
    activeCount,
    stats,
    publicView,
  };
}

export function isLeaseComplete(lease) {
  if (!lease || typeof lease !== 'object') return false;
  return Boolean(lease.revoked || (lease.activeConnections === 0 && (lease.usedBytes > 0 || lease.completedConnections > 0)));
}

export function rejectConnect(clientSocket, status, message) {
  if (!clientSocket || typeof clientSocket.write !== 'function') return;
  clientSocket.write(`HTTP/1.1 ${status}\r\nContent-Length: ${Buffer.byteLength(message)}\r\nConnection: close\r\n\r\n${message}`);
  clientSocket.destroy?.();
}

export function formatConnectHeader(hostname, port) {
  return `CONNECT ${hostname}:${port} HTTP/1.1\r\nHost: ${hostname}:${port}\r\n\r\n`;
}

export function createLeaseProxy({
  leaseStore,
  upstreamProxyHost = DEFAULT_LEASE_UPSTREAM_PROXY_HOST,
  upstreamProxyPort = DEFAULT_LEASE_UPSTREAM_PROXY_PORT,
  host = DEFAULT_LEASE_PROXY_HOST,
  port,
  onEvent = () => {},
  httpServerImpl,
  netConnectImpl,
} = {}) {
  const createServer = httpServerImpl || http.createServer;
  const netConnect = netConnectImpl || net.connect;
  const server = createServer((req, res) => {
    writeText(res, 405, 'lease proxy supports CONNECT only\n');
  });

  const failuresByIp = new Map();

  function recordFailure(ip) {
    const now = Date.now();
    const entry = failuresByIp.get(ip) || { count: 0, windowStart: now };
    if (now - entry.windowStart > DEFAULT_LEASE_FAILURE_WINDOW_MS) {
      entry.count = 0;
      entry.windowStart = now;
    }
    entry.count += 1;
    failuresByIp.set(ip, entry);
    if (failuresByIp.size > DEFAULT_LEASE_FAILURES_CAP) failuresByIp.clear();
    return entry.count;
  }

  function rateLimited(ip) {
    const entry = failuresByIp.get(ip);
    if (!entry) return false;
    if (Date.now() - entry.windowStart > DEFAULT_LEASE_FAILURE_WINDOW_MS) {
      failuresByIp.delete(ip);
      return false;
    }
    return entry.count >= DEFAULT_LEASE_FAILURE_THRESHOLD;
  }

  function pipeTunnel(clientSocket, proxySocket, lease, onClose) {
    let closed = false;
    const finish = () => {
      if (closed) return;
      closed = true;
      lease.activeConnections = Math.max(0, lease.activeConnections - 1);
      lease.completedConnections += 1;
      onClose(lease);
      clientSocket.destroy();
      proxySocket.destroy();
    };
    clientSocket.on('error', finish);
    proxySocket.on('error', finish);
    clientSocket.on('end', finish);
    proxySocket.on('end', finish);
    clientSocket.on('close', finish);
    proxySocket.on('close', finish);
    const account = (chunk) => {
      lease.usedBytes += chunk.length;
      if (lease.usedBytes >= lease.maxBytes) {
        safeEvent(onEvent, { event: 'lease_byte_cap', username: lease.username, usedBytes: lease.usedBytes });
        finish();
        return false;
      }
      return true;
    };
    proxySocket.on('data', (chunk) => {
      if (account(chunk)) clientSocket.write(chunk);
    });
    clientSocket.on('data', (chunk) => {
      if (account(chunk)) proxySocket.write(chunk);
    });
  }

  function completeLease(lease, reason) {
    if (isLeaseComplete(lease)) {
      leaseStore.revoke(lease.username);
      safeEvent(onEvent, { event: 'lease_completed', username: lease.username, usedBytes: lease.usedBytes, reason });
    }
  }

  server.on('connect', (req, clientSocket, head) => {
    const ip = String(req.headers['x-lease-client-ip'] || req.socket?.remoteAddress || 'unknown');
    let tunnelEstablished = false;
    if (rateLimited(ip)) {
      rejectConnect(clientSocket, 403, 'rate limited\n');
      return;
    }
    const credentials = parseProxyAuth(req.headers['proxy-authorization']);
    const lease = credentials ? leaseStore.verify(credentials.username, credentials.password) : null;
    if (!lease) {
      recordFailure(ip);
      safeEvent(onEvent, { event: 'lease_auth_failure', ip });
      rejectConnect(clientSocket, 407, 'proxy authentication required\n');
      return;
    }
    const authority = parseAuthority(req.url);
    if (!authority || !lease.allowHosts.includes(authority.hostname)) {
      safeEvent(onEvent, { event: 'lease_host_denied', username: lease.username, host: authority?.hostname });
      rejectConnect(clientSocket, 403, 'host not allowed by lease\n');
      return;
    }
    if (lease.activeConnections >= lease.maxConcurrency) {
      rejectConnect(clientSocket, 429, 'lease concurrency exhausted\n');
      return;
    }
    const proxySocket = netConnect(upstreamProxyPort, upstreamProxyHost, () => {
      proxySocket.write(formatConnectHeader(authority.hostname, authority.port));
    });
    proxySocket.on('error', () => {
      if (!tunnelEstablished) rejectConnect(clientSocket, 502, 'upstream proxy unavailable\n');
    });
    proxySocket.on('close', () => {
      if (!tunnelEstablished) rejectConnect(clientSocket, 502, 'upstream proxy closed\n');
    });
    let handshakeBuffer = Buffer.alloc(0);
    let handshakeDone = false;
    proxySocket.on('data', (chunk) => {
      if (handshakeDone) return;
      handshakeBuffer = Buffer.concat([handshakeBuffer, chunk]);
      if (handshakeBuffer.length > DEFAULT_LEASE_HANDSHAKE_MAX_BYTES) {
        proxySocket.destroy();
        if (!tunnelEstablished) rejectConnect(clientSocket, 502, 'upstream proxy handshake too large\n');
        return;
      }
      const headerEnd = handshakeBuffer.indexOf('\r\n\r\n');
      if (headerEnd < 0) return;
      const headerText = handshakeBuffer.slice(0, headerEnd).toString('latin1');
      if (!/^HTTP\/1\.[01] 200/i.test(headerText)) {
        rejectConnect(clientSocket, 502, 'upstream proxy refused\n');
        proxySocket.destroy();
        return;
      }
      handshakeDone = true;
      const remainder = handshakeBuffer.slice(headerEnd + 4);
      tunnelEstablished = true;
      lease.activeConnections += 1;
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head && head.length) proxySocket.write(head);
      if (remainder.length) clientSocket.write(remainder);
      pipeTunnel(clientSocket, proxySocket, lease, (updatedLease) => {
        completeLease(updatedLease, 'session_end');
      });
    });
  });

  function listen() {
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => {
        server.removeListener('error', reject);
        const boundPort = server.address()?.port || port;
        safeEvent(onEvent, { event: 'lease_proxy_listening', port: boundPort, host });
        resolve(boundPort);
      });
    });
  }

  function close() {
    return new Promise((resolve) => server.close(resolve));
  }

  return { listen, close, server };
}

export function publicLeaseView(lease, { proxyHost, proxyPort, proxyUrl } = {}, now = Date.now) {
  if (!lease || typeof lease !== 'object') return null;
  let endpoint;
  if (proxyUrl) {
    const url = new URL(String(proxyUrl));
    url.username = lease.username;
    url.password = lease.password;
    endpoint = url.toString().replace(/\/$/, '');
  } else {
    endpoint = `http://${lease.username}:${lease.password}@${proxyHost}:${proxyPort}`;
  }
  const nowMs = typeof now === 'function' ? now() : Number(now || Date.now());
  return {
    username: lease.username,
    password: lease.password,
    proxyUrl: endpoint,
    url: lease.resolvedUrl || lease.targetUrl,
    allowHosts: Array.isArray(lease.allowHosts) ? lease.allowHosts : [],
    expiresAt: lease.expiresAt,
    ttlMs: Number.isFinite(lease.expiresAt) ? lease.expiresAt - nowMs : 0,
    maxBytes: lease.maxBytes,
    maxConcurrency: lease.maxConcurrency,
    once: true,
  };
}

export function isChunkSignatureValid(token, secret) {
  const [payload, signature] = String(token || '').split('.');
  if (!payload || !signature || !secret) return false;
  return isSignatureMatch(signature, hmacSha256(payload, secret, 'base64url'));
}

export function initialEhGalleryManifest(opts = {}) {
  if (!opts || typeof opts !== 'object') return null;
  const {
    adapter,
    target,
    initialHtml,
    maxPages,
    extractTitle = extractEhGalleryTitle,
  } = opts;
  if (!adapter || typeof adapter.imagePageUrls !== 'function') return null;
  const rawImageUrls = adapter.imagePageUrls(initialHtml, target) || [];
  const imageUrls = rawImageUrls.slice(0, maxPages);
  const galleryUrls = typeof adapter.galleryPageUrls === 'function' ? (adapter.galleryPageUrls(initialHtml, target) || []) : [];
  return {
    galleryUrls,
    imageUrls,
    failures: [],
    truncated: false,
    totalPages: imageUrls.length,
    status: 200,
    title: typeof extractTitle === 'function' ? extractTitle({ url: target, html: initialHtml }) : 'E-Hentai 画廊',
  };
}

export function routeBucket(pathname) {
  const p = String(pathname || '');
  if (p === '/healthz') return 'healthz';
  if (p === '/readyz') return 'readyz';
  if (p.startsWith('/_gateway/lease/')) return 'lease';
  if (p.startsWith('/_gateway/chunk/')) return 'chunk';
  if (p.startsWith('/_gateway/infra')) return 'infra';
  if (p.startsWith('/_gateway/prefetch')) return 'prefetch';
  if (p.startsWith('/_gateway/metrics')) return 'metrics';
  if (p.startsWith('/_gateway/item/')) return 'item';
  if (p.startsWith('/_gateway/media/')) return 'media';
  if (p.startsWith('/ehviewer/')) return 'ehviewer';
  return 'feed';
}

export function compilePattern(routeId) {
  const segments = String(routeId || '').split('/').filter(Boolean);
  const pattern = [];
  let star = false;
  for (const segment of segments) {
    if (segment === '*') {
      star = true;
      pattern.push({ type: 'star' });
    } else if (segment.startsWith(':')) {
      const name = segment.slice(1);
      if (name.endsWith('?')) {
        pattern.push({ type: 'optional', name: name.slice(0, -1) });
      } else {
        pattern.push({ type: 'param', name });
      }
    } else {
      pattern.push({ type: 'literal', value: segment });
    }
  }
  if (star && pattern[pattern.length - 1].type !== 'star') {
    throw new Error(`route "${routeId}": * must be the last segment`);
  }
  return pattern;
}

export function normalizeRoute(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const routeId = String(raw.routeId || '').trim();
  const backend = String(raw.backend || '').trim();
  if (!routeId || !backend) return null;
  let pattern;
  try {
    pattern = compilePattern(routeId);
  } catch {
    return null;
  }
  const fallbackUpstream = raw.fallback_upstream === true || raw.fallbackUpstream === true;
  const cacheTtl = Number.isInteger(raw.cacheTtl) && raw.cacheTtl > 0 ? raw.cacheTtl : undefined;
  const redirectTo = typeof raw.redirectTo === 'string' && raw.redirectTo.trim()
    ? raw.redirectTo.trim()
    : (typeof raw.redirect_to === 'string' && raw.redirect_to.trim() ? raw.redirect_to.trim() : undefined);
  return { routeId, backend, fallbackUpstream, cacheTtl, redirectTo, pattern };
}

export function matchSegments(pattern, segments) {
  if (!Array.isArray(pattern) || !Array.isArray(segments)) return null;
  const params = {};
  const starIndex = pattern.findIndex((part) => part.type === 'star');
  const required = pattern.filter((part) => part.type !== 'optional');
  const minLength = starIndex >= 0 ? starIndex : required.length;
  const maxLength = starIndex >= 0 ? Infinity : pattern.length;
  if (segments.length < minLength || segments.length > maxLength) return null;
  let segmentIndex = 0;
  for (let index = 0; index < pattern.length; index += 1) {
    const part = pattern[index];
    if (part.type === 'star') {
      return params;
    }
    if (segmentIndex >= segments.length) {
      if (part.type === 'optional') return params;
      return null;
    }
    const value = segments[segmentIndex];
    if (part.type === 'literal') {
      if (value !== part.value) return null;
    } else if (part.type === 'param' || part.type === 'optional') {
      try {
        params[part.name] = decodeURIComponent(value);
      } catch {
        // Malformed percent-encoding must reject the match, never crash
        return null;
      }
    }
    segmentIndex += 1;
  }
  return segmentIndex === segments.length ? params : null;
}

export function matchRouteList(routes, pathname) {
  const segments = String(pathname || '').split('/').filter(Boolean);
  for (const route of Array.isArray(routes) ? routes : []) {
    if (!route || !route.pattern) continue;
    const params = matchSegments(route.pattern, segments);
    if (params !== null) return { route, params };
  }
  return null;
}

export function registerRouteEntries(targetList, entries) {
  let registered = 0;
  let rejected = 0;
  for (const raw of Array.isArray(entries) ? entries : []) {
    const route = normalizeRoute(raw);
    if (!route) {
      rejected += 1;
      continue;
    }
    targetList.push(route);
    registered += 1;
  }
  return { registered, rejected };
}

export function unregisterRouteEntries(targetList, routeIds) {
  const wanted = new Set(Array.isArray(routeIds) ? routeIds.map(String) : []);
  const before = targetList.length;
  for (let index = targetList.length - 1; index >= 0; index -= 1) {
    if (wanted.has(targetList[index]?.routeId)) targetList.splice(index, 1);
  }
  return { removed: before - targetList.length };
}

export function buildSidecarFetchPayload(route, params, { egressLane, cookies, cacheTtl } = {}) {
  return {
    routeId: route?.routeId,
    params,
    egressLane,
    cookies: cookiesObject(cookies),
    cacheTtl: cacheTtl ?? route?.cacheTtl,
  };
}

export function sidecarUrl(backend) {
  if (typeof backend !== 'string' || !backend.startsWith('sidecar://')) return null;
  const hostPort = backend.slice('sidecar://'.length).replace(/\/$/, '');
  if (!hostPort) return null;
  return `http://${hostPort}`;
}

export function createDispatcher({
  routesFile = process.env.GATEWAY_ROUTES_FILE || DEFAULT_ROUTES_FILE,
  readFileImpl,
  parseYaml,
  fetchImpl = fetch,
  logger = console,
  sidecarTimeoutMs = DEFAULT_SIDECAR_TIMEOUT_MS,
} = {}) {
  const readFn = readFileImpl || fs.readFileSync;
  const yamlParser = parseYaml || ((src) => {
    try {
      return JSON.parse(src);
    } catch {
      return null;
    }
  });
  const routes = [];
  const runtimeRoutes = [];
  try {
    const source = readFn(routesFile, 'utf8');
    const parsed = yamlParser(source);
    if (parsed && Array.isArray(parsed.routes)) {
      for (const raw of parsed.routes) {
        const route = normalizeRoute(raw);
        if (route) routes.push(route);
      }
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      logger?.error?.(`dispatcher_routes_load_failed: ${error?.message || error}`);
    }
  }

  function registerRoutes(entries) {
    return registerRouteEntries(runtimeRoutes, entries);
  }

  function unregisterRoutes(routeIds) {
    return unregisterRouteEntries(runtimeRoutes, routeIds);
  }

  function match(pathname) {
    return matchRouteList([...routes, ...runtimeRoutes], pathname);
  }

  async function callSidecar(route, params, { egressLane, cookies, cacheTtl, requestId } = {}) {
    const baseUrl = sidecarUrl(route?.backend);
    if (!baseUrl) throw new Error(`unsupported backend: ${route?.backend}`);
    let response;
    try {
      response = await fetchImpl(`${baseUrl}/fetch`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(requestId ? { 'x-request-id': requestId } : {}),
        },
        body: JSON.stringify(buildSidecarFetchPayload(route, params, { egressLane, cookies, cacheTtl })),
        signal: AbortSignal.timeout(sidecarTimeoutMs),
      });
    } catch (error) {
      throw new Error(`sidecar unavailable: ${error.message}`);
    }
    if (!response.ok) throw new Error(`sidecar returned ${response.status}`);
    let payload;
    try {
      payload = await response.json();
    } catch {
      throw new Error('sidecar response is not valid json');
    }
    if (!payload || typeof payload.rssXml !== 'string') {
      throw new Error('sidecar response missing rssXml');
    }
    return payload;
  }

  return { routes, runtimeRoutes, registerRoutes, unregisterRoutes, match, callSidecar };
}

export function cookiesObject(cookies) {
  if (cookies === undefined || cookies === null) return {};
  if (typeof cookies === 'string') {
    const parsed = {};
    for (const part of cookies.split(';')) {
      const separator = part.indexOf('=');
      if (separator <= 0) continue;
      const name = part.slice(0, separator).trim();
      const value = part.slice(separator + 1).trim();
      if (name && !(name in parsed)) parsed[name] = value;
    }
    return parsed;
  }
  if (typeof cookies === 'object') {
    return Object.fromEntries(
      Object.entries(cookies)
        .filter(([name, value]) => name && value !== undefined && value !== null)
        .map(([name, value]) => [String(name).trim(), String(value).trim()]),
    );
  }
  return {};
}

export function resolveRedirect(template, params = {}) {
  if (typeof template !== 'string') return null;
  return template.replace(/:([a-zA-Z0-9_]+)\??/g, (_, name) => {
    const value = params && typeof params === 'object' ? params[name] : undefined;
    return value !== undefined && value !== null ? encodeURIComponent(String(value)) : '';
  }).replace(/\/+/g, '/').replace(/\/$/, '') || '/';
}

export function durationCheckpoint(results = [], count = 0) {
  const safeCount = Number.isInteger(count) ? count : 0;
  if (!safeCount || !Array.isArray(results) || !results.length) return 0;
  const samples = results
    .map((result) => (typeof result === 'object' && result !== null ? Number(result.completedAt) : Number(result)))
    .filter(Number.isFinite)
    .sort((left, right) => left - right);
  if (!samples.length) return 0;
  const picked = samples.slice(0, safeCount);
  return Math.max(...picked);
}

export function cdata(value) {
  return `<![CDATA[${String(value ?? '').replaceAll(']]>', ']]]]><![CDATA[>')}]]>`;
}

export async function atomicWriteJson(targetFile, data, { mode = 0o600, dirMode = 0o700, indent } = {}) {
  if (!targetFile) return false;
  const payload = typeof data === 'string' ? data : (indent ? JSON.stringify(data, null, indent) : JSON.stringify(data));
  const directory = path.dirname(targetFile);
  const temporary = `${targetFile}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fsp.mkdir(directory, { recursive: true, mode: dirMode });
    await fsp.writeFile(temporary, payload, { encoding: 'utf8', mode });
    if (mode) await fsp.chmod(temporary, mode).catch(() => {});
    await fsp.rename(temporary, targetFile);
    if (mode) await fsp.chmod(targetFile, mode).catch(() => {});
    return true;
  } catch (error) {
    await fsp.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}
