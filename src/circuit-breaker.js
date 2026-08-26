export const DEFAULT_FAILURE_THRESHOLD = 3;
export const DEFAULT_COOLDOWN_MS = 30_000;

export const CIRCUIT_STATE_CLOSED = 'closed';
export const CIRCUIT_STATE_OPEN = 'open';
export const CIRCUIT_STATE_HALF_OPEN = 'half-open';

export class CircuitBreaker {
  constructor({ failureThreshold = DEFAULT_FAILURE_THRESHOLD, cooldownMs = DEFAULT_COOLDOWN_MS, now = () => Date.now() } = {}) {
    this.failureThreshold = failureThreshold;
    this.cooldownMs = cooldownMs;
    this.now = now;
    this.entries = new Map();
  }

  state(key) {
    const entry = this.entries.get(key);
    if (!entry) return CIRCUIT_STATE_CLOSED;
    if (entry.state === CIRCUIT_STATE_OPEN && this.now() - entry.openedAt >= this.cooldownMs) return CIRCUIT_STATE_HALF_OPEN;
    return entry.state;
  }

  canRequest(key) {
    const entry = this.entries.get(key);
    if (!entry || entry.state === CIRCUIT_STATE_CLOSED) return true;
    if (entry.state === CIRCUIT_STATE_OPEN) {
      if (this.now() - entry.openedAt < this.cooldownMs) return false;
      entry.state = CIRCUIT_STATE_HALF_OPEN;
      entry.probeInFlight = true;
      return true;
    }
    return !entry.probeInFlight;
  }

  recordFailure(key) {
    const entry = this.entries.get(key) || { state: CIRCUIT_STATE_CLOSED, failures: 0, openedAt: 0, probeInFlight: false };
    entry.failures += 1;
    entry.probeInFlight = false;
    if (entry.state === CIRCUIT_STATE_HALF_OPEN || entry.failures >= this.failureThreshold) {
      entry.state = CIRCUIT_STATE_OPEN;
      entry.openedAt = this.now();
    }
    this.entries.set(key, entry);
  }

  recordSuccess(key) {
    this.entries.delete(key);
  }

  openKeys() {
    return [...this.entries.entries()]
      .filter(([key, entry]) => this.state(key) === CIRCUIT_STATE_OPEN)
      .map(([key]) => key)
      .sort();
  }

  clearAll() {
    this.entries.clear();
  }

  stats() {
    const byState = { [CIRCUIT_STATE_CLOSED]: 0, [CIRCUIT_STATE_OPEN]: 0, [CIRCUIT_STATE_HALF_OPEN]: 0 };
    for (const [key, entry] of this.entries.entries()) {
      byState[this.state(key)] += 1;
    }
    return { byState, open: byState[CIRCUIT_STATE_OPEN], openKeys: this.openKeys() };
  }
}
