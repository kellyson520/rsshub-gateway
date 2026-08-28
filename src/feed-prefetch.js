import {
  createFeedPrefetchQueue as baseCreateFeedPrefetchQueue,
  DEFAULT_FEED_PREFETCH_CONCURRENCY,
  DEFAULT_FEED_PREFETCH_INTERVAL_MS,
  DEFAULT_FEED_PREFETCH_MAX_RETRIES,
  DEFAULT_FEED_PREFETCH_RETRY_BACKOFF_MS,
  feedPrefetchBackoffMultiplier,
  feedPrefetchEffectiveInterval,
  feedPrefetchRetryDelay,
  initialFeedPathStats,
  MAX_FEED_PREFETCH_CONCURRENCY,
  MAX_FEED_PREFETCH_INTERVAL_CAP_MS,
  MAX_FEED_PREFETCH_RETRIES,
} from './http-utils.js';

export {
  DEFAULT_FEED_PREFETCH_INTERVAL_MS,
  DEFAULT_FEED_PREFETCH_CONCURRENCY,
  DEFAULT_FEED_PREFETCH_MAX_RETRIES,
  DEFAULT_FEED_PREFETCH_RETRY_BACKOFF_MS,
  MAX_FEED_PREFETCH_CONCURRENCY,
  MAX_FEED_PREFETCH_RETRIES,
  MAX_FEED_PREFETCH_INTERVAL_CAP_MS,
  feedPrefetchBackoffMultiplier,
  feedPrefetchEffectiveInterval,
  feedPrefetchRetryDelay,
  initialFeedPathStats,
};

export function createFeedPrefetchQueue(options = {}) {
  return baseCreateFeedPrefetchQueue(options);
}
