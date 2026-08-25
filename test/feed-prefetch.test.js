import test from 'node:test';
import assert from 'node:assert/strict';
import { createFeedPrefetchQueue } from '../src/feed-prefetch.js';

const FEED_XML = `<?xml version="1.0"?><rss version="2.0"><channel><title>Feed</title>
<item><title>A</title><enclosure url="https://cdn.example.com/a.mp4" type="video/mp4"/></item>
<item><title>B</title><media:content url="https://cdn.example.com/b.jpg" type="image/jpeg"/></item>
<item><title>C</title><media:thumbnail url="https://cdn.example.com/c.jpg"/></item>
</channel></rss>`;

function okResponse(xml = FEED_XML) {
  return { ok: true, status: 200, text: async () => xml };
}

async function waitFor(fn, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('waitFor timeout');
}

test('feed prefetch queue fetches configured paths on runCycle', async () => {
  const fetched = [];
  const queue = createFeedPrefetchQueue({
    paths: ['/iwara/users/tsyj/video', '/ehviewer/ranking'],
    intervalMs: 60_000,
    concurrency: 2,
    fetchFeed: async (path) => {
      fetched.push(path);
      return okResponse();
    },
  });
  queue.start();
  queue.runCycle();
  await waitFor(() => fetched.length === 2);
  const stats = queue.stats();
  assert.equal(stats.completed, 2);
  assert.equal(stats.failed, 0);
  assert.equal(fetched[0], '/iwara/users/tsyj/video');
  assert.equal(fetched[1], '/ehviewer/ranking');
  assert.ok(stats.paths['/iwara/users/tsyj/video'].completed === 1);
  queue.stop();
});

test('feed prefetch queue deduplicates in-flight and queued paths', async () => {
  const fetched = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const queue = createFeedPrefetchQueue({
    paths: [],
    concurrency: 1,
    fetchFeed: async (path) => {
      fetched.push(path);
      await gate;
      return okResponse();
    },
  });
  queue.start();
  assert.equal(queue.enqueue('/feed/a').queued, 1);
  assert.equal(queue.enqueue('/feed/a').queued, 0);
  assert.equal(queue.enqueue('/feed/a').skipped, 1);
  await waitFor(() => fetched.length === 1);
  assert.equal(queue.stats().inFlight, 1);
  release();
  await waitFor(() => queue.stats().inFlight === 0);
  queue.stop();
});

test('feed prefetch queue respects the per-path interval on runCycle', async () => {
  const fetched = [];
  const queue = createFeedPrefetchQueue({
    paths: ['/feed/hot'],
    intervalMs: 1000,
    fetchFeed: async (path) => {
      fetched.push(path);
      return okResponse();
    },
  });
  queue.start();
  queue.runCycle();
  await waitFor(() => fetched.length === 1);
  queue.runCycle();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(fetched.length, 1, 'second runCycle within interval must be skipped');
  await new Promise((resolve) => setTimeout(resolve, 1100));
  queue.runCycle();
  await waitFor(() => fetched.length === 2, 2000);
  queue.stop();
});

test('feed prefetch queue limits concurrency', async () => {
  let active = 0;
  let maxActive = 0;
  const queue = createFeedPrefetchQueue({
    paths: [],
    concurrency: 2,
    fetchFeed: async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 30));
      active -= 1;
      return okResponse();
    },
  });
  queue.start();
  queue.enqueue('/feed/1');
  queue.enqueue('/feed/2');
  queue.enqueue('/feed/3');
  queue.enqueue('/feed/4');
  await waitFor(() => queue.stats().inFlight === 0 && queue.stats().completed === 4);
  assert.equal(maxActive, 2, 'never exceeds concurrency limit');
  queue.stop();
});

test('feed prefetch queue retries failures and reports failed after maxRetries', async () => {
  let attempts = 0;
  const queue = createFeedPrefetchQueue({
    paths: ['/feed/flaky'],
    concurrency: 1,
    maxRetries: 2,
    retryBackoffMs: 10,
    fetchFeed: async () => {
      attempts += 1;
      return { ok: false, status: 502 };
    },
  });
  queue.start();
  queue.runCycle();
  await waitFor(() => queue.stats().failed === 1);
  assert.equal(attempts, 3, 'initial attempt + 2 retries');
  assert.equal(queue.stats().completed, 0);
  queue.stop();
});

test('feed prefetch queue retries after a transient failure and succeeds', async () => {
  let attempts = 0;
  const queue = createFeedPrefetchQueue({
    paths: ['/feed/recover'],
    concurrency: 1,
    maxRetries: 3,
    retryBackoffMs: 5,
    fetchFeed: async () => {
      attempts += 1;
      return attempts < 2 ? { ok: false, status: 503 } : okResponse();
    },
  });
  queue.start();
  queue.runCycle();
  await waitFor(() => queue.stats().completed === 1);
  assert.equal(attempts, 2);
  queue.stop();
});

test('feed prefetch queue reports stats including per-path state', async () => {
  const queue = createFeedPrefetchQueue({
    paths: ['/feed/a'],
    intervalMs: 60_000,
    fetchFeed: async () => okResponse(),
  });
  queue.start();
  queue.runCycle();
  await waitFor(() => queue.stats().completed === 1);
  const stats = queue.stats();
  assert.equal(typeof stats.queueLength, 'number');
  assert.equal(typeof stats.inFlight, 'number');
  assert.ok(stats.lastRunAt > 0);
  const pathStats = stats.paths['/feed/a'];
  assert.equal(pathStats.completed, 1);
  assert.equal(pathStats.lastStatus, 200);
  assert.ok(pathStats.lastDurationMs >= 0);
  queue.stop();
});

test('feed prefetch queue exposes idle() that resolves when drained', async () => {
  const queue = createFeedPrefetchQueue({
    paths: [],
    concurrency: 2,
    fetchFeed: async () => okResponse(),
  });
  queue.start();
  queue.enqueue('/feed/1');
  queue.enqueue('/feed/2');
  await queue.idle();
  assert.equal(queue.stats().completed, 2);
  assert.equal(queue.stats().queueLength, 0);
  queue.stop();
});

test('enqueue handles empty, null or undefined path inputs cleanly', () => {
  const queue = createFeedPrefetchQueue();
  assert.deepEqual(queue.enqueue(''), { queued: 0, skipped: 1 });
  assert.deepEqual(queue.enqueue(null), { queued: 0, skipped: 1 });
  assert.deepEqual(queue.enqueue(undefined), { queued: 0, skipped: 1 });
});
