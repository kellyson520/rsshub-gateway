import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { createResponseCache } from '../src/cache.js';
import {
  createMediaTransport,
  parseByteRange,
  sliceRanges,
  imageVariantCacheUrl,
} from '../src/media/media-transport.js';
import { chunkSizeFor } from '../src/media/chunks.js';
import { createSignedChunk } from '../src/download-lease.js';

function response(body, { status = 200, contentType = 'image/jpeg', contentLength } = {}) {
  const buffer = Buffer.isBuffer(body) ? body : Buffer.from(body);
  const headers = new Headers({ 'content-type': contentType });
  if (contentLength !== undefined) headers.set('content-length', String(contentLength));
  return new Response(buffer, { status, headers });
}

function streamResponse(body, { contentType = 'video/mp4', size } = {}) {
  const buffer = Buffer.from(body);
  const headers = new Headers({ 'content-type': contentType, 'content-length': String(size ?? buffer.length) });
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(buffer);
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers });
}

test('parseByteRange handles suffix, open-ended and unsatisfiable ranges', () => {
  assert.deepEqual(parseByteRange('bytes=0-3', 10), { start: 0, end: 3 });
  assert.deepEqual(parseByteRange('bytes=4-', 10), { start: 4, end: 9 });
  assert.deepEqual(parseByteRange('bytes=-5', 10), { start: 5, end: 9 });
  assert.deepEqual(parseByteRange('bytes=-50', 10), { start: 0, end: 9 });
  assert.deepEqual(parseByteRange('bytes=20-30', 10), { unsatisfiable: true });
  assert.equal(parseByteRange('items=0-1', 10), null);
});

test('sliceRanges plans aligned slices with a bounded lookahead', () => {
  const plan = sliceRanges(0, 1024, 20 * 1024 * 1024, { sliceSize: 4 * 1024 * 1024, lookahead: 16 * 1024 * 1024 });
  assert.equal(plan.slice, 4 * 1024 * 1024);
  assert.deepEqual(plan.ranges.map((r) => r.start), [0, 4 * 1024 * 1024, 8 * 1024 * 1024, 12 * 1024 * 1024]);
  const tail = sliceRanges(18 * 1024 * 1024, 19 * 1024 * 1024, 20 * 1024 * 1024, { sliceSize: 4 * 1024 * 1024, lookahead: 16 * 1024 * 1024 });
  assert.deepEqual(tail.ranges.map((r) => [r.start, r.end]), [[16 * 1024 * 1024, 20 * 1024 * 1024 - 1]]);
  assert.deepEqual(sliceRanges(500, 600, 100, { sliceSize: 4 * 1024 * 1024, lookahead: 16 * 1024 * 1024 }).ranges, []);
});

test('readCached and cacheMedia store and serve media through the transport', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rsshub-gateway-media-transport-'));
  try {
    const cache = createResponseCache({ root });
    const transport = createMediaTransport({ cache, fetchExternal: async () => response('x') });
    const original = streamResponse(Buffer.alloc(0), { size: 0 });
    const media = new Response(Buffer.from('videobytes'), {
      headers: { 'content-type': 'video/mp4', 'content-length': '10' },
    });
    const served = await transport.cacheMedia('https://example.com/v.mp4', 'public', media);
    assert.equal(served.status, 200);
    const cached = await transport.readCached('https://example.com/v.mp4', 'media', 'public');
    assert.ok(cached);
    assert.equal(await cached.text(), 'videobytes');
    const ranged = await transport.readRange({ target: 'https://example.com/v.mp4', range: 'bytes=1-3' });
    assert.equal(ranged.status, 206);
    assert.equal(await ranged.text(), 'ide');
    assert.equal(ranged.headers.get('content-range'), 'bytes 1-3/10');
    assert.ok(original.body.cancel);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('serve routes through the cache and routeRequest hook', async () => {
  const fetched = [];
  const routedRequests = [];
  const transport = createMediaTransport({
    fetchExternal: async (url) => {
      fetched.push(String(url));
      return response('img', { contentType: 'image/png', contentLength: 3 });
    },
    routeRequest: async (target, requestOptions) => {
      routedRequests.push(String(target));
      return {
        adapter: { name: 'test' },
        egressScope: 'public',
        response: response('img', { contentType: 'image/png', contentLength: 3 }),
      };
    },
    adapterFor: () => ({ name: 'test' }),
  });
  const routed = await transport.serve('https://example.com/i.png', { priority: 'foreground' }, { egressScope: 'public' });
  assert.equal(routed.response.status, 200);
  assert.equal(await routed.response.text(), 'img');
  assert.deepEqual(routedRequests, ['https://example.com/i.png']);
  assert.equal(fetched.length, 0);
});

test('serve serves byte ranges from cache without hitting upstream', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rsshub-gateway-media-transport-range-'));
  try {
    const cache = createResponseCache({ root });
    let upstream = 0;
    const fetcher = async () => {
      upstream += 1;
      return response('0123456789', { contentType: 'video/mp4', contentLength: 10 });
    };
    const transport = createMediaTransport({
      cache,
      fetchExternal: fetcher,
      routeRequest: async () => ({ adapter: { name: 't' }, egressScope: 'public', response: await fetcher() }),
      adapterFor: () => ({ name: 't' }),
    });
    await transport.serve('https://example.com/v.mp4', { priority: 'foreground' }, { egressScope: 'public' });
    await new Promise((resolve) => setTimeout(resolve, 30));
    const ranged = await transport.serve('https://example.com/v.mp4', { range: 'bytes=2-5', priority: 'foreground' }, { egressScope: 'public' });
    assert.equal(ranged.response.status, 206);
    assert.equal(await ranged.response.text(), '2345');
    assert.equal(upstream, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('probeSize returns the full size from a content-range probe', async () => {
  let probed = false;
  const transport = createMediaTransport({
    fetchExternal: async (url, options) => {
      if (options?.range) {
        probed = true;
        return new Response(null, {
          status: 206,
          headers: { 'content-range': 'bytes 0-0/12345', 'content-length': '1' },
        });
      }
      return response('x');
    },
    resolveMediaUrl: async () => ({ url: 'https://cdn.example.com/v.mp4' }),
    isVideoTarget: () => true,
  });
  const size = await transport.probeSize('https://www.iwara.tv/video/abc');
  assert.equal(size, 12345);
  assert.equal(probed, true);
});

test('first video range request fills slices in the background', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rsshub-gateway-media-transport-video-'));
  try {
    const cache = createResponseCache({ root });
    const body = Buffer.from('0123456789');
    let upstreamRanges = 0;
    const fetchExternal = async (url, options = {}) => {
      if (options.range) {
        upstreamRanges += 1;
        const match = String(options.range).match(/^bytes=(\d+)-(\d+)$/);
        const start = Number(match[1]);
        const end = Number(match[2]);
        const slice = body.subarray(start, end + 1);
        return new Response(slice, {
          status: 206,
          headers: {
            'content-type': 'video/mp4',
            'content-length': String(slice.length),
            'content-range': `bytes ${start}-${end}/${body.length}`,
          },
        });
      }
      return new Response(body, {
        headers: { 'content-type': 'video/mp4', 'content-length': String(body.length) },
      });
    };
    const transport = createMediaTransport({
      cache,
      fetchExternal,
      resolveMediaUrl: async () => ({ url: 'https://cdn.example.com/v.mp4' }),
      isVideoTarget: () => true,
      videoCacheMaxFileBytes: 1024,
      sliceSize: 4 * 1024 * 1024,
      sliceLookaheadBytes: 16 * 1024 * 1024,
    });
    const first = await transport.serve(
      'https://www.iwara.tv/video/abc',
      { range: 'bytes=2-5', priority: 'foreground' },
      {},
    );
    assert.equal(first.response.status, 206);
    assert.equal(await first.response.text(), '2345');
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline && !(await cache.peek('https://www.iwara.tv/video/abc#slice=0', 'media')).hit) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal((await cache.peek('https://www.iwara.tv/video/abc#slice=0', 'media')).hit, true);
    const second = await transport.serve(
      'https://www.iwara.tv/video/abc',
      { range: 'bytes=4-7', priority: 'foreground' },
      {},
    );
    assert.equal(second.response.status, 206);
    assert.equal(await second.response.text(), '4567');
    assert.equal(upstreamRanges, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('serves later video seeks from cached slices without upstream', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rsshub-gateway-media-transport-slices-'));
  try {
    const cache = createResponseCache({ root });
    const body = Buffer.alloc(20 * 1024 * 1024, 7);
    let upstreamRanges = 0;
    const fetchExternal = async (url, options = {}) => {
      upstreamRanges += 1;
      const match = String(options.range).match(/^bytes=(\d+)-(\d+)$/);
      const start = Number(match[1]);
      const end = Number(match[2]);
      const slice = body.subarray(start, end + 1);
      return new Response(slice, {
        status: 206,
        headers: {
          'content-type': 'video/mp4',
          'content-length': String(slice.length),
          'content-range': `bytes ${start}-${end}/${body.length}`,
        },
      });
    };
    const transport = createMediaTransport({
      cache,
      fetchExternal,
      resolveMediaUrl: async () => ({ url: 'https://cdn.example.com/v.mp4' }),
      isVideoTarget: () => true,
      sliceSize: 4 * 1024 * 1024,
      sliceLookaheadBytes: 16 * 1024 * 1024,
      sliceFillConcurrency: 4,
    });
    const first = await transport.serve(
      'https://www.iwara.tv/video/big',
      { range: 'bytes=0-1023', priority: 'foreground' },
      {},
    );
    assert.equal(first.response.status, 206);
    await first.response.arrayBuffer();
    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline && !(await cache.peek('https://www.iwara.tv/video/big#slice=4194304', 'media')).hit) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal((await cache.peek('https://www.iwara.tv/video/big#slice=4194304', 'media')).hit, true);
    const slicesBefore = upstreamRanges;
    const seek = await transport.serve(
      'https://www.iwara.tv/video/big',
      { range: 'bytes=524288-1048575', priority: 'foreground' },
      {},
    );
    assert.equal(seek.response.status, 206);
    const bytes = Buffer.from(await seek.response.arrayBuffer());
    assert.equal(bytes.length, 524288);
    assert.equal(bytes.every((value) => value === 7), true);
    assert.equal(upstreamRanges, slicesBefore);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('chunkManifest signs independent chunk urls covering the full file', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rsshub-gateway-media-transport-chunk-'));
  try {
    const cache = createResponseCache({ root });
    const transport = createMediaTransport({
      cache,
      fetchExternal: async () => response('x'),
      createSignedChunk,
      routeRequest: async () => ({ adapter: { name: 't' }, egressScope: 'public', response: response('x') }),
      adapterFor: () => ({ name: 't' }),
    });
    const plan = chunkSizeFor(50 * 1024 * 1024, 8);
    const manifest = transport.chunkManifest({
      target: 'https://example.com/big.mp4',
      size: 50 * 1024 * 1024,
      chunks: plan,
      secret: 'secret',
      baseUrl: 'https://gateway.example/',
      metadata: { egressScope: 'public' },
    });
    assert.equal(manifest.count, plan.count);
    assert.equal(manifest.urls.length, plan.count);
    assert.equal(manifest.chunkSize * manifest.count >= 50 * 1024 * 1024, true);
    const last = manifest.urls[manifest.count - 1];
    assert.match(last, /^https:\/\/gateway\.example\/_gateway\/chunk\//);
    assert.equal(imageVariantCacheUrl('https://example.com/i.png', 1920).includes('w1920'), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('exposes fillVideoSlices, sliceKey and rememberVideoSize for lease backfill', () => {
  const transport = createMediaTransport({ fetchExternal: async () => response('x') });
  assert.equal(typeof transport.fillVideoSlices, 'function');
  assert.equal(typeof transport.sliceKey, 'function');
  assert.equal(typeof transport.rememberVideoSize, 'function');
  assert.equal(transport.sliceKey('https://example.com/v.mp4', 0), 'https://example.com/v.mp4#slice=0');
});

test('fillVideoSlices stops early when shouldStop returns true', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rsshub-gateway-backfill-stop-'));
  try {
    const cache = createResponseCache({ root });
    const fetched = [];
    const transport = createMediaTransport({
      cache,
      sliceSize: 4 * 1024 * 1024,
      sliceFillConcurrency: 2,
      fetchExternal: async (url, options = {}) => {
        fetched.push(String(options.range));
        const match = String(options.range).match(/bytes=(\d+)-(\d+)/);
        const start = Number(match[1]);
        const end = Number(match[2]);
        return new Response(Buffer.alloc(end - start + 1, 0x61), {
          status: 206,
          headers: { 'content-type': 'video/mp4', 'content-range': `bytes ${start}-${end}/100000000` },
        });
      },
    });
    let stopped = false;
    await transport.fillVideoSlices('https://example.com/v.mp4', 'https://cdn.example.com/v.mp4', 100 * 1024 * 1024, 'public', { start: 0, end: 100 * 1024 * 1024 - 1 }, 256 * 1024 * 1024, { shouldStop: () => stopped });
    const before = fetched.length;
    assert.ok(before >= 1);
    stopped = true;
    await transport.fillVideoSlices('https://example.com/v.mp4', 'https://cdn.example.com/v.mp4', 100 * 1024 * 1024, 'public', { start: 0, end: 100 * 1024 * 1024 - 1 }, 256 * 1024 * 1024, { shouldStop: () => stopped });
    await new Promise((resolve) => setTimeout(resolve, 30));
    const after = fetched.length;
    assert.ok(after <= before + 2, `fetched grew ${before} -> ${after}`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('known video sizes expire after their TTL and serve stale-free', async () => {
  let now = 1_000_000;
  const transport = createMediaTransport({
    fetchExternal: async () => response('x'),
    knownSizeTtlMs: 60_000,
    now: () => now,
  });
  transport.rememberVideoSize('https://www.iwara.tv/video/a', 12345);
  assert.equal(transport.knownVideoSize('https://www.iwara.tv/video/a'), 12345);
  now += 61_000;
  assert.equal(transport.knownVideoSize('https://www.iwara.tv/video/a'), undefined);
});

test('known video sizes drop the oldest entry past the cap', () => {
  let now = 1_000_000;
  const transport = createMediaTransport({
    fetchExternal: async () => response('x'),
    knownSizeTtlMs: 60_000,
    now: () => now,
    knownSizeCap: 3,
  });
  transport.rememberVideoSize('https://www.iwara.tv/video/a', 1);
  transport.rememberVideoSize('https://www.iwara.tv/video/b', 2);
  transport.rememberVideoSize('https://www.iwara.tv/video/c', 3);
  transport.rememberVideoSize('https://www.iwara.tv/video/d', 4);
  assert.equal(transport.knownVideoSize('https://www.iwara.tv/video/a'), undefined);
  assert.equal(transport.knownVideoSize('https://www.iwara.tv/video/d'), 4);
});

test('large video range assembles from parallel slice fetches', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rsshub-gateway-media-assemble-'));
  try {
    const cache = createResponseCache({ root });
    const body = Buffer.alloc(20 * 1024 * 1024, 7);
    const requested = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const fetchExternal = async (url, options = {}) => {
      if (options.range) {
        requested.push(String(options.range));
        const match = String(options.range).match(/^bytes=(\d+)-(\d+)$/);
        const start = Number(match[1]);
        const end = Number(match[2]);
        const slice = body.subarray(start, end + 1);
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 30));
        inFlight -= 1;
        return new Response(slice, {
          status: 206,
          headers: {
            'content-type': 'video/mp4',
            'content-length': String(slice.length),
            'content-range': `bytes ${start}-${end}/${body.length}`,
          },
        });
      }
      return new Response(body, {
        headers: { 'content-type': 'video/mp4', 'content-length': String(body.length) },
      });
    };
    const transport = createMediaTransport({
      cache,
      fetchExternal,
      resolveMediaUrl: async () => ({ url: 'https://cdn.example.com/v.mp4' }),
      isVideoTarget: () => true,
      sliceSize: 4 * 1024 * 1024,
      sliceLookaheadBytes: 16 * 1024 * 1024,
      sliceFillConcurrency: 4,
    });
    const served = await transport.serve(
      'https://www.iwara.tv/video/parallel',
      { range: 'bytes=0-8388607', priority: 'foreground' },
      {},
    );
    assert.equal(served.response.status, 206);
    assert.equal(served.response.headers.get('content-range'), 'bytes 0-8388607/20971520');
    const bytes = Buffer.from(await served.response.arrayBuffer());
    assert.equal(bytes.length, 8 * 1024 * 1024);
    assert.equal(bytes.every((value) => value === 7), true);
    assert.ok(maxInFlight >= 2, `expected parallel slice fetches, maxInFlight=${maxInFlight}`);
    assert.ok(requested.includes('bytes=0-0'), 'expected a size probe');
    assert.equal((await cache.peek('https://www.iwara.tv/video/parallel#slice=0', 'media')).hit, true);
    assert.equal((await cache.peek('https://www.iwara.tv/video/parallel#slice=4194304', 'media')).hit, true);
    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline && !(await cache.peek('https://www.iwara.tv/video/parallel#slice=16777216', 'media')).hit) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const rangesBefore = requested.length;
    const second = await transport.serve(
      'https://www.iwara.tv/video/parallel',
      { range: 'bytes=0-8388607', priority: 'foreground' },
      {},
    );
    assert.equal(second.response.status, 206);
    assert.equal(Buffer.from(await second.response.arrayBuffer()).length, 8 * 1024 * 1024);
    assert.equal(requested.length, rangesBefore);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('single-slice range keeps the single-fetch path', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rsshub-gateway-media-assemble-small-'));
  try {
    const cache = createResponseCache({ root });
    const body = Buffer.alloc(20 * 1024 * 1024, 9);
    const requested = [];
    const fetchExternal = async (url, options = {}) => {
      if (options.range) {
        requested.push(String(options.range));
        const match = String(options.range).match(/^bytes=(\d+)-(\d+)$/);
        const start = Number(match[1]);
        const end = Number(match[2]);
        const slice = body.subarray(start, end + 1);
        return new Response(slice, {
          status: 206,
          headers: {
            'content-type': 'video/mp4',
            'content-length': String(slice.length),
            'content-range': `bytes ${start}-${end}/${body.length}`,
          },
        });
      }
      return new Response(body, {
        headers: { 'content-type': 'video/mp4', 'content-length': String(body.length) },
      });
    };
    const transport = createMediaTransport({
      cache,
      fetchExternal,
      resolveMediaUrl: async () => ({ url: 'https://cdn.example.com/v.mp4' }),
      isVideoTarget: () => true,
      sliceSize: 4 * 1024 * 1024,
      sliceLookaheadBytes: 16 * 1024 * 1024,
      sliceFillConcurrency: 4,
    });
    const served = await transport.serve(
      'https://www.iwara.tv/video/small',
      { range: 'bytes=0-2097151', priority: 'foreground' },
      {},
    );
    assert.equal(served.response.status, 206);
    assert.equal(Buffer.from(await served.response.arrayBuffer()).length, 2 * 1024 * 1024);
    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline && !(await cache.peek('https://www.iwara.tv/video/small#slice=0', 'media')).hit) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal((await cache.peek('https://www.iwara.tv/video/small#slice=0', 'media')).hit, true);
    assert.equal(requested.includes('bytes=0-0'), false, 'small ranges must not probe size');
    assert.equal(requested.filter((range) => range === 'bytes=0-2097151').length, 1);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('assembly falls back to single fetch when the first slice fails', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rsshub-gateway-media-assemble-fallback-'));
  try {
    const cache = createResponseCache({ root });
    const body = Buffer.alloc(20 * 1024 * 1024, 5);
    const requested = [];
    const fetchExternal = async (url, options = {}) => {
      if (options.range) {
        requested.push(String(options.range));
        if (options.range === 'bytes=0-4194303') {
          return new Response('slice unavailable', { status: 503 });
        }
        const match = String(options.range).match(/^bytes=(\d+)-(\d+)$/);
        const start = Number(match[1]);
        const end = Number(match[2]);
        const slice = body.subarray(start, end + 1);
        return new Response(slice, {
          status: 206,
          headers: {
            'content-type': 'video/mp4',
            'content-length': String(slice.length),
            'content-range': `bytes ${start}-${end}/${body.length}`,
          },
        });
      }
      return new Response(body, {
        headers: { 'content-type': 'video/mp4', 'content-length': String(body.length) },
      });
    };
    const transport = createMediaTransport({
      cache,
      fetchExternal,
      resolveMediaUrl: async () => ({ url: 'https://cdn.example.com/v.mp4' }),
      isVideoTarget: () => true,
      sliceSize: 4 * 1024 * 1024,
      sliceLookaheadBytes: 16 * 1024 * 1024,
      sliceFillConcurrency: 4,
    });
    const served = await transport.serve(
      'https://www.iwara.tv/video/fallback',
      { range: 'bytes=0-8388607', priority: 'foreground' },
      {},
    );
    assert.equal(served.response.status, 206);
    const bytes = Buffer.from(await served.response.arrayBuffer());
    assert.equal(bytes.length, 8 * 1024 * 1024);
    assert.equal(bytes.every((value) => value === 5), true);
    assert.ok(requested.includes('bytes=0-8388607'), 'expected a full-range fallback fetch');
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('prefetchVideoFile caches every slice with bounded concurrency', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rsshub-gateway-prefetch-'));
  try {
    const cache = createResponseCache({ root });
    const body = Buffer.alloc(20 * 1024 * 1024, 3);
    const requested = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const fetchExternal = async (url, options = {}) => {
      if (options.range) {
        requested.push(String(options.range));
        const match = String(options.range).match(/^bytes=(\d+)-(\d+)$/);
        const start = Number(match[1]);
        const end = Number(match[2]);
        const slice = body.subarray(start, end + 1);
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 20));
        inFlight -= 1;
        return new Response(slice, {
          status: 206,
          headers: {
            'content-type': 'video/mp4',
            'content-length': String(slice.length),
            'content-range': `bytes ${start}-${end}/${body.length}`,
          },
        });
      }
      return new Response(body, {
        headers: { 'content-type': 'video/mp4', 'content-length': String(body.length) },
      });
    };
    const transport = createMediaTransport({
      cache,
      fetchExternal,
      resolveMediaUrl: async () => ({ url: 'https://cdn.example.com/v.mp4' }),
      isVideoTarget: () => true,
      sliceSize: 4 * 1024 * 1024,
      sliceFillConcurrency: 2,
    });
    const target = 'https://www.iwara.tv/video/prefetch';
    const fetched = await transport.prefetchVideoFile(target, { size: 20 * 1024 * 1024 });
    assert.equal(fetched, 5);
    assert.equal(maxInFlight, 2);
    assert.equal(requested.length, 5);
    for (const start of [0, 4194304, 8388608, 12582912, 16777216]) {
      const range = `bytes=${start}-${start + 4194303}`;
      assert.ok(requested.includes(range), `missing ${range}`);
      const ranged = await cache.readRange(`${target}#slice=${start}`, 'media');
      assert.ok(ranged, `slice ${start} not cached`);
      assert.equal(ranged.size, 4 * 1024 * 1024);
    }
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('prefetchVideoFile deduplicates concurrent prefetches for the same target', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rsshub-gateway-prefetch-dedup-'));
  try {
    const cache = createResponseCache({ root });
    const body = Buffer.alloc(20 * 1024 * 1024, 6);
    let rangeRequests = 0;
    const transport = createMediaTransport({
      cache,
      fetchExternal: async (url, options = {}) => {
        if (options.range) {
          rangeRequests += 1;
          const match = String(options.range).match(/^bytes=(\d+)-(\d+)$/);
          const start = Number(match[1]);
          const end = Number(match[2]);
          await new Promise((resolve) => setTimeout(resolve, 30));
          return new Response(body.subarray(start, end + 1), {
            status: 206,
            headers: {
              'content-type': 'video/mp4',
              'content-range': `bytes ${start}-${end}/${body.length}`,
            },
          });
        }
        return new Response(body, {
          headers: { 'content-type': 'video/mp4', 'content-length': String(body.length) },
        });
      },
      resolveMediaUrl: async () => ({ url: 'https://cdn.example.com/v.mp4' }),
      isVideoTarget: () => true,
      sliceSize: 4 * 1024 * 1024,
    });
    const target = 'https://www.iwara.tv/video/prefetch-dedup';
    const [first, second] = await Promise.all([
      transport.prefetchVideoFile(target, { size: 20 * 1024 * 1024 }),
      transport.prefetchVideoFile(target, { size: 20 * 1024 * 1024 }),
    ]);
    assert.equal(first, 5);
    assert.equal(second, 5);
    assert.equal(rangeRequests, 5);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('prefetchVideoFile respects the video cache cap and skips cached slices', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rsshub-gateway-prefetch-cap-'));
  try {
    const cache = createResponseCache({ root });
    const body = Buffer.alloc(20 * 1024 * 1024, 8);
    const requested = [];
    const transport = createMediaTransport({
      cache,
      videoCacheMaxFileBytes: 12 * 1024 * 1024,
      fetchExternal: async (url, options = {}) => {
        if (options.range) {
          requested.push(String(options.range));
          const match = String(options.range).match(/^bytes=(\d+)-(\d+)$/);
          const start = Number(match[1]);
          const end = Number(match[2]);
          return new Response(body.subarray(start, end + 1), {
            status: 206,
            headers: {
              'content-type': 'video/mp4',
              'content-range': `bytes ${start}-${end}/${body.length}`,
            },
          });
        }
        return new Response(body, {
          headers: { 'content-type': 'video/mp4', 'content-length': String(body.length) },
        });
      },
      resolveMediaUrl: async () => ({ url: 'https://cdn.example.com/v.mp4' }),
      isVideoTarget: () => true,
      sliceSize: 4 * 1024 * 1024,
    });
    const target = 'https://www.iwara.tv/video/prefetch-cap';
    const fetched = await transport.prefetchVideoFile(target, { size: 20 * 1024 * 1024 });
    assert.equal(fetched, 3);
    assert.equal(requested.length, 3);
    assert.ok(requested.includes('bytes=8388608-12582911'));
    assert.ok(!requested.includes('bytes=12582912-16777215'));
    const warmed = await transport.prefetchVideoFile(target, { size: 20 * 1024 * 1024 });
    assert.equal(warmed, 0);
    assert.equal(requested.length, 3);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('prefetchVideoFile probes the size when not provided and no-ops for non-video targets', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rsshub-gateway-prefetch-probe-'));
  try {
    const cache = createResponseCache({ root });
    const body = Buffer.alloc(20 * 1024 * 1024, 9);
    const requested = [];
    const transport = createMediaTransport({
      cache,
      fetchExternal: async (url, options = {}) => {
        if (options.range) {
          requested.push(String(options.range));
          const match = String(options.range).match(/^bytes=(\d+)-(\d+)$/);
          const start = Number(match[1]);
          const end = Number(match[2]);
          return new Response(body.subarray(start, end + 1), {
            status: 206,
            headers: {
              'content-type': 'video/mp4',
              'content-range': `bytes ${start}-${end}/${body.length}`,
            },
          });
        }
        return new Response(body, {
          headers: { 'content-type': 'video/mp4', 'content-length': String(body.length) },
        });
      },
      resolveMediaUrl: async () => ({ url: 'https://cdn.example.com/v.mp4' }),
      isVideoTarget: () => true,
      sliceSize: 4 * 1024 * 1024,
    });
    const target = 'https://www.iwara.tv/video/prefetch-probe';
    const fetched = await transport.prefetchVideoFile(target);
    assert.equal(fetched, 5);
    assert.ok(requested.includes('bytes=0-0'));
    assert.equal(transport.knownVideoSize(target), 20 * 1024 * 1024);

    let calls = 0;
    const nonVideo = createMediaTransport({
      cache,
      fetchExternal: async () => { calls += 1; return new Response(body, { status: 200 }); },
      resolveMediaUrl: async () => ({ url: 'https://cdn.example.com/v.mp4' }),
      isVideoTarget: () => false,
    });
    assert.equal(await nonVideo.prefetchVideoFile(target, { size: 20 * 1024 * 1024 }), 0);
    assert.equal(calls, 0);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('prefetchStatus reports running and done progress with bounded prefetch concurrency', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rsshub-gateway-prefetch-status-'));
  try {
    const cache = createResponseCache({ root });
    const body = Buffer.alloc(20 * 1024 * 1024, 5);
    let inFlight = 0;
    let maxInFlight = 0;
    const transport = createMediaTransport({
      cache,
      fetchExternal: async (url, options = {}) => {
        if (options.range) {
          const match = String(options.range).match(/^bytes=(\d+)-(\d+)$/);
          const start = Number(match[1]);
          const end = Number(match[2]);
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await new Promise((resolve) => setTimeout(resolve, 30));
          inFlight -= 1;
          return new Response(body.subarray(start, end + 1), {
            status: 206,
            headers: {
              'content-type': 'video/mp4',
              'content-range': `bytes ${start}-${end}/${body.length}`,
            },
          });
        }
        return new Response(body, {
          headers: { 'content-type': 'video/mp4', 'content-length': String(body.length) },
        });
      },
      resolveMediaUrl: async () => ({ url: 'https://cdn.example.com/v.mp4' }),
      isVideoTarget: () => true,
      sliceSize: 4 * 1024 * 1024,
      sliceFillConcurrency: 4,
      prefetchConcurrency: 2,
    });
    const target = 'https://www.iwara.tv/video/prefetch-status';
    const pending = transport.prefetchVideoFile(target, { size: 20 * 1024 * 1024 });
    assert.equal(transport.prefetchStatus(target).status, 'running');
    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline && transport.prefetchStatus(target).totalSlices !== 5) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(transport.prefetchStatus(target).totalSlices, 5);
    assert.equal(await pending, 5);
    assert.equal(maxInFlight, 2);
    const done = transport.prefetchStatus(target);
    assert.equal(done.status, 'done');
    assert.equal(done.fetchedSlices, 5);
    assert.equal(done.failedSlices, 0);
    assert.equal(done.totalSlices, 5);
    assert.ok(done.completedAt >= done.startedAt);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('prefetchStatus is null without activity and resets on a new prefetch', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rsshub-gateway-prefetch-status-none-'));
  try {
    const cache = createResponseCache({ root });
    const body = Buffer.alloc(8 * 1024 * 1024, 6);
    const transport = createMediaTransport({
      cache,
      fetchExternal: async (url, options = {}) => {
        if (options.range) {
          const match = String(options.range).match(/^bytes=(\d+)-(\d+)$/);
          const start = Number(match[1]);
          const end = Number(match[2]);
          return new Response(body.subarray(start, end + 1), {
            status: 206,
            headers: {
              'content-type': 'video/mp4',
              'content-range': `bytes ${start}-${end}/${body.length}`,
            },
          });
        }
        return new Response(body, {
          headers: { 'content-type': 'video/mp4', 'content-length': String(body.length) },
        });
      },
      resolveMediaUrl: async () => ({ url: 'https://cdn.example.com/v.mp4' }),
      isVideoTarget: () => true,
      sliceSize: 4 * 1024 * 1024,
    });
    const target = 'https://www.iwara.tv/video/prefetch-status-reset';
    assert.equal(transport.prefetchStatus(target), null);
    assert.equal(await transport.prefetchVideoFile(target, { size: 8 * 1024 * 1024 }), 2);
    assert.equal(transport.prefetchStatus(target).status, 'done');
    const pending = transport.prefetchVideoFile(target, { size: 8 * 1024 * 1024 });
    assert.equal(transport.prefetchStatus(target).status, 'running');
    assert.equal(transport.prefetchStatus(target).fetchedSlices, 0);
    assert.equal(await pending, 0);
    assert.equal(transport.prefetchStatus(target).status, 'done');
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('prefetch and foreground assembly share slice fetches without duplicate upstream requests', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rsshub-gateway-slice-dedup-'));
  try {
    const cache = createResponseCache({ root });
    const body = Buffer.alloc(20 * 1024 * 1024, 3);
    const requested = [];
    const fetchExternal = async (url, options = {}) => {
      if (options.range) {
        requested.push(String(options.range));
        const match = String(options.range).match(/^bytes=(\d+)-(\d+)$/);
        const start = Number(match[1]);
        const end = Number(match[2]);
        await new Promise((resolve) => setTimeout(resolve, 80));
        return new Response(body.subarray(start, end + 1), {
          status: 206,
          headers: {
            'content-type': 'video/mp4',
            'content-length': String(end - start + 1),
            'content-range': `bytes ${start}-${end}/${body.length}`,
          },
        });
      }
      return new Response(body, {
        headers: { 'content-type': 'video/mp4', 'content-length': String(body.length) },
      });
    };
    const transport = createMediaTransport({
      cache,
      fetchExternal,
      resolveMediaUrl: async () => ({ url: 'https://cdn.example.com/v.mp4' }),
      isVideoTarget: () => true,
      sliceSize: 4 * 1024 * 1024,
      sliceFillConcurrency: 4,
    });
    const target = 'https://www.iwara.tv/video/slice-dedup';
    const prefetch = transport.prefetchVideoFile(target, { size: 20 * 1024 * 1024 });
    await new Promise((resolve) => setTimeout(resolve, 30));
    const served = await transport.serve(
      target,
      { range: 'bytes=0-8388607', priority: 'foreground' },
      {},
    );
    assert.equal(served.response.status, 206);
    assert.equal(Buffer.from(await served.response.arrayBuffer()).length, 8 * 1024 * 1024);
    await prefetch;
    const counts = requested.reduce((acc, range) => {
      acc[range] = (acc[range] || 0) + 1;
      return acc;
    }, {});
    assert.equal(requested.length, 5);
    for (let slice = 0; slice < 5; slice += 1) {
      const start = slice * 4 * 1024 * 1024;
      const end = start + 4 * 1024 * 1024 - 1;
      assert.equal(counts[`bytes=${start}-${end}`], 1);
    }
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
