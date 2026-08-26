import test from 'node:test';
import assert from 'node:assert/strict';
import { benchmarkGallery } from '../src/gallery-benchmark.js';

test('rejects a benchmark target outside the local gateway', async () => {
  await assert.rejects(
    benchmarkGallery({ gatewayUrl: 'https://gateway.example.test/_gateway/item/token' }),
    (error) => error.code === 'BENCHMARK_LOCAL_GATEWAY_REQUIRED',
  );
});

test('reports aggregate gallery timings and byte counts without source URLs', async () => {
  let time = 0;
  const result = await benchmarkGallery({
    gatewayUrl: 'http://127.0.0.1:1300/_gateway/item/token',
    now: () => {
      time += 10;
      return time;
    },
    fetchImpl: async (url, request = {}) => {
      const target = new URL(url);
      if (target.pathname.includes('/_gateway/item/')) {
        return new Response('<img src="/_gateway/media/one"><img src="/_gateway/media/two">', {
          headers: { 'content-type': 'text/html' },
        });
      }
      if (request.method === 'HEAD') {
        return new Response(null, { headers: { 'content-length': '100' } });
      }
      return new Response('x'.repeat(60), { status: 200, headers: { 'content-type': 'image/webp' } });
    },
  });

  assert.deepEqual(Object.keys(result).sort(), [
    'allReadyMs',
    'firstScreenMs',
    'htmlMs',
    'originalBytes',
    'quarterReadyMs',
    'statusCounts',
    'variantBytes',
    'variantSavedPercent',
  ]);
  assert.equal(result.originalBytes, 200);
  assert.equal(result.variantBytes, 120);
  assert.equal(result.variantSavedPercent, 40);
  assert.deepEqual(result.statusCounts, { 200: 2 });
  assert.doesNotMatch(JSON.stringify(result), /token|127\.0\.0\.1|_gateway\/media/);
});

test('handles benchmark gallery with empty or media without content-length', async () => {
  const result = await benchmarkGallery({
    gatewayUrl: 'http://localhost:1300/_gateway/item/empty-token',
    fetchImpl: async (url, request = {}) => {
      const target = new URL(url);
      if (target.pathname.includes('/_gateway/item/')) {
        return new Response('<p>No media here</p>', { headers: { 'content-type': 'text/html' } });
      }
      return new Response('', { status: 404 });
    },
  });

  assert.equal(result.originalBytes, 0);
  assert.equal(result.variantBytes, 0);
  assert.equal(result.variantSavedPercent, 0);
  assert.deepEqual(result.statusCounts, {});
});

test('benchmarkGallery rejects URLs with credentials embedded in authority', async () => {
  await assert.rejects(
    benchmarkGallery({ gatewayUrl: 'http://user:pass@127.0.0.1:1300/_gateway/item/token' }),
    (error) => error.code === 'BENCHMARK_LOCAL_GATEWAY_REQUIRED',
  );
});

test('exports benchmark helpers and concurrency constants', async () => {
  const {
    LOCAL_HOSTS,
    MEDIA_CONCURRENCY,
    DEFAULT_BENCHMARK_VARIANT_WIDTH,
    mediaUrls,
    variantUrl,
    numericContentLength,
    durationCheckpoint,
    mapWithConcurrency,
  } = await import('../src/gallery-benchmark.js');

  assert.ok(LOCAL_HOSTS instanceof Set);
  assert.ok(LOCAL_HOSTS.has('127.0.0.1'));
  assert.ok(LOCAL_HOSTS.has('localhost'));
  assert.equal(MEDIA_CONCURRENCY, 8);
  assert.equal(DEFAULT_BENCHMARK_VARIANT_WIDTH, 1920);

  const html = '<div><img src="/_gateway/media/abc"><img src="https://other.com/ext.jpg"></div>';
  const urls = mediaUrls(html, new URL('http://127.0.0.1:1300/_gateway/item/token'));
  assert.deepEqual(urls, ['http://127.0.0.1:1300/_gateway/media/abc']);

  assert.equal(
    variantUrl('http://127.0.0.1:1300/_gateway/media/token'),
    'http://127.0.0.1:1300/_gateway/media/token?w=1920',
  );
  assert.equal(
    variantUrl('http://127.0.0.1:1300/_gateway/media/token', 1280),
    'http://127.0.0.1:1300/_gateway/media/token?w=1280',
  );

  const mockRes = new Response(null, { headers: { 'content-length': '2048' } });
  assert.equal(numericContentLength(mockRes), 2048);
  assert.equal(numericContentLength(new Response(null)), 0);

  const results = [{ completedAt: 100 }, { completedAt: 300 }, { completedAt: 200 }];
  assert.equal(durationCheckpoint(results, 2), 200);
  assert.equal(durationCheckpoint(results, 0), 0);

  const mapped = await mapWithConcurrency([1, 2, 3], 2, async (x) => x * 10);
  assert.deepEqual(mapped, [10, 20, 30]);
});

