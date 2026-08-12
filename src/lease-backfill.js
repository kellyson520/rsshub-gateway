const DEFAULT_MAX_CONCURRENCY = 2;
const DEFAULT_EVICTION_BUDGET = 128 * 1024 ** 2;

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.min(Math.max(parsed, minimum), maximum);
}

/**
 * One-time lease download backfill.
 *
 * When a download lease is issued, the gateway fills the video's slices into
 * the shared media cache in the background, using the exact same slice keys
 * and size limits as normal playback. This makes the second play instant
 * without relaying bytes through the gateway during the lease download.
 * Backfill is best-effort: it stops when the lease is revoked, deduplicates
 * per target, and skips when the cache lacks headroom.
 */
export function createLeaseBackfillQueue({
  mediaTransport,
  fetchExternal,
  resolveMediaUrl = async () => null,
  leaseStore,
  cache,
  isVideoTarget = () => false,
  probeSize,
  maxConcurrency = DEFAULT_MAX_CONCURRENCY,
  evictionBudget = DEFAULT_EVICTION_BUDGET,
  videoCacheMaxFileBytes = 256 * 1024 ** 2,
  logger = { info() {}, warn() {}, error() {} },
} = {}) {
  const limit = boundedInteger(maxConcurrency, DEFAULT_MAX_CONCURRENCY, 0, 8);
  const active = new Map();
  const stops = new Map();
  const stats = { running: 0, completed: 0, failed: 0, skipped: 0, bytesFilled: 0 };
  let running = 0;

  function sizeFor(lease) {
    if (typeof probeSize === 'function') return probeSize(lease);
    if (mediaTransport?.probeSize) {
      return mediaTransport.probeSize(lease.targetUrl, { namespace: 'public' });
    }
    return null;
  }

  function cacheHeadroom() {
    const current = cache?.stats?.() || {};
    const used = Number(current.bytes) || 0;
    const limitBytes = Number(current.byteLimit) || 0;
    if (limitBytes <= 0) return Infinity;
    return Math.max(0, limitBytes - used) + evictionBudget;
  }

  async function run(lease) {
    const target = String(lease.targetUrl || '');
    const stop = stops.get(lease.username) || { stopped: false };
    let host = 'unknown';
    try {
      host = new URL(target).hostname;
    } catch {
      // Diagnostics must never fail backfill.
    }
    try {
      const size = await sizeFor(lease);
      if (!Number.isSafeInteger(size) || size <= 0) {
        stats.skipped += 1;
        logger.info('lease_backfill_skipped', { host, reason: 'unknown-size' });
        return;
      }
      const expected = Math.min(size, videoCacheMaxFileBytes);
      if (cacheHeadroom() < expected) {
        stats.skipped += 1;
        logger.info('lease_backfill_skipped', { host, reason: 'cache-full' });
        return;
      }
      const resolved = await resolveMediaUrl(target);
      if (!resolved?.url) {
        stats.skipped += 1;
        logger.info('lease_backfill_skipped', { host, reason: 'unresolved' });
        return;
      }
      mediaTransport?.rememberVideoSize?.(target, size);
      await mediaTransport.fillVideoSlices(
        target,
        resolved.url,
        size,
        'public',
        { start: 0, end: size - 1 },
        videoCacheMaxFileBytes,
        { shouldStop: () => stop.stopped },
      );
      stats.bytesFilled += expected;
      stats.completed += 1;
      logger.info('lease_backfill_completed', { host, size });
    } catch (error) {
      stats.failed += 1;
      logger.warn('lease_backfill_failed', { host, error: error.message });
    } finally {
      active.delete(target);
      running -= 1;
      stats.running = running;
    }
  }

  function enqueue(lease) {
    if (!lease || !isVideoTarget(lease.targetUrl) || !lease.resolvedUrl) {
      stats.skipped += 1;
      return Promise.resolve();
    }
    const target = String(lease.targetUrl || '');
    const existing = active.get(target);
    if (existing) return existing;
    if (limit > 0 && running >= limit) {
      stats.skipped += 1;
      return Promise.resolve();
    }
    stops.set(lease.username, { stopped: false });
    running += 1;
    stats.running = running;
    const task = run(lease);
    active.set(target, task);
    return task;
  }

  function cancel(username) {
    const stop = stops.get(String(username));
    if (stop) stop.stopped = true;
  }

  return {
    enqueue,
    cancel,
    stats: () => ({ ...stats }),
  };
}
