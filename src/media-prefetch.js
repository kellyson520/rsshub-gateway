import { randomUUID } from 'node:crypto';
import * as fsp from 'node:fs/promises';
import path from 'node:path';
import { isAllowedTarget } from './signed-target.js';

const DEFAULT_CACHE_ROOT = process.env.GATEWAY_CACHE_DIR || '/var/cache/rsshub-gateway';
const DEFAULT_INITIAL_CONCURRENCY = 6;
const DEFAULT_MIN_CONCURRENCY = 3;
const DEFAULT_MAX_CONCURRENCY = 12;
const DEFAULT_PER_ORIGIN_CONCURRENCY = 2;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_SUCCESS_RAMP_AFTER = 6;
const DEFAULT_QUEUE_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_QUEUE_ITEMS = 2_000;
const MAX_PER_ORIGIN_CONCURRENCY = 48;
const RETRYABLE_STATUSES = new Set([408, 425, 429]);

function boundedInteger(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

function originFor(target) {
  try {
    const parsed = new URL(target);
    return isAllowedTarget(parsed) ? parsed.host.toLowerCase() : '';
  } catch {
    return '';
  }
}

function retryableStatus(status) {
  return RETRYABLE_STATUSES.has(status) || (Number.isInteger(status) && status >= 500 && status <= 599);
}

function successfulStatus(status) {
  return Number.isInteger(status) && status >= 200 && status <= 299;
}

function safeEvent(onEvent, event) {
  try {
    onEvent?.(event);
  } catch {
    // Diagnostics must never affect background preloading.
  }
}

export {
  originFor,
  retryableStatus,
  successfulStatus,
  boundedInteger,
  safeEvent,
  DEFAULT_CACHE_ROOT,
  DEFAULT_INITIAL_CONCURRENCY,
  DEFAULT_MIN_CONCURRENCY,
  DEFAULT_MAX_CONCURRENCY,
  DEFAULT_PER_ORIGIN_CONCURRENCY,
  DEFAULT_MAX_RETRIES,
  DEFAULT_SUCCESS_RAMP_AFTER,
  DEFAULT_QUEUE_TTL_MS,
  MAX_QUEUE_ITEMS,
  MAX_PER_ORIGIN_CONCURRENCY,
  RETRYABLE_STATUSES,
};

export function createMediaPrefetchQueue(options = {}) {
  const queueFile = path.resolve(options.queueFile || path.join(DEFAULT_CACHE_ROOT, 'media-prefetch.json'));
  const initialConcurrency = boundedInteger(options.initialConcurrency, DEFAULT_INITIAL_CONCURRENCY, 1, DEFAULT_MAX_CONCURRENCY);
  const minConcurrency = boundedInteger(options.minConcurrency, DEFAULT_MIN_CONCURRENCY, 1, DEFAULT_MAX_CONCURRENCY);
  const maxConcurrency = boundedInteger(options.maxConcurrency, DEFAULT_MAX_CONCURRENCY, minConcurrency, DEFAULT_MAX_CONCURRENCY);
  const perOriginConcurrency = boundedInteger(options.perOriginConcurrency, DEFAULT_PER_ORIGIN_CONCURRENCY, 1, MAX_PER_ORIGIN_CONCURRENCY);
  const maxRetries = boundedInteger(options.maxRetries, DEFAULT_MAX_RETRIES, 0, 4);
  const successRampAfter = boundedInteger(options.successRampAfter, DEFAULT_SUCCESS_RAMP_AFTER, 1, 100);
  const queueTtlMs = Number.isFinite(options.queueTtlMs) && options.queueTtlMs > 0
    ? options.queueTtlMs
    : DEFAULT_QUEUE_TTL_MS;
  const now = options.now || (() => Date.now());
  const sleep = options.sleep || ((delay) => new Promise((resolve) => setTimeout(resolve, delay)));
  const random = options.random || Math.random;
  const fetchMedia = options.fetchMedia || (async () => ({ status: 204, cacheState: 'MISS' }));
  const onEvent = options.onEvent;
  const minimumConcurrencyProvider = options.minimumConcurrencyProvider;
  const capacityProvider = options.capacityProvider;
  const persistEnabled = options.persist !== false;

  let currentConcurrency = Math.min(Math.max(initialConcurrency, minConcurrency), maxConcurrency);
  let active = 0;
  let delayed = 0;
  let successStreak = 0;
  let completed = 0;
  let failures = 0;
  const pending = [];
  const records = new Map();
  const activeByOrigin = new Map();
  const earlyTargets = [];
  const idleWaiters = [];
  let persistChain = Promise.resolve();
  let initialized = false;

  function providerValue(provider, fallback) {
    try {
      const value = Number(provider?.());
      return Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
    } catch {
      return fallback;
    }
  }

  function isIdle() {
    return initialized && active === 0 && delayed === 0 && pending.length === 0;
  }

  function notifyIdle() {
    if (!isIdle()) return;
    while (idleWaiters.length) idleWaiters.shift()();
  }

  function schedulePersist() {
    if (!persistEnabled) return Promise.resolve();
    const items = [...records.values()].map((record) => ({ ...record }));
    persistChain = persistChain.then(async () => {
      await fsp.mkdir(path.dirname(queueFile), { recursive: true });
      const tempFile = `${queueFile}.${process.pid}.${randomUUID()}.tmp`;
      try {
        await fsp.writeFile(tempFile, JSON.stringify({ version: 1, items }), 'utf8');
        await fsp.rename(tempFile, queueFile);
      } finally {
        await fsp.rm(tempFile, { force: true }).catch(() => {});
      }
    }, async () => {}).catch(() => {});
    return persistChain;
  }

  function emit(event) {
    safeEvent(onEvent, {
      ...event,
      concurrency: currentConcurrency,
      queued: records.size,
      active,
    });
  }

  function addTargets(targets) {
    for (const value of targets || []) {
      const target = String(value || '');
      const origin = originFor(target);
      if (!origin || records.has(target) || records.size >= MAX_QUEUE_ITEMS) continue;
      records.set(target, { target, enqueuedAt: now(), attempts: 0 });
      pending.push(target);
      emit({ state: 'queued', host: origin });
    }
    void schedulePersist();
    drain();
  }

  function nextTargetIndex() {
    for (let index = 0; index < pending.length; index += 1) {
      const target = pending[index];
      const origin = originFor(target);
      if ((activeByOrigin.get(origin) || 0) < perOriginConcurrency) return index;
    }
    return -1;
  }

  function releaseOrigin(origin) {
    const count = (activeByOrigin.get(origin) || 1) - 1;
    if (count <= 0) activeByOrigin.delete(origin);
    else activeByOrigin.set(origin, count);
  }

  function reduceConcurrency(host, status) {
    currentConcurrency = Math.max(minConcurrency, currentConcurrency - 1);
    successStreak = 0;
    emit({ state: 'backoff', host, status });
  }

  function recordSuccess(host, cacheState) {
    if (cacheState === 'HIT' || cacheState === 'STALE') {
      emit({ state: 'hit', host });
      return;
    }
    successStreak += 1;
    if (successStreak >= successRampAfter) {
      currentConcurrency = Math.min(maxConcurrency, currentConcurrency + 1);
      successStreak = 0;
      emit({ state: 'ramp', host });
    } else {
      emit({ state: 'success', host });
    }
  }

  async function runTarget(target) {
    const record = records.get(target);
    const host = originFor(target);
    active += 1;
    activeByOrigin.set(host, (activeByOrigin.get(host) || 0) + 1);
    let retry = false;
    let retryDelay = 0;
    let result;
    try {
      result = await fetchMedia(target);
      const status = Number(result?.status);
      if (successfulStatus(status)) {
        completed += 1;
        records.delete(target);
        recordSuccess(host, result?.cacheState);
      } else if (retryableStatus(status) && record && record.attempts < maxRetries) {
        record.attempts += 1;
        retry = true;
        retryDelay = Math.min(2_000, 250 * (2 ** record.attempts) + Math.floor(random() * 100));
        reduceConcurrency(host, status);
        emit({ state: 'retry', host, status, attempt: record.attempts });
      } else {
        failures += 1;
        records.delete(target);
        reduceConcurrency(host, status);
        emit({ state: 'failed', host, status });
      }
    } catch (error) {
      const status = Number(error?.status) || 504;
      if (record && record.attempts < maxRetries) {
        record.attempts += 1;
        retry = true;
        retryDelay = Math.min(2_000, 250 * (2 ** record.attempts) + Math.floor(random() * 100));
        reduceConcurrency(host, status);
        emit({ state: 'retry', host, status, attempt: record.attempts });
      } else {
        failures += 1;
        records.delete(target);
        reduceConcurrency(host, status);
        emit({ state: 'failed', host, status });
      }
    } finally {
      active -= 1;
      releaseOrigin(host);
      void schedulePersist();
    }

    if (retry && records.has(target)) {
      delayed += 1;
      await sleep(retryDelay);
      delayed -= 1;
      if (records.has(target)) pending.push(target);
      void schedulePersist();
    }
    drain();
    notifyIdle();
  }

  function drain() {
    if (!initialized) return;
    const dynamicMinimum = Math.max(minConcurrency, providerValue(minimumConcurrencyProvider, 0));
    const dynamicCapacity = Math.max(dynamicMinimum, providerValue(capacityProvider, maxConcurrency));
    const effectiveMaximum = Math.min(maxConcurrency, dynamicCapacity);
    currentConcurrency = Math.min(Math.max(currentConcurrency, dynamicMinimum), effectiveMaximum);
    while (active < currentConcurrency) {
      const index = nextTargetIndex();
      if (index < 0) break;
      const target = pending.splice(index, 1)[0];
      void runTarget(target);
    }
    notifyIdle();
  }

  async function initialize() {
    if (!persistEnabled) {
      initialized = true;
      if (earlyTargets.length) addTargets(earlyTargets.splice(0));
      drain();
      notifyIdle();
      return;
    }
    await fsp.mkdir(path.dirname(queueFile), { recursive: true }).catch(() => {});
    try {
      const parsed = JSON.parse(await fsp.readFile(queueFile, 'utf8'));
      for (const item of Array.isArray(parsed?.items) ? parsed.items : []) {
        const target = String(item?.target || '');
        const enqueuedAt = Number(item?.enqueuedAt);
        if (!originFor(target) || !Number.isFinite(enqueuedAt) || now() - enqueuedAt > queueTtlMs) continue;
        if (records.size >= MAX_QUEUE_ITEMS || records.has(target)) continue;
        records.set(target, { target, enqueuedAt, attempts: boundedInteger(item?.attempts, 0, 0, maxRetries) });
        pending.push(target);
      }
    } catch {
      // A missing or corrupt queue is equivalent to an empty queue.
    }
    initialized = true;
    if (earlyTargets.length) addTargets(earlyTargets.splice(0));
    drain();
    notifyIdle();
  }

  const ready = initialize();

  function enqueue(targets) {
    const list = Array.isArray(targets) ? targets : (targets ? [targets] : []);
    if (!initialized) earlyTargets.push(...list);
    else addTargets(list);
  }

  async function idle() {
    await ready;
    if (!isIdle()) await new Promise((resolve) => idleWaiters.push(resolve));
    await persistChain;
  }

  function stats() {
    return {
      queued: records.size,
      pending: pending.length,
      active,
      delayed,
      completed,
      failures,
      concurrency: currentConcurrency,
    };
  }

  return { enqueue, idle, ready: () => ready, stats };
}
