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

async function waitForCacheHit(cache, url, kind, timeout = 500) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if ((await cache.peek(url, kind)).hit) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`timed out waiting for ${kind} cache entry`);
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

test('tracks hit, miss and stale counters in stats', async () => {
  let now = 1_000;
  await withCache({ now: () => now, ttlSeconds: { html: 10 }, maxBytes: 1024 }, async (cache) => {
    const loader = async () => ({ status: 200, headers: { 'content-type': 'text/html' }, body: 'abc' });
    assert.equal((await cache.getOrLoad('https://e-hentai.org/g/1/a/', 'html', loader)).state, 'MISS');
    assert.equal((await cache.getOrLoad('https://e-hentai.org/g/1/a/', 'html', loader)).state, 'HIT');
    now = 12_000;
    assert.equal((await cache.getOrLoad('https://e-hentai.org/g/1/a/', 'html', async () => {
      throw new Error('offline');
    })).state, 'STALE');
    const stats = cache.stats();
    assert.equal(stats.counters.hits, 1);
    assert.equal(stats.counters.misses, 1);
    assert.equal(stats.counters.staleHits, 1);
    assert.equal(stats.entries, 1);
    assert.equal(stats.bytes, 3);
    assert.equal(stats.counters.bytesStored, 3);
    assert.ok(stats.byteLimit > 0);
  });
});

test('counts byte ranges served from cache', async () => {
  await withCache({ maxBytes: 4096 }, async (cache) => {
    await cache.getOrLoad('https://cdn.example/video.mp4', 'media', async () => ({
      status: 200,
      headers: { 'content-type': 'video/mp4', 'content-length': '10' },
      body: '0123456789',
    }));
    const ranged = await cache.readRange('https://cdn.example/video.mp4', 'media');
    assert.ok(ranged);
    const stream = ranged.createStream(2, 5);
    assert.ok(stream);
    await new Promise((resolve, reject) => {
      const chunks = [];
      stream.on('data', (chunk) => chunks.push(chunk));
      stream.on('end', () => resolve(Buffer.concat(chunks)));
      stream.on('error', reject);
    });
    const stats = cache.stats();
    assert.equal(stats.counters.rangeReads, 1);
    assert.equal(stats.counters.rangeBytes, 4);
    assert.equal(stats.counters.hits, 1);
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

test('does not let a background completion overwrite a foreground cache result', async () => {
  let releaseBackground;
  let notifyBackgroundStarted;
  const backgroundGate = new Promise((resolve) => { releaseBackground = resolve; });
  const backgroundStarted = new Promise((resolve) => { notifyBackgroundStarted = resolve; });
  await withCache({}, async (cache) => {
    const url = 'https://page.example.hath.network/h/ordered.webp';
    const background = cache.getOrLoad(url, 'media', async () => {
      notifyBackgroundStarted();
      await backgroundGate;
      return { status: 200, headers: { 'content-type': 'image/webp' }, body: 'background-body' };
    });

    await backgroundStarted;
    const foreground = await cache.getOrLoad(url, 'media', async () => ({
      status: 200,
      headers: { 'content-type': 'image/webp' },
      body: 'foreground-body',
    }), { bypassInflight: true });

    assert.equal(foreground.body, 'foreground-body');
    releaseBackground();
    await background;

    const cached = await cache.getOrLoad(url, 'media', async () => ({
      status: 200,
      headers: { 'content-type': 'image/webp' },
      body: 'unexpected-reload',
    }));
    assert.equal(cached.state, 'HIT');
    assert.equal(cached.body, 'foreground-body');
  });
});

test('keeps a completed foreground response after an intervening cache fill', async () => {
  await withCache({}, async (cache) => {
    const url = 'https://page.example.hath.network/h/intervening.webp';
    await cache.getOrLoad(url, 'media', async () => ({
      status: 200,
      headers: { 'content-type': 'image/webp' },
      body: 'background-body',
    }));

    const foreground = await cache.getOrLoad(url, 'media', async () => ({
      status: 200,
      headers: { 'content-type': 'image/webp' },
      body: 'foreground-body',
    }), { bypassInflight: true, ignoreFresh: true });

    assert.equal(foreground.body, 'foreground-body');
    const cached = await cache.getOrLoad(url, 'media', async () => ({
      status: 200,
      headers: { 'content-type': 'image/webp' },
      body: 'unexpected-reload',
    }));
    assert.equal(cached.state, 'HIT');
    assert.equal(cached.body, 'foreground-body');
  });
});

test('returns a foreground passthrough before deferred cache storage finishes', async () => {
  let releaseCacheBody;
  let notifyCacheBodyStarted;
  let notifyCacheBodyFinished;
  const cacheBodyGate = new Promise((resolve) => { releaseCacheBody = resolve; });
  const cacheBodyStarted = new Promise((resolve) => { notifyCacheBodyStarted = resolve; });
  const cacheBodyFinished = new Promise((resolve) => { notifyCacheBodyFinished = resolve; });
  await withCache({}, async (cache) => {
    const url = 'https://page.example.hath.network/h/streamed.webp';
    const result = await cache.getOrLoad(url, 'media', async () => ({
      passthrough: new Response('foreground-body', { headers: { 'content-type': 'image/webp' } }),
      status: 200,
      headers: { 'content-type': 'image/webp' },
      cacheable: true,
      cacheBody: async () => {
        notifyCacheBodyStarted();
        await cacheBodyGate;
        notifyCacheBodyFinished();
        return { status: 200, headers: { 'content-type': 'image/webp' }, body: 'foreground-body' };
      },
    }), { bypassInflight: true, deferStore: true });

    assert.equal(await result.passthrough.text(), 'foreground-body');
    await cacheBodyStarted;
    releaseCacheBody();
    await cacheBodyFinished;
    await waitForCacheHit(cache, url, 'media');
    const cached = await cache.getOrLoad(url, 'media', async () => ({
      status: 200,
      headers: { 'content-type': 'image/webp' },
      body: 'unexpected-reload',
    }));
    assert.equal(cached.state, 'HIT');
    assert.equal(cached.body, 'foreground-body');
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

test('evicts by kind weight so cheap rss leaves before media-variant', async () => {
  let now = 1_000;
  await withCache({ now: () => now, maxBytes: 7 }, async (cache) => {
    await cache.getOrLoad('https://example.com/f.xml', 'rss', async () => ({ status: 200, headers: {}, body: 'aaaa' }));
    now += 1;
    await cache.getOrLoad('https://example.com/i.png', 'media-variant', async () => ({ status: 200, headers: {}, body: 'bbbb' }));
    assert.equal((await cache.peek('https://example.com/f.xml', 'rss')).hit, false);
    assert.equal((await cache.peek('https://example.com/i.png', 'media-variant')).hit, true);
  });
});

test('touching a variant makes it the last eviction candidate', async () => {
  let now = 1_000;
  await withCache({ now: () => now, maxBytes: 10 }, async (cache) => {
    await cache.getOrLoad('https://example.com/i.png', 'media-variant', async () => ({ status: 200, headers: {}, body: 'bbbb' }));
    await cache.getOrLoad('https://example.com/f.xml', 'rss', async () => ({ status: 200, headers: {}, body: 'aaaa' }));
    now += 1;
    assert.equal((await cache.peek('https://example.com/i.png', 'media-variant')).hit, true);
    await cache.getOrLoad('https://example.com/g.html', 'html', async () => ({ status: 200, headers: {}, body: 'cccc' }));
    assert.equal((await cache.peek('https://example.com/f.xml', 'rss')).hit, false);
    assert.equal((await cache.peek('https://example.com/i.png', 'media-variant')).hit, true);
  });
});

test('handles invalid and non-buffer body in getOrLoad gracefully', async () => {
  await withCache({}, async (cache) => {
    // Attempting to return an unsupported body format safely bubbles or falls back
    const result = await cache.getOrLoad('https://example.com/invalid', 'html', async () => ({
      status: 200,
      headers: {},
      body: { not: 'a string or buffer' },
    }));
    assert.equal(result.state, 'MISS');
    assert.equal((await cache.peek('https://example.com/invalid', 'html')).hit, false);
  });
});

test('cache peek and readRange handle non-existent keys safely', async () => {
  await withCache({}, async (cache) => {
    const peekResult = await cache.peek('https://example.com/non-existent', 'media');
    assert.equal(peekResult.hit, false);
    const rangeResult = await cache.readRange('https://example.com/non-existent', 'media');
    assert.equal(rangeResult, null);
  });
});

test('keyFor generates deterministic sha256 cache keys', () => {
  const cache = createResponseCache();
  const k1 = cache.keyFor('https://example.com/test', 'html', 'public');
  const k2 = cache.keyFor('https://example.com/test', 'html', 'public');
  assert.equal(k1, k2);
  assert.equal(typeof k1, 'string');
  assert.equal(k1.length, 64);
});

test('exports cache helpers and default constants for external consumers', async () => {
  const {
    keyFor,
    canonicalUrl,
    normalizedNamespace,
    normalizedHeaders,
    DEFAULT_TTL_SECONDS,
    DEFAULT_MAX_BYTES,
    DEFAULT_EVICTION_PRIORITY,
  } = await import('../src/cache.js');

  assert.equal(canonicalUrl('https://example.com/a/b?x=1'), 'https://example.com/a/b?x=1');
  assert.equal(normalizedNamespace('  session-1  '), 'session-1');
  assert.equal(normalizedNamespace(''), 'public');

  const key1 = keyFor('https://example.com/a', 'html', 'public');
  const key2 = keyFor('https://example.com/a', 'html', 'public');
  assert.equal(key1, key2);
  assert.match(key1, /^[a-f0-9]{64}$/);

  assert.deepEqual(normalizedHeaders({ 'Content-Type': 'text/html', 'x-custom': 'ignore' }), {
    'content-type': 'text/html',
  });

  assert.equal(DEFAULT_TTL_SECONDS.rss, 300);
  assert.equal(DEFAULT_MAX_BYTES, 5 * 1024 ** 3);
  assert.equal(DEFAULT_EVICTION_PRIORITY.rss, 0);
});

test('exports normalizeBody, positiveNumber, resultFromEntry and SAFE_HEADERS', async () => {
  const {
    normalizeBody,
    positiveNumber,
    resultFromEntry,
    SAFE_HEADERS,
  } = await import('../src/cache.js');

  assert.ok(SAFE_HEADERS instanceof Set);
  assert.ok(SAFE_HEADERS.has('content-type'));
  assert.ok(SAFE_HEADERS.has('etag'));

  assert.equal(positiveNumber(100, 50), 100);
  assert.equal(positiveNumber(-5, 50), 50);
  assert.equal(positiveNumber(NaN, 50), 50);

  const stringBody = normalizeBody('hello');
  assert.equal(stringBody.type, 'string');
  assert.equal(stringBody.value, 'hello');
  assert.ok(Buffer.isBuffer(stringBody.buffer));

  const buf = Buffer.from('bytes');
  const bufferBody = normalizeBody(buf);
  assert.equal(bufferBody.type, 'buffer');
  assert.deepEqual(bufferBody.value, buf);

  assert.equal(normalizeBody(null), null);

  const entryString = { status: 200, headers: { 'content-type': 'text/plain' }, bodyType: 'string' };
  const resString = resultFromEntry(entryString, Buffer.from('hello'), 'HIT');
  assert.deepEqual(resString, {
    state: 'HIT',
    status: 200,
    headers: { 'content-type': 'text/plain' },
    body: 'hello',
  });

  const entryBuf = { status: 200, headers: { 'content-type': 'image/jpeg' }, bodyType: 'buffer' };
  const resBuf = resultFromEntry(entryBuf, Buffer.from('bin'), 'MISS');
  assert.deepEqual(resBuf, {
    state: 'MISS',
    status: 200,
    headers: { 'content-type': 'image/jpeg' },
    body: Buffer.from('bin'),
  });
});
