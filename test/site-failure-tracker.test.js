import test from 'node:test';
import assert from 'node:assert/strict';
import { createSiteFailureTracker } from '../src/infrastructure/site-failure-tracker.js';

test('trips only after the threshold inside the window', () => {
  let now = 1_000;
  const tracker = createSiteFailureTracker({ threshold: 3, windowMs: 60_000, now: () => now });
  assert.equal(tracker.record('lane-01', 'iwara.tv', 403), false);
  assert.equal(tracker.record('lane-01', 'iwara.tv', 429), false);
  assert.equal(tracker.record('lane-01', 'iwara.tv', 403), true);
  assert.equal(tracker.blocked('lane-01', 'iwara.tv'), true);
  assert.equal(tracker.record('lane-02', 'iwara.tv', 403), false);
  assert.equal(tracker.record('lane-01', 'x.com', 403), false);
});

test('resets on success and expires after the window', () => {
  let now = 1_000;
  const tracker = createSiteFailureTracker({ threshold: 2, windowMs: 60_000, now: () => now });
  tracker.record('lane-01', 'x.com', 403);
  tracker.reset('lane-01', 'x.com');
  assert.equal(tracker.blocked('lane-01', 'x.com'), false);
  assert.equal(tracker.record('lane-01', 'x.com', 403), false);
  now = 1_000 + 61_000;
  assert.equal(tracker.record('lane-01', 'x.com', 403), false);
  assert.equal(tracker.blocked('lane-01', 'x.com'), false);
});

test('stats exposes per lane and host counts', () => {
  const tracker = createSiteFailureTracker({ threshold: 5, windowMs: 60_000 });
  tracker.record('lane-01', 'iwara.tv', 403);
  tracker.record('lane-01', 'iwara.tv', 429);
  const stats = tracker.stats();
  assert.equal(stats.length, 1);
  assert.equal(stats[0].laneId, 'lane-01');
  assert.equal(stats[0].host, 'iwara.tv');
  assert.equal(stats[0].count, 2);
  assert.equal(stats[0].trippedAt, null);
});

test('re-trips periodically when failures persist and normalizes host casing', () => {
  const tracker = createSiteFailureTracker({ threshold: 3, windowMs: 60_000 });
  // Host casing test
  assert.equal(tracker.record('lane-01', 'IWARA.TV', 403), false);
  assert.equal(tracker.record('lane-01', 'iwara.tv', 403), false);
  assert.equal(tracker.record('lane-01', 'Iwara.Tv', 403), true); // 3rd -> trips

  // 4th, 5th -> false, 6th -> re-trips
  assert.equal(tracker.record('lane-01', 'iwara.tv', 403), false);
  assert.equal(tracker.record('lane-01', 'iwara.tv', 403), false);
  assert.equal(tracker.record('lane-01', 'iwara.tv', 403), true); // 6th -> re-trips
});

test('handles non-string laneId or host values gracefully without crashing', () => {
  const tracker = createSiteFailureTracker({ threshold: 2, windowMs: 60_000 });
  assert.equal(tracker.record(null, undefined, 500), false);
  assert.equal(tracker.record(null, undefined, 500), true);
  assert.equal(tracker.blocked(null, undefined), true);
  tracker.reset(null, undefined);
  assert.equal(tracker.blocked(null, undefined), false);
});
