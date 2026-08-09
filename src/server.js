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
const DEFAULT_EGRESS_LANE_COUNT = 12;
const DEFAULT_EGRESS_MIN_CONCURRENCY_PER_LANE = 3;
const DEFAULT_EGRESS_MAX_CONCURRENCY_PER_LANE = 6;
const DEFAULT_EGRESS_MAX_TOTAL_CONCURRENCY = 48;
const DEFAULT_EGRESS_REFRESH_INTERVAL_MS = 60_000;
const DEFAULT_MEDIA_CACHE_MAX_FILE_BYTES = 32 * 1024 ** 2;

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function boundedInteger(value, fallback, minimum, maximum) {
  return Math.min(Math.max(positiveInteger(value, fallback), minimum), maximum);
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
  if (egressAdapter) {
    const refreshEgress = async () => {
      const lanes = await egressAdapter.refresh();
      egressPool.setLanes(lanes);
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
  const mediaCacheMaxFileBytes = boundedInteger(
    options.mediaCacheMaxFileBytes ?? process.env.GATEWAY_MEDIA_CACHE_MAX_FILE_BYTES,
    DEFAULT_MEDIA_CACHE_MAX_FILE_BYTES,
    1 * 1024 ** 2,
    256 * 1024 ** 2,
  );
  const cache = options.cache === false
    ? null
    : options.cache || ((!options.fetchExternal && !options.fetchRssHub) ? createResponseCache() : null);
  const client = options.client || createUpstreamClient({ sourceConfig, fetchImpl: options.fetchImpl, egressPool });
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
      let target;
      try {
        target = verifySignedTarget(gatewayMatch[2], secret).url;
      } catch {
        writeText(res, 403, 'resource unavailable\n');
        return;
      }
      try {
        const adapter = adapterForUrl(target);
        let remote = gatewayMatch[1] === 'item'
          ? await fetchExternalDocument(adapter.readerTarget(target), { range: req.headers.range }, 'html')
          : await fetchCachedMedia({
            cache,
            fetcher: fetchExternal,
            target,
            range: req.headers.range,
            maxBytes: mediaCacheMaxFileBytes,
          });
        if (gatewayMatch[1] === 'media') {
          const headers = {};
          for (const name of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified']) {
            const value = remote.headers.get(name);
            if (value) headers[name] = value;
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
          });
          mediaPreloadQueue.enqueue(prefetchedGallery.pages.map((page) => page.mediaTarget));
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
          })
          : (contentType.includes('html')
            ? renderReaderPage({ url: target, html: body, baseUrl: publicBaseUrl(req), secret, prefetchedGallery })
            : body);
        writeText(res, unavailable ? unavailableStatus : (remote.ok ? 200 : remote.status), page, unavailable || contentType.includes('html') ? 'text/html; charset=utf-8' : contentType);
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
