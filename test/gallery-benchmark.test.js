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

