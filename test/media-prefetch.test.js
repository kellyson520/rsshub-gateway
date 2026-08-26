import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createMediaPrefetchQueue } from '../src/media-prefetch.js';

async function tempQueueFile() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rsshub-prefetch-'));
  return { root, queueFile: path.join(root, 'queue.json') };
}

async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

test('ramps successful prefetches up to twelve workers without exceeding the maximum', async () => {
  const { root, queueFile } = await tempQueueFile();
  try {
    let active = 0;
    let maxActive = 0;
    let completed = 0;
    const queue = createMediaPrefetchQueue({
      queueFile,
      initialConcurrency: 6,
      minConcurrency: 3,
      maxConcurrency: 12,
      perOriginConcurrency: 4,
      successRampAfter: 2,
      persist: false,
      sleep: async () => {},
      fetchMedia: async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await flush();
        active -= 1;
        completed += 1;
        return { status: 200, cacheState: 'MISS' };
      },
    });

    queue.enqueue(Array.from({ length: 24 }, (_, index) => `https://node${index}.hath.network/h/${index}.webp`));
    await queue.idle();
    assert.equal(completed, 24);
    assert.equal(maxActive, 12);
    assert.equal(queue.stats().concurrency, 12);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('backs off and retries a throttled origin while other origins continue', async () => {
  const { root, queueFile } = await tempQueueFile();
  try {
    const attempts = new Map();
    const completed = [];
    const queue = createMediaPrefetchQueue({
      queueFile,
      initialConcurrency: 2,
      minConcurrency: 1,
      maxConcurrency: 4,
      perOriginConcurrency: 1,
      maxRetries: 1,
      sleep: async () => {},
      fetchMedia: async (target) => {
        const count = (attempts.get(target) || 0) + 1;
        attempts.set(target, count);
        if (target.includes('slow.hath.network') && count === 1) return { status: 429, cacheState: 'MISS' };
        completed.push(target);
        return { status: 200, cacheState: 'MISS' };
      },
    });

    const slow = 'https://slow.hath.network/h/a.webp';
    const fast = 'https://fast.hath.network/h/b.webp';
    queue.enqueue([slow, fast]);
    await queue.idle();
    assert.equal(attempts.get(slow), 2);
    assert.deepEqual(completed.sort(), [fast, slow].sort());
    assert.equal(queue.stats().concurrency, 1);
    assert.equal(queue.stats().failures, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('never exceeds two workers for a single H@H origin', async () => {
  const { root, queueFile } = await tempQueueFile();
  try {
    let active = 0;
    let maxActive = 0;
    const queue = createMediaPrefetchQueue({
      queueFile,
      initialConcurrency: 12,
      minConcurrency: 3,
      maxConcurrency: 12,
      perOriginConcurrency: 2,
      persist: false,
      sleep: async () => {},
      fetchMedia: async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await flush();
        active -= 1;
        return { status: 200, cacheState: 'MISS' };
      },
    });

    queue.enqueue(Array.from({ length: 12 }, (_, index) => `https://same.hath.network/h/${index}.webp`));
    await queue.idle();
    assert.equal(maxActive, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('raises effective prefetch capacity to the healthy egress pool floor', async () => {
  const { root, queueFile } = await tempQueueFile();
  try {
    let active = 0;
    let maxActive = 0;
    const queue = createMediaPrefetchQueue({
      queueFile,
      initialConcurrency: 1,
      minConcurrency: 1,
      maxConcurrency: 8,
      perOriginConcurrency: 8,
      minimumConcurrencyProvider: () => 6,
      capacityProvider: () => 6,
      persist: false,
      fetchMedia: async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await flush();
        active -= 1;
        return { status: 200, cacheState: 'MISS' };
      },
    });

    queue.enqueue(Array.from({ length: 6 }, (_, index) => `https://pool${index}.hath.network/h/${index}.webp`));
    await queue.idle();
    assert.equal(maxActive, 6);
    assert.equal(queue.stats().concurrency, 6);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('deduplicates queued targets and resumes persisted work', async () => {
  const { root, queueFile } = await tempQueueFile();
  const target = 'https://node.hath.network/h/a.webp';
  try {
    let calls = 0;
    const first = createMediaPrefetchQueue({
      queueFile,
      fetchMedia: async () => {
        calls += 1;
        return { status: 200, cacheState: 'MISS' };
      },
      sleep: async () => {},
    });
    first.enqueue([target, target]);
    await first.idle();
    assert.equal(calls, 1);

    await writeFile(queueFile, JSON.stringify({
      version: 1,
      items: [{ target, enqueuedAt: Date.now(), attempts: 0 }],
    }));
    const second = createMediaPrefetchQueue({
      queueFile,
      fetchMedia: async () => {
        calls += 1;
        return { status: 200, cacheState: 'MISS' };
      },
      sleep: async () => {},
    });
    await second.idle();
    assert.equal(calls, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('expires abandoned persisted targets after the queue TTL', async () => {
  const { root, queueFile } = await tempQueueFile();
  try {
    await writeFile(queueFile, JSON.stringify({
      version: 1,
      items: [{ target: 'https://node.hath.network/h/a.webp', enqueuedAt: 0, attempts: 0 }],
    }));
    const queue = createMediaPrefetchQueue({
      queueFile,
      now: () => 2 * 24 * 60 * 60 * 1000,
      queueTtlMs: 24 * 60 * 60 * 1000,
      fetchMedia: async () => {
        throw new Error('expired target must not run');
      },
      sleep: async () => {},
    });
    await queue.ready();
    assert.equal(queue.stats().queued, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('ignores disallowed and invalid URLs gracefully in enqueue', async () => {
  const { root, queueFile } = await tempQueueFile();
  try {
    let executed = 0;
    const queue = createMediaPrefetchQueue({
      queueFile,
      persist: false,
      fetchMedia: async () => {
        executed += 1;
        return { status: 200, cacheState: 'MISS' };
      },
    });

    queue.enqueue(['not-a-valid-url', 'http://127.0.0.1/private.jpg', 'https://disallowed.example.invalid/demo.jpg']);
    await queue.idle();
    assert.equal(executed, 0);
    assert.equal(queue.stats().queued, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('survives exceptions thrown inside onEvent callbacks', async () => {
  const { root, queueFile } = await tempQueueFile();
  try {
    const queue = createMediaPrefetchQueue({
      queueFile,
      persist: false,
      onEvent: () => {
        throw new Error('diagnostic listener exploded');
      },
      fetchMedia: async () => ({ status: 200, cacheState: 'MISS' }),
      sleep: async () => {},
    });

    queue.enqueue(['https://node.hath.network/h/safe.webp']);
    await queue.idle();
    assert.equal(queue.stats().completed, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('enqueue handles empty, null or undefined input gracefully', async () => {
  const { root, queueFile } = await tempQueueFile();
  try {
    const queue = createMediaPrefetchQueue({ queueFile, persist: false });
    queue.enqueue([]);
    queue.enqueue(null);
    queue.enqueue(undefined);
    queue.enqueue('');
    assert.equal(queue.stats().queued, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('exports helper functions and constants for media prefetch scheduling', async () => {
  const {
    originFor,
    retryableStatus,
    successfulStatus,
    boundedInteger,
    safeEvent,
    DEFAULT_CACHE_ROOT,
    DEFAULT_INITIAL_CONCURRENCY,
    DEFAULT_MIN_CONCURRENCY,
    DEFAULT_MAX_CONCURRENCY,
    DEFAULT_PER_ORIGIN_CONCURRENCY,
    DEFAULT_MAX_RETRIES,
    DEFAULT_SUCCESS_RAMP_AFTER,
    DEFAULT_QUEUE_TTL_MS,
    MAX_QUEUE_ITEMS,
    MAX_PER_ORIGIN_CONCURRENCY,
    RETRYABLE_STATUSES,
  } = await import('../src/media-prefetch.js');

  assert.equal(originFor('https://page.example.hath.network/h/1.jpg'), 'page.example.hath.network');
  assert.equal(originFor('http://127.0.0.1:8080/invalid'), '');
  assert.equal(originFor('not-a-url'), '');

  assert.equal(retryableStatus(429), true);
  assert.equal(retryableStatus(503), true);
  assert.equal(retryableStatus(200), false);

  assert.equal(successfulStatus(200), true);
  assert.equal(successfulStatus(206), true);
  assert.equal(successfulStatus(500), false);

  assert.equal(DEFAULT_INITIAL_CONCURRENCY, 6);
  assert.equal(DEFAULT_MIN_CONCURRENCY, 3);
  assert.equal(DEFAULT_MAX_CONCURRENCY, 12);
  assert.equal(DEFAULT_PER_ORIGIN_CONCURRENCY, 2);
  assert.equal(DEFAULT_MAX_RETRIES, 2);
  assert.equal(DEFAULT_SUCCESS_RAMP_AFTER, 6);
  assert.equal(DEFAULT_QUEUE_TTL_MS, 24 * 60 * 60 * 1000);
  assert.equal(MAX_QUEUE_ITEMS, 2000);
  assert.equal(MAX_PER_ORIGIN_CONCURRENCY, 48);
  assert.ok(RETRYABLE_STATUSES.has(429));
  assert.ok(DEFAULT_CACHE_ROOT.length > 0);

  assert.equal(boundedInteger('10', 5, 1, 20), 10);
  assert.equal(boundedInteger('invalid', 5, 1, 20), 5);

  let captured = null;
  safeEvent((e) => { captured = e; }, { type: 'test' });
  assert.deepEqual(captured, { type: 'test' });
  assert.doesNotThrow(() => safeEvent(() => { throw new Error('err'); }, {}));
});
