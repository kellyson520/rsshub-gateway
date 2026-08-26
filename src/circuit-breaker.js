export class CircuitBreaker {
  constructor({ failureThreshold = 3, cooldownMs = 30_000, now = () => Date.now() } = {}) {
    this.failureThreshold = failureThreshold;
    this.cooldownMs = cooldownMs;
    this.now = now;
    this.entries = new Map();
  }

  state(key) {
    const entry = this.entries.get(key);
    if (!entry) return 'closed';
    if (entry.state === 'open' && this.now() - entry.openedAt >= this.cooldownMs) return 'half-open';
    return entry.state;
  }

  canRequest(key) {
    const entry = this.entries.get(key);
    if (!entry || entry.state === 'closed') return true;
    if (entry.state === 'open') {
      if (this.now() - entry.openedAt < this.cooldownMs) return false;
      entry.state = 'half-open';
      entry.probeInFlight = true;
      return true;
    }
    return !entry.probeInFlight;
  }

  recordFailure(key) {
    const entry = this.entries.get(key) || { state: 'closed', failures: 0, openedAt: 0, probeInFlight: false };
    entry.failures += 1;
    entry.probeInFlight = false;
    if (entry.state === 'half-open' || entry.failures >= this.failureThreshold) {
      entry.state = 'open';
      entry.openedAt = this.now();
    }
    this.entries.set(key, entry);
  }

  recordSuccess(key) {
    this.entries.delete(key);
  }

  openKeys() {
    return [...this.entries.entries()]
      .filter(([key, entry]) => this.state(key) === 'open')
      .map(([key]) => key)
      .sort();
  }

  clearAll() {
    this.entries.clear();
  }

  stats() {
    const byState = { closed: 0, open: 0, 'half-open': 0 };
    for (const [key, entry] of this.entries.entries()) {
      byState[this.state(key)] += 1;
    }
    return { byState, open: byState.open, openKeys: this.openKeys() };
  }
}
