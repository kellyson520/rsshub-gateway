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
