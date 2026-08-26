import {
  boundedInteger,
  createConcurrencyLimiter,
  dedupe,
  parseHostList,
  parseProbeTargets,
  readSecret,
  readSources,
} from './http-utils.js';
import { DEFAULT_BLOCKED_STATUSES } from './upstream-errors.js';
import { DEFAULT_HTML_BROTLI_MIN_BYTES, DEFAULT_HTML_BROTLI_QUALITY } from './http-encoding.js';
import { DEFAULT_FIRST_DETAIL_BUDGET_MS } from './reader-manifest.js';
import { createLogger } from './infrastructure/logger.js';

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
const DEFAULT_VIDEO_PREFETCH_CONCURRENCY = 4;
const DEFAULT_FEED_PREFETCH_INTERVAL_MS = 900_000;
const DEFAULT_FEED_PREFETCH_CONCURRENCY = 2;
const DEFAULT_FEED_PREFETCH_MAX_RETRIES = 2;

const DEFAULT_IMAGE_VARIANT_CONCURRENCY = 2;
const DEFAULT_LEASE_BACKFILL_CONCURRENCY = 2;
const DEFAULT_LEASE_TTL_MS = 30 * 60_000;
const DEFAULT_LEASE_MAX_BYTES = 2 * 1024 ** 3;
const DEFAULT_LEASE_MAX_CONCURRENCY = 8;
const DEFAULT_SLOW_SOURCE_THRESHOLD_MS = 5_000;
const DEFAULT_CACHE_ROOT = '/var/cache/rsshub-gateway';

export {
  DEFAULT_CACHE_ROOT,
  DEFAULT_EH_PREFETCH_CONCURRENCY,
  DEFAULT_EH_PREFETCH_MAX_CONCURRENCY,
  DEFAULT_EH_MAX_PREFETCH_PAGES,
  DEFAULT_EH_MEDIA_PREFETCH_CONCURRENCY,
  DEFAULT_EH_MEDIA_PREFETCH_MIN_CONCURRENCY,
  DEFAULT_EH_MEDIA_PREFETCH_MAX_CONCURRENCY,
  DEFAULT_EH_MEDIA_PREFETCH_PER_ORIGIN,
  DEFAULT_EH_MEDIA_FOREGROUND_WARM_COUNT,
  DEFAULT_EH_MEDIA_FOREGROUND_WARM_CONCURRENCY,
  DEFAULT_EH_FIRST_PAINT_COUNT,
  DEFAULT_EGRESS_LANE_COUNT,
  DEFAULT_EGRESS_SESSION_LANE_COUNT,
  DEFAULT_EGRESS_SESSION_LISTENER_BASE_PORT,
  DEFAULT_EGRESS_MIN_CONCURRENCY_PER_LANE,
  DEFAULT_EGRESS_MAX_CONCURRENCY_PER_LANE,
  DEFAULT_EGRESS_MAX_TOTAL_CONCURRENCY,
  DEFAULT_EGRESS_REFRESH_INTERVAL_MS,
  DEFAULT_MEDIA_CACHE_MAX_FILE_BYTES,
  DEFAULT_VIDEO_CACHE_MAX_FILE_BYTES,
  DEFAULT_MEDIA_BROWSER_CACHE_SECONDS,
  DEFAULT_VIDEO_PREFETCH_CONCURRENCY,
  DEFAULT_FEED_PREFETCH_INTERVAL_MS,
  DEFAULT_FEED_PREFETCH_CONCURRENCY,
  DEFAULT_FEED_PREFETCH_MAX_RETRIES,
  DEFAULT_IMAGE_VARIANT_CONCURRENCY,
  DEFAULT_LEASE_BACKFILL_CONCURRENCY,
  DEFAULT_LEASE_TTL_MS,
  DEFAULT_LEASE_MAX_BYTES,
  DEFAULT_LEASE_MAX_CONCURRENCY,
  DEFAULT_SLOW_SOURCE_THRESHOLD_MS,
};

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
    (options.egressBlockedStatuses ?? env.EGRESS_BLOCKED_STATUSES) !== undefined
      ? String(options.egressBlockedStatuses ?? env.EGRESS_BLOCKED_STATUSES)
          .split(',')
          .map((value) => Number.parseInt(value, 10))
          .filter(Number.isInteger)
      : DEFAULT_BLOCKED_STATUSES,
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
  const ehColdStartEnabled = String(
    options.ehColdStartEnabled ?? env.EH_COLD_START_ENABLED ?? 'true',
  ).toLowerCase() !== 'false';
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
  const leaseBackfillEnabled = String(
    options.leaseBackfillEnabled ?? env.GATEWAY_LEASE_BACKFILL ?? 'true',
  ).toLowerCase() !== 'false';
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
  const slowSourceThresholdMs = (() => {
    const raw = options.slowSourceThresholdMs ?? env.GATEWAY_SLOW_SOURCE_MS ?? 5000;
    const value = Number(raw);
    return Number.isFinite(value) && value >= 0 ? Math.floor(value) : 5000;
  })();
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
  const videoPrefetchEnabled = options.videoPrefetchEnabled !== false
    && String(env.GATEWAY_VIDEO_PREFETCH ?? '').toLowerCase() !== 'false';
  const videoPrefetchConcurrency = boundedInteger(
    options.videoPrefetchConcurrency ?? env.GATEWAY_VIDEO_PREFETCH_CONCURRENCY,
    DEFAULT_VIDEO_PREFETCH_CONCURRENCY,
    1,
    8,
  );
  const feedPrefetchPaths = dedupe(
    Array.isArray(options.feedPrefetchPaths)
      ? options.feedPrefetchPaths.map(String).filter(Boolean)
      : String(options.feedPrefetchPaths ?? env.GATEWAY_FEED_PREFETCH_PATHS ?? '')
          .split(',')
          .map((value) => value.trim())
          .filter(Boolean),
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
