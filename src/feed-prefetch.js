/**
 * Asynchronous feed prefetch / precache task queue (architecture v0.2, phase 3.2).
 *
 * Keeps configured feed paths warm in the shared RSS cache. The gateway
 * re-requests each configured path through its own pipeline on a schedule
 * (poller-driven `runCycle`), so the exact same cache namespace, post-processing
 * and metrics apply. In-flight and queued paths are deduplicated, concurrency is
 * bounded, transient failures are retried with backoff, and `/_gateway/prefetch`
 * exposes stats plus on-demand enqueue.
 */
export function createFeedPrefetchQueue({
  paths = [],
  intervalMs = 900_000,
  concurrency = 2,
  maxRetries = 2,
  retryBackoffMs = 5_000,
  fetchFeed = async () => ({ ok: false, status: 503 }),
  logger = { info() {}, warn() {}, error() {} },
  now = () => Date.now(),
  sleep = (delay) => new Promise((resolve) => setTimeout(resolve, delay)),
} = {}) {
  const idleSleep = (delay) => new Promise((resolve) => {
    const timer = setTimeout(resolve, delay);
    timer.unref?.();
  });
  const limit = Math.min(8, Math.max(1, Math.floor(Number(concurrency) || 2)));
  const retries = Math.min(5, Math.max(0, Math.floor(Number(maxRetries) || 0)));
  const interval = Math.max(1_000, Number(intervalMs) || 900_000);
  const configured = [...new Set(paths.map(String).filter(Boolean))];
  const pending = new Map();
  const pathStats = new Map();
  const idleWaiters = [];
  let inFlight = 0;
  let completed = 0;
  let failed = 0;
  let lastRunAt = 0;
  let running = false;
  let wake = null;

  function notifyIdle() {
    if (pending.size !== 0 || inFlight !== 0) return;
    while (idleWaiters.length) idleWaiters.shift()();
  }

  function idle() {
    if (pending.size === 0 && inFlight === 0) return Promise.resolve();
    return new Promise((resolve) => idleWaiters.push(resolve));
  }

  function record(path, patch) {
    const entry = pathStats.get(path) || { queued: 0, completed: 0, failed: 0, attempts: 0, lastStatus: null, lastAttemptAt: 0, lastDurationMs: null };
    pathStats.set(path, { ...entry, ...patch });
    return pathStats.get(path);
  }

  function enqueue(path, { force = false } = {}) {
    const key = String(path || '').trim();
    if (!key) return { queued: 0, skipped: 1 };
    if (pending.has(key)) return { queued: 0, skipped: 1, reason: 'already-pending' };
    const entry = pathStats.get(key);
    if (!force && entry?.lastAttemptAt && now() - entry.lastAttemptAt < interval) {
      return { queued: 0, skipped: 1, reason: 'within-interval' };
    }
    pending.set(key, { path: key, attempts: 0, retryAt: 0 });
    record(key, { queued: (pathStats.get(key)?.queued || 0) + 1 });
    if (wake) {
      const resolve = wake;
      wake = null;
      resolve();
    }
    return { queued: 1, skipped: 0 };
  }

  function runCycle() {
    lastRunAt = now();
    let enqueued = 0;
    for (const path of configured) {
      const result = enqueue(path);
      if (result.queued) enqueued += 1;
    }
    return { paths: configured.length, enqueued, queueLength: pending.size };
  }

  function nextPath() {
    const timestamp = now();
    for (const [key, item] of pending) {
      if (item.retryAt <= timestamp) return { key, item };
    }
    return null;
  }

  async function runItem(key, item) {
    const startedAt = now();
    item.attempts += 1;
    record(key, { attempts: item.attempts, lastAttemptAt: startedAt });
    let result;
    try {
      result = await fetchFeed(key);
    } catch (error) {
      result = { ok: false, status: 0, error: error.message };
    }
    const durationMs = now() - startedAt;
    if (result?.notReady) {
      pending.set(key, { ...item, retryAt: now() + 1000 });
      return;
    }
    if (result?.ok) {
      completed += 1;
      pending.delete(key);
      record(key, {
        completed: (pathStats.get(key)?.completed || 0) + 1,
        lastStatus: result.status,
        lastDurationMs: durationMs,
        lastAttemptAt: startedAt,
      });
      logger.info('feed_prefetch_completed', { path: key, status: result.status, durationMs });
      notifyIdle();
      return;
    }
    if (item.attempts > retries) {
      failed += 1;
      record(key, {
        failed: (pathStats.get(key)?.failed || 0) + 1,
        lastStatus: result.status || 0,
        lastDurationMs: durationMs,
      });
      logger.warn('feed_prefetch_failed', { path: key, status: result.status, error: result.error, attempts: item.attempts });
      notifyIdle();
      return;
    }
    item.retryAt = now() + retryBackoffMs * item.attempts;
    pending.set(key, item);
  }

  async function drainLoop() {
    while (running) {
      if (pending.size === 0) {
        if (inFlight === 0) notifyIdle();
        await new Promise((resolve) => {
          wake = resolve;
          const timer = setTimeout(resolve, 100);
          timer.unref?.();
        });
        continue;
      }
      let spawned = 0;
      while (spawned < limit && inFlight < limit) {
        const next = nextPath();
        if (!next) break;
        pending.delete(next.key);
        inFlight += 1;
        spawned += 1;
        runItem(next.key, next.item)
          .catch((error) => {
            logger.error('feed_prefetch_internal', { error: error.message });
          })
          .finally(() => {
            inFlight -= 1;
            notifyIdle();
          });
      }
      await idleSleep(spawned === 0 ? 20 : 1);
    }
  }

  function start() {
    if (running) return;
    running = true;
    void drainLoop();
  }

  function stop() {
    running = false;
  }

  function stats() {
    return {
      enabled: configured.length > 0,
      configured: configured.length,
      queueLength: pending.size,
      inFlight,
      completed,
      failed,
      lastRunAt,
      paths: Object.fromEntries([...pathStats.entries()].map(([path, entry]) => [path, { ...entry }])),
    };
  }

  return { enqueue, runCycle, idle, start, stop, stats };
}
