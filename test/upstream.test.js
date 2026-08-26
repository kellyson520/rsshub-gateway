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

test('uses the public pool for anonymous source requests without credentials', async () => {
  const publicDispatchers = [{ name: 'public-01' }, { name: 'public-02' }];
  const acquired = [];
  const requests = [];
  const client = createUpstreamClient({
    sourceConfig: {
      iwara: { cookie: 'iwara-session' },
      x: { authToken: 'x-auth', ct0: 'x-csrf' },
      instagram: { cookie: 'instagram-session' },
    },
    egressPool: {
      acquire: async () => {
        const dispatcher = publicDispatchers[acquired.length % publicDispatchers.length];
        acquired.push(dispatcher.name);
        return { dispatcher, release: () => {} };
      },
    },
    fetchImpl: async (_url, options) => {
      requests.push(options);
      return new Response('ok', { status: 200 });
    },
  });

  for (const target of [
    'https://iwara.tv/video/1',
    'https://x.com/example/status/1',
    'https://instagram.com/p/1',
    'https://t.me/s/channel',
  ]) {
    const response = await client.fetchExternal(target, {
      egressScope: 'public',
      headers: { Cookie: 'caller-cookie', Authorization: 'Bearer caller-token' },
    });
    await response.text();
  }

  assert.deepEqual(acquired, ['public-01', 'public-02', 'public-01', 'public-02']);
  assert.equal(requests.every(({ headers }) => !Object.keys(headers).some((name) => /^(cookie|authorization)$/i.test(name))), true);
});

test('uses only the stable session dispatcher and session credentials for session scope', async () => {
  let acquired = 0;
  const sessionDispatcher = { name: 'session-lane-x' };
  const requests = [];
  const client = createUpstreamClient({
    sourceConfig: { x: { authToken: 'wrong-public-token', ct0: 'wrong-public-csrf' } },
    egressPool: { acquire: async () => { acquired += 1; throw new Error('public pool must not be used'); } },
    fetchImpl: async (_url, options) => {
      requests.push(options);
      return new Response('ok', { status: 200 });
    },
  });

  const response = await client.fetchExternal('https://x.com/example/status/1', {
    egressScope: 'session',
    sessionDispatcher,
    sessionCredentials: { authToken: 'session-token', ct0: 'session-csrf' },
  });
  await response.text();

  assert.equal(acquired, 0);
  assert.equal(requests[0].dispatcher, sessionDispatcher);
  assert.match(requests[0].headers.cookie, /auth_token=session-token/);
  assert.match(requests[0].headers.cookie, /ct0=session-csrf/);
});

test('escalates one authentication challenge to the session dispatcher', async () => {
  const dispatchers = [];
  let attempts = 0;
  const sessionDispatcher = { name: 'session-lane-x' };
  const client = createUpstreamClient({
    egressPool: {
      acquire: async () => ({
        dispatcher: { name: 'public-lane' },
        release: () => {},
      }),
    },
    fetchImpl: async (_url, options) => {
      dispatchers.push({ dispatcher: options.dispatcher, headers: options.headers });
      attempts += 1;
      return attempts === 1 ? new Response('login', { status: 401 }) : new Response('ok', { status: 200 });
    },
    sleep: async () => {},
  });

  const response = await client.fetchExternal('https://x.com/example/status/1', {
    egressScope: 'public',
    allowSessionRetry: true,
    sessionDispatcher,
    sessionCredentials: { authToken: 'session-token', ct0: 'session-csrf' },
  });
  assert.equal(await response.text(), 'ok');
  assert.equal(dispatchers.length, 2);
  assert.equal(dispatchers[0].dispatcher.name, 'public-lane');
  assert.equal(dispatchers[1].dispatcher, sessionDispatcher);
  assert.equal(dispatchers[0].headers.cookie, undefined);
  assert.match(dispatchers[1].headers.cookie, /auth_token=session-token/);
});

test('keeps throttling responses on public retry lanes', async () => {
  const dispatchers = [];
  let attempts = 0;
  const sessionDispatcher = { name: 'session-lane-x' };
  const client = createUpstreamClient({
    egressPool: {
      acquire: async () => ({
        dispatcher: { name: `public-lane-${attempts + 1}` },
        release: () => {},
      }),
    },
    fetchImpl: async (_url, options) => {
      dispatchers.push(options.dispatcher);
      attempts += 1;
      return attempts === 1 ? new Response('busy', { status: 429 }) : new Response('ok', { status: 200 });
    },
    sleep: async () => {},
  });

  const response = await client.fetchExternal('https://x.com/example/status/1', {
    egressScope: 'public',
    allowSessionRetry: true,
    sessionDispatcher,
    sessionCredentials: { authToken: 'session-token' },
  });
  assert.equal(await response.text(), 'ok');
  assert.equal(dispatchers.length, 2);
  assert.equal(dispatchers.every((dispatcher) => dispatcher.name.startsWith('public-lane-')), true);
});

test('attaches correct Referer for hotlinking-protected adult CDNs', async () => {
  const recordedHeaders = [];
  const client = createUpstreamClient({
    fetchImpl: async (_url, options) => {
      recordedHeaders.push(options.headers);
      return new Response('image-data', { status: 200 });
    },
    sleep: async () => {},
  });

  await client.fetchExternal('https://www.javbus.com/pics/cover/abc.jpg');
  await client.fetchExternal('https://jdbstatic.com/covers/ab/abc.jpg');
  await client.fetchExternal('https://missav.ai/media/preview.jpg');

  assert.equal(recordedHeaders[0].referer, 'https://www.javbus.com/');
  assert.equal(recordedHeaders[1].referer, 'https://javdb.com/');
  assert.equal(recordedHeaders[2].referer, 'https://missav.ai/');
});

test('refererFor returns undefined for malformed URL or unconfigured hosts', async () => {
  const recordedHeaders = [];
  const client = createUpstreamClient({
    fetchImpl: async (_url, options) => {
      recordedHeaders.push(options.headers);
      return new Response('ok', { status: 200 });
    },
    sleep: async () => {},
  });

  await client.fetchExternal('https://e-hentai.org/g/1/2/');
  assert.equal(recordedHeaders[0].referer, undefined);
});

test('exports default upstream constants and authentication predicates', async () => {
  const {
    DEFAULT_PROXY,
    DEFAULT_TIMEOUT,
    DEFAULT_MAX_ATTEMPTS,
    MAX_REDIRECTS_PER_ATTEMPT,
    HOTLINK_REFERERS,
    withoutCredentials,
    isAuthenticationRedirect,
    refererFor,
  } = await import('../src/upstream.js');

  assert.equal(DEFAULT_PROXY, 'http://127.0.0.1:7890');
  assert.equal(DEFAULT_TIMEOUT, 30_000);
  assert.equal(DEFAULT_MAX_ATTEMPTS, 3);
  assert.equal(MAX_REDIRECTS_PER_ATTEMPT, 5);

  assert.equal(typeof HOTLINK_REFERERS, 'object');
  assert.equal(HOTLINK_REFERERS['javbus.com'], 'https://www.javbus.com/');

  assert.equal(refererFor('https://javbus.com/item/1'), 'https://www.javbus.com/');
  assert.equal(refererFor('invalid-url'), undefined);

  assert.deepEqual(
    withoutCredentials({ 'content-type': 'text/plain', cookie: 'secret=1', authorization: 'Bearer abc' }),
    { 'content-type': 'text/plain' },
  );

  assert.equal(isAuthenticationRedirect(new Response(null, { status: 302, headers: { location: '/login' } })), true);
  assert.equal(isAuthenticationRedirect(new Response(null, { status: 200, headers: { location: '/login' } })), false);

  const { isAuthenticationChallenge, sourceHeaders } = await import('../src/upstream.js');
  assert.equal(await isAuthenticationChallenge(new Response(null, { status: 401 }), 'https://x.com/item/1'), true);
  assert.equal(await isAuthenticationChallenge(new Response(null, { status: 200 }), 'https://x.com/item/1'), false);

  const headers = sourceHeaders('https://javbus.com/sample', {});
  assert.equal(headers['user-agent'], 'rsshub-gateway/0.1');
  assert.equal(headers.referer, 'https://www.javbus.com/');
});
