import test from 'node:test';
import assert from 'node:assert/strict';
import { CircuitBreaker } from '../src/circuit-breaker.js';
import { createUpstreamClient } from '../src/upstream.js';

test('retries a transport error and returns the next successful response', async () => {
  let attempts = 0;
  const client = createUpstreamClient({
    fetchImpl: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('connection reset');
      return new Response('ok', { status: 200 });
    },
    sleep: async () => {},
  });

  const response = await client.fetchExternal('https://t.me/s/baipiaotg');

  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'ok');
  assert.equal(attempts, 2);
});

test('does not retry a source authorization failure', async () => {
  let attempts = 0;
  const client = createUpstreamClient({
    fetchImpl: async () => {
      attempts += 1;
      return new Response('forbidden', { status: 403 });
    },
    sleep: async () => {},
  });

  const response = await client.fetchExternal('https://x.com/example/status/1');

  assert.equal(response.status, 403);
  assert.equal(attempts, 1);
});

test('retries a 503 and throws a typed error after the attempt limit', async () => {
  let attempts = 0;
  const client = createUpstreamClient({
    fetchImpl: async () => {
      attempts += 1;
      return new Response('unavailable', { status: 503 });
    },
    sleep: async () => {},
  });

  await assert.rejects(
    client.fetchExternal('https://t.me/s/baipiaotg'),
    (error) => error.code === 'UPSTREAM_RETRY_EXHAUSTED' && error.status === 502 && error.attempts === 3,
  );
  assert.equal(attempts, 3);
});

test('validates every manual redirect target', async () => {
  const client = createUpstreamClient({
    fetchImpl: async () => new Response('', { status: 302, headers: { location: 'https://example.com/private' } }),
    sleep: async () => {},
  });

  await assert.rejects(
    client.fetchExternal('https://t.me/s/baipiaotg'),
    (error) => error.code === 'UPSTREAM_REDIRECT_DISALLOWED' && /allowlist/i.test(error.message),
  );
});

test('maps an aborted request to a typed timeout error', async () => {
  let attempts = 0;
  const client = createUpstreamClient({
    totalTimeoutMs: 5,
    fetchImpl: async (_url, { signal }) => {
      attempts += 1;
      await new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
        signal.addEventListener('abort', resolve);
      });
    },
    sleep: async () => {},
  });

  await assert.rejects(
    client.fetchExternal('https://t.me/s/baipiaotg'),
    (error) => error.code === 'UPSTREAM_TIMEOUT' && error.status === 504,
  );
  assert.equal(attempts, 1);
});

test('opens a source circuit after retry exhaustion', async () => {
  let attempts = 0;
  const breaker = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 30_000, now: () => 0 });
  const client = createUpstreamClient({
    maxAttempts: 1,
    breaker,
    fetchImpl: async () => {
      attempts += 1;
      throw new Error('connection reset');
    },
    sleep: async () => {},
  });

  await assert.rejects(client.fetchExternal('https://t.me/s/baipiaotg'), (error) => error.code === 'UPSTREAM_RETRY_EXHAUSTED');
  await assert.rejects(client.fetchExternal('https://t.me/s/baipiaotg'), (error) => error.code === 'UPSTREAM_CIRCUIT_OPEN');
  assert.equal(attempts, 1);
});

test('does not open a host circuit for independent media requests', async () => {
  let attempts = 0;
  const breaker = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 30_000, now: () => 0 });
  const client = createUpstreamClient({
    maxAttempts: 1,
    breaker,
    fetchImpl: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('thumbnail connection reset');
      return new Response('image', { status: 200, headers: { 'content-type': 'image/webp' } });
    },
    sleep: async () => {},
  });

  await assert.rejects(
    client.fetchExternal('https://ehgt.org/w/01/002/thumbnail.webp', { circuit: false }),
    (error) => error.code === 'UPSTREAM_RETRY_EXHAUSTED',
  );
  const response = await client.fetchExternal('https://ehgt.org/w/01/003/thumbnail.webp', { circuit: false });

  assert.equal(response.status, 200);
  assert.equal(attempts, 2);
  assert.deepEqual(client.openCircuits(), []);
});

test('applies the same retry policy to the local RSSHub endpoint', async () => {
  let attempts = 0;
  const client = createUpstreamClient({
    fetchImpl: async () => {
      attempts += 1;
      if (attempts === 1) return new Response('busy', { status: 503 });
      return new Response('ok', { status: 200 });
    },
    sleep: async () => {},
  });

  const response = await client.fetchRssHub('/telegram/channel/baipiaotg');

  assert.equal(response.status, 200);
  assert.equal(attempts, 2);
});

test('does not open the RSSHub circuit for a route-level retryable response', async () => {
  const breaker = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 30_000, now: () => 0 });
  const client = createUpstreamClient({
    maxAttempts: 1,
    breaker,
    fetchImpl: async (url) => (url.pathname === '/healthz'
      ? new Response('ok', { status: 200 })
      : new Response('route unavailable', { status: 503 })),
    sleep: async () => {},
  });

  await assert.rejects(client.fetchRssHub('/instagram/2/user/instagram'), (error) => error.code === 'UPSTREAM_RETRY_EXHAUSTED');
  const health = await client.fetchRssHub('/healthz');

  assert.equal(health.status, 200);
  assert.deepEqual(client.openCircuits(), []);
});

test('reports the egress policy without exposing the target URL', async () => {
  const policies = [];
  const client = createUpstreamClient({
    fetchImpl: async () => new Response('ok', { status: 200 }),
    onRequestPolicy: (event) => policies.push(event),
  });

  await client.fetchExternal('https://e-hentai.org/s/abcdef/123/001-001');
  await client.fetchExternal('https://x.com/example/status/1');

  assert.deepEqual(policies, [
    { host: 'e-hentai.org', policy: 'public' },
    { host: 'x.com', policy: 'sticky' },
  ]);
});

test('leases public requests from the adaptive egress pool and releases after body consumption', async () => {
  const dispatchers = [{ name: 'lane-a' }, { name: 'lane-b' }];
  const leases = [];
  let nextLane = 0;
  const requests = [];
  const egressPool = {
    acquire: async () => {
      const dispatcher = dispatchers[nextLane % dispatchers.length];
      nextLane += 1;
      const lease = {
        dispatcher,
        laneId: dispatcher.name,
        release: (result) => leases.push({ laneId: dispatcher.name, result }),
      };
      return lease;
    },
  };
  const client = createUpstreamClient({
    egressPool,
    fetchImpl: async (_url, options) => {
      requests.push(options.dispatcher);
      return new Response('image-bytes', { status: 200, headers: { 'content-type': 'image/webp' } });
    },
  });

  const first = await client.fetchExternal('https://e-hentai.org/h/one.webp');
  assert.deepEqual(requests[0], dispatchers[0]);
  assert.equal(leases.length, 0);
  assert.equal(await first.text(), 'image-bytes');
  assert.deepEqual(leases, [{ laneId: 'lane-a', result: { status: 200 } }]);

  const second = await client.fetchExternal('https://e-hentai.org/h/two.webp');
  assert.deepEqual(requests[1], dispatchers[1]);
  await second.text();
  assert.equal(leases.length, 2);
});

test('releases a public egress lease after consuming a redirect response without a location', async () => {
  const leases = [];
  const client = createUpstreamClient({
    egressPool: {
      acquire: async () => ({
        dispatcher: { name: 'lane-a' },
        release: (result) => leases.push(result),
      }),
    },
    fetchImpl: async () => new Response('redirect body', { status: 302 }),
  });

  const response = await client.fetchExternal('https://e-hentai.org/g/123/abc/');

  assert.equal(response.status, 302);
  assert.equal(leases.length, 0);
  assert.equal(await response.text(), 'redirect body');
  assert.deepEqual(leases, [{ status: 302 }]);
});

test('passes the request priority into the shared egress pool', async () => {
  const priorities = [];
  const client = createUpstreamClient({
    egressPool: {
      acquire: async (context) => {
        priorities.push(context.priority);
        return { dispatcher: { name: 'lane-a' }, release: () => {} };
      },
    },
    fetchImpl: async () => new Response('ok', { status: 200 }),
  });

  const response = await client.fetchExternal('https://e-hentai.org/h/priority.webp', { priority: 'background' });
  await response.text();

  assert.deepEqual(priorities, ['background']);
});

test('passes a gallery shard hint into the shared egress pool', async () => {
  const galleryShards = [];
  const client = createUpstreamClient({
    egressPool: {
      acquire: async (context) => {
        galleryShards.push(context.galleryShard);
        return { dispatcher: { name: 'lane-a' }, release: () => {} };
      },
    },
    fetchImpl: async () => new Response('ok', { status: 200 }),
  });

  const response = await client.fetchExternal('https://e-hentai.org/s/shard/123-4', { galleryShard: 4 });
  await response.text();

  assert.deepEqual(galleryShards, [4]);
});

test('keeps sticky and RSSHub requests outside the public egress pool', async () => {
  let acquired = 0;
  const egressPool = { acquire: async () => { acquired += 1; throw new Error('must not acquire'); } };
  const client = createUpstreamClient({
    egressPool,
    fetchImpl: async () => new Response('ok', { status: 200 }),
  });

  const sticky = await client.fetchExternal('https://x.com/example/status/1');
  const rsshub = await client.fetchRssHub('/telegram/channel/baipiaotg');
  assert.equal(sticky.status, 200);
  assert.equal(rsshub.status, 200);
  assert.equal(acquired, 0);
});
