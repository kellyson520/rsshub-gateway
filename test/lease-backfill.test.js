import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { createResponseCache } from '../src/cache.js';
import { createLeaseStore } from '../src/download-lease.js';
import { createLeaseBackfillQueue } from '../src/lease-backfill.js';

function makeFakeTransport() {
  const filled = [];
  return {
    filled,
    fake: {
      fillVideoSlices: async (target, resolvedUrl, size, namespace, parsed, maxBytes, options = {}) => {
        filled.push({ target, resolvedUrl, size, namespace, parsed, maxBytes });
        for (let start = 0; start < size; start += 4 * 1024 * 1024) {
          if (options.shouldStop?.()) break;
        }
      },
      sliceKey: (target, start) => `${target}#slice=${start}`,
      rememberVideoSize: () => {},
      probeSize: async () => null,
    },
  };
}

function lease(store, overrides = {}) {
  return store.createLease({
    targetUrl: 'https://www.iwara.tv/video/abc',
    resolvedUrl: 'https://cdn.iwara.tv/video/abc.mp4',
    allowHosts: ['cdn.iwara.tv'],
    ...overrides,
  });
}

test('backfills video slices for a lease and records stats', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rsshub-gateway-backfill-'));
  try {
    const cache = createResponseCache({ root, maxBytes: 1024 * 1024 * 1024 });
    const store = createLeaseStore();
    const transport = makeFakeTransport();
    const queue = createLeaseBackfillQueue({
      mediaTransport: transport.fake,
      fetchExternal: async () => new Response('x'),
      resolveMediaUrl: async () => ({ url: 'https://cdn.iwara.tv/video/abc.mp4' }),
      leaseStore: store,
      cache,
      isVideoTarget: () => true,
      probeSize: async () => 10 * 1024 * 1024,
      maxConcurrency: 2,
    });
    await queue.enqueue(lease(store));
    const stats = queue.stats();
    assert.equal(stats.completed, 1);
    assert.equal(transport.filled.length, 1);
    assert.equal(transport.filled[0].target, 'https://www.iwara.tv/video/abc');
    assert.equal(transport.filled[0].resolvedUrl, 'https://cdn.iwara.tv/video/abc.mp4');
    assert.equal(stats.bytesFilled, 10 * 1024 * 1024);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('deduplicates concurrent backfills for the same target', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rsshub-gateway-backfill-dedup-'));
  try {
    const cache = createResponseCache({ root, maxBytes: 1024 * 1024 * 1024 });
    const store = createLeaseStore();
    const transport = makeFakeTransport();
    let releases = 0;
    let gate;
    const gatePromise = new Promise((resolve) => { gate = resolve; });
    const queue = createLeaseBackfillQueue({
      mediaTransport: {
        ...transport.fake,
        fillVideoSlices: async () => {
          releases += 1;
          await gatePromise;
        },
      },
      fetchExternal: async () => new Response('x'),
      resolveMediaUrl: async () => ({ url: 'https://cdn.iwara.tv/video/abc.mp4' }),
      leaseStore: store,
      cache,
      isVideoTarget: () => true,
      probeSize: async () => 10 * 1024 * 1024,
      maxConcurrency: 2,
    });
    const first = queue.enqueue(lease(store));
    const second = queue.enqueue(lease(store));
    await new Promise((resolve) => setTimeout(resolve, 20));
    gate();
    await first;
    await second;
    assert.equal(releases, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('cancels on lease revoke and stops filling', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rsshub-gateway-backfill-cancel-'));
  try {
    const cache = createResponseCache({ root, maxBytes: 1024 * 1024 * 1024 });
    const store = createLeaseStore();
    const transport = makeFakeTransport();
    const queue = createLeaseBackfillQueue({
      mediaTransport: transport.fake,
      fetchExternal: async () => new Response('x'),
      resolveMediaUrl: async () => ({ url: 'https://cdn.iwara.tv/video/abc.mp4' }),
      leaseStore: store,
      cache,
      isVideoTarget: () => true,
      probeSize: async () => 10 * 1024 * 1024,
      maxConcurrency: 2,
    });
    const l = lease(store);
    const task = queue.enqueue(l);
    queue.cancel(l.username);
    await task;
    assert.ok(queue.stats().completed + queue.stats().failed >= 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('skips non-video targets and unknown sizes', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rsshub-gateway-backfill-skip-'));
  try {
    const cache = createResponseCache({ root, maxBytes: 1024 * 1024 * 1024 });
    const store = createLeaseStore();
    const transport = makeFakeTransport();
    const queue = createLeaseBackfillQueue({
      mediaTransport: transport.fake,
      fetchExternal: async () => new Response('x'),
      resolveMediaUrl: async () => ({ url: 'https://cdn.iwara.tv/video/abc.mp4' }),
      leaseStore: store,
      cache,
      isVideoTarget: () => false,
      probeSize: async () => null,
      maxConcurrency: 2,
    });
    await queue.enqueue(lease(store));
    assert.equal(transport.filled.length, 0);
    assert.equal(queue.stats().skipped, 1);
    const queue2 = createLeaseBackfillQueue({
      mediaTransport: transport.fake,
      fetchExternal: async () => new Response('x'),
      resolveMediaUrl: async () => ({ url: 'https://cdn.iwara.tv/video/abc.mp4' }),
      leaseStore: store,
      cache,
      isVideoTarget: () => true,
      probeSize: async () => null,
      maxConcurrency: 2,
    });
    await queue2.enqueue(lease(store));
    assert.equal(queue2.stats().skipped, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('backfills from a full cache within the eviction budget and skips larger videos', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rsshub-gateway-backfill-cap-'));
  try {
    const cache = createResponseCache({ root, maxBytes: 2 * 1024 * 1024 });
    const store = createLeaseStore();
    const transport = makeFakeTransport();
    const queue = createLeaseBackfillQueue({
      mediaTransport: transport.fake,
      fetchExternal: async () => new Response('x'),
      resolveMediaUrl: async () => ({ url: 'https://cdn.iwara.tv/video/abc.mp4' }),
      leaseStore: store,
      cache,
      isVideoTarget: () => true,
      probeSize: async () => 20 * 1024 * 1024,
      maxConcurrency: 2,
      evictionBudget: 4 * 1024 * 1024,
    });
    await queue.enqueue(lease(store));
    assert.equal(transport.filled.length, 0);
    assert.equal(queue.stats().skipped, 1);
    const queue2 = createLeaseBackfillQueue({
      mediaTransport: transport.fake,
      fetchExternal: async () => new Response('x'),
      resolveMediaUrl: async () => ({ url: 'https://cdn.iwara.tv/video/abc.mp4' }),
      leaseStore: store,
      cache,
      isVideoTarget: () => true,
      probeSize: async () => 1 * 1024 * 1024,
      maxConcurrency: 2,
      evictionBudget: 4 * 1024 * 1024,
    });
    await queue2.enqueue(lease(store));
    assert.equal(transport.filled.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('enqueue handles null, non-object or non-video leases gracefully', async () => {
  const store = createLeaseStore();
  const transport = makeFakeTransport();
  const queue = createLeaseBackfillQueue({
    mediaTransport: transport.fake,
    leaseStore: store,
    isVideoTarget: () => false,
  });

  await queue.enqueue(null);
  await queue.enqueue('invalid');
  await queue.enqueue({ targetUrl: 'https://example.com/not-video' });

  assert.equal(queue.stats().completed, 0);
  assert.equal(queue.stats().skipped, 3);
});
