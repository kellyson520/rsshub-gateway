import http from 'node:http';
import { Readable } from 'node:stream';
import fs from 'node:fs';
import path from 'node:path';
import { transformFeed } from './feed-transform.js';
import { verifySignedTarget } from './signed-target.js';
import { GatewayUpstreamError } from './upstream-errors.js';
import { adapterForUrl } from './adapters/index.js';
import { parseRankingHtml, rankingTarget, renderRankingFeed } from './adapters/ehviewer.js';
import {
  extractEhGalleryTitle,
  extractEhImagePage,
  renderReaderPage,
  renderUnavailablePage,
} from './reader.js';
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
import {
  boundedInteger,
  cacheStateLog,
  createConcurrencyLimiter,
  documentCacheKind,
  fetchCachedDocument,
  imageVariantCacheUrl,
  isEhImagePageTarget,
  mapWithConcurrency,
  mediaFileName,
  parseProbeTargets,
  positiveInteger,
  publicBaseUrl,
  readBinaryLimited,
  readLimited,
  readSecret,
  readSources,
  requestedImageVariantWidth,
  responseFromCachedDocument,
  responseHeaders,
  writeBuffer,
  writeGatewayError,
  writeJson,
  writeText,
} from './http-utils.js';
const DEFAULT_EH_PREFETCH_CONCURRENCY = 8;
const DEFAULT_EH_PREFETCH_MAX_CONCURRENCY = 36;
const DEFAULT_EH_MAX_PREFETCH_PAGES = 300;
const DEFAULT_EH_MEDIA_PREFETCH_CONCURRENCY = 6;
const DEFAULT_EH_MEDIA_PREFETCH_MIN_CONCURRENCY = 3;
const DEFAULT_EH_MEDIA_PREFETCH_MAX_CONCURRENCY = 12;
const DEFAULT_EH_MEDIA_PREFETCH_PER_ORIGIN = 2;
const DEFAULT_EH_MEDIA_FOREGROUND_WARM_COUNT = 8;
const DEFAULT_EH_MEDIA_FOREGROUND_WARM_CONCURRENCY = 8;
const DEFAULT_EH_FIRST_PAINT_COUNT = 1;
const DEFAULT_EGRESS_LANE_COUNT = 12;
const DEFAULT_EGRESS_SESSION_LANE_COUNT = 12;
const DEFAULT_EGRESS_SESSION_LISTENER_BASE_PORT = 7921;
const DEFAULT_EGRESS_MIN_CONCURRENCY_PER_LANE = 3;
const DEFAULT_EGRESS_MAX_CONCURRENCY_PER_LANE = 6;
const DEFAULT_EGRESS_MAX_TOTAL_CONCURRENCY = 48;
const DEFAULT_EGRESS_REFRESH_INTERVAL_MS = 60_000;
const DEFAULT_MEDIA_CACHE_MAX_FILE_BYTES = 32 * 1024 ** 2;
const DEFAULT_VIDEO_CACHE_MAX_FILE_BYTES = 256 * 1024 ** 2;
const DEFAULT_MEDIA_BROWSER_CACHE_SECONDS = 300;


import {
  DEFAULT_FIRST_DETAIL_BUDGET_MS,
  createInitialReaderManifest,
  mergeResolvedPage,
  withForegroundDeadline,
} from './reader-manifest.js';
import {
  fetchIwaraUser,
  fetchIwaraVideos,
  fetchIwaraVideoDetail,
  isIwaraVideoTarget,
  iwaraVideoId,
  renderIwaraFeed,
  renderIwaraReaderPage,
  resolveIwaraVideoStream,
} from './adapters/iwara.js';
import { createRequestService } from './infrastructure/request-service.js';
import { createLeaseStore, createSignedChunk, verifySignedChunk } from './download-lease.js';
import { createLeaseProxy } from './lease-proxy.js';
import { createLeaseBackfillQueue } from './lease-backfill.js';
import { createLogger } from './infrastructure/logger.js';
import { createPoller } from './infrastructure/poller.js';
import { createSiteFailureTracker } from './infrastructure/site-failure-tracker.js';
import { createMediaTransport } from './media/media-transport.js';
import { chunkSizeFor } from './media/chunks.js';

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

export function createGatewayServer(options = {}) {
  const logger = options.logger || createLogger();
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
  const egressProbeTargets = parseProbeTargets(
    options.egressProbeTargets ?? process.env.EGRESS_PROBE_TARGETS,
    egressProbeUrl,
  );
  const egressSiteFailureThreshold = boundedInteger(
    options.egressSiteFailureThreshold ?? process.env.EGRESS_SITE_FAILURE_THRESHOLD,
    3,
    1,
    100,
  );
  const egressSiteFailureWindowMs = boundedInteger(
    options.egressSiteFailureWindowMs ?? process.env.EGRESS_SITE_FAILURE_WINDOW_MS,
    60_000,
    1_000,
    24 * 60 * 60_000,
  );
  const egressSiteBlockCooldownMs = boundedInteger(
    options.egressSiteBlockCooldownMs ?? process.env.EGRESS_SITE_BLOCK_COOLDOWN_MS,
    60_000,
    0,
    24 * 60 * 60_000,
  );
  const egressBlockedStatuses = new Set(String(
    options.egressBlockedStatuses ?? process.env.EGRESS_BLOCKED_STATUSES ?? '401,403,407,429',
  ).split(',').map((value) => Number.parseInt(value, 10)).filter(Number.isInteger));
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
  const controllerUrl = options.egressControllerUrl || process.env.EGRESS_CONTROLLER_URL;
  const egressAdapter = options.egressAdapter || (controllerUrl
    ? createMihomoEgressAdapter({
      controllerUrl,
      listenerBaseUrl: options.egressProxyBaseUrl || process.env.EGRESS_PROXY_BASE_URL,
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
      root: options.sessionAffinityRoot || process.env.GATEWAY_CACHE_DIR || '/var/cache/rsshub-gateway',
      file: options.sessionAffinityFile || process.env.SESSION_AFFINITY_FILE,
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
  const ehFirstPaintCount = boundedInteger(
    options.ehFirstPaintCount ?? process.env.EH_FIRST_PAINT_COUNT,
    DEFAULT_EH_FIRST_PAINT_COUNT,
    1,
    24,
  );
  const ehColdStartEnabled = String(
    options.ehColdStartEnabled ?? process.env.EH_COLD_START_ENABLED ?? 'true',
  ).toLowerCase() !== 'false';
  const ehFirstDetailBudgetMs = boundedInteger(
    options.ehFirstDetailBudgetMs ?? process.env.EH_FIRST_DETAIL_BUDGET_MS,
    DEFAULT_FIRST_DETAIL_BUDGET_MS,
    100,
    1_800,
  );
  const mediaCacheMaxFileBytes = boundedInteger(
    options.mediaCacheMaxFileBytes ?? process.env.GATEWAY_MEDIA_CACHE_MAX_FILE_BYTES,
    DEFAULT_MEDIA_CACHE_MAX_FILE_BYTES,
    1 * 1024 ** 2,
    256 * 1024 ** 2,
  );
  const videoCacheMaxFileBytes = boundedInteger(
    options.videoCacheMaxFileBytes ?? process.env.GATEWAY_VIDEO_CACHE_MAX_FILE_BYTES,
    DEFAULT_VIDEO_CACHE_MAX_FILE_BYTES,
    8 * 1024 ** 2,
    1024 ** 3,
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
  const iwaraResolutionCache = new Map();

  async function iwaraToken() {
    const credentials = sourceConfig.iwara;
    if (!credentials?.token) return null;
    const now = Date.now();
    if (iwaraAccessToken.value && iwaraAccessToken.expiresAt > now + 60_000) return iwaraAccessToken.value;
    let expiresAt = now + 2 * 60 * 60 * 1000;
    try {
      const payload = JSON.parse(Buffer.from(String(credentials.token).split('.')[1] || '', 'base64url').toString('utf8'));
      if (Number.isFinite(payload?.exp)) expiresAt = payload.exp * 1000;
    } catch {
      // Fall back to the short-lived in-memory expiry when the token is not a JWT.
    }
    iwaraAccessToken.value = credentials.token;
    iwaraAccessToken.expiresAt = expiresAt;
    return iwaraAccessToken.value;
  }

  async function resolveIwaraVideo(target) {
    const videoId = iwaraVideoId(target);
    if (!videoId) return null;
    const cached = iwaraResolutionCache.get(videoId);
    if (cached && cached.expiresAt > Date.now()) return cached;
    const token = await iwaraToken();
    const detail = await fetchIwaraVideoDetail(fetchJsonViaFetchd, videoId, { token });
    if (!detail?.fileUrl) return null;
    const stream = await resolveIwaraVideoStream(fetchJsonViaFetchd, detail);
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

  const leaseBackfillEnabled = String(
    options.leaseBackfillEnabled ?? process.env.GATEWAY_LEASE_BACKFILL ?? 'true',
  ).toLowerCase() !== 'false';
  const leaseBackfillConcurrency = boundedInteger(
    options.leaseBackfillConcurrency ?? process.env.GATEWAY_LEASE_BACKFILL_CONCURRENCY,
    2,
    0,
    8,
  );
  const leaseStore = options.leaseStore || createLeaseStore();
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
  const leaseProxyPort = boundedInteger(
    options.leaseProxyPort ?? process.env.GATEWAY_LEASE_PROXY_PORT,
    0,
    0,
    65_535,
  );
  const leaseProxyPublicUrl = String(
    options.leaseProxyPublicUrl ?? process.env.GATEWAY_LEASE_PROXY_PUBLIC_URL ?? '',
  );
  const leaseTtlMs = boundedInteger(
    options.leaseTtlMs ?? process.env.GATEWAY_LEASE_TTL_MS,
    30 * 60_000,
    60_000,
    24 * 60 * 60_000,
  );
  const leaseMaxBytes = boundedInteger(
    options.leaseMaxBytes ?? process.env.GATEWAY_LEASE_MAX_BYTES,
    2 * 1024 ** 3,
    1024 * 1024,
    64 * 1024 ** 3,
  );
  const leaseMaxConcurrency = boundedInteger(
    options.leaseMaxConcurrency ?? process.env.GATEWAY_LEASE_MAX_CONCURRENCY,
    8,
    1,
    32,
  );
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

  const server = http.createServer(async (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      writeText(res, 405, 'method not allowed\n');
      return;
    }
    const requestStartedAt = Date.now();
    const requestUrl = new URL(req.url || '/', 'http://gateway.internal');
    const requestId = String(req.headers['x-request-id'] || crypto.randomUUID()).slice(0, 64);
    res.setHeader('x-request-id', requestId);
    recordMetric('gateway_request', { path: requestUrl.pathname });
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
    if (requestUrl.pathname === '/_gateway/metrics') {
      const cacheStats = cache ? cache.stats() : null;
      const egressStats = egressPool.stats();
      const backfillStats = leaseBackfillQueue ? leaseBackfillQueue.stats() : null;
      const lines = [
        '# TYPE rsshub_gateway_requests_total counter',
        `rsshub_gateway_requests_total ${metricCounts.get('gateway_request') || 0}`,
        '# TYPE rsshub_gateway_cache_hits_total counter',
        `rsshub_gateway_cache_hits_total ${cacheStats?.counters?.hits || 0}`,
        '# TYPE rsshub_gateway_cache_misses_total counter',
        `rsshub_gateway_cache_misses_total ${cacheStats?.counters?.misses || 0}`,
        '# TYPE rsshub_gateway_cache_bytes gauge',
        `rsshub_gateway_cache_bytes ${cacheStats?.bytes || 0}`,
        '# TYPE rsshub_gateway_cache_entries gauge',
        `rsshub_gateway_cache_entries ${cacheStats?.entries || 0}`,
        '# TYPE rsshub_gateway_egress_lanes gauge',
        `rsshub_gateway_egress_lanes ${egressStats.lanes?.length || 0}`,
        '# TYPE rsshub_gateway_egress_active gauge',
        `rsshub_gateway_egress_active ${egressStats.active || 0}`,
      ];
      for (const [metric, count] of metricCounts) {
        if (/^[a-z0-9_]+$/.test(metric)) {
          lines.push(`# TYPE rsshub_gateway_${metric}_total counter`);
          lines.push(`rsshub_gateway_${metric}_total ${count}`);
        }
      }
      if (backfillStats) {
        lines.push('# TYPE rsshub_gateway_lease_backfill_completed counter');
        lines.push(`rsshub_gateway_lease_backfill_completed ${backfillStats.completed}`);
        lines.push('# TYPE rsshub_gateway_lease_backfill_failed counter');
        lines.push(`rsshub_gateway_lease_backfill_failed ${backfillStats.failed}`);
        lines.push('# TYPE rsshub_gateway_lease_backfill_skipped counter');
        lines.push(`rsshub_gateway_lease_backfill_skipped ${backfillStats.skipped}`);
        lines.push('# TYPE rsshub_gateway_lease_backfill_bytes gauge');
        lines.push(`rsshub_gateway_lease_backfill_bytes ${backfillStats.bytesFilled}`);
      }
      writeText(res, 200, `${lines.join('\n')}\n`, 'text/plain; version=0.0.4; charset=utf-8');
      return;
    }
    if (requestUrl.pathname === '/_gateway/infra') {
      const memory = process.memoryUsage();
      writeJson(res, 200, {
        uptimeMs: Math.round(process.uptime() * 1000),
        memory: {
          rss: memory.rss,
          heapUsed: memory.heapUsed,
          heapTotal: memory.heapTotal,
        },
        poller: poller.stats(),
        cache: cache ? cache.stats() : null,
        egress: {
          ...egressPool.stats(),
          probeTargets: egressProbeTargets,
          adapter: egressAdapter?.stats?.() || null,
        },
        leases: leaseStore.stats(),
        leaseBackfill: leaseBackfillQueue ? leaseBackfillQueue.stats() : null,
        circuits: client.circuitStats ? client.circuitStats() : { openKeys: client.openCircuits?.() || [] },
        metrics: Object.fromEntries(metricCounts),
        limits: {
          leaseTtlMs,
          leaseMaxBytes,
          leaseMaxConcurrency,
          mediaCacheMaxFileBytes,
          videoCacheMaxFileBytes,
        },
      });
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
          logger.error('ehviewer_failure', {
            source: error.source,
            code: error.code,
            status: error.status,
            attempts: error.attempts,
          });
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
    const iwaraFeedMatch = requestUrl.pathname.match(/^\/iwara\/users\/([^/]+)(?:\/(video|image))?$/);
    if (iwaraFeedMatch) {
      const username = decodeURIComponent(iwaraFeedMatch[1]);
      const kind = iwaraFeedMatch[2] || 'video';
      try {
        const output = await fetchCachedDocument({
          cache,
          fetcher: async () => {
            const token = await iwaraToken();
            const user = await fetchIwaraUser(fetchJsonViaFetchd, username, { token });
            if (!user?.id) {
              return new Response('user not found\n', {
                status: 404,
                headers: { 'content-type': 'text/plain; charset=utf-8' },
              });
            }
            const videos = await fetchIwaraVideos(fetchJsonViaFetchd, user.id, { kind, token });
            const feed = renderIwaraFeed({ username, kind, videos });
            return new Response(feed, {
              status: 200,
              headers: { 'content-type': 'application/rss+xml; charset=utf-8' },
            });
          },
          requestUrl: requestUrl.pathname,
          cacheUrl: new URL(requestUrl.pathname, 'http://gateway.internal').toString(),
          kind: 'rss',
          request: { priority: 'foreground' },
        });
        const body = await readLimited(output);
        const transformed = transformFeed(body, {
          baseUrl: publicBaseUrl(req),
          selfUrl: `${publicBaseUrl(req)}${requestUrl.pathname}${requestUrl.search}`,
          secret,
          signedTargetMetadata: { egressScope: 'public' },
        });
        writeText(res, output.status, transformed, 'application/rss+xml; charset=utf-8', { 'cache-control': 'public, max-age=300' });
      } catch (error) {
        if (error instanceof GatewayUpstreamError) {
          logger.error('iwara_failure', {
            source: error.source,
            code: error.code,
            status: error.status,
            attempts: error.attempts,
          });
          writeGatewayError(res, error);
        } else {
          logger.error('iwara_failure', { code: 'IWARA_FEED_ERROR', status: 502, error: error.message });
          writeText(res, 502, 'source unavailable\n');
        }
      }
      return;
    }
    const chunkMatch = requestUrl.pathname.match(/^\/_gateway\/chunk\/(.+)$/);
    if (chunkMatch) {
      let chunk;
      try {
        chunk = verifySignedChunk(chunkMatch[1], secret);
      } catch {
        writeText(res, 403, 'resource unavailable\n');
        return;
      }
      try {
        const routed = await fetchGatewayMedia(
          chunk.url,
          { range: `bytes=${chunk.start}-${chunk.end}`, circuit: false, priority: 'foreground' },
          { egressScope: chunk.egressScope || 'public', source: chunk.source },
          undefined,
        );
        if (routed.unavailable) {
          writeText(res, 503, 'source unavailable\n');
          return;
        }
        const remote = routed.response;
        const headers = {};
        for (const name of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified']) {
          const value = remote.headers.get(name);
          if (value) headers[name] = value;
        }
        headers['content-disposition'] = `attachment; filename="chunk-${chunk.start}-${chunk.end}.bin"`;
        res.writeHead(remote.status, headers);
        if (req.method === 'HEAD') return res.end();
        if (remote.body) Readable.fromWeb(remote.body).pipe(res);
        else res.end();
      } catch (error) {
        if (error instanceof GatewayUpstreamError) {
          writeGatewayError(res, error);
        } else {
          writeText(res, 502, 'upstream unavailable\n');
        }
      }
      return;
    }
    const leaseMatch = requestUrl.pathname.match(/^\/_gateway\/lease\/(.+)$/);
    if (leaseMatch) {
      let verified;
      try {
        verified = verifySignedTarget(leaseMatch[1], secret);
      } catch {
        writeText(res, 403, 'resource unavailable\n');
        return;
      }
      if (!leaseProxy) {
        writeText(res, 503, 'lease proxy disabled\n');
        return;
      }
      try {
        const target = verified.url;
        let resolvedUrl = target;
        let allowHosts = [new URL(target).hostname];
        if (isIwaraVideoTarget(target)) {
          const resolved = await resolveIwaraVideo(target);
          if (!resolved?.url) throw new Error('video resolution unavailable');
          resolvedUrl = resolved.url;
          allowHosts = [new URL(resolvedUrl).hostname];
        }
        const lease = leaseStore.createLease({
          targetUrl: target,
          resolvedUrl,
          allowHosts,
          ttlMs: leaseTtlMs,
          maxBytes: leaseMaxBytes,
          maxConcurrency: leaseMaxConcurrency,
          metadata: { source: verified.source || 'unknown' },
        });
        const requestHost = (req.headers.host || 'localhost:1300').split(':')[0];
        const view = leaseStore.publicView(lease, {
          proxyHost: requestHost,
          proxyPort: leaseProxyBoundPort,
          proxyUrl: leaseProxyPublicUrl || undefined,
        });
        logger.info('lease_created', {
          host: allowHosts[0],
          ttlMs: view.ttlMs,
          maxBytes: view.maxBytes,
        });
        if (leaseBackfillQueue) {
          leaseBackfillQueue.enqueue(lease).catch(() => {
            // Backfill must never fail the lease response.
          });
        }
        writeJson(res, 200, view);
      } catch (error) {
        logger.error('lease_failure', { error: error.message });
        writeText(res, 502, 'lease unavailable\n');
      }
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
      const chunksParam = gatewayMatch[1] === 'media' ? requestUrl.searchParams.get('chunks') : null;
      if (chunksParam !== null && chunksParam !== '') {
        const wanted = Number.parseInt(chunksParam, 10);
        const size = await mediaSizeFor(target);
        if (!size) {
          writeText(res, 503, 'size unavailable\n');
          return;
        }
        const { count, size: chunkSize } = chunkSizeFor(size, Number.isInteger(wanted) ? wanted : 1);
        const urls = [];
        for (let index = 0; index < count; index += 1) {
          const start = index * chunkSize;
          const end = Math.min(size - 1, start + chunkSize - 1);
          const token = createSignedChunk({
            url: target,
            start,
            end,
            secret,
            metadata: { egressScope: routeMetadata.egressScope, source: routeMetadata.source },
          });
          urls.push(`${publicBaseUrl(req)}/_gateway/chunk/${token}`);
        }
        writeJson(res, 200, { size, chunkSize, count, urls });
        return;
      }
      try {
        const adapter = adapterForUrl(target);
        if (gatewayMatch[1] === 'item' && isIwaraVideoTarget(target)) {
          try {
            const token = await iwaraToken();
            const detail = await fetchIwaraVideoDetail(fetchJsonViaFetchd, iwaraVideoId(target), { token });
            if (detail?.id) {
              const page = renderIwaraReaderPage({ video: detail, baseUrl: publicBaseUrl(req), secret });
              writeText(res, 200, page, 'text/html; charset=utf-8');
              return;
            }
          } catch {
            // Fall through to the standard item handling when metadata is unavailable.
          }
        }
        const ehImageMediaTarget = gatewayMatch[1] === 'media' && isEhImagePageTarget(target);
        const responseDriven = adapter.publiclyReadable
          || ['session', 'sticky'].includes(routeMetadata.egressScope)
          || mediaVariant.width !== undefined
          || ehImageMediaTarget;
        const routed = responseDriven
          ? (gatewayMatch[1] === 'item'
            ? await fetchGatewayDocument(target, { range: req.headers.range, priority: 'foreground' }, routeMetadata)
            : (ehImageMediaTarget
              ? await fetchResolvedEhMedia(
                target,
                { range: req.headers.range, circuit: false, priority: 'foreground' },
                routeMetadata,
                mediaVariant.width,
                publicBaseUrl(req),
              )
              : await fetchGatewayMedia(target, { range: req.headers.range, circuit: false, priority: 'foreground' }, routeMetadata, mediaVariant.width)))
          : {
            adapter,
            egressScope: routeMetadata.egressScope || 'public',
            response: gatewayMatch[1] === 'item'
              ? await fetchExternalDocument(adapter.readerTarget(target), { range: req.headers.range, priority: 'foreground' }, 'html')
              : await fetchCachedMedia({
                cache,
                fetcher: fetchExternal,
                target,
                range: req.headers.range,
                maxBytes: mediaCacheMaxFileBytes,
                request: { priority: 'foreground' },
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
          if (requestUrl.searchParams.get('download') === '1') {
            headers['content-disposition'] = `attachment; filename="${mediaFileName(target, remote.headers.get('content-type') || '')}"`;
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
        let readerState = 'standard';
        let unavailableStatus = remote.status;
        const shouldPrefetchGallery = requestUrl.searchParams.get('view') !== 'gallery'
          && adapter.isGalleryUrl(target)
          && remote.ok
          && contentType.includes('html');
        if (shouldPrefetchGallery) {
          const initial = initialEhGalleryManifest({
            adapter,
            target,
            initialHtml: body,
            maxPages: ehMaxPrefetchPages,
          });
          const cachedDiscovery = await discoverCachedEhGallery({
            adapter,
            target,
            initialHtml: body,
            concurrency: currentEhPrefetchConcurrency(),
            maxPages: ehMaxPrefetchPages,
            namespace: cacheNamespaceFor(routed.egressScope, routed.session),
          });
          let discovery = cachedDiscovery;
          if (!discovery && (!ehColdStartEnabled || !initial.imageUrls.length)) {
            discovery = await discoverEhGallery({
              adapter,
              target,
              initialHtml: body,
              fetchExternal: fetchExternalDocument,
              concurrency: currentEhPrefetchConcurrency(),
              maxPages: ehMaxPrefetchPages,
            });
          }
          let pageTargets = discovery?.selectedImageUrls || initial.imageUrls;
          if (!discovery && ehColdStartEnabled && initial.imageUrls.length) {
            const firstDetailStartedAt = Date.now();
            recordMetric('eh_first_detail_started', { source: adapter.name });
            const firstPage = await resolveForegroundEhPage({
              adapter,
              imageUrl: initial.imageUrls[0],
              pageNumber: 1,
              fetchDocument: fetchExternalDocument,
              baseUrl: publicBaseUrl(req),
              secret,
              signedTargetMetadata: signedTargetMetadata(adapter, routed.egressScope),
              budgetMs: ehFirstDetailBudgetMs,
            });
            recordMetric(firstPage ? 'eh_first_detail_resolved' : 'eh_first_detail_deferred', {
              source: adapter.name,
              durationMs: Date.now() - firstDetailStartedAt,
            });
            let manifest = createInitialReaderManifest({
              imageUrls: initial.imageUrls,
              maxPages: ehMaxPrefetchPages,
            });
            if (firstPage) manifest = mergeResolvedPage(manifest, firstPage);
            pageTargets = manifest.pages.map((page) => page.mediaTarget);
          }
          readerState = discovery ? 'complete' : 'cold';
          const gallery = discovery || initial;
          prefetchedGallery = {
            title: gallery.title,
            pages: pageTargets.map((mediaTarget, index) => ({
              pageNumber: index + 1,
              mediaTarget,
              alt: `第 ${index + 1} 页`,
            })),
            failures: gallery.failures,
            totalPages: gallery.totalPages,
            truncated: gallery.truncated,
            preloadCount: ehFirstPaintCount,
            status: gallery.status,
          };
          unavailableStatus = gallery.status;
          void (async () => {
            const resolvedGallery = await prefetchEhGallery({
              adapter,
              target,
              initialHtml: body,
              fetchExternal: (url, request) => fetchExternalDocument(url, {
                ...request,
                priority: 'background',
              }),
              baseUrl: publicBaseUrl(req),
              secret,
              concurrency: currentEhPrefetchConcurrency(),
              maxPages: ehMaxPrefetchPages,
              discovery: discovery || undefined,
              onPage: (page) => {
                recordMetric('gallery_detail_completed', { source: adapter.name, count: 1 });
                if (page.pageNumber > ehMediaForegroundWarmCount && page.mediaTarget) {
                  mediaPreloadQueue.enqueue([page.mediaTarget]);
                }
              },
            });
            const foregroundWarm = await warmEhMedia({
              pages: resolvedGallery.pages,
              cache,
              fetcher: (url, request) => fetchExternal(url, { ...request, priority: 'background' }),
              maxBytes: mediaCacheMaxFileBytes,
              count: ehMediaForegroundWarmCount,
              concurrency: ehMediaForegroundWarmConcurrency,
            });
            const readyCount = foregroundWarm.targets.length - foregroundWarm.failedTargets.length;
            if (readyCount > 0) recordMetric('media_cache_ready', { source: adapter.name, count: readyCount });
            const warmed = new Set(foregroundWarm.targets);
            mediaPreloadQueue.enqueue([
              ...foregroundWarm.failedTargets,
              ...resolvedGallery.pages.map((page) => page.mediaTarget).filter((mediaTarget) => !warmed.has(mediaTarget)),
            ]);
          })().catch(() => {
            recordMetric('gallery_background_prefetch_failed', { source: adapter.name });
          });
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
          recordMetric('reader_html_emitted', {
            source: adapter.name,
            state: readerState,
            durationMs: Date.now() - requestStartedAt,
            requestId,
          });
          writeBuffer(res, status, encoded.body, 'text/html; charset=utf-8', encoded.headers);
        } else {
          writeText(res, status, page, contentType.includes('html') ? 'text/html; charset=utf-8' : contentType);
        }
      } catch (error) {
        if (error instanceof GatewayUpstreamError) {
          logger.error('upstream_failure', {
            source: error.source,
            code: error.code,
            status: error.status,
            attempts: error.attempts,
          });
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
        logger,
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
        logger.error('rsshub_failure', {
          source: error.source,
          code: error.code,
          status: error.status,
          attempts: error.attempts,
        });
        writeGatewayError(res, error);
        return;
      }
      writeText(res, 502, 'upstream unavailable\n');
    }
  });
  const poller = options.poller || createPoller({ intervalMs: 60_000, logger });
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
  server.listen(Number(process.env.PORT || 1300), '0.0.0.0', () => bootLogger.info('gateway_listening', { port: Number(process.env.PORT || 1300) }));
}
