import test from 'node:test';
import assert from 'node:assert/strict';
import { createEgressPool } from '../src/egress-pool.js';

const dispatcher = (name) => ({ name });

test('keeps at least three concurrent leases per healthy lane and queues overflow', async () => {
  const pool = createEgressPool({
    lanes: [
      { id: 'lane-a', proxyName: 'node-a', proxyUrl: 'http://127.0.0.1:7901', dispatcher: dispatcher('a') },
      { id: 'lane-b', proxyName: 'node-b', proxyUrl: 'http://127.0.0.1:7902', dispatcher: dispatcher('b') },
    ],
    minConcurrencyPerLane: 3,
    maxConcurrencyPerLane: 6,
  });

  const leases = await Promise.all(Array.from({ length: 6 }, () => pool.acquire({ host: 'e-hentai.org' })));
  let overflowResolved = false;
  const overflow = pool.acquire({ host: 'e-hentai.org' }).then((lease) => {
    overflowResolved = true;
    return lease;
  });

  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(overflowResolved, false);
  leases[0].release({ status: 200 });
  const seventh = await overflow;
  assert.match(seventh.laneId, /^lane-/);
  seventh.release({ status: 200 });
  for (const lease of leases.slice(1)) lease.release({ status: 200 });
  assert.equal(pool.stats().active, 0);
});

test('ramps a lane after successes and backs it off without dropping below three', async () => {
  const pool = createEgressPool({
    lanes: [{ id: 'lane-a', proxyName: 'node-a', proxyUrl: 'http://127.0.0.1:7901', dispatcher: dispatcher('a') }],
    minConcurrencyPerLane: 3,
    maxConcurrencyPerLane: 6,
    successRampAfter: 2,
  });

  for (let index = 0; index < 2; index += 1) {
    const lease = await pool.acquire({ host: 'e-hentai.org' });
    lease.release({ status: 200 });
  }
  assert.equal(pool.stats().lanes[0].targetConcurrency, 4);

  const throttled = await pool.acquire({ host: 'e-hentai.org' });
  throttled.release({ status: 429 });
  assert.equal(pool.stats().lanes[0].targetConcurrency, 3);

  const failedAtFloor = await pool.acquire({ host: 'e-hentai.org' });
  failedAtFloor.release({ status: 503 });
  assert.equal(pool.stats().lanes[0].targetConcurrency, 3);
});

test('does not lease unhealthy lanes and exposes only safe diagnostics', async () => {
  const events = [];
  const pool = createEgressPool({
    lanes: [{ id: 'lane-a', proxyName: 'secret-node-name', proxyUrl: 'http://127.0.0.1:7901', dispatcher: dispatcher('a') }],
    onEvent: (event) => events.push(event),
  });

  pool.setLanes([]);
  await assert.rejects(pool.acquire({ host: 'x.com' }), (error) => error.code === 'EGRESS_POOL_EMPTY');
  assert.deepEqual(events.at(-1), { state: 'empty', lanes: 0 });
});

test('releases an in-flight lease against the refreshed lane state', async () => {
  const pool = createEgressPool({
    lanes: [{ id: 'lane-a', proxyName: 'node-a', proxyUrl: 'http://127.0.0.1:7901', dispatcher: dispatcher('a') }],
  });

  const lease = await pool.acquire({ host: 'e-hentai.org' });
  pool.setLanes([{ id: 'lane-a', proxyName: 'node-b', proxyUrl: 'http://127.0.0.1:7901', dispatcher: dispatcher('b') }]);
  lease.release({ status: 200 });

  assert.equal(pool.stats().active, 0);
});

test('prefers distinct lanes for consecutive gallery shards', async () => {
  const pool = createEgressPool({
    lanes: [
      { id: 'lane-a', proxyName: 'node-a', proxyUrl: 'http://127.0.0.1:7901', dispatcher: dispatcher('a') },
      { id: 'lane-b', proxyName: 'node-b', proxyUrl: 'http://127.0.0.1:7902', dispatcher: dispatcher('b') },
      { id: 'lane-c', proxyName: 'node-c', proxyUrl: 'http://127.0.0.1:7903', dispatcher: dispatcher('c') },
    ],
  });

  const leases = await Promise.all(Array.from({ length: 6 }, (_, galleryShard) => pool.acquire({ galleryShard })));

  assert.deepEqual(leases.map((lease) => lease.laneId), [
    'lane-a', 'lane-b', 'lane-c', 'lane-a', 'lane-b', 'lane-c',
  ]);
  leases.forEach((lease) => lease.release({ status: 200 }));
});

test('reserves one slot per lane for foreground requests over background work', async () => {
  const pool = createEgressPool({
    lanes: [{ id: 'lane-a', proxyName: 'node-a', proxyUrl: 'http://127.0.0.1:7901', dispatcher: dispatcher('a') }],
  });

  const backgroundLeases = await Promise.all([
    pool.acquire({ priority: 'background' }),
    pool.acquire({ priority: 'background' }),
  ]);
  let backgroundResolved = false;
  const background = pool.acquire({ priority: 'background' }).then((lease) => {
    backgroundResolved = true;
    return lease;
  });
  const foreground = await pool.acquire({ priority: 'foreground' });

  assert.equal(backgroundResolved, false);
  foreground.release({ status: 200 });
  backgroundLeases[0].release({ status: 200 });
  backgroundLeases[1].release({ status: 200 });
  const finalBackground = await background;
  finalBackground.release({ status: 200 });
});

test('blocks a lane for a host after repeated blocked statuses and degrades gracefully', async () => {
  const events = [];
  const pool = createEgressPool({
    lanes: [
      { id: 'lane-a', proxyName: 'node-a', proxyUrl: 'http://127.0.0.1:7901', dispatcher: dispatcher('a'), healthyScopes: ['public', 'sticky'] },
      { id: 'lane-b', proxyName: 'node-b', proxyUrl: 'http://127.0.0.1:7902', dispatcher: dispatcher('b'), healthyScopes: ['public', 'sticky'] },
    ],
    minConcurrencyPerLane: 1,
    maxConcurrencyPerLane: 1,
    cooldownMs: 0,
    siteFailureThreshold: 2,
    siteFailureWindowMs: 60_000,
    siteBlockCooldownMs: 60_000,
    blockedStatuses: [401, 403, 407, 429],
    onEvent: (event) => events.push(event),
  });

  for (let count = 0; count < 4; count += 1) {
    const lease = await pool.acquire({ host: 'iwara.tv' });
    lease.release({ status: 403 });
  }
  const blockedEvents = events.filter((event) => event.state === 'site-blocked');
  assert.equal(blockedEvents.length, 2);
  assert.equal(blockedEvents[0].host, 'iwara.tv');
  for (const lane of pool.stats().lanes) {
    assert.equal(lane.siteBlocked.includes('iwara.tv'), true);
  }

  const degraded = await pool.acquire({ host: 'iwara.tv' });
  assert.ok(degraded.laneId);
  assert.ok(events.some((event) => event.state === 'site-degraded' && event.host === 'iwara.tv'));
  degraded.release({ status: 403 });

  const other = await pool.acquire({ host: 'x.com' });
  assert.ok(other.laneId);
  other.release({ status: 200 });
});

test('filters lanes by healthyScopes and applies host scope overrides', async () => {
  const pool = createEgressPool({
    lanes: [
      { id: 'lane-a', proxyName: 'node-a', proxyUrl: 'http://127.0.0.1:7901', dispatcher: dispatcher('a'), healthyScopes: ['public'] },
      { id: 'lane-b', proxyName: 'node-b', proxyUrl: 'http://127.0.0.1:7902', dispatcher: dispatcher('b'), healthyScopes: ['public', 'sticky'] },
    ],
    minConcurrencyPerLane: 1,
    maxConcurrencyPerLane: 1,
    scopeOverrides: { 'i.iwara.tv': 'sticky' },
  });

  const stickyLease = await pool.acquire({ host: 'www.iwara.tv', scope: 'sticky' });
  assert.equal(stickyLease.laneId, 'lane-b');
  stickyLease.release({ status: 200 });
  const overridden = await pool.acquire({ host: 'i.iwara.tv' });
  assert.equal(overridden.laneId, 'lane-b');
  overridden.release({ status: 200 });
  const publicLease = await pool.acquire({ host: 'e-hentai.org', scope: 'public' });
  assert.ok(['lane-a', 'lane-b'].includes(publicLease.laneId));
  publicLease.release({ status: 200 });
});

test('prefers the lower-latency lane when loads are tied', async () => {
  let clock = 0;
  const pool = createEgressPool({
    lanes: [
      { id: 'lane-a', proxyName: 'node-a', proxyUrl: 'http://127.0.0.1:7901', dispatcher: dispatcher('a') },
      { id: 'lane-b', proxyName: 'node-b', proxyUrl: 'http://127.0.0.1:7902', dispatcher: dispatcher('b') },
    ],
    minConcurrencyPerLane: 3,
    maxConcurrencyPerLane: 6,
    now: () => clock,
  });
  const seedA = await pool.acquire({ host: 'e-hentai.org' });
  clock += 100;
  seedA.release({ status: 200 });
  const seedB = await pool.acquire({ host: 'e-hentai.org' });
  clock += 400;
  seedB.release({ status: 200 });

  const first = await pool.acquire({ host: 'e-hentai.org' });
  const second = await pool.acquire({ host: 'e-hentai.org' });
  assert.equal(first.laneId, 'lane-a');
  assert.equal(second.laneId, 'lane-b');
  first.release({ status: 200 });
  second.release({ status: 200 });
});

test('exposes per-lane latency samples in stats', async () => {
  let clock = 0;
  const pool = createEgressPool({
    lanes: [{ id: 'lane-a', proxyName: 'node-a', proxyUrl: 'http://127.0.0.1:7901', dispatcher: dispatcher('a') }],
    now: () => clock,
  });
  const lease = await pool.acquire({ host: 'e-hentai.org' });
  clock += 250;
  lease.release({ status: 200 });
  const lane = pool.stats().lanes[0];
  assert.equal(lane.samples, 1);
  assert.equal(lane.ewmaMs, 250);
});

test('keeps latency state across lane refreshes', async () => {
  let clock = 0;
  const pool = createEgressPool({
    lanes: [{ id: 'lane-a', proxyName: 'node-a', proxyUrl: 'http://127.0.0.1:7901', dispatcher: dispatcher('a') }],
    now: () => clock,
  });
  const lease = await pool.acquire({ host: 'e-hentai.org' });
  clock += 150;
  lease.release({ status: 200 });
  pool.setLanes([{ id: 'lane-a', proxyName: 'node-a', proxyUrl: 'http://127.0.0.1:7901', dispatcher: dispatcher('a') }]);
  const lane = pool.stats().lanes[0];
  assert.equal(lane.samples, 1);
  assert.equal(lane.ewmaMs, 150);
});

test('clamps extreme durations when scoring lane latency', async () => {
  let clock = 0;
  const pool = createEgressPool({
    lanes: [{ id: 'lane-a', proxyName: 'node-a', proxyUrl: 'http://127.0.0.1:7901', dispatcher: dispatcher('a') }],
    now: () => clock,
  });
  const lease = await pool.acquire({ host: 'e-hentai.org' });
  clock += 30_000;
  lease.release({ status: 200 });
  assert.equal(pool.stats().lanes[0].ewmaMs, 10_000);
});

test('smooths latency samples with an exponential moving average', async () => {
  let clock = 0;
  const pool = createEgressPool({
    lanes: [{ id: 'lane-a', proxyName: 'node-a', proxyUrl: 'http://127.0.0.1:7901', dispatcher: dispatcher('a') }],
    now: () => clock,
  });
  for (let index = 0; index < 3; index += 1) {
    const lease = await pool.acquire({ host: 'e-hentai.org' });
    clock += 100;
    lease.release({ status: 200 });
  }
  assert.equal(pool.stats().lanes[0].ewmaMs, 100);
  const lease = await pool.acquire({ host: 'e-hentai.org' });
  clock += 400;
  lease.release({ status: 200 });
  assert.equal(pool.stats().lanes[0].ewmaMs, 160);
});

test('exports pool predicate functions and concurrency constants', async () => {
  const {
    isSuccess,
    isRetryable,
    poolError,
    DEFAULT_MIN_CONCURRENCY_PER_LANE,
    DEFAULT_MAX_CONCURRENCY_PER_LANE,
    DEFAULT_SUCCESS_RAMP_AFTER,
    DEFAULT_COOLDOWN_MS,
    DEFAULT_BACKGROUND_RESERVE_PER_LANE,
  } = await import('../src/egress-pool.js');

  assert.equal(isSuccess(200), true);
  assert.equal(isSuccess(204), true);
  assert.equal(isSuccess(404), false);
  assert.equal(isSuccess(null), false);

  assert.equal(isRetryable(429), true);
  assert.equal(isRetryable(502), true);
  assert.equal(isRetryable(404), false);

  const err = poolError('pool exhausted', 'EGRESS_POOL_EXHAUSTED');
  assert.equal(err.message, 'pool exhausted');
  assert.equal(err.code, 'EGRESS_POOL_EXHAUSTED');

  assert.equal(DEFAULT_MIN_CONCURRENCY_PER_LANE, 3);
  assert.equal(DEFAULT_MAX_CONCURRENCY_PER_LANE, 6);
  assert.equal(DEFAULT_SUCCESS_RAMP_AFTER, 6);
  assert.equal(DEFAULT_COOLDOWN_MS, 500);
  assert.equal(DEFAULT_BACKGROUND_RESERVE_PER_LANE, 1);
});
