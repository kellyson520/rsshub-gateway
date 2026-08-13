import http from 'node:http';
import path from 'node:path';
import { adapterForUrl } from './adapters/index.js';
import {
  extractEhGalleryTitle,
  extractEhImagePage,
} from './reader.js';
import { createResponseCache } from './cache.js';
import { createMediaPrefetchQueue } from './media-prefetch.js';
import { createEgressPool } from './egress-pool.js';
import { createMihomoEgressAdapter } from './mihomo-egress.js';
import { createSessionAffinity } from './session-affinity.js';
import { IMAGE_VARIANT_WIDTHS, createImageVariant } from './image-variants.js';
import {
  cacheStateLog,
  documentCacheKind,
  fetchCachedDocument,
  imageVariantCacheUrl,
  mapWithConcurrency,
  readBinaryLimited,
  readLimited,
  responseFromCachedDocument,
  responseHeaders,
} from './http-utils.js';
import { resolveGatewayOptions } from './options.js';


import { withForegroundDeadline } from './reader-manifest.js';
import {
  fetchIwaraVideoDetail,
  isIwaraVideoTarget,
  iwaraVideoId,
  refreshIwaraAccessToken,
  resolveIwaraVideoStream,
} from './adapters/iwara.js';
import { createRequestService } from './infrastructure/request-service.js';
import { createLeaseStore, createSignedChunk } from './download-lease.js';
import { createDownloadSessionStore } from './download-session.js';
import { createDispatcher } from './dispatcher.js';
import { createRequestHandler } from './request-handler.js';
import { installGracefulShutdown } from './graceful-shutdown.js';
import { createLeaseProxy } from './lease-proxy.js';
import { createLeaseBackfillQueue } from './lease-backfill.js';
import { createLogger } from './infrastructure/logger.js';
import { createPoller } from './infrastructure/poller.js';
import { createSiteFailureTracker } from './infrastructure/site-failure-tracker.js';
import { createMediaTransport } from './media/media-transport.js';

async function loadCachedMedia({ cache, fetcher, target, range, maxBytes, request }) {
  const requestOptions = { ...request, range, circuit: false };
  const foreground = request?.priority === 'foreground';
  if (!cache || range) {
    return { response: await fetcher(target, requestOptions), cacheState: 'BYPASS' };
  }
  const result = await cache.getOrLoad(target, 'media', async () => {
    const remote = await fetcher(target, requestOptions);
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
  }, { bypassInflight: foreground, deferStore: foreground });
  cacheStateLog(target, 'media', result.state);
  return {
    response: result.passthrough || responseFromCachedDocument(result),
    cacheState: result.state,
  };
}

async function fetchCachedMedia(options) {
  return (await loadCachedMedia(options)).response;
}

function parseByteRange(value, size) {
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

async function discoverEhGallery({
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

function initialEhGalleryManifest({ adapter, target, initialHtml, maxPages }) {
  const imageUrls = adapter.imagePageUrls(initialHtml, target).slice(0, maxPages);
  return {
    galleryUrls: adapter.galleryPageUrls(initialHtml, target),
    imageUrls,
    failures: [],
    truncated: false,
    totalPages: imageUrls.length,
    status: 200,
    title: extractEhGalleryTitle({ url: target, html: initialHtml }),
  };
}

async function resolveForegroundEhPage({
  adapter,
  imageUrl,
  pageNumber,
  fetchDocument,
  baseUrl,
  secret,
  signedTargetMetadata,
  budgetMs,
}) {
  const operation = (async () => {
    const remote = await fetchDocument(adapter.readerTarget(imageUrl), {
      galleryShard: pageNumber - 1,
      priority: 'foreground',
      timeout: budgetMs,
    }, 'html');
    const body = await readLimited(remote);
    if (!remote.ok || !(remote.headers.get('content-type') || '').includes('html')) return null;
    const page = extractEhImagePage({
      url: imageUrl,
      html: body,
      baseUrl,
      secret,
      pageNumber,
      signedTargetMetadata,
    });
    return page ? { ...page, detailTarget: imageUrl } : null;
  })();
  void operation.catch(() => {});
  const result = await withForegroundDeadline(operation, budgetMs);
  return result.timedOut || !result.value ? null : result.value;
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
  discovery: providedDiscovery,
}) {
  const discovery = providedDiscovery || await discoverEhGallery({
    adapter,
    target,
    initialHtml,
    fetchExternal,
    concurrency,
    maxPages,
  });
  const failures = [...discovery.failures];
  const imageResults = await mapWithConcurrency(discovery.selectedImageUrls, concurrency, async (imageUrl, index) => {
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
  let status = discovery.status;
  for (const result of imageResults) {
    if (result.page) pages.push(result.page);
    if (result.failure) failures.push(result.failure);
    if (!result.page && result.status && result.status >= 400) status = result.status;
  }
  pages.sort((left, right) => left.pageNumber - right.pageNumber);
  return {
    title: pages[0]?.title || discovery.title || 'E-Hentai 画廊',
    pages,
    failures,
    totalPages: discovery.totalPages,
    truncated: discovery.truncated,
    status,
  };
}

function routeBucket(pathname) {
  if (pathname === '/healthz') return 'healthz';
  if (pathname === '/readyz') return 'readyz';
  if (pathname.startsWith('/_gateway/lease/')) return 'lease';
  if (pathname.startsWith('/_gateway/chunk/')) return 'chunk';
  if (pathname.startsWith('/_gateway/infra')) return 'infra';
  if (pathname.startsWith('/_gateway/metrics')) return 'metrics';
  if (pathname.startsWith('/_gateway/item/')) return 'item';
  if (pathname.startsWith('/_gateway/media/')) return 'media';
  if (pathname.startsWith('/ehviewer/')) return 'ehviewer';
  return 'feed';
}

export function createGatewayServer(options = {}) {
  const routesFile = options.routesFile || process.env.GATEWAY_ROUTES_FILE || 'gateway-routes.yaml';
  const dispatcherRegistrationToken = options.dispatcherRegistrationToken
    || process.env.DISPATCHER_REGISTRATION_TOKEN
    || '';
  const {
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
  } = resolveGatewayOptions(options);
  const egressPool = options.egressPool || createEgressPool({
    lanes: options.egressLanes,
    minConcurrencyPerLane: egressMinConcurrencyPerLane,
    maxConcurrencyPerLane: egressMaxConcurrencyPerLane,
    blockedStatuses: egressBlockedStatuses,
    siteFailureThreshold: egressSiteFailureThreshold,
    siteFailureWindowMs: egressSiteFailureWindowMs,
    siteBlockCooldownMs: egressSiteBlockCooldownMs,
    scopeOverrides: egressProbeTargets.hosts,
    onEvent: (event) => {
      if (['ramp', 'backoff', 'empty'].includes(event.state)) {
        logger.info('egress_pool', { state: event.state, lanes: egressPool.stats().lanes.length });
      } else if (event.state === 'site-blocked') {
        logger.warn('egress_site_blocked', { laneId: event.laneId, host: event.host, status: event.status });
      } else if (event.state === 'site-degraded') {
        logger.info('egress_site_degraded', { host: event.host, scope: event.scope });
      }
    },
  });
  const egressAdapter = options.egressAdapter || (controllerUrl
    ? createMihomoEgressAdapter({
      controllerUrl,
      listenerBaseUrl: egressProxyBaseUrl,
      laneCount: egressLaneCount,
      sessionLaneCount: egressSessionLaneCount,
      sessionListenerBasePort: egressSessionListenerBasePort,
      probeUrl: egressProbeUrl,
      probeTargets: egressProbeTargets,
      probeTimeoutMs: egressProbeTimeoutMs,
      probeCacheMs: egressProbeCacheMs,
      onEvent: (event) => {
        if (['refresh', 'degraded', 'empty'].includes(event.state)) {
          logger.info('mihomo_egress', { state: event.state, lanes: event.lanes });
        }
      },
    })
    : null);
  const sessionAffinity = options.sessionAffinity || (egressAdapter
    ? createSessionAffinity({
      root: sessionAffinityRoot,
      file: sessionAffinityFile,
      secret,
      laneIds: () => egressAdapter.sessionLanes?.().map((lane) => lane.id) || [],
    })
    : null);
  const sessionSiteTracker = createSiteFailureTracker({
    threshold: egressSiteFailureThreshold,
    windowMs: egressSiteFailureWindowMs,
  });

  async function recordSessionFailure(session, response, target) {
    if (!session?.laneId || !egressAdapter?.markSessionLaneUnhealthy || !sessionAffinity) return;
    if (!egressBlockedStatuses.has(response.status)) return;
    let host = 'unknown';
    try {
      host = new URL(String(target)).hostname.toLowerCase();
    } catch {
      // Diagnostics must never fail the request.
    }
    if (sessionSiteTracker.record(session.laneId, host, response.status)) {
      await egressAdapter.markSessionLaneUnhealthy(session.laneId);
      await sessionAffinity.markLaneUnhealthy(session.laneId);
      logger.warn('session_lane_site_blocked', { laneId: session.laneId, host, status: response.status });
    }
  }

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
  const metricCounts = new Map();
  const metricSink = options.onMetric || ((event) => logger.info(String(event.event || 'metric'), event));
  function recordMetric(metric, details = {}) {
    const count = (metricCounts.get(metric) || 0) + 1;
    metricCounts.set(metric, count);
    try {
      metricSink({ event: 'gateway_metric', metric, count, ...details });
    } catch {
      // Metrics must never affect a gateway response.
    }
  }
  const histogramBucketsMs = [25, 50, 100, 250, 500, 1000, 2500, 5000, 10_000];
  const histograms = new Map();
  function recordDuration(metric, durationMs) {
    let entry = histograms.get(metric);
    if (!entry) {
      entry = { buckets: new Map(), sumMs: 0, count: 0 };
      histograms.set(metric, entry);
    }
    entry.count += 1;
    entry.sumMs += durationMs;
    for (const bucketMs of histogramBucketsMs) {
      if (durationMs <= bucketMs) entry.buckets.set(bucketMs, (entry.buckets.get(bucketMs) || 0) + 1);
    }
  }
  const cache = options.cache === false
    ? null
    : options.cache || ((!options.fetchExternal && !options.fetchRssHub) ? createResponseCache() : null);
  const requestService = options.requestService || createRequestService({
    sourceConfig,
    client: options.client,
    fetchImpl: options.fetchImpl,
    egressPool,
    browserFetch: options.browserFetch,
    fetchdFetch: options.fetchdFetch,
    fetchExternal: options.fetchExternal,
    fetchRssHub: options.fetchRssHub,
    logger,
  });
  const client = requestService.client;
  const makeImageVariant = options.createImageVariant || createImageVariant;
  const fetchRssHub = requestService.fetchRssHub;
  const fetchExternal = requestService.fetchExternal;
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
    logger,
  });

  const browserFetch = requestService.browserFetch;
  const fetchdFetch = requestService.fetchdFetch;
  const fetchJsonViaFetchd = requestService.fetchJsonViaFetchd;
  const iwaraAccessToken = { value: null, expiresAt: 0 };
  const iwaraRefreshToken = { value: null };
  const iwaraResolutionCache = new Map();
  const IWARA_ACCESS_DEFAULT_TTL_MS = 60 * 60 * 1000;
  const IWARA_REFRESH_RETRY_MS = 15 * 60 * 1000;

  function decodeJwtPayload(value) {
    try {
      const payload = JSON.parse(Buffer.from(String(value).split('.')[1] || '', 'base64url').toString('utf8'));
      return payload && typeof payload === 'object' ? payload : null;
    } catch {
      return null;
    }
  }

  async function iwaraToken() {
    const credentials = sourceConfig.iwara;
    if (!credentials?.token) return null;
    const now = Date.now();
    if (iwaraAccessToken.value && iwaraAccessToken.expiresAt > now + 60_000) return iwaraAccessToken.value;
    const payload = decodeJwtPayload(credentials.token);
    if (payload?.type === 'access_token') {
      iwaraAccessToken.value = credentials.token;
      iwaraAccessToken.expiresAt = Number.isFinite(payload.exp) ? payload.exp * 1000 : now + IWARA_ACCESS_DEFAULT_TTL_MS;
      return credentials.token;
    }
    try {
      const refreshSource = iwaraRefreshToken.value || credentials.token;
      const refreshed = await refreshIwaraAccessToken(fetchJsonViaFetchd, refreshSource);
      if (refreshed?.token) {
        recordMetric('iwara_token_refreshed');
        iwaraRefreshToken.value = refreshed.refreshToken || refreshSource;
        iwaraAccessToken.value = refreshed.token;
        iwaraAccessToken.expiresAt = now + Math.max(60_000, refreshed.expiresMs);
        return refreshed.token;
      }
    } catch (error) {
      recordMetric('iwara_token_refresh_failed');
      logger.warn('iwara_token_refresh_failed', { error: error.message });
    }
    // Fall back to the configured token; refresh is retried after the retry window.
    iwaraAccessToken.value = credentials.token;
    iwaraAccessToken.expiresAt = now + IWARA_REFRESH_RETRY_MS;
    return credentials.token;
  }

  function isRetryableFetchError(error) {
    if (!error) return false;
    if (error.status === undefined) return true;
    return error.status >= 500;
  }

  async function retryFetchJson(fetchJson, url, options = {}, { attempts = 3, backoffMs = 300 } = {}) {
    let lastError;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        return await fetchJson(url, options);
      } catch (error) {
        lastError = error;
        if (!isRetryableFetchError(error) || attempt >= attempts) break;
        await new Promise((resolve) => setTimeout(resolve, backoffMs * attempt));
      }
    }
    throw lastError;
  }

  async function resolveIwaraVideo(target) {
    const videoId = iwaraVideoId(target);
    if (!videoId) return null;
    const cached = iwaraResolutionCache.get(videoId);
    if (cached && cached.expiresAt > Date.now()) return cached;
    const token = await iwaraToken();
    const retryingFetch = (url, options = {}) => retryFetchJson(fetchJsonViaFetchd, url, options);
    const detail = await fetchIwaraVideoDetail(retryingFetch, videoId, { token });
    if (!detail?.fileUrl) return null;
    const stream = await resolveIwaraVideoStream(retryingFetch, detail);
    if (!stream) return null;
    const resolved = { ...stream, expiresAt: Date.now() + 15 * 60 * 1000 };
    iwaraResolutionCache.set(videoId, resolved);
    return resolved;
  }

  const mediaTransport = createMediaTransport({
    cache,
    fetchExternal,
    resolveMediaUrl: resolveIwaraVideo,
    isVideoTarget: isIwaraVideoTarget,
    makeImageVariant,
    variantLimiter: imageVariantLimiter,
    imageVariantMaxSourceBytes,
    mediaCacheMaxFileBytes,
    videoCacheMaxFileBytes,
    mediaBrowserCacheSeconds,
    prefetchConcurrency: videoPrefetchConcurrency,
    createSignedChunk,
    routeRequest: (target, requestOptions, routeMetadata) => fetchGatewayTarget(target, requestOptions, routeMetadata),
    adapterFor: adapterForUrl,
    resolveSession: (adapter) => resolveSessionTransport(adapter),
    namespaceFor: cacheNamespaceFor,
    logger,
    onMetric: recordMetric,
    onImageWarmup: (target, namespace) => warmupImageVariants(target, namespace),
  });

  function iwaraUnavailableResponse() {
    return new Response('video unavailable\n', {
      status: 502,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  }

  async function warmupImageVariants(target, namespace) {
    try {
      const cachedOriginal = await mediaTransport.readCached(target, 'media', namespace);
      if (!cachedOriginal?.ok) return;
      for (const width of IMAGE_VARIANT_WIDTHS) {
        const startedAt = Date.now();
        const original = cachedOriginal.clone();
        await mediaTransport.mediaVariant(
          { adapter: adapterForUrl(target), response: original },
          target,
          width,
          namespace,
        );
        recordMetric('image_variant_warmup', {
          source: adapterForUrl(target).name,
          width,
          durationMs: Date.now() - startedAt,
        });
      }
    } catch {
      // Background warmup must never affect requests.
    }
  }

  async function mediaSizeFor(target) {
    return mediaTransport.probeSize(target);
  }

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
    if (!lane?.dispatcher) return null;
    const sessionCredentials = adapter.name === 'iwara'
      ? { ...credentials, token: (await iwaraToken()) || credentials.token }
      : credentials;
    return { ...affinity, dispatcher: lane.dispatcher, credentials: sessionCredentials };
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
      const response = await fetchExternal(adapter.readerTarget(target), {
        ...requestOptions,
        egressScope: 'session',
        sessionDispatcher: session.dispatcher,
        sessionCredentials: session.credentials,
      });
      await recordSessionFailure(session, response, adapter.readerTarget(target));
      return { adapter, egressScope: 'session', session, response };
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
    const sessionResponse = await fetchExternal(adapter.readerTarget(target), {
      ...requestOptions,
      egressScope: 'session',
      sessionDispatcher: session.dispatcher,
      sessionCredentials: session.credentials,
    });
    await recordSessionFailure(session, sessionResponse, adapter.readerTarget(target));
    return {
      adapter,
      egressScope: 'session',
      session,
      response: sessionResponse,
    };
  }

  function signedTargetMetadata(adapter, scope) {
    return { egressScope: scope, source: adapter.name };
  }

  function cacheNamespaceFor(scope, session) {
    return scope === 'session' && session?.fingerprint ? `session:${session.fingerprint}` : 'public';
  }

  async function readCachedGatewayDocument(target, kind, namespace, { bypassInflight = false } = {}) {
    if (!cache) return null;
    const cacheKind = documentCacheKind(target, kind);
    const miss = new Error('gateway cache miss');
    miss.code = 'GATEWAY_CACHE_MISS';
    try {
      const result = await cache.getOrLoad(target, cacheKind, async () => { throw miss; }, {
        allowStale: cacheKind !== 'eh-image',
        namespace,
        bypassInflight,
      });
      cacheStateLog(target, cacheKind, result.state);
      return responseFromCachedDocument(result);
    } catch (error) {
      if (error === miss) return null;
      throw error;
    }
  }

  async function cacheGatewayDocument(target, kind, namespace, response, { bypassInflight = false } = {}) {
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
      bypassInflight,
      ignoreFresh: bypassInflight,
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
      const bypassInflight = requestOptions?.priority === 'foreground';
      const cached = await readCachedGatewayDocument(target, 'html', namespace, { bypassInflight });
      if (cached) return { adapter, egressScope: 'session', session, response: cached };
      const routed = await fetchGatewayTarget(target, requestOptions, routeMetadata);
      return { ...routed, response: await cacheGatewayDocument(target, 'html', namespace, routed.response, { bypassInflight }) };
    }

    const bypassInflight = requestOptions?.priority === 'foreground';
    const publicCached = await readCachedGatewayDocument(target, 'html', 'public', { bypassInflight });
    if (publicCached) return { adapter, egressScope: 'public', response: publicCached };
    const routed = await fetchGatewayTarget(target, requestOptions, routeMetadata);
    if (routed.unavailable) return routed;
    const namespace = cacheNamespaceFor(routed.egressScope, routed.session);
    return { ...routed, response: await cacheGatewayDocument(target, 'html', namespace, routed.response, { bypassInflight }) };
  }

  async function discoverCachedEhGallery({ adapter, target, initialHtml, concurrency, maxPages, namespace }) {
    if (!cache) return null;
    const discovery = await discoverEhGallery({
      adapter,
      target,
      initialHtml,
      fetchExternal: async (url) => {
        const cached = await readCachedGatewayDocument(url, 'html', namespace);
        if (!cached) throw new Error('gallery cache miss');
        return cached;
      },
      concurrency,
      maxPages,
    });
    return discovery.failures.length ? null : discovery;
  }

  async function cacheGatewayMedia(target, namespace, response, { bypassInflight = false } = {}) {
    return mediaTransport.cacheMedia(target, namespace, response, { bypassInflight });
  }

  async function createGatewayMediaVariant(source, target, width, namespace) {
    return mediaTransport.mediaVariant(source, target, width, namespace);
  }

  async function fetchGatewayMedia(target, requestOptions, routeMetadata, variantWidth) {
    return mediaTransport.serve(target, requestOptions, routeMetadata, variantWidth);
  }

  async function fetchResolvedEhMedia(target, requestOptions, routeMetadata, variantWidth, baseUrl) {
    const pageRouted = await fetchGatewayDocument(target, requestOptions, routeMetadata);
    if (pageRouted.unavailable) return pageRouted;
    const pageBody = await readLimited(pageRouted.response);
    const page = extractEhImagePage({
      url: target,
      html: pageBody,
      baseUrl,
      secret,
      signedTargetMetadata: { egressScope: pageRouted.egressScope, source: 'ehviewer' },
    });
    if (!page?.mediaTarget) {
      return {
        adapter: adapterForUrl(target),
        egressScope: pageRouted.egressScope,
        response: new Response('image unavailable\n', {
          status: 502,
          headers: { 'content-type': 'text/plain; charset=utf-8' },
        }),
      };
    }
    return fetchGatewayMedia(page.mediaTarget, requestOptions, routeMetadata, variantWidth);
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
          logger.info('eh_media_prefetch', event);
        }
      },
    })
    : { enqueue: () => {} };

  const leaseStore = options.leaseStore || createLeaseStore();
  const downloadSessions = createDownloadSessionStore({
    file: downloadSessionFile || path.join(sessionAffinityRoot, 'download-sessions.json'),
  });
  const leaseBackfillQueue = leaseBackfillEnabled ? createLeaseBackfillQueue({
    mediaTransport,
    fetchExternal,
    resolveMediaUrl: resolveIwaraVideo,
    leaseStore,
    cache,
    isVideoTarget: isIwaraVideoTarget,
    probeSize: (lease) => mediaTransport.probeSize(lease.targetUrl, { namespace: 'public' }),
    maxConcurrency: leaseBackfillConcurrency,
    videoCacheMaxFileBytes,
    logger,
    ...(options.leaseBackfillOptions || {}),
  }) : null;
  let leaseProxyBoundPort = leaseProxyPort;
  const leaseProxy = (options.leaseProxy !== undefined || leaseProxyPort > 0)
    ? createLeaseProxy({
      leaseStore,
      upstreamProxyHost: '127.0.0.1',
      upstreamProxyPort: 7890,
      port: leaseProxyPort,
      host: '0.0.0.0',
      onEvent: (event) => {
        if (event.event === 'lease_completed') leaseBackfillQueue?.cancel(event.username);
        if (event.event !== 'lease_proxy_listening') logger.info(String(event.event || 'lease_proxy'), event);
      },
    })
    : null;
  if (leaseProxy && !options.leaseProxy) {
    leaseProxy.listen().then((boundPort) => {
      leaseProxyBoundPort = boundPort;
    }).catch((error) => {
      logger.error('lease_proxy_failed', { error: error.message });
    });
  }

  const poller = options.poller || createPoller({ intervalMs: 60_000, logger });
  const dispatcher = options.dispatcher || createDispatcher({ routesFile, logger });
  const requestHandler = createRequestHandler({
    cache,
    dispatcher,
    dispatcherRegistrationToken,
    cacheNamespaceFor,
    client,
    currentEhPrefetchConcurrency,
    discoverCachedEhGallery,
    discoverEhGallery,
    downloadSessions,
    egressAdapter,
    egressPool,
    egressProbeTargets,
    ehColdStartEnabled,
    ehFirstDetailBudgetMs,
    ehFirstPaintCount,
    ehMaxPrefetchPages,
    ehMediaForegroundWarmConcurrency,
    ehMediaForegroundWarmCount,
    fetchCachedMedia,
    fetchExternal,
    fetchExternalDocument,
    fetchGatewayDocument,
    fetchGatewayMedia,
    fetchJsonViaFetchd,
    fetchResolvedEhMedia,
    fetchRssHub,
    htmlBrotliMinBytes,
    htmlBrotliQuality,
    histogramBucketsMs,
    histograms,
    initialEhGalleryManifest,
    iwaraToken,
    leaseBackfillQueue,
    leaseMaxBytes,
    leaseMaxConcurrency,
    leaseProxy,
    leaseProxyBoundPort,
    leaseProxyPublicUrl,
    leaseStore,
    leaseTtlMs,
    logger,
    mediaBrowserCacheSeconds,
    mediaCacheMaxFileBytes,
    mediaPreloadQueue,
    slowSourceThresholdMs,
    mediaSizeFor,
    prefetchVideoFile: mediaTransport.prefetchVideoFile,
    prefetchStatus: mediaTransport.prefetchStatus,
    metricCounts,
    poller,
    prefetchEhGallery,
    recordDuration,
    recordMetric,
    resolveForegroundEhPage,
    resolveIwaraVideo,
    routeBucket,
    secret,
    signedTargetMetadata,
    videoCacheMaxFileBytes,
    videoPrefetchEnabled,
    warmEhMedia,
  });
  const server = http.createServer(requestHandler);
  poller.register('lease-sweep', () => {
    const expired = leaseStore.revokeExpired();
    for (const username of expired) leaseBackfillQueue?.cancel(username);
    if (expired.length) logger.info('lease_sweep', { count: expired.length });
  }, { interval: 60_000 });
  if (options.poller === undefined) poller.start();

  server.leaseProxy = leaseProxy;
  server.leaseStore = leaseStore;
  server.leaseBackfillQueue = leaseBackfillQueue;
  server.browserFetch = browserFetch;
  server.poller = poller;
  return server;
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const server = createGatewayServer();
  const bootLogger = createLogger();
  installGracefulShutdown({
    servers: [server, server.leaseProxy?.server].filter(Boolean),
    logger: bootLogger,
  });
  server.listen(Number(process.env.PORT || 1300), '0.0.0.0', () => bootLogger.info('gateway_listening', { port: Number(process.env.PORT || 1300) }));
}
