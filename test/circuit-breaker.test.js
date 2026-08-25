import test from 'node:test';
import assert from 'node:assert/strict';
import { CircuitBreaker } from '../src/circuit-breaker.js';

test('opens after three failures and rejects requests during cooldown', () => {
  let now = 0;
  const breaker = new CircuitBreaker({ failureThreshold: 3, cooldownMs: 30_000, now: () => now });

  assert.equal(breaker.canRequest('t.me'), true);
  breaker.recordFailure('t.me');
  breaker.recordFailure('t.me');
  breaker.recordFailure('t.me');

  assert.equal(breaker.state('t.me'), 'open');
  assert.equal(breaker.canRequest('t.me'), false);
});

test('permits one half-open probe and closes on success', () => {
  let now = 0;
  const breaker = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 30_000, now: () => now });

  breaker.recordFailure('x.com');
  now += 30_000;

  assert.equal(breaker.canRequest('x.com'), true);
  assert.equal(breaker.canRequest('x.com'), false);
  breaker.recordSuccess('x.com');
  assert.equal(breaker.state('x.com'), 'closed');
  assert.equal(breaker.canRequest('x.com'), true);
});

test('success clears consecutive failures without affecting another source', () => {
  let now = 0;
  const breaker = new CircuitBreaker({ failureThreshold: 2, now: () => now });

  breaker.recordFailure('t.me');
  breaker.recordSuccess('t.me');
  breaker.recordFailure('t.me');
  assert.equal(breaker.state('t.me'), 'closed');

  breaker.recordFailure('x.com');
  breaker.recordFailure('x.com');
  assert.equal(breaker.state('x.com'), 'open');
});

test('lists only circuits that are currently open', () => {
  let now = 0;
  const breaker = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 30_000, now: () => now });

  breaker.recordFailure('t.me');
  assert.deepEqual(breaker.openKeys(), ['t.me']);
  now += 30_000;
  assert.deepEqual(breaker.openKeys(), []);
});

test('stats summarizes circuit breaker state distribution and open keys', () => {
  let now = 1000;
  const breaker = new CircuitBreaker({ failureThreshold: 2, cooldownMs: 10_000, now: () => now });

  breaker.recordFailure('host-a.com');
  breaker.recordFailure('host-a.com'); // Open

  breaker.recordFailure('host-b.com'); // Closed (1 failure)

  let summary = breaker.stats();
  assert.equal(summary.open, 1);
  assert.deepEqual(summary.openKeys, ['host-a.com']);
  assert.equal(summary.byState.open, 1);
  assert.equal(summary.byState.closed, 1);

  // Transition to half-open after cooldown
  now += 10_000;
  summary = breaker.stats();
  assert.equal(summary.byState['half-open'], 1);
  assert.equal(summary.open, 0);
});
