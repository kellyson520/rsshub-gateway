import { createSiteFailureTracker } from './infrastructure/site-failure-tracker.js';

const DEFAULT_MIN_CONCURRENCY_PER_LANE = 3;
const DEFAULT_MAX_CONCURRENCY_PER_LANE = 6;
const DEFAULT_SUCCESS_RAMP_AFTER = 6;
const DEFAULT_COOLDOWN_MS = 500;
const DEFAULT_BACKGROUND_RESERVE_PER_LANE = 1;
const EWMA_ALPHA = 0.2;
const MAX_LATENCY_SAMPLE_MS = 10_000;
const RETRYABLE_STATUSES = new Set([408, 425, 429]);

function safeEvent(onEvent, event) {
  try {
    onEvent?.(event);
  } catch {
    // Diagnostics must never affect request scheduling.
  }
}

function isSuccess(status) {
  return Number.isInteger(status) && status >= 200 && status <= 299;
}

function isRetryable(status) {
  return RETRYABLE_STATUSES.has(status) || (Number.isInteger(status) && status >= 500 && status <= 599);
}

function poolError(message, code) {
  return Object.assign(new Error(message), { code });
}

export {
  isSuccess,
  isRetryable,
  poolError,
  safeEvent,
  DEFAULT_MIN_CONCURRENCY_PER_LANE,
  DEFAULT_MAX_CONCURRENCY_PER_LANE,
  DEFAULT_SUCCESS_RAMP_AFTER,
  DEFAULT_COOLDOWN_MS,
  DEFAULT_BACKGROUND_RESERVE_PER_LANE,
  EWMA_ALPHA,
  MAX_LATENCY_SAMPLE_MS,
  RETRYABLE_STATUSES,
};

export function createEgressPool(options = {}) {
  const minConcurrencyPerLane = Math.max(1, Number.parseInt(options.minConcurrencyPerLane, 10) || DEFAULT_MIN_CONCURRENCY_PER_LANE);
  const maxConcurrencyPerLane = Math.max(minConcurrencyPerLane, Number.parseInt(options.maxConcurrencyPerLane, 10) || DEFAULT_MAX_CONCURRENCY_PER_LANE);
  const successRampAfter = Math.max(1, Number.parseInt(options.successRampAfter, 10) || DEFAULT_SUCCESS_RAMP_AFTER);
  const cooldownMs = Math.max(0, Number.parseInt(options.cooldownMs, 10) || DEFAULT_COOLDOWN_MS);
  const backgroundReservePerLane = Math.max(0, Number.parseInt(options.backgroundReservePerLane, 10) || DEFAULT_BACKGROUND_RESERVE_PER_LANE);
  const blockedStatuses = new Set([...(options.blockedStatuses || [401, 403, 407, 429])].map(Number));
  const siteFailureThreshold = Math.max(1, Number.parseInt(options.siteFailureThreshold, 10) || 3);
  const siteFailureWindowMs = Math.max(1_000, Number.parseInt(options.siteFailureWindowMs, 10) || 60_000);
  const siteBlockCooldownMs = Math.max(0, Number.parseInt(options.siteBlockCooldownMs, 10) || 60_000);
  const scopeOverrides = options.scopeOverrides && typeof options.scopeOverrides === 'object' ? options.scopeOverrides : {};
  const now = options.now || (() => Date.now());
  const onEvent = options.onEvent;
  const siteTracker = options.siteTracker || createSiteFailureTracker({
    threshold: siteFailureThreshold,
    windowMs: siteFailureWindowMs,
    now,
  });
  const laneStates = new Map();
  const waiters = [];
  let cursor = 0;
  let wakeTimer;

  function createState(lane, previous) {
    if (previous) {
      previous.proxyName = String(lane.proxyName || lane.id);
      previous.proxyUrl = String(lane.proxyUrl || '');
      previous.dispatcher = lane.dispatcher;
      // Probe results change across refreshes: always take the latest scopes
      // instead of freezing the first snapshot on the lane state.
      if (lane.healthyScopes) previous.healthyScopes = new Set(lane.healthyScopes);
      if (!previous.siteHealth) previous.siteHealth = new Map();
      return previous;
    }
    return {
      id: String(lane.id),
      proxyName: String(lane.proxyName || lane.id),
      proxyUrl: String(lane.proxyUrl || ''),
      dispatcher: lane.dispatcher,
      active: 0,
      targetConcurrency: minConcurrencyPerLane,
      successStreak: 0,
      cooldownUntil: 0,
      siteHealth: new Map(),
      healthyScopes: lane.healthyScopes ? new Set(lane.healthyScopes) : null,
      ewmaMs: 0,
      samples: 0,
    };
  }

  function emit(event) {
    safeEvent(onEvent, event);
  }

  function setLanes(lanes = []) {
    const next = new Map();
    for (const lane of lanes) {
      if (!lane?.id) continue;
      next.set(String(lane.id), createState(lane, laneStates.get(String(lane.id))));
    }
    laneStates.clear();
    for (const [id, lane] of next) laneStates.set(id, lane);
    if (!laneStates.size) {
      while (waiters.length) waiters.shift().reject(poolError('no healthy egress lanes are available', 'EGRESS_POOL_EMPTY'));
      emit({ state: 'empty', lanes: 0 });
    }
    drain();
  }

  function availableLanes(priority = 'foreground') {
    const timestamp = now();
    return [...laneStates.values()].filter((lane) => {
      // Keep at least one slot for background work even when the configured
      // reserve would starve it (min concurrency <= reserve).
      const reserve = priority === 'background'
        ? Math.min(backgroundReservePerLane, Math.max(0, lane.targetConcurrency - 1))
        : 0;
      return lane.active < Math.max(0, lane.targetConcurrency - reserve) && lane.cooldownUntil <= timestamp;
    });
  }

  function effectiveScope(host, scope) {
    if (host && scopeOverrides[String(host).toLowerCase()]) {
      return scopeOverrides[String(host).toLowerCase()];
    }
    return scope || 'public';
  }

  function laneHealthyForScope(lane, scope) {
    if (!lane.healthyScopes || lane.healthyScopes.has(scope)) return true;
    return false;
  }

  function chooseLane({ priority = 'foreground', galleryShard, host, scope } = {}) {
    const requestScope = effectiveScope(host, scope);
    const timestamp = now();
    const hostKey = String(host || '').toLowerCase();
    const lanes = availableLanes(priority).filter((lane) => laneHealthyForScope(lane, requestScope));
    if (!lanes.length) return undefined;
    const unblocked = lanes.filter((lane) => {
      const until = lane.siteHealth.get(hostKey);
      return until === undefined || until <= timestamp;
    });
    let candidates = unblocked;
    if (!unblocked.length) {
      candidates = lanes;
      emit({ state: 'site-degraded', host: hostKey, scope: requestScope });
    }
    if (Number.isInteger(galleryShard) && galleryShard >= 0) {
      const allLanes = [...laneStates.values()].filter((lane) => lane.cooldownUntil <= now());
      const hinted = allLanes[galleryShard % allLanes.length];
      if (hinted && candidates.includes(hinted)) return hinted;
    }
    candidates.sort((left, right) => left.active - right.active || left.id.localeCompare(right.id));
    const leastActive = candidates[0].active;
    const tied = candidates.filter((lane) => lane.active === leastActive);
    const measured = tied.filter((lane) => lane.samples > 0);
    if (!measured.length || measured.length < tied.length) {
      const lane = tied[cursor % tied.length];
      cursor = (cursor + 1) % Math.max(1, tied.length);
      return lane;
    }
    const fastest = Math.min(...measured.map((lane) => lane.ewmaMs));
    const fastestLanes = measured.filter((lane) => lane.ewmaMs === fastest);
    const lane = fastestLanes[cursor % fastestLanes.length];
    cursor = (cursor + 1) % Math.max(1, fastestLanes.length);
    return lane;
  }

  function scheduleWake() {
    if (wakeTimer || !waiters.length) return;
    const nextCooldown = [...laneStates.values()]
      .map((lane) => lane.cooldownUntil)
      .filter((value) => value > now())
      .sort((left, right) => left - right)[0];
    if (!nextCooldown) return;
    wakeTimer = setTimeout(() => {
      wakeTimer = undefined;
      drain();
    }, Math.max(1, nextCooldown - now()));
  }

  function recordResult(lane, result = {}, durationMs = 0) {
    const status = Number(result.status);
    const hostKey = result.host ? String(result.host).toLowerCase() : undefined;
    if (isSuccess(status)) {
      lane.ewmaMs = lane.samples ? lane.ewmaMs * (1 - EWMA_ALPHA) + durationMs * EWMA_ALPHA : durationMs;
      lane.samples += 1;
      if (hostKey) {
        siteTracker.reset(lane.id, hostKey);
        lane.siteHealth.delete(hostKey);
      }
      lane.successStreak += 1;
      if (lane.successStreak >= successRampAfter) {
        lane.targetConcurrency = Math.min(maxConcurrencyPerLane, lane.targetConcurrency + 1);
        lane.successStreak = 0;
        emit({ state: 'ramp', laneId: lane.id, targetConcurrency: lane.targetConcurrency });
      }
      return;
    }
    if (isRetryable(status) || result.error) {
      lane.successStreak = 0;
      lane.targetConcurrency = Math.max(minConcurrencyPerLane, lane.targetConcurrency - 1);
      lane.cooldownUntil = now() + cooldownMs;
      emit({ state: 'backoff', laneId: lane.id, status: Number.isInteger(status) ? status : 504, targetConcurrency: lane.targetConcurrency });
    }
    if (hostKey && blockedStatuses.has(status)) {
      if (siteTracker.record(lane.id, hostKey, status)) {
        lane.siteHealth.set(hostKey, now() + siteBlockCooldownMs);
        emit({ state: 'site-blocked', laneId: lane.id, host: hostKey, status });
      }
    }
  }

  function makeLease(lane, context = {}) {
    lane.active += 1;
    const startedAt = now();
    let released = false;
    return {
      laneId: lane.id,
      proxyName: lane.proxyName,
      proxyUrl: lane.proxyUrl,
      dispatcher: lane.dispatcher,
      host: context.host,
      release(result) {
        if (released) return;
        released = true;
        lane.active = Math.max(0, lane.active - 1);
        const durationMs = Math.min(Math.max(0, now() - startedAt), MAX_LATENCY_SAMPLE_MS);
        recordResult(lane, { ...result, host: result.host || context.host }, durationMs);
        drain();
      },
    };
  }

  function drain() {
    while (waiters.length) {
      const indexes = waiters.map((_, index) => index).sort((left, right) => (
        (waiters[left].priority === 'background' ? 1 : 0)
        - (waiters[right].priority === 'background' ? 1 : 0)
        || left - right
      ));
      let selectedIndex = -1;
      let selectedLane;
      for (const index of indexes) {
        const lane = chooseLane({ priority: waiters[index].priority, galleryShard: waiters[index].context.galleryShard, host: waiters[index].context.host, scope: waiters[index].context.scope });
        if (lane) {
          selectedIndex = index;
          selectedLane = lane;
          break;
        }
      }
      if (selectedIndex < 0) break;
      const waiter = waiters.splice(selectedIndex, 1)[0];
      waiter.resolve(makeLease(selectedLane));
    }
    scheduleWake();
  }

  function acquire(context = {}) {
    const priority = context.priority === 'background' ? 'background' : 'foreground';
    const lane = chooseLane({ priority, galleryShard: context.galleryShard, host: context.host, scope: context.scope });
    if (lane) return Promise.resolve(makeLease(lane, context));
    if (!laneStates.size) return Promise.reject(poolError('no healthy egress lanes are available', 'EGRESS_POOL_EMPTY'));
    return new Promise((resolve, reject) => {
      waiters.push({ resolve, reject, context, priority });
      scheduleWake();
    });
  }

  setLanes(options.lanes || []);

  return {
    acquire,
    setLanes,
    capacity: () => [...laneStates.values()].reduce((total, lane) => total + lane.targetConcurrency, 0),
    minimumCapacity: () => laneStates.size * minConcurrencyPerLane,
    stats: () => ({
      active: [...laneStates.values()].reduce((total, lane) => total + lane.active, 0),
      lanes: [...laneStates.values()].map((lane) => ({
        id: lane.id,
        active: lane.active,
        targetConcurrency: lane.targetConcurrency,
        siteBlocked: [...lane.siteHealth.keys()],
        healthyScopes: lane.healthyScopes ? [...lane.healthyScopes] : null,
        samples: lane.samples,
        ewmaMs: lane.samples ? Math.round(lane.ewmaMs) : undefined,
      })),
    }),
  };
}
