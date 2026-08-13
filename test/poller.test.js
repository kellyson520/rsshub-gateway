import test from 'node:test';
import assert from 'node:assert/strict';
import { createPoller } from '../src/infrastructure/poller.js';

test('runs registered tasks periodically with jitter', async () => {
  const poller = createPoller({ intervalMs: 50, jitterRatio: 0, now: () => Date.now() });
  let runs = 0;
  poller.register('tick', async () => { runs += 1; }, { interval: 50 });
  poller.start();
  await new Promise((resolve) => setTimeout(resolve, 250));
  poller.stop();
  assert.ok(runs >= 3, `expected >=3 runs, got ${runs}`);
  const stats = poller.stats();
  assert.equal(stats.tasks[0].name, 'tick');
  assert.ok(stats.tasks[0].ticks >= 3);
});

test('captures task failures without stopping the loop', async () => {
  const poller = createPoller({ intervalMs: 30, jitterRatio: 0, now: () => Date.now() });
  let runs = 0;
  poller.register('flaky', async () => {
    runs += 1;
    if (runs === 1) throw new Error('boom');
  }, { interval: 30 });
  poller.start();
  await new Promise((resolve) => setTimeout(resolve, 150));
  poller.stop();
  assert.ok(runs >= 3);
  assert.ok(poller.stats().tasks[0].failures >= 1);
});


test('runs each task on its own interval instead of a global cadence', async () => {
  const poller = createPoller({ intervalMs: 10_000, jitterRatio: 0 });
  let slowRuns = 0;
  let fastRuns = 0;
  poller.register('slow', async () => { slowRuns += 1; }, { interval: 200 });
  poller.register('fast', async () => { fastRuns += 1; }, { interval: 40 });
  poller.start();
  await new Promise((resolve) => setTimeout(resolve, 170));
  poller.stop();
  assert.ok(fastRuns >= 3, `expected >=3 fast runs, got ${fastRuns}`);
  assert.ok(slowRuns <= 1, `expected <=1 slow runs, got ${slowRuns}`);
});

test('runs immediately when requested', async () => {
  const poller = createPoller({ intervalMs: 10_000, jitterRatio: 0 });
  let runs = 0;
  poller.register('boot', async () => { runs += 1; }, { runImmediately: true });
  poller.start();
  await new Promise((resolve) => setTimeout(resolve, 20));
  poller.stop();
  assert.ok(runs >= 1);
});
