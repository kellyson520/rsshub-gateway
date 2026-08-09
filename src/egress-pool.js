const DEFAULT_MIN_CONCURRENCY_PER_LANE = 3;
const DEFAULT_MAX_CONCURRENCY_PER_LANE = 6;
const DEFAULT_SUCCESS_RAMP_AFTER = 6;
const DEFAULT_COOLDOWN_MS = 500;
const DEFAULT_BACKGROUND_RESERVE_PER_LANE = 1;
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

export function createEgressPool(options = {}) {
  const minConcurrencyPerLane = Math.max(1, Number.parseInt(options.minConcurrencyPerLane, 10) || DEFAULT_MIN_CONCURRENCY_PER_LANE);
  const maxConcurrencyPerLane = Math.max(minConcurrencyPerLane, Number.parseInt(options.maxConcurrencyPerLane, 10) || DEFAULT_MAX_CONCURRENCY_PER_LANE);
  const successRampAfter = Math.max(1, Number.parseInt(options.successRampAfter, 10) || DEFAULT_SUCCESS_RAMP_AFTER);
  const cooldownMs = Math.max(0, Number.parseInt(options.cooldownMs, 10) || DEFAULT_COOLDOWN_MS);
  const backgroundReservePerLane = Math.max(0, Number.parseInt(options.backgroundReservePerLane, 10) || DEFAULT_BACKGROUND_RESERVE_PER_LANE);
  const now = options.now || (() => Date.now());
  const onEvent = options.onEvent;
  const laneStates = new Map();
  const waiters = [];
  let cursor = 0;
  let wakeTimer;

  function createState(lane, previous) {
    if (previous) {
      previous.proxyName = String(lane.proxyName || lane.id);
      previous.proxyUrl = String(lane.proxyUrl || '');
      previous.dispatcher = lane.dispatcher;
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
    const reserve = priority === 'background' ? backgroundReservePerLane : 0;
    return [...laneStates.values()].filter((lane) => lane.active < Math.max(0, lane.targetConcurrency - reserve) && lane.cooldownUntil <= timestamp);
  }

  function chooseLane({ priority = 'foreground', galleryShard } = {}) {
    const lanes = availableLanes(priority);
    if (!lanes.length) return undefined;
    if (Number.isInteger(galleryShard) && galleryShard >= 0) {
      const allLanes = [...laneStates.values()].filter((lane) => lane.cooldownUntil <= now());
      const hinted = allLanes[galleryShard % allLanes.length];
      if (hinted && lanes.includes(hinted)) return hinted;
    }
    lanes.sort((left, right) => left.active - right.active || left.id.localeCompare(right.id));
    const leastActive = lanes[0].active;
    const tied = lanes.filter((lane) => lane.active === leastActive);
    const lane = tied[cursor % tied.length];
    cursor = (cursor + 1) % Math.max(1, tied.length);
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

  function recordResult(lane, result = {}) {
    const status = Number(result.status);
    if (isSuccess(status)) {
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
  }

  function makeLease(lane) {
    lane.active += 1;
    let released = false;
    return {
      laneId: lane.id,
      proxyName: lane.proxyName,
      proxyUrl: lane.proxyUrl,
      dispatcher: lane.dispatcher,
      release(result) {
        if (released) return;
        released = true;
        lane.active = Math.max(0, lane.active - 1);
        recordResult(lane, result);
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
        const lane = chooseLane({ priority: waiters[index].priority, galleryShard: waiters[index].context.galleryShard });
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
    const lane = chooseLane({ priority, galleryShard: context.galleryShard });
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
      })),
    }),
  };
}
