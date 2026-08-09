import http from 'node:http';
import { Readable } from 'node:stream';
import fs from 'node:fs';
import path from 'node:path';
import { transformFeed } from './feed-transform.js';
import { verifySignedTarget } from './signed-target.js';
import { createUpstreamClient } from './upstream.js';
import { GatewayUpstreamError } from './upstream-errors.js';
import { adapterForUrl } from './adapters/index.js';
import { parseRankingHtml, rankingTarget, renderRankingFeed } from './adapters/ehviewer.js';
import { extractEhImagePage, renderReaderPage, renderUnavailablePage } from './reader.js';
import { createResponseCache } from './cache.js';
import { createMediaPrefetchQueue } from './media-prefetch.js';
import { createEgressPool } from './egress-pool.js';
import { createMihomoEgressAdapter } from './mihomo-egress.js';
import { createSessionAffinity } from './session-affinity.js';
import { IMAGE_VARIANT_WIDTHS, createImageVariant } from './image-variants.js';
import {
  DEFAULT_HTML_BROTLI_MIN_BYTES,
  DEFAULT_HTML_BROTLI_QUALITY,
  encodeHtmlResponse,
} from './http-encoding.js';

function readSecret() {
  const file = process.env.GATEWAY_SECRET_FILE;
  if (file) return fs.readFileSync(file, 'utf8').trim();
  if (process.env.GATEWAY_SECRET) return process.env.GATEWAY_SECRET;
  return 'development-only-secret';
}

function readSources() {
  const file = process.env.SOURCE_CONFIG_FILE;
  if (!file) return {};
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

function publicBaseUrl(req) {
  const scheme = req.headers['x-forwarded-proto'] || 'https';
  return `${scheme}://${req.headers.host || 'localhost:1300'}`;
}

function writeText(res, status, body, contentType = 'text/plain; charset=utf-8', headers = {}) {
  res.writeHead(status, { 'content-type': contentType, ...headers, 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

function writeBuffer(res, status, body, contentType, headers = {}) {
  const output = Buffer.isBuffer(body) ? body : Buffer.from(body || '');
  res.writeHead(status, { 'content-type': contentType, ...headers, 'content-length': output.length });
  res.end(output);
}

function writeJson(res, status, payload) {
  writeText(res, status, JSON.stringify(payload), 'application/json; charset=utf-8');
}

function writeGatewayError(res, error) {
  const headers = {
    'x-gateway-source': error.source,
    'x-gateway-attempts': String(error.attempts),
  };
  if (error.retryAfter !== undefined) headers['retry-after'] = String(Math.min(Math.max(error.retryAfter, 0), 60));
  writeText(res, error.status, 'upstream unavailable\n', 'text/plain; charset=utf-8', headers);
}

async function readLimited(response, limit = 4 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body ?? []) {
    size += chunk.length;
    if (size > limit) throw new Error('upstream response too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function readBinaryLimited(response, limit) {
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

function responseHeaders(response) {
  const headers = {};
  for (const name of CACHE_RESPONSE_HEADERS) {
    const value = response.headers.get(name);
    if (value) headers[name] = value;
  }
  return headers;
}

function responseFromCachedDocument(result) {
  return new Response(result.body, { status: result.status, headers: result.headers });
}

function documentCacheKind(url, kind) {
  if (kind !== 'html') return kind;
  try {
    const target = new URL(url);
    if (target.hostname === 'e-hentai.org' && /^\/s\/[^/]+\/[^/]+\/?$/.test(target.pathname)) return 'eh-image';
  } catch {
    // Keep the caller's cache kind for malformed diagnostic URLs.
  }
  return kind;
}

function cacheStateLog(url, kind, state) {
  try {
    console.log(JSON.stringify({ event: 'gateway_cache', host: new URL(url).hostname, kind, state }));
  } catch {
    // Cache diagnostics must never affect the response.
  }
}

async function fetchCachedDocument({ cache, fetcher, requestUrl, cacheUrl = requestUrl, request, kind }) {
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
  }, { allowStale: cacheKind !== 'eh-image' });
  cacheStateLog(cacheUrl, cacheKind, result.state);
  return responseFromCachedDocument(result);
}

const DEFAULT_EH_PREFETCH_CONCURRENCY = 8;
const DEFAULT_EH_PREFETCH_MAX_CONCURRENCY = 36;
const DEFAULT_EH_MAX_PREFETCH_PAGES = 300;
const DEFAULT_EH_MEDIA_PREFETCH_CONCURRENCY = 6;
const DEFAULT_EH_MEDIA_PREFETCH_MIN_CONCURRENCY = 3;
const DEFAULT_EH_MEDIA_PREFETCH_MAX_CONCURRENCY = 12;
const DEFAULT_EH_MEDIA_PREFETCH_PER_ORIGIN = 2;
const DEFAULT_EH_MEDIA_FOREGROUND_WARM_COUNT = 8;
const DEFAULT_EH_MEDIA_FOREGROUND_WARM_CONCURRENCY = 8;
const DEFAULT_EGRESS_LANE_COUNT = 12;
const DEFAULT_EGRESS_SESSION_LANE_COUNT = 12;
const DEFAULT_EGRESS_SESSION_LISTENER_BASE_PORT = 7921;
const DEFAULT_EGRESS_MIN_CONCURRENCY_PER_LANE = 3;
const DEFAULT_EGRESS_MAX_CONCURRENCY_PER_LANE = 6;
const DEFAULT_EGRESS_MAX_TOTAL_CONCURRENCY = 48;
const DEFAULT_EGRESS_REFRESH_INTERVAL_MS = 60_000;
const DEFAULT_MEDIA_CACHE_MAX_FILE_BYTES = 32 * 1024 ** 2;
const DEFAULT_MEDIA_BROWSER_CACHE_SECONDS = 300;
const IMAGE_VARIANT_CACHE_VERSION = 'v1';

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function boundedInteger(value, fallback, minimum, maximum) {
  return Math.min(Math.max(positiveInteger(value, fallback), minimum), maximum);
}

function requestedImageVariantWidth(searchParams) {
  if (!searchParams.has('w')) return { width: undefined };
  const values = searchParams.getAll('w');
  const value = values.length === 1 ? values[0] : '';
  const width = Number(value);
  if (!IMAGE_VARIANT_WIDTHS.includes(width) || String(width) !== value) return { error: true };
  return { width };
}

function imageVariantCacheUrl(target, width) {
  const cacheUrl = new URL(target);
  cacheUrl.hash = `rsshub-gateway-${IMAGE_VARIANT_CACHE_VERSION}-w${width}`;
  return cacheUrl.toString();
}

async function mapWithConcurrency(items, concurrency, worker) {
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

function createConcurrencyLimiter(limit) {
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

async function loadCachedMedia({ cache, fetcher, target, range, maxBytes }) {
  if (!cache || range) {
    return { response: await fetcher(target, { range, circuit: false }), cacheState: 'BYPASS' };
  }
  const result = await cache.getOrLoad(target, 'media', async () => {
    const remote = await fetcher(target, { range, circuit: false });
    const contentType = remote.headers.get('content-type') || '';
    const contentLength = Number.parseInt(remote.headers.get('content-length') || '', 10);
    const cacheable = remote.ok
      && contentType.toLowerCase().startsWith('image/')
      && Number.isSafeInteger(contentLength)
      && contentLength >= 0
      && contentLength <= maxBytes;
    if (!cacheable) {
      return { passthrough: remote, cacheable: false };
    }
    return {
      status: remote.status,
      headers: responseHeaders(remote),
      body: await readBinaryLimited(remote, maxBytes),
      cacheable: true,
    };
  });
  cacheStateLog(target, 'media', result.state);
  return {
    response: result.passthrough || responseFromCachedDocument(result),
    cacheState: result.state,
  };
}

async function fetchCachedMedia(options) {
  return (await loadCachedMedia(options)).response;
}

async function warmEhMedia({ pages, cache, fetcher, maxBytes, count, concurrency }) {
  const targets = [...new Set(pages.map((page) => page.mediaTarget).filter(Boolean))].slice(0, count);
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

function failureMessage(kind, pageNumber) {
  if (kind === 'gallery') return `画廊分页 ${pageNumber} 暂时无法读取`;
  return `第 ${pageNumber} 页暂时无法读取`;
}

async function prefetchEhGallery({
  adapter,
  target,
  initialHtml,
  fetchExternal,
  baseUrl,
  secret,
  concurrency,
  maxPages,
  onPage,
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
  const imageResults = await mapWithConcurrency(selectedImageUrls, concurrency, async (imageUrl, index) => {
    const pageNumber = index + 1;
    try {
      const remote = await fetchExternal(adapter.readerTarget(imageUrl), { galleryShard: index });
      const body = await readLimited(remote);
      const contentType = remote.headers.get('content-type') || '';
      if (!remote.ok || !contentType.includes('html')) {
        return { page: null, failure: { pageNumber, message: failureMessage('image', pageNumber) }, status: remote.status };
      }
      const page = extractEhImagePage({ url: imageUrl, html: body, baseUrl, secret, pageNumber });
      if (page) {
        try {
          onPage?.(page);
        } catch {
          // Background warming must not affect gallery parsing.
        }
      }
      return page
        ? { page, failure: null, status: remote.status }
        : { page: null, failure: { pageNumber, message: failureMessage('image', pageNumber) }, status: remote.status };
    } catch {
      return { page: null, failure: { pageNumber, message: failureMessage('image', pageNumber) }, status: 502 };
    }
  });

  const pages = [];
  let status = galleryResults.find((result) => !result.ok)?.status || 200;
  for (const result of imageResults) {
    if (result.page) pages.push(result.page);
    if (result.failure) failures.push(result.failure);
    if (!result.page && result.status && result.status >= 400) status = result.status;
  }
  pages.sort((left, right) => left.pageNumber - right.pageNumber);
  return {
    title: pages[0]?.title || 'E-Hentai 画廊',
    pages,
    failures,
    totalPages: imageUrls.length,
    truncated,
    status,
  };
}

export function createGatewayServer(options = {}) {
  const secret = options.secret || readSecret();
  const sourceConfig = options.sourceConfig || readSources();
  const ehPrefetchConcurrency = boundedInteger(
    options.ehPrefetchConcurrency ?? process.env.EH_PREFETCH_CONCURRENCY,
    DEFAULT_EH_PREFETCH_CONCURRENCY,
    1,
    DEFAULT_EGRESS_MAX_TOTAL_CONCURRENCY,
  );
  const ehMaxPrefetchPages = boundedInteger(
    options.ehMaxPrefetchPages ?? process.env.EH_MAX_PREFETCH_PAGES,
    DEFAULT_EH_MAX_PREFETCH_PAGES,
    1,
    DEFAULT_EH_MAX_PREFETCH_PAGES,
  );
  const egressLaneCount = boundedInteger(
    options.egressLaneCount ?? process.env.EGRESS_LANE_COUNT,
    DEFAULT_EGRESS_LANE_COUNT,
    1,
    DEFAULT_EGRESS_LANE_COUNT,
  );
  const egressSessionLaneCount = boundedInteger(
    options.egressSessionLaneCount ?? process.env.EGRESS_SESSION_LANE_COUNT,
    DEFAULT_EGRESS_SESSION_LANE_COUNT,
    1,
    DEFAULT_EGRESS_SESSION_LANE_COUNT,
  );
  const egressSessionListenerBasePort = boundedInteger(
    options.egressSessionListenerBasePort ?? process.env.EGRESS_SESSION_LISTENER_BASE_PORT,
    DEFAULT_EGRESS_SESSION_LISTENER_BASE_PORT,
    1024,
    65_524,
  );
  const egressMinConcurrencyPerLane = boundedInteger(
    options.egressMinConcurrencyPerLane ?? process.env.EGRESS_MIN_CONCURRENCY_PER_LANE,
    DEFAULT_EGRESS_MIN_CONCURRENCY_PER_LANE,
    1,
    12,
  );
  const egressMaxConcurrencyPerLane = boundedInteger(
    options.egressMaxConcurrencyPerLane ?? process.env.EGRESS_MAX_CONCURRENCY_PER_LANE,
    DEFAULT_EGRESS_MAX_CONCURRENCY_PER_LANE,
    egressMinConcurrencyPerLane,
    24,
  );
  const egressMaxTotalConcurrency = boundedInteger(
    options.egressMaxTotalConcurrency ?? process.env.EGRESS_MAX_TOTAL_CONCURRENCY,
    DEFAULT_EGRESS_MAX_TOTAL_CONCURRENCY,
    egressMinConcurrencyPerLane,
    96,
  );
  const ehPrefetchMaxConcurrency = boundedInteger(
    options.ehPrefetchMaxConcurrency ?? process.env.EH_PREFETCH_MAX_CONCURRENCY,
    DEFAULT_EH_PREFETCH_MAX_CONCURRENCY,
    ehPrefetchConcurrency,
    egressMaxTotalConcurrency,
  );
  const egressRefreshIntervalMs = boundedInteger(
    options.egressRefreshIntervalMs ?? process.env.EGRESS_REFRESH_INTERVAL_MS,
    DEFAULT_EGRESS_REFRESH_INTERVAL_MS,
    5_000,
    10 * 60_000,
  );
  const egressProbeUrl = options.egressProbeUrl ?? process.env.EGRESS_PROBE_URL ?? 'https://e-hentai.org/';
  const egressProbeTimeoutMs = boundedInteger(
    options.egressProbeTimeoutMs ?? process.env.EGRESS_PROBE_TIMEOUT_MS,
    5_000,
    1_000,
    30_000,
  );
  const egressProbeCacheMs = boundedInteger(
    options.egressProbeCacheMs ?? process.env.EGRESS_PROBE_CACHE_MS,
    5 * 60_000,
    10_000,
    60 * 60_000,
  );
  const egressPool = options.egressPool || createEgressPool({
    lanes: options.egressLanes,
    minConcurrencyPerLane: egressMinConcurrencyPerLane,
    maxConcurrencyPerLane: egressMaxConcurrencyPerLane,
    onEvent: (event) => {
      if (['ramp', 'backoff', 'empty'].includes(event.state)) {
        console.log(JSON.stringify({ event: 'egress_pool', state: event.state, lanes: egressPool.stats().lanes.length }));
      }
    },
  });
  const controllerUrl = options.egressControllerUrl || process.env.EGRESS_CONTROLLER_URL;
  const egressAdapter = options.egressAdapter || (controllerUrl
    ? createMihomoEgressAdapter({
      controllerUrl,
      listenerBaseUrl: options.egressProxyBaseUrl || process.env.EGRESS_PROXY_BASE_URL,
      laneCount: egressLaneCount,
      sessionLaneCount: egressSessionLaneCount,
      sessionListenerBasePort: egressSessionListenerBasePort,
      probeUrl: egressProbeUrl,
      probeTimeoutMs: egressProbeTimeoutMs,
      probeCacheMs: egressProbeCacheMs,
      onEvent: (event) => {
        if (['refresh', 'degraded', 'empty'].includes(event.state)) {
          console.log(JSON.stringify({ event: 'mihomo_egress', state: event.state, lanes: event.lanes }));
        }
      },
    })
    : null);
  const sessionAffinity = options.sessionAffinity || (egressAdapter
    ? createSessionAffinity({
      root: options.sessionAffinityRoot || process.env.GATEWAY_CACHE_DIR || '/var/cache/rsshub-gateway',
      file: options.sessionAffinityFile || process.env.SESSION_AFFINITY_FILE,
      secret,
      laneIds: () => egressAdapter.sessionLanes?.().map((lane) => lane.id) || [],
    })
    : null);
  if (egressAdapter) {
    const refreshEgress = async () => {
      const lanes = egressAdapter.refreshPublicLanes
        ? await egressAdapter.refreshPublicLanes()
        : await egressAdapter.refresh();
      egressPool.setLanes(lanes);
      await egressAdapter.refreshSessionLanes?.();
    };
    void refreshEgress();
    const refreshTimer = setInterval(() => void refreshEgress(), egressRefreshIntervalMs);
    refreshTimer.unref?.();
  }
  const ehMediaPrefetchConcurrency = boundedInteger(
    options.ehMediaPrefetchConcurrency ?? process.env.EH_MEDIA_PREFETCH_CONCURRENCY,
    DEFAULT_EH_MEDIA_PREFETCH_CONCURRENCY,
    1,
    egressMaxTotalConcurrency,
  );
  const ehMediaPrefetchMinConcurrency = boundedInteger(
    options.ehMediaPrefetchMinConcurrency ?? process.env.EH_MEDIA_PREFETCH_MIN_CONCURRENCY,
    DEFAULT_EH_MEDIA_PREFETCH_MIN_CONCURRENCY,
    1,
    egressMaxTotalConcurrency,
  );
  const ehMediaPrefetchMaxConcurrency = boundedInteger(
    options.ehMediaPrefetchMaxConcurrency ?? process.env.EH_MEDIA_PREFETCH_MAX_CONCURRENCY,
    DEFAULT_EH_MEDIA_PREFETCH_MAX_CONCURRENCY,
    ehMediaPrefetchMinConcurrency,
    egressMaxTotalConcurrency,
  );
  const ehMediaPrefetchPerOriginConcurrency = boundedInteger(
    options.ehMediaPrefetchPerOriginConcurrency ?? process.env.EH_MEDIA_PREFETCH_PER_ORIGIN,
    DEFAULT_EH_MEDIA_PREFETCH_PER_ORIGIN,
    1,
    48,
  );
  const ehMediaForegroundWarmCount = boundedInteger(
    options.ehMediaForegroundWarmCount ?? process.env.EH_MEDIA_FOREGROUND_WARM_COUNT,
    DEFAULT_EH_MEDIA_FOREGROUND_WARM_COUNT,
    1,
    24,
  );
  const ehMediaForegroundWarmConcurrency = boundedInteger(
    options.ehMediaForegroundWarmConcurrency ?? process.env.EH_MEDIA_FOREGROUND_WARM_CONCURRENCY,
    DEFAULT_EH_MEDIA_FOREGROUND_WARM_CONCURRENCY,
    1,
    ehMediaForegroundWarmCount,
  );
  const mediaCacheMaxFileBytes = boundedInteger(
    options.mediaCacheMaxFileBytes ?? process.env.GATEWAY_MEDIA_CACHE_MAX_FILE_BYTES,
    DEFAULT_MEDIA_CACHE_MAX_FILE_BYTES,
    1 * 1024 ** 2,
    256 * 1024 ** 2,
  );
  const mediaBrowserCacheSeconds = boundedInteger(
    options.mediaBrowserCacheSeconds ?? process.env.GATEWAY_MEDIA_BROWSER_CACHE_SECONDS,
    DEFAULT_MEDIA_BROWSER_CACHE_SECONDS,
    60,
    86_400,
  );
  const imageVariantConcurrency = boundedInteger(
    options.imageVariantConcurrency ?? process.env.GATEWAY_IMAGE_VARIANT_CONCURRENCY,
    2,
    1,
    12,
  );
  const imageVariantMaxSourceBytes = boundedInteger(
    options.imageVariantMaxSourceBytes ?? process.env.GATEWAY_IMAGE_VARIANT_MAX_SOURCE_BYTES,
    mediaCacheMaxFileBytes,
    1 * 1024 ** 2,
    mediaCacheMaxFileBytes,
  );
  const htmlBrotliMinBytes = boundedInteger(
    options.htmlBrotliMinBytes ?? process.env.GATEWAY_HTML_BROTLI_MIN_BYTES,
    DEFAULT_HTML_BROTLI_MIN_BYTES,
    256,
    16 * 1024 ** 2,
  );
  const htmlBrotliQuality = boundedInteger(
    options.htmlBrotliQuality ?? process.env.GATEWAY_HTML_BROTLI_QUALITY,
    DEFAULT_HTML_BROTLI_QUALITY,
    1,
    11,
  );
  const imageVariantLimiter = createConcurrencyLimiter(imageVariantConcurrency);
  const metricCounts = new Map();
  const metricSink = options.onMetric || ((event) => console.log(JSON.stringify(event)));
  function recordMetric(metric, details = {}) {
    const count = (metricCounts.get(metric) || 0) + 1;
    metricCounts.set(metric, count);
    try {
      metricSink({ event: 'gateway_metric', metric, count, ...details });
    } catch {
      // Metrics must never affect a gateway response.
    }
  }
  const cache = options.cache === false
    ? null
    : options.cache || ((!options.fetchExternal && !options.fetchRssHub) ? createResponseCache() : null);
  const client = options.client || createUpstreamClient({ sourceConfig, fetchImpl: options.fetchImpl, egressPool });
  const makeImageVariant = options.createImageVariant || createImageVariant;
  const fetchRssHub = options.fetchRssHub || ((path, request) => client.fetchRssHub(path, undefined, request?.headers, request));
  const fetchExternal = options.fetchExternal || ((url, request) => client.fetchExternal(url, request));
  const currentEhPrefetchConcurrency = () => {
    const poolCapacity = Number(egressPool.capacity?.()) || 0;
    return Math.min(ehPrefetchMaxConcurrency, egressMaxTotalConcurrency, Math.max(ehPrefetchConcurrency, poolCapacity));
  };
  const fetchExternalDocument = (url, request, kind = 'html') => fetchCachedDocument({
    cache,
    fetcher: fetchExternal,
    requestUrl: url,
    request,
    kind,
  });
  function sessionCredentialsFor(adapter) {
    const credentials = sourceConfig[adapter.name];
    const headers = adapter.headers?.(credentials, { includeCredentials: true }) || {};
    return Object.keys(headers).some((name) => /^(cookie|authorization)$/i.test(name)) ? credentials : null;
  }

  async function resolveSessionTransport(adapter) {
    const credentials = sessionCredentialsFor(adapter);
    if (!credentials) return null;
    if (typeof options.resolveSessionTransport === 'function') {
      const resolved = await options.resolveSessionTransport({ adapter, credentials });
      return resolved?.dispatcher ? { ...resolved, credentials } : null;
    }
    if (!sessionAffinity || !egressAdapter?.sessionLanes) return null;
    await egressAdapter.refreshSessionLanes?.();
    sessionAffinity.setLaneIds?.(egressAdapter.sessionLanes().map((lane) => lane.id));
    const affinity = await sessionAffinity.resolve(adapter.name, credentials);
    const lane = egressAdapter.sessionLanes().find((entry) => entry.id === affinity.laneId);
    return lane?.dispatcher ? { ...affinity, dispatcher: lane.dispatcher, credentials } : null;
  }

  async function authenticationChallenge(adapter, response) {
    let body = '';
    const contentType = response.headers.get('content-type') || '';
    if (contentType.includes('html')) {
      try {
        body = await readLimited(response.clone(), 512 * 1024);
      } catch {
        body = '';
      }
    }
    return adapter.isAuthenticationChallenge?.({ status: response.status, headers: response.headers, body }) || false;
  }

  async function fetchGatewayTarget(target, requestOptions = {}, routeMetadata = {}) {
    const adapter = adapterForUrl(target);
    const requestedScope = routeMetadata.egressScope === 'session'
      ? 'session'
      : (routeMetadata.egressScope === 'sticky' ? 'sticky' : 'public');
    if (requestedScope === 'session') {
      const session = await resolveSessionTransport(adapter);
      if (!session) return { adapter, unavailable: true, egressScope: 'session' };
      return {
        adapter,
        egressScope: 'session',
        session,
        response: await fetchExternal(adapter.readerTarget(target), {
          ...requestOptions,
          egressScope: 'session',
          sessionDispatcher: session.dispatcher,
          sessionCredentials: session.credentials,
        }),
      };
    }

    const response = await fetchExternal(adapter.readerTarget(target), {
      ...requestOptions,
      egressScope: requestedScope,
    });
    if (requestedScope !== 'public' || !adapter.publiclyReadable || !await authenticationChallenge(adapter, response)) {
      return { adapter, egressScope: requestedScope, response };
    }
    const session = await resolveSessionTransport(adapter);
    if (!session) return { adapter, egressScope: 'public', response };
    await response.body?.cancel();
    return {
      adapter,
      egressScope: 'session',
      session,
      response: await fetchExternal(adapter.readerTarget(target), {
        ...requestOptions,
        egressScope: 'session',
        sessionDispatcher: session.dispatcher,
        sessionCredentials: session.credentials,
      }),
    };
  }

  function signedTargetMetadata(adapter, scope) {
    return { egressScope: scope, source: adapter.name };
  }

  function cacheNamespaceFor(scope, session) {
    return scope === 'session' && session?.fingerprint ? `session:${session.fingerprint}` : 'public';
  }

  async function readCachedGatewayDocument(target, kind, namespace) {
    if (!cache) return null;
    const cacheKind = documentCacheKind(target, kind);
    const miss = new Error('gateway cache miss');
    miss.code = 'GATEWAY_CACHE_MISS';
    try {
      const result = await cache.getOrLoad(target, cacheKind, async () => { throw miss; }, {
        allowStale: cacheKind !== 'eh-image',
        namespace,
      });
      cacheStateLog(target, cacheKind, result.state);
      return responseFromCachedDocument(result);
    } catch (error) {
      if (error === miss) return null;
      throw error;
    }
  }

  async function cacheGatewayDocument(target, kind, namespace, response) {
    const body = await readLimited(response);
    if (!cache) return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
    const cacheKind = documentCacheKind(target, kind);
    const contentType = response.headers.get('content-type') || '';
    const result = await cache.getOrLoad(target, cacheKind, async () => ({
      status: response.status,
      headers: responseHeaders(response),
      body,
      cacheable: response.ok && contentType.includes('html'),
      refreshFailed: [408, 425, 429].includes(response.status) || response.status >= 500,
    }), {
      allowStale: cacheKind !== 'eh-image',
      namespace,
    });
    cacheStateLog(target, cacheKind, result.state);
    return responseFromCachedDocument(result);
  }

  async function fetchGatewayDocument(target, requestOptions, routeMetadata) {
    const adapter = adapterForUrl(target);
    const requestedScope = routeMetadata.egressScope === 'session'
      ? 'session'
      : (routeMetadata.egressScope === 'sticky' ? 'sticky' : 'public');
    if (requestedScope === 'session') {
      const session = await resolveSessionTransport(adapter);
      if (!session) return { adapter, unavailable: true, egressScope: 'session' };
      const namespace = cacheNamespaceFor('session', session);
      const cached = await readCachedGatewayDocument(target, 'html', namespace);
      if (cached) return { adapter, egressScope: 'session', session, response: cached };
      const routed = await fetchGatewayTarget(target, requestOptions, routeMetadata);
      return { ...routed, response: await cacheGatewayDocument(target, 'html', namespace, routed.response) };
    }

    const publicCached = await readCachedGatewayDocument(target, 'html', 'public');
    if (publicCached) return { adapter, egressScope: 'public', response: publicCached };
    const routed = await fetchGatewayTarget(target, requestOptions, routeMetadata);
    if (routed.unavailable) return routed;
    const namespace = cacheNamespaceFor(routed.egressScope, routed.session);
    return { ...routed, response: await cacheGatewayDocument(target, 'html', namespace, routed.response) };
  }

  async function cacheGatewayMedia(target, namespace, response) {
    if (!cache) return response;
    const contentType = response.headers.get('content-type') || '';
    const contentLength = Number.parseInt(response.headers.get('content-length') || '', 10);
    const cacheable = response.ok
      && contentType.toLowerCase().startsWith('image/')
      && Number.isSafeInteger(contentLength)
      && contentLength >= 0
      && contentLength <= mediaCacheMaxFileBytes;
    if (!cacheable) return response;
    const body = await readBinaryLimited(response, mediaCacheMaxFileBytes);
    const result = await cache.getOrLoad(target, 'media', async () => ({
      status: response.status,
      headers: responseHeaders(response),
      body,
      cacheable: true,
    }), { namespace });
    cacheStateLog(target, 'media', result.state);
    return responseFromCachedDocument(result);
  }

  async function createGatewayMediaVariant(source, target, width, namespace) {
    const original = source.response;
    if (!original?.ok || !original.body) return source;

    let variant;
    let sourceBytes = 0;
    const startedAt = Date.now();
    try {
      const body = await readBinaryLimited(original.clone(), imageVariantMaxSourceBytes);
      sourceBytes = body.length;
      variant = await imageVariantLimiter(() => makeImageVariant({
        body,
        contentType: original.headers.get('content-type') || '',
        width,
      }));
    } catch {
      recordMetric('image_variant_fallback', {
        source: source.adapter?.name || 'unknown',
        width,
        reason: 'transform-failed',
        durationMs: Date.now() - startedAt,
      });
      return source;
    }
    if (!variant?.usedVariant || !Buffer.isBuffer(variant.body)) {
      recordMetric('image_variant_fallback', {
        source: source.adapter?.name || 'unknown',
        width,
        reason: 'not-smaller',
        durationMs: Date.now() - startedAt,
      });
      return source;
    }
    recordMetric('image_variant_generated', {
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
    cacheStateLog(target, 'media-variant', result.state);
    return { ...source, response: responseFromCachedDocument(result) };
  }

  async function fetchGatewayMedia(target, requestOptions, routeMetadata, variantWidth) {
    if (requestOptions.range) return fetchGatewayTarget(target, requestOptions, routeMetadata);
    const adapter = adapterForUrl(target);
    const requestedScope = routeMetadata.egressScope === 'session'
      ? 'session'
      : (routeMetadata.egressScope === 'sticky' ? 'sticky' : 'public');
    if (requestedScope === 'session') {
      const session = await resolveSessionTransport(adapter);
      if (!session) return { adapter, unavailable: true, egressScope: 'session' };
      const namespace = cacheNamespaceFor('session', session);
      if (variantWidth && cache) {
        const cachedVariant = await readCachedGatewayDocument(imageVariantCacheUrl(target, variantWidth), 'media-variant', namespace);
        if (cachedVariant) {
          recordMetric('image_variant_hit', { source: adapter.name, width: variantWidth });
          return { adapter, egressScope: 'session', session, response: cachedVariant };
        }
      }
      const cached = await readCachedGatewayDocument(target, 'media', namespace);
      if (cached) {
        const source = { adapter, egressScope: 'session', session, response: cached };
        return variantWidth ? createGatewayMediaVariant(source, target, variantWidth, namespace) : source;
      }
      const routed = await fetchGatewayTarget(target, requestOptions, routeMetadata);
      const source = { ...routed, response: await cacheGatewayMedia(target, namespace, routed.response) };
      return variantWidth ? createGatewayMediaVariant(source, target, variantWidth, namespace) : source;
    }

    if (variantWidth && cache) {
      const cachedVariant = await readCachedGatewayDocument(imageVariantCacheUrl(target, variantWidth), 'media-variant', 'public');
      if (cachedVariant) {
        recordMetric('image_variant_hit', { source: adapter.name, width: variantWidth });
        return { adapter, egressScope: 'public', response: cachedVariant };
      }
    }
    const publicCached = await readCachedGatewayDocument(target, 'media', 'public');
    if (publicCached) {
      const source = { adapter, egressScope: 'public', response: publicCached };
      return variantWidth ? createGatewayMediaVariant(source, target, variantWidth, 'public') : source;
    }
    const routed = await fetchGatewayTarget(target, requestOptions, routeMetadata);
    if (routed.unavailable) return routed;
    const namespace = cacheNamespaceFor(routed.egressScope, routed.session);
    if (variantWidth && namespace !== 'public' && cache) {
      const cachedVariant = await readCachedGatewayDocument(imageVariantCacheUrl(target, variantWidth), 'media-variant', namespace);
      if (cachedVariant) {
        recordMetric('image_variant_hit', { source: adapter.name, width: variantWidth });
        return { ...routed, response: cachedVariant };
      }
    }
    const source = { ...routed, response: await cacheGatewayMedia(target, namespace, routed.response) };
    return variantWidth ? createGatewayMediaVariant(source, target, variantWidth, namespace) : source;
  }
  const mediaPreloadQueue = cache
    ? createMediaPrefetchQueue({
      queueFile: options.mediaPrefetchQueueFile
        || path.join(cache.root || process.env.GATEWAY_CACHE_DIR || '/var/cache/rsshub-gateway', 'media-prefetch.json'),
      initialConcurrency: ehMediaPrefetchConcurrency,
      minConcurrency: ehMediaPrefetchMinConcurrency,
      maxConcurrency: ehMediaPrefetchMaxConcurrency,
      perOriginConcurrency: ehMediaPrefetchPerOriginConcurrency,
      minimumConcurrencyProvider: egressPool.minimumCapacity,
      capacityProvider: () => Math.min(egressMaxTotalConcurrency, Math.max(egressPool.capacity(), ehMediaPrefetchConcurrency)),
      persist: options.mediaPrefetchPersist ?? !options.fetchExternal,
      fetchMedia: async (target) => {
        const loaded = await loadCachedMedia({
          cache,
          fetcher: (url, request) => fetchExternal(url, { ...request, priority: 'background' }),
          target,
          maxBytes: mediaCacheMaxFileBytes,
        });
        await loaded.response.body?.cancel();
        if (loaded.response.ok) {
          recordMetric('media_cache_ready', { source: adapterForUrl(target).name, count: 1 });
        }
        return { status: loaded.response.status, cacheState: loaded.cacheState };
      },
      onEvent: (event) => {
        if (['ramp', 'backoff', 'retry', 'failed'].includes(event.state)) {
          console.log(JSON.stringify({ event: 'eh_media_prefetch', ...event }));
        }
      },
    })
    : { enqueue: () => {} };

  return http.createServer(async (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      writeText(res, 405, 'method not allowed\n');
      return;
    }
    const requestUrl = new URL(req.url || '/', 'http://gateway.internal');
    if (requestUrl.pathname === '/healthz') {
      writeText(res, 200, 'ok\n');
      return;
    }
    if (requestUrl.pathname === '/readyz') {
      try {
        const rsshub = await fetchRssHub('/healthz', { timeout: 3_000 });
        const body = await readLimited(rsshub, 16 * 1024);
        const ready = rsshub.ok && body.trim() === 'ok';
        const payload = {
          ready,
          rsshub: ready ? 'ok' : 'unavailable',
          openCircuits: client.openCircuits?.() || [],
        };
        writeJson(res, ready ? 200 : 503, payload);
      } catch {
        writeJson(res, 503, { ready: false, rsshub: 'unavailable', openCircuits: client.openCircuits?.() || [] });
      }
      return;
    }
    const rankingMatch = requestUrl.pathname.match(/^\/ehviewer\/ranking(?:\/(month|year|all))?$/);
    if (rankingMatch) {
      const period = rankingMatch[1] || 'day';
      try {
        const remote = await fetchExternalDocument(rankingTarget(period), undefined, 'html');
        if (!remote.ok) {
          writeText(res, remote.status, 'source unavailable\n');
          return;
        }
        const body = await readLimited(remote);
        const feed = renderRankingFeed(parseRankingHtml(body, { period }));
        const output = transformFeed(feed, {
          baseUrl: publicBaseUrl(req),
          selfUrl: `${publicBaseUrl(req)}${requestUrl.pathname}${requestUrl.search}`,
          secret,
          signedTargetMetadata: { egressScope: 'public' },
        });
        writeText(res, 200, output, 'application/rss+xml; charset=utf-8', { 'cache-control': 'public, max-age=300' });
      } catch (error) {
        if (error instanceof GatewayUpstreamError) {
          console.log(JSON.stringify({
            event: 'ehviewer_failure',
            source: error.source,
            code: error.code,
            status: error.status,
            attempts: error.attempts,
          }));
          writeGatewayError(res, error);
        } else {
          writeText(res, 502, 'source unavailable\n');
        }
      }
      return;
    }
    if (requestUrl.pathname.startsWith('/ehviewer/ranking/')) {
      writeText(res, 404, 'not found\n');
      return;
    }
    const gatewayMatch = requestUrl.pathname.match(/^\/_gateway\/(item|media)\/(.+)$/);
    if (gatewayMatch) {
      const mediaVariant = gatewayMatch[1] === 'media'
        ? requestedImageVariantWidth(requestUrl.searchParams)
        : { width: undefined };
      if (mediaVariant.error) {
        writeText(res, 400, 'unsupported image variant\n');
        return;
      }
      let target;
      let routeMetadata;
      try {
        const verified = verifySignedTarget(gatewayMatch[2], secret);
        target = verified.url;
        routeMetadata = { egressScope: verified.egressScope, source: verified.source };
      } catch {
        writeText(res, 403, 'resource unavailable\n');
        return;
      }
      try {
        const adapter = adapterForUrl(target);
        const responseDriven = adapter.publiclyReadable
          || ['session', 'sticky'].includes(routeMetadata.egressScope)
          || mediaVariant.width !== undefined;
        const routed = responseDriven
          ? (gatewayMatch[1] === 'item'
            ? await fetchGatewayDocument(target, { range: req.headers.range }, routeMetadata)
            : await fetchGatewayMedia(target, { range: req.headers.range, circuit: false }, routeMetadata, mediaVariant.width))
          : {
            adapter,
            egressScope: routeMetadata.egressScope || 'public',
            response: gatewayMatch[1] === 'item'
              ? await fetchExternalDocument(adapter.readerTarget(target), { range: req.headers.range }, 'html')
              : await fetchCachedMedia({
                cache,
                fetcher: fetchExternal,
                target,
                range: req.headers.range,
                maxBytes: mediaCacheMaxFileBytes,
              }),
          };
        if (routed.unavailable) {
          if (gatewayMatch[1] === 'media') {
            writeText(res, 503, 'source unavailable\n');
          } else {
            const page = renderUnavailablePage({
              url: target,
              title: adapter.name,
              message: adapter.unavailableMessage(target, 503),
              baseUrl: publicBaseUrl(req),
              secret,
              signedTargetMetadata: signedTargetMetadata(adapter, 'session'),
            });
            writeText(res, 503, page, 'text/html; charset=utf-8');
          }
          return;
        }
        const remote = routed.response;
        if (gatewayMatch[1] === 'media') {
          const headers = {};
          for (const name of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified']) {
            const value = remote.headers.get(name);
            if (value) headers[name] = value;
          }
          const mediaContentType = remote.headers.get('content-type') || '';
          if (remote.ok && mediaContentType.toLowerCase().startsWith('image/')) {
            headers['cache-control'] = `${routed.egressScope === 'public' ? 'public' : 'private'}, max-age=${mediaBrowserCacheSeconds}`;
          }
          res.writeHead(remote.status, headers);
          if (req.method === 'HEAD') return res.end();
          if (remote.body) Readable.fromWeb(remote.body).pipe(res);
          else res.end();
          return;
        }
        let body = await readLimited(remote);
        let contentType = remote.headers.get('content-type') || '';
        let prefetchedGallery;
        let unavailableStatus = remote.status;
        const shouldPrefetchGallery = requestUrl.searchParams.get('view') !== 'gallery'
          && adapter.isGalleryUrl(target)
          && remote.ok
          && contentType.includes('html');
        if (shouldPrefetchGallery) {
          prefetchedGallery = await prefetchEhGallery({
            adapter,
            target,
            initialHtml: body,
            fetchExternal: fetchExternalDocument,
            baseUrl: publicBaseUrl(req),
            secret,
            concurrency: currentEhPrefetchConcurrency(),
            maxPages: ehMaxPrefetchPages,
            onPage: (page) => {
              recordMetric('gallery_detail_completed', { source: adapter.name, count: 1 });
              if (page.pageNumber > ehMediaForegroundWarmCount && page.mediaTarget) {
                mediaPreloadQueue.enqueue([page.mediaTarget]);
              }
            },
          });
          const foregroundWarm = await warmEhMedia({
            pages: prefetchedGallery.pages,
            cache,
            fetcher: (url, request) => fetchExternal(url, { ...request, priority: 'foreground' }),
            maxBytes: mediaCacheMaxFileBytes,
            count: ehMediaForegroundWarmCount,
            concurrency: ehMediaForegroundWarmConcurrency,
          });
          prefetchedGallery.preloadCount = foregroundWarm.targets.length;
          const readyCount = foregroundWarm.targets.length - foregroundWarm.failedTargets.length;
          if (readyCount > 0) recordMetric('media_cache_ready', { source: adapter.name, count: readyCount });
          const warmed = new Set(foregroundWarm.targets);
          mediaPreloadQueue.enqueue([
            ...foregroundWarm.failedTargets,
            ...prefetchedGallery.pages.map((page) => page.mediaTarget).filter((mediaTarget) => !warmed.has(mediaTarget)),
          ]);
          unavailableStatus = prefetchedGallery.status;
        }
        const unavailable = !remote.ok
          || (contentType.includes('html') && adapter.isReaderUnavailable?.(body))
          || (shouldPrefetchGallery && !prefetchedGallery.pages.length);
        const page = unavailable
          ? renderUnavailablePage({
            url: target,
            title: adapter.name,
            message: adapter.unavailableMessage(target, remote.status),
            baseUrl: publicBaseUrl(req),
            secret,
            signedTargetMetadata: signedTargetMetadata(adapter, routed.egressScope),
          })
          : (contentType.includes('html')
            ? renderReaderPage({
              url: target,
              html: body,
              baseUrl: publicBaseUrl(req),
              secret,
              prefetchedGallery,
              signedTargetMetadata: signedTargetMetadata(adapter, routed.egressScope),
            })
            : body);
        const status = unavailable ? unavailableStatus : (remote.ok ? 200 : remote.status);
        const renderedHtml = !unavailable && contentType.includes('html');
        if (renderedHtml) {
          const encodingStartedAt = Date.now();
          const encoded = encodeHtmlResponse({
            body: page,
            contentType: 'text/html; charset=utf-8',
            acceptEncoding: req.headers['accept-encoding'],
            method: req.method,
            minBytes: htmlBrotliMinBytes,
            quality: htmlBrotliQuality,
          });
          if (encoded.headers['content-encoding'] === 'br') {
            recordMetric('html_brotli_encoded', {
              source: adapter.name,
              bytesIn: Buffer.byteLength(page),
              bytesOut: encoded.body.length,
              durationMs: Date.now() - encodingStartedAt,
            });
          }
          writeBuffer(res, status, encoded.body, 'text/html; charset=utf-8', encoded.headers);
        } else {
          writeText(res, status, page, contentType.includes('html') ? 'text/html; charset=utf-8' : contentType);
        }
      } catch (error) {
        if (error instanceof GatewayUpstreamError) {
          console.log(JSON.stringify({
            event: 'upstream_failure',
            source: error.source,
            code: error.code,
            status: error.status,
            attempts: error.attempts,
          }));
          writeGatewayError(res, error);
          return;
        }
        writeText(res, 502, 'upstream unavailable\n');
      }
      return;
    }
    try {
      const rsshubPath = `${requestUrl.pathname}${requestUrl.search}`;
      const rsshubTarget = new URL(rsshubPath, process.env.RSSHUB_URL || 'http://rsshub:1200').toString();
      const remote = await fetchCachedDocument({
        cache,
        fetcher: fetchRssHub,
        requestUrl: rsshubPath,
        cacheUrl: rsshubTarget,
        kind: 'rss',
        request: {
          headers: {
            host: req.headers.host || 'localhost:1300',
            'x-forwarded-host': req.headers.host || 'localhost:1300',
            'x-forwarded-proto': req.headers['x-forwarded-proto'] || 'https',
          },
        },
      });
      const body = await readLimited(remote);
      const contentType = remote.headers.get('content-type') || '';
      const output = contentType.includes('xml') ? transformFeed(body, {
        baseUrl: publicBaseUrl(req),
        selfUrl: `${publicBaseUrl(req)}${requestUrl.pathname}${requestUrl.search}`,
        secret,
        signedTargetMetadata: { egressScope: 'public' },
      }) : body;
      writeText(res, remote.status, output, contentType || 'application/octet-stream');
    } catch (error) {
      if (error instanceof GatewayUpstreamError) {
        console.log(JSON.stringify({
          event: 'rsshub_failure',
          source: error.source,
          code: error.code,
          status: error.status,
          attempts: error.attempts,
        }));
        writeGatewayError(res, error);
        return;
      }
      writeText(res, 502, 'upstream unavailable\n');
    }
  });
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const server = createGatewayServer();
  server.listen(Number(process.env.PORT || 1300), '0.0.0.0', () => console.log('rsshub-gateway listening on 1300'));
}
