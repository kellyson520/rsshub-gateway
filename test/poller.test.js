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

test('idempotently registers duplicate task names', () => {
  const poller = createPoller({ intervalMs: 10_000 });
  const task1 = poller.register('unique-task', () => {});
  const task2 = poller.register('unique-task', () => {});
  assert.equal(task1, task2);
});

test('stats reports accurate consecutive failures and duration', async () => {
  let time = 1000;
  const poller = createPoller({
    now: () => time,
  });

  const task = poller.register('stats-task', async () => {
    time += 50;
    throw new Error('fail');
  }, { interval: 10 });

  poller.start();
  time += 100; // Advance time past interval
  await poller.tick();
  poller.stop();

  const stats = poller.stats();
  assert.equal(stats.running, false);
  assert.equal(stats.tasks[0].failures, 1);
  assert.equal(stats.tasks[0].consecutiveFailures, 1);
  assert.equal(stats.tasks[0].lastDurationMs, 50);
});

test('poller stop is idempotent and clears active timers cleanly', () => {
  const poller = createPoller({ intervalMs: 100 });
  poller.register('noop', () => {});
  poller.start();
  assert.equal(poller.stats().running, true);
  poller.stop();
  assert.equal(poller.stats().running, false);
  // Second call must be harmless
  poller.stop();
  assert.equal(poller.stats().running, false);
});

test('unregister removes task and stops poller if no tasks remain', () => {
  const poller = createPoller({ intervalMs: 100 });
  poller.register('task-a', () => {});
  poller.register('task-b', () => {});
  poller.start();
  assert.equal(poller.stats().tasks.length, 2);

  assert.equal(poller.unregister('task-a'), true);
  assert.equal(poller.unregister('non-existent'), false);
  assert.equal(poller.stats().tasks.length, 1);
  assert.equal(poller.stats().running, true);

  assert.equal(poller.unregister('task-b'), true);
  assert.equal(poller.stats().tasks.length, 0);
  assert.equal(poller.stats().running, false);
});

test('exports default poller timing and jitter configuration constants', async () => {
  const {
    DEFAULT_POLLER_INTERVAL_MS,
    DEFAULT_POLLER_JITTER_RATIO,
    MIN_TASK_INTERVAL_MS,
    MAX_JITTER_RATIO,
  } = await import('../src/infrastructure/poller.js');

  assert.equal(DEFAULT_POLLER_INTERVAL_MS, 60_000);
  assert.equal(DEFAULT_POLLER_JITTER_RATIO, 0.2);
  assert.equal(MIN_TASK_INTERVAL_MS, 10);
  assert.equal(MAX_JITTER_RATIO, 0.5);
});
