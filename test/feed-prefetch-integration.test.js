import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { createGatewayServer } from '../src/server.js';
import { createResponseCache } from '../src/cache.js';

const UPSTREAM_FEED = `<?xml version="1.0"?><rss version="2.0"><channel><title>Upstream</title>
<item><title>Entry</title><link>https://www.iwara.tv/video/abc</link>
<enclosure url="https://i.iwara.tv/image/thumbnail/t1/thumbnail-00.jpg" type="image/jpeg"/></item>
</channel></rss>`;

async function waitFor(fn, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('waitFor timeout');
}

test('feed prefetch warms the RSS cache through the real pipeline', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rsshub-gateway-prefetch-int-'));
  let upstreamCalls = 0;
  const server = createGatewayServer({
    secret: 'secret',
    cache: createResponseCache({ root: path.join(root, 'cache') }),
    feedPrefetchPaths: ['/custom/feed'],
    feedPrefetchIntervalMs: 60_000,
    feedPrefetchConcurrency: 2,
    fetchRssHub: async () => {
      upstreamCalls += 1;
      return new Response(UPSTREAM_FEED, { status: 200, headers: { 'content-type': 'application/rss+xml' } });
    },
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    await waitFor(() => server.feedPrefetchQueue?.stats().completed === 1);
    assert.ok(upstreamCalls >= 1, 'prefetch must hit upstream');

    const served = await fetch(`http://127.0.0.1:${port}/custom/feed`);
    const body = await served.text();
    assert.equal(served.status, 200);
    assert.match(body, /<title>Upstream<\/title>/);
    assert.equal(upstreamCalls, 1, 'client request must hit the prefetched cache');
  } finally {
    server.feedPrefetchQueue?.stop();
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});

test('prefetch endpoint is disabled without a registration token', async () => {
  const server = createGatewayServer({ secret: 'secret', cache: false, feedPrefetchPaths: ['/custom/feed'] });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/_gateway/prefetch`);
  assert.equal(response.status, 404);
  server.feedPrefetchQueue?.stop();
  await new Promise((resolve) => server.close(resolve));
});

test('prefetch endpoint reports stats and accepts on-demand enqueue', async () => {
  let upstreamCalls = 0;
  const server = createGatewayServer({
    secret: 'secret',
    cache: false,
    dispatcherRegistrationToken: 'reg-token',
    feedPrefetchPaths: ['/custom/a'],
    feedPrefetchIntervalMs: 60_000,
    fetchRssHub: async () => {
      upstreamCalls += 1;
      return new Response(UPSTREAM_FEED, { status: 200, headers: { 'content-type': 'application/rss+xml' } });
    },
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    const listed = await fetch(`http://127.0.0.1:${port}/_gateway/prefetch`, {
      headers: { authorization: 'Bearer reg-token' },
    });
    assert.equal(listed.status, 200);
    const stats = await listed.json();
    assert.equal(stats.configured, 1);
    assert.ok(stats.paths['/custom/a']);

    await waitFor(() => server.feedPrefetchQueue?.stats().completed === 1);

    const denied = await fetch(`http://127.0.0.1:${port}/_gateway/prefetch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer wrong' },
      body: JSON.stringify({ path: '/custom/b' }),
    });
    assert.equal(denied.status, 401);

    const enqueued = await fetch(`http://127.0.0.1:${port}/_gateway/prefetch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer reg-token' },
      body: JSON.stringify({ path: '/custom/b' }),
    });
    assert.equal(enqueued.status, 200);
    assert.deepEqual(await enqueued.json(), { queued: 1, skipped: 0, queueLength: 1 });

    await waitFor(() => server.feedPrefetchQueue?.stats().completed === 2);
    assert.equal(upstreamCalls, 2);
  } finally {
    server.feedPrefetchQueue?.stop();
    await new Promise((resolve) => server.close(resolve));
  }
});
