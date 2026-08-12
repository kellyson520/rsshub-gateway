import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { createResponseCache } from '../src/cache.js';
import {
  createMediaTransport,
  parseByteRange,
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
