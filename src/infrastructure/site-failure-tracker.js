/**
 * Sliding-window per-(lane, host) failure tracking.
 *
 * Shared by the public egress pool and the session-lane path so both treat
 * site blocks with the same threshold and window. `record()` returns true
 * only when the failure count crosses the threshold inside the window;
 * the caller owns any block cooldown derived from the trip.
 */
export function createSiteFailureTracker({
  threshold = 3,
  windowMs = 60_000,
  now = () => Date.now(),
} = {}) {
  const states = new Map();

  function key(laneId, host) {
    return `${String(laneId)}\n${String(host).toLowerCase()}`;
  }

  function record(laneId, host, status) {
    const k = key(laneId, host);
    const current = now();
    let state = states.get(k);
    if (!state || current - state.lastAt > windowMs) {
      state = { count: 0, firstAt: current, lastAt: current, trippedAt: undefined };
      states.set(k, state);
    }
    state.lastAt = current;
    state.count += 1;
    // Trip again after every additional threshold of failures, so a persistently
    // blocked host re-arms the caller's cooldown instead of being blocked once
    // and then hammered forever.
    if (state.count >= threshold && state.count % threshold === 0) {
      state.trippedAt = current;
      return true;
    }
    return false;
  }

  function reset(laneId, host) {
    states.delete(key(laneId, host));
  }

  function blocked(laneId, host) {
    return Boolean(states.get(key(laneId, host))?.trippedAt !== undefined);
  }

  function stats() {
    const cutoff = now() - windowMs;
    return [...states.entries()]
      .filter(([, state]) => state.trippedAt !== undefined || state.lastAt >= cutoff)
      .map(([k, state]) => {
        const [laneId, host] = k.split('\n');
        return { laneId, host, count: state.count, trippedAt: state.trippedAt || null };
      });
  }

  function clearAll() {
    states.clear();
  }

  return { record, reset, clearAll, blocked, stats };
}
