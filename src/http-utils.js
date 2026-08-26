import fs from 'node:fs';
import { IMAGE_VARIANT_WIDTHS } from './image-variants.js';

export function readSecret() {
  const file = process.env.GATEWAY_SECRET_FILE;
  if (file) return fs.readFileSync(file, 'utf8').trim();
  if (process.env.GATEWAY_SECRET) return process.env.GATEWAY_SECRET;
  return 'development-only-secret';
}

export function readSources() {
  const file = process.env.SOURCE_CONFIG_FILE;
  if (!file) return {};
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

export function publicBaseUrl(req) {
  const scheme = req.headers['x-forwarded-proto'] || 'https';
  return `${scheme}://${req.headers.host || 'localhost:1300'}`;
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
  if (error.retryAfter !== undefined) headers['retry-after'] = String(Math.min(Math.max(error.retryAfter, 0), 60));
  writeText(res, error.status, 'upstream unavailable\n', 'text/plain; charset=utf-8', headers);
}

export async function readLimited(response, limit = 4 * 1024 * 1024) {
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

const CACHE_RESPONSE_HEADERS = ['content-type', 'content-length', 'etag', 'last-modified', 'cache-control'];

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

export function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function boundedInteger(value, fallback, minimum, maximum) {
  return Math.min(Math.max(positiveInteger(value, fallback), minimum), maximum);
}

export function parseProbeTargets(value, legacyProbeUrl) {
  if (value && typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      // Fall through to default targets.
    }
  }
  if (value && typeof value === 'object') {
    const list = (input) => {
      if (!input) return [];
      return (Array.isArray(input) ? input : [input]).map(String).filter(Boolean);
    };
    return {
      public: list(value.public),
      sticky: list(value.sticky),
      hosts: value.hosts && typeof value.hosts === 'object' ? value.hosts : {},
    };
  }
  return {
    public: [String(legacyProbeUrl || 'https://e-hentai.org/').trim()],
    sticky: ['https://www.iwara.tv/', 'https://x.com/'],
    hosts: {},
  };
}

const IMAGE_VARIANT_CACHE_VERSION = 'v1';

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

export function isEhImagePageTarget(value) {
  try {
    const target = new URL(value);
    return target.protocol === 'https:'
      && target.hostname === 'e-hentai.org'
      && /^\/s\/[^/]+\/[^/]+\/?$/.test(target.pathname);
  } catch {
    return false;
  }
}

export function parseByteRange(rangeHeader, totalBytes) {
  if (!rangeHeader || typeof rangeHeader !== 'string' || !rangeHeader.startsWith('bytes=')) {
    return null;
  }
  const spec = rangeHeader.slice(6).trim();
  if (!spec || spec.includes(',')) return null; // Only single range supported
  const parts = spec.split('-');
  if (parts.length !== 2) return null;
  const [startStr, endStr] = parts;
  let start;
  let end;
  if (startStr === '') {
    // Suffix byte range: bytes=-500 (last 500 bytes)
    const suffix = Number.parseInt(endStr, 10);
    if (!Number.isInteger(suffix) || suffix <= 0) return null;
    start = Math.max(0, totalBytes - suffix);
    end = totalBytes - 1;
  } else {
    start = Number.parseInt(startStr, 10);
    if (!Number.isInteger(start) || start < 0) return null;
    if (endStr === '') {
      end = totalBytes - 1;
    } else {
      end = Number.parseInt(endStr, 10);
      if (!Number.isInteger(end) || end < start) return null;
    }
  }
  if (start >= totalBytes) return { unsatisfiable: true };
  end = Math.min(end, totalBytes - 1);
  return { start, end, size: end - start + 1, total: totalBytes };
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
