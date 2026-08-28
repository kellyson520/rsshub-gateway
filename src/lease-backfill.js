import {
  boundedInteger,
  calculateCacheHeadroom,
  createLeaseBackfillQueue as baseCreateLeaseBackfillQueue,
  DEFAULT_LEASE_BACKFILL_EVICTION_BUDGET as DEFAULT_EVICTION_BUDGET,
  DEFAULT_LEASE_BACKFILL_MAX_CONCURRENCY as DEFAULT_MAX_CONCURRENCY,
  DEFAULT_LEASE_BACKFILL_VIDEO_CACHE_MAX_FILE_BYTES as DEFAULT_VIDEO_CACHE_MAX_FILE_BYTES,
} from './http-utils.js';

export {
  DEFAULT_MAX_CONCURRENCY,
  DEFAULT_EVICTION_BUDGET,
  DEFAULT_VIDEO_CACHE_MAX_FILE_BYTES,
  boundedInteger,
  calculateCacheHeadroom,
};

export function createLeaseBackfillQueue(options = {}) {
  return baseCreateLeaseBackfillQueue(options);
}
