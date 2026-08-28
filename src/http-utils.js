import fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { randomUUID, createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { brotliCompressSync, constants as zlibConstants, gzipSync } from 'node:zlib';

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

export const EH_GALLERY_PATH = /^\/g\/[^/]+\/[^/]+\/?$/;
export const EH_IMAGE_PATH = /^\/s\/[^/]+\/[^/]+(?:\/)?$/;

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

export function sidecarUrl(backend) {
  if (typeof backend !== 'string' || !backend.startsWith('sidecar://')) return null;
  const hostPort = backend.slice('sidecar://'.length).replace(/\/$/, '');
  if (!hostPort) return null;
  return `http://${hostPort}`;
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
