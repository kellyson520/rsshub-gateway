import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createResponseCache } from '../src/cache.js';

async function withCache(options, callback) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rsshub-gateway-cache-'));
  try {
    return await callback(createResponseCache({ root, ...options }), root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('returns a fresh cached response without calling the loader twice', async () => {
  let loads = 0;
  await withCache({ now: () => 1_000, maxBytes: 1024 }, async (cache) => {
    const loader = async () => {
      loads += 1;
      return { status: 200, headers: { 'content-type': 'text/html' }, body: 'gallery' };
    };
    assert.equal((await cache.getOrLoad('https://e-hentai.org/g/1/a/', 'html', loader)).state, 'MISS');
    assert.equal((await cache.getOrLoad('https://e-hentai.org/g/1/a/', 'html', loader)).state, 'HIT');
    assert.equal(loads, 1);
  });
});

test('serves an expired document only when refresh fails', async () => {
  let now = 1_000;
  await withCache({ now: () => now, ttlSeconds: { html: 10 } }, async (cache) => {
    const good = async () => ({ status: 200, headers: { 'content-type': 'text/html' }, body: 'old' });
    await cache.getOrLoad('https://e-hentai.org/g/1/a/', 'html', good);
    now = 12_000;
    const stale = await cache.getOrLoad('https://e-hentai.org/g/1/a/', 'html', async () => {
      throw new Error('offline');
    });
    assert.equal(stale.state, 'STALE');
    assert.equal(stale.body, 'old');
  });
});

test('serves stale content when refresh returns a retryable HTTP failure', async () => {
  let now = 1_000;
  await withCache({ now: () => now, ttlSeconds: { html: 10 } }, async (cache) => {
    await cache.getOrLoad('https://e-hentai.org/g/1/a/', 'html', async () => ({ status: 200, headers: {}, body: 'old' }));
    now = 12_000;
    const stale = await cache.getOrLoad('https://e-hentai.org/g/1/a/', 'html', async () => ({
      status: 503,
      headers: {},
      body: 'upstream unavailable',
      refreshFailed: true,
    }));
    assert.equal(stale.state, 'STALE');
    assert.equal(stale.body, 'old');
  });
});

test('does not serve stale E-Hentai image documents after a refresh failure', async () => {
  let now = 1_000;
  await withCache({ now: () => now, ttlSeconds: { 'eh-image': 10 } }, async (cache) => {
    const url = 'https://e-hentai.org/s/one/123-1';
    await cache.getOrLoad(url, 'eh-image', async () => ({ status: 200, headers: {}, body: 'old image page' }));
    now = 12_000;
    const refreshed = await cache.getOrLoad(url, 'eh-image', async () => ({
      status: 503,
      headers: {},
      body: 'upstream unavailable',
      refreshFailed: true,
    }), { allowStale: false });
    assert.equal(refreshed.state, 'MISS');
    assert.equal(refreshed.status, 503);
    assert.equal(refreshed.body, 'upstream unavailable');
  });
});

test('coalesces concurrent loads for one cache key', async () => {
  let loads = 0;
  await withCache({}, async (cache) => {
    const loader = async () => {
      loads += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { status: 200, headers: {}, body: 'ok' };
    };
    const results = await Promise.all([
      cache.getOrLoad('https://e-hentai.org/g/1/a/', 'html', loader),
      cache.getOrLoad('https://e-hentai.org/g/1/a/', 'html', loader),
    ]);
    assert.equal(loads, 1);
    assert.equal(results[1].body, 'ok');
  });
});

test('does not retain successful responses marked non-cacheable', async () => {
  let loads = 0;
  await withCache({}, async (cache) => {
    const loader = async () => {
      loads += 1;
      return { status: 200, headers: { 'content-type': 'application/json' }, body: '{}', cacheable: false };
    };
    assert.equal((await cache.getOrLoad('https://e-hentai.org/g/1/a/', 'html', loader)).state, 'MISS');
    assert.equal((await cache.getOrLoad('https://e-hentai.org/g/1/a/', 'html', loader)).state, 'MISS');
    assert.equal(loads, 2);
  });
});

test('evicts least-recently-used entries over the byte budget', async () => {
  let now = 1_000;
  await withCache({ now: () => now, maxBytes: 6 }, async (cache) => {
    await cache.getOrLoad('https://e-hentai.org/g/1/a/', 'html', async () => ({ status: 200, headers: {}, body: '1111' }));
    now += 1;
    await cache.getOrLoad('https://e-hentai.org/g/1/b/', 'html', async () => ({ status: 200, headers: {}, body: '2222' }));
    assert.equal((await cache.peek('https://e-hentai.org/g/1/a/', 'html')).hit, false);
    assert.equal((await cache.peek('https://e-hentai.org/g/1/b/', 'html')).hit, true);
  });
});

test('ignores a corrupt index and reloads the document', async () => {
  let loads = 0;
  await withCache({}, async (cache, root) => {
    const loader = async () => {
      loads += 1;
      return { status: 200, headers: {}, body: 'ok' };
    };
    await cache.getOrLoad('https://e-hentai.org/g/1/a/', 'html', loader);
    await writeFile(path.join(root, 'index.json'), '{broken', 'utf8');
    const reloaded = createResponseCache({ root });
    const result = await reloaded.getOrLoad('https://e-hentai.org/g/1/a/', 'html', loader);
    assert.equal(result.state, 'MISS');
    assert.equal(loads, 2);
  });
});

test('isolates public and session cache namespaces for one upstream URL', async () => {
  await withCache({}, async (cache) => {
    const url = 'https://x.com/example/status/1';
    const publicNamespace = 'public';
    const sessionNamespace = 'session:abcdef123456';
    assert.notEqual(cache.keyFor(url, 'html', publicNamespace), cache.keyFor(url, 'html', sessionNamespace));

    await cache.getOrLoad(url, 'html', async () => ({ status: 200, headers: {}, body: 'public-body' }), { namespace: publicNamespace });
    await cache.getOrLoad(url, 'html', async () => ({ status: 200, headers: {}, body: 'session-body' }), { namespace: sessionNamespace });

    const publicHit = await cache.getOrLoad(url, 'html', async () => ({ status: 500, headers: {}, body: 'wrong-public-body' }), { namespace: publicNamespace });
    const sessionHit = await cache.getOrLoad(url, 'html', async () => ({ status: 500, headers: {}, body: 'wrong-session-body' }), { namespace: sessionNamespace });
    assert.equal(publicHit.body, 'public-body');
    assert.equal(sessionHit.body, 'session-body');
    assert.equal((await cache.peek(url, 'html', { namespace: publicNamespace })).hit, true);
    assert.equal((await cache.peek(url, 'html', { namespace: sessionNamespace })).hit, true);
  });
});
