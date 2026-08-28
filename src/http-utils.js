import fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import path from 'node:path';
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

export function isValidImageVariantWidth(width) {
  return IMAGE_VARIANT_WIDTHS.includes(Number(width));
}

export function isSupportedImageVariantType(contentType) {
  const normalized = String(contentType || '').split(';', 1)[0].trim().toLowerCase();
  return SUPPORTED_IMAGE_VARIANT_TYPES.has(normalized);
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
