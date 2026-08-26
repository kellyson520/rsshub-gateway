import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import {
  boundedInteger,
  documentCacheKind,
  imageVariantCacheUrl,
  isEhImagePageTarget,
  mapWithConcurrency,
  mediaFileName,
  parseProbeTargets,
  publicBaseUrl,
  readLimited,
  readBinaryLimited,
  requestedImageVariantWidth,
  writeBuffer,
  writeJson,
  writeText,
} from '../src/http-utils.js';

test('boundedInteger clamps and falls back', () => {
  assert.equal(boundedInteger('5', 3, 1, 10), 5);
  assert.equal(boundedInteger('50', 3, 1, 10), 10);
  assert.equal(boundedInteger('abc', 3, 1, 10), 3);
  assert.equal(boundedInteger(undefined, 3, 1, 10), 3);
});

test('documentCacheKind maps e-hentai image pages to eh-image', () => {
  assert.equal(documentCacheKind('https://e-hentai.org/s/abc/123-1', 'html'), 'eh-image');
  assert.equal(documentCacheKind('https://e-hentai.org/g/123/gallery/', 'html'), 'html');
  assert.equal(documentCacheKind('https://x.com/status/1', 'html'), 'html');
  assert.equal(documentCacheKind('https://e-hentai.org/s/abc/123-1', 'rss'), 'rss');
});

test('isEhImagePageTarget and imageVariantCacheUrl', () => {
  assert.equal(isEhImagePageTarget('https://e-hentai.org/s/abc/123-1'), true);
  assert.equal(isEhImagePageTarget('https://e-hentai.org/g/123/'), false);
  assert.equal(imageVariantCacheUrl('https://example.com/i.png', 1920), 'https://example.com/i.png#rsshub-gateway-v1-w1920');
});

test('requestedImageVariantWidth validates widths', () => {
  assert.deepEqual(requestedImageVariantWidth(new URLSearchParams('w=1920')), { width: 1920 });
  assert.deepEqual(requestedImageVariantWidth(new URLSearchParams('w=111')), { error: true });
  assert.deepEqual(requestedImageVariantWidth(new URLSearchParams('')), { width: undefined });
});

test('parseProbeTargets handles JSON, defaults and host overrides', () => {
  const parsed = parseProbeTargets(JSON.stringify({ public: ['https://a.com/'], sticky: ['https://b.com/'], hosts: { 'x.com': 'sticky' } }), 'https://e-hentai.org/');
  assert.deepEqual(parsed.public, ['https://a.com/']);
  assert.deepEqual(parsed.sticky, ['https://b.com/']);
  assert.deepEqual(parsed.hosts, { 'x.com': 'sticky' });
  const fallback = parseProbeTargets(undefined, 'https://e-hentai.org/');
  assert.deepEqual(fallback.public, ['https://e-hentai.org/']);
  assert.ok(fallback.sticky.length >= 2);
});

test('mediaFileName and publicBaseUrl', () => {
  assert.equal(mediaFileName('https://example.com/v/video.mp4', 'video/mp4'), 'video.mp4');
  assert.equal(mediaFileName('https://example.com/v/video', 'video/mp4'), 'video.mp4');
  assert.equal(mediaFileName('not a url', 'video/mp4'), 'download.bin');
  assert.equal(publicBaseUrl({ headers: { host: 'gw.example.com', 'x-forwarded-proto': 'http' } }), 'http://gw.example.com');
});

test('readLimited and readBinaryLimited read response bodies with limits', async () => {
  const text = await readLimited(new Response('hello world'), 100);
  assert.equal(text, 'hello world');
  const bin = await readBinaryLimited(new Response('abc'), 10);
  assert.deepEqual(bin, Buffer.from('abc'));
  await assert.rejects(() => readLimited(new Response('hello world'), 4), /too large/);
});

test('mapWithConcurrency runs all items bounded by concurrency', async () => {
  const seen = [];
  const results = await mapWithConcurrency([1, 2, 3, 4, 5], 2, async (value) => {
    seen.push(value);
    return value * 2;
  });
  assert.deepEqual(results, [2, 4, 6, 8, 10]);
  assert.equal(seen.length, 5);
});

test('writeJson writes status and json body', async () => {
  const server = http.createServer((req, res) => writeJson(res, 200, { ok: true }));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  const response = await fetch(`http://127.0.0.1:${port}/`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  server.close();
});

test('writeText and writeBuffer write correct headers and bodies', async () => {
  const server = http.createServer((req, res) => {
    if (req.url === '/text') writeText(res, 200, 'hello text');
    else if (req.url === '/buffer') writeBuffer(res, 200, Buffer.from('hello buffer'), 'application/octet-stream');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;

  const resText = await fetch(`http://127.0.0.1:${port}/text`);
  assert.equal(resText.status, 200);
  assert.equal(await resText.text(), 'hello text');

  const resBuf = await fetch(`http://127.0.0.1:${port}/buffer`);
  assert.equal(resBuf.status, 200);
  assert.equal(resBuf.headers.get('content-type'), 'application/octet-stream');
  assert.equal(await resBuf.text(), 'hello buffer');
  server.close();
});

test('createConcurrencyLimiter throttles concurrent tasks', async () => {
  const { createConcurrencyLimiter } = await import('../src/http-utils.js');
  const limit = createConcurrencyLimiter(2);
  let active = 0;
  let maxActive = 0;

  const tasks = Array.from({ length: 6 }, (_, i) => limit(async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((r) => setTimeout(r, 10));
    active -= 1;
    return i;
  }));

  const results = await Promise.all(tasks);
  assert.deepEqual(results, [0, 1, 2, 3, 4, 5]);
  assert.equal(maxActive, 2);
});

test('readSecret and readSources handle default and fallback states', async () => {
  const { readSecret, readSources, writeGatewayError } = await import('../src/http-utils.js');
  assert.equal(typeof readSecret(), 'string');
  assert.ok(readSecret().length > 0);
  assert.equal(typeof readSources(), 'object');

  // Verify writeGatewayError writes proper status and headers
  let writtenStatus = 0;
  let writtenHeaders = {};
  let writtenBody = '';
  const mockRes = {
    writeHead(status, headers) {
      writtenStatus = status;
      writtenHeaders = headers;
    },
    end(body) {
      writtenBody = body;
    },
  };
  writeGatewayError(mockRes, { status: 503, source: 'x', attempts: 3, retryAfter: 10 });
  assert.equal(writtenStatus, 503);
  assert.equal(writtenHeaders['x-gateway-source'], 'x');
  assert.equal(writtenHeaders['x-gateway-attempts'], '3');
  assert.equal(writtenHeaders['retry-after'], '10');
  assert.equal(writtenBody, 'upstream unavailable\n');
});

test('parseByteRange parses single, suffix, open-ended and unsatisfiable ranges', async () => {
  const { parseByteRange } = await import('../src/http-utils.js');
  assert.deepEqual(parseByteRange('bytes=0-499', 1000), { start: 0, end: 499 });
  assert.deepEqual(parseByteRange('bytes=500-', 1000), { start: 500, end: 999 });
  assert.deepEqual(parseByteRange('bytes=-200', 1000), { start: 800, end: 999 });
  assert.deepEqual(parseByteRange('bytes=1000-1200', 1000), { unsatisfiable: true });
  assert.deepEqual(parseByteRange('bytes=0-2000', 1000), { start: 0, end: 999 });
  assert.deepEqual(parseByteRange('bytes=500-200', 1000), { unsatisfiable: true });
  assert.equal(parseByteRange(null, 1000), null);
  assert.equal(parseByteRange('invalid', 1000), null);
  assert.equal(parseByteRange('bytes=0-100,200-300', 1000), null);
  assert.equal(parseByteRange('bytes=-', 1000), null);
});

test('createConcurrencyLimiter bounds active concurrent tasks', async () => {
  const { createConcurrencyLimiter } = await import('../src/http-utils.js');
  const limiter = createConcurrencyLimiter(2);
  let active = 0;
  let maxActive = 0;

  const tasks = Array.from({ length: 6 }, async (_, i) => {
    return limiter(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active -= 1;
      return i * 10;
    });
  });

  const results = await Promise.all(tasks);
  assert.equal(maxActive, 2);
  assert.deepEqual(results, [0, 10, 20, 30, 40, 50]);
});

test('decodeJwtPayload, jwtExpiryMs and asDate helpers format and parse correctly', async () => {
  const { decodeJwtPayload, jwtExpiryMs, asDate } = await import('../src/http-utils.js');
  
  // JWT
  const now = 1_700_000_000_000;
  const validExp = Math.floor(now / 1000) + 3600;
  const payloadStr = Buffer.from(JSON.stringify({ sub: 'user123', exp: validExp, type: 'access_token' })).toString('base64url');
  const dummyJwt = `header.${payloadStr}.signature`;

  assert.deepEqual(decodeJwtPayload(dummyJwt), { sub: 'user123', exp: validExp, type: 'access_token' });
  assert.equal(jwtExpiryMs(dummyJwt, { now: () => now }), 3600 * 1000);
  assert.equal(decodeJwtPayload('invalid.token'), null);
  assert.equal(jwtExpiryMs('invalid.token'), null);

  // asDate
  assert.equal(asDate('2026-08-26 12:00:00'), new Date('2026-08-26T12:00:00Z').toUTCString());
  assert.equal(asDate('invalid-date'), '');
  assert.equal(asDate(''), '');
  assert.equal(asDate(null), '');
});

test('exports CACHE_RESPONSE_HEADERS, DEFAULT_READ_LIMIT_BYTES and IMAGE_VARIANT_CACHE_VERSION constants', async () => {
  const {
    CACHE_RESPONSE_HEADERS,
    DEFAULT_READ_LIMIT_BYTES,
    IMAGE_VARIANT_CACHE_VERSION,
  } = await import('../src/http-utils.js');
  assert.ok(Array.isArray(CACHE_RESPONSE_HEADERS));
  assert.ok(CACHE_RESPONSE_HEADERS.includes('content-type'));
  assert.ok(CACHE_RESPONSE_HEADERS.includes('etag'));
  assert.equal(DEFAULT_READ_LIMIT_BYTES, 4 * 1024 * 1024);
  assert.equal(IMAGE_VARIANT_CACHE_VERSION, 'v1');
});
