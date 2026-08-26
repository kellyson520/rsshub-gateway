import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import {
  boundedInteger,
  clamp,
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

test('clamp and boundedInteger restrict numbers within bounds', () => {
  assert.equal(clamp(5, 1, 10), 5);
  assert.equal(clamp(50, 1, 10), 10);
  assert.equal(clamp(-5, 0, 10), 0);
  assert.equal(clamp(NaN, 0, 10), 0);
  assert.equal(clamp('invalid', 0, 10), 0);

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

test('sha256Hex produces deterministic lowercase hex digest', async () => {
  const { sha256Hex } = await import('../src/http-utils.js');
  assert.equal(sha256Hex('hello world'), 'b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9');
  assert.equal(sha256Hex(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assert.equal(sha256Hex(null), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
});

test('hmacSha256 and isSignatureMatch compute and verify cryptographic signatures safely', async () => {
  const { hmacSha256, isSignatureMatch, constantTimeEquals } = await import('../src/http-utils.js');
  const secret = 'test-secret';
  const data = 'payload-to-sign';

  const rawDigest = hmacSha256(data, secret);
  assert.ok(Buffer.isBuffer(rawDigest));

  const hexDigest = hmacSha256(data, secret, 'hex');
  const base64urlDigest = hmacSha256(data, secret, 'base64url');
  assert.equal(typeof hexDigest, 'string');
  assert.equal(typeof base64urlDigest, 'string');

  assert.equal(isSignatureMatch(base64urlDigest, rawDigest), true);
  assert.equal(isSignatureMatch(base64urlDigest, hmacSha256('tampered', secret)), false);
  assert.equal(isSignatureMatch('invalid-sig', rawDigest), false);
  assert.equal(isSignatureMatch(null, rawDigest), false);

  assert.equal(constantTimeEquals('secret-password', 'secret-password'), true);
  assert.equal(constantTimeEquals('secret-password', 'wrong-password'), false);
  assert.equal(constantTimeEquals(null, 'password'), false);
});

test('isBearerAuthorized validates authorization header in constant time', async () => {
  const { isBearerAuthorized } = await import('../src/http-utils.js');
  const token = 'my-secret-token-123';

  assert.equal(isBearerAuthorized(`Bearer ${token}`, token), true);
  assert.equal(isBearerAuthorized({ headers: { authorization: `Bearer ${token}` } }, token), true);
  assert.equal(isBearerAuthorized({ headers: { authorization: `Bearer ${token} ` } }, token), true);
  assert.equal(isBearerAuthorized('Bearer wrong-token', token), false);
  assert.equal(isBearerAuthorized('Basic dXNlcjpwYXNz', token), false);
  assert.equal(isBearerAuthorized('', token), false);
  assert.equal(isBearerAuthorized(null, token), false);
  assert.equal(isBearerAuthorized(`Bearer ${token}`, ''), false);
  assert.equal(isBearerAuthorized(`Bearer ${token}`, null), false);
});

test('readJsonBody parses stream payload into JSON object', async () => {
  const { Readable } = await import('node:stream');
  const { readJsonBody } = await import('../src/http-utils.js');

  const stream = Readable.from([Buffer.from('{"hello":'), Buffer.from('"world"}')]);
  const parsed = await readJsonBody(stream);
  assert.deepEqual(parsed, { hello: 'world' });

  const invalidStream = Readable.from([Buffer.from('{invalid')]);
  await assert.rejects(() => readJsonBody(invalidStream), /JSON/);
});

test('safeHost, isHostOrSubdomain, matchesHost and parseHostList handle hostnames safely', async () => {
  const { safeHost, isHostOrSubdomain, matchesHost, parseHostList } = await import('../src/http-utils.js');

  assert.equal(safeHost('https://JavBus.COM/path'), 'javbus.com');
  assert.equal(safeHost('https://sub.domain.org:8080/v/1'), 'sub.domain.org');
  assert.equal(safeHost('not-a-url'), 'unknown');
  assert.equal(safeHost('not-a-url', ''), '');
  assert.equal(safeHost(null), 'unknown');

  assert.equal(isHostOrSubdomain('sub.example.com', 'example.com'), true);
  assert.equal(isHostOrSubdomain('example.com', 'example.com'), true);
  assert.equal(isHostOrSubdomain('fake-example.com', 'example.com'), false);
  assert.equal(isHostOrSubdomain('', 'example.com'), false);
  assert.equal(isHostOrSubdomain(null, 'example.com'), false);

  assert.equal(matchesHost('api.iwara.tv', ['iwara.tv', 'x.com']), true);
  assert.equal(matchesHost('x.com', ['iwara.tv', 'x.com']), true);
  assert.equal(matchesHost('notallowed.com', ['iwara.tv', 'x.com']), false);
  assert.equal(matchesHost('', ['iwara.tv']), false);

  assert.deepEqual(parseHostList('e-hentai.org, EHGT.ORG, e-hentai.org'), ['e-hentai.org', 'ehgt.org']);
  assert.deepEqual(parseHostList('["example.com", "API.EXAMPLE.COM", "example.com"]'), ['example.com', 'api.example.com']);
  assert.deepEqual(parseHostList(null), []);
  assert.deepEqual(parseHostList(''), []);
});

test('sleep resolves after specified delay', async () => {
  const { sleep } = await import('../src/http-utils.js');
  const started = Date.now();
  await sleep(15);
  assert.ok(Date.now() - started >= 10);
  await sleep(-10); // should resolve immediately without throwing
});

test('withDeadline resolves value or times out gracefully', async () => {
  const { withDeadline } = await import('../src/http-utils.js');

  const fast = await withDeadline(Promise.resolve('success'), 50);
  assert.deepEqual(fast, { value: 'success', timedOut: false });

  const slow = await withDeadline(new Promise(() => {}), 10, 'fallback-val');
  assert.deepEqual(slow, { value: 'fallback-val', timedOut: true });

  const failing = await withDeadline(Promise.reject(new Error('boom')), 50, null);
  assert.deepEqual(failing, { value: null, timedOut: false });
});

test('dedupe removes duplicate items preserving order and supports key mapper', async () => {
  const { dedupe } = await import('../src/http-utils.js');
  assert.deepEqual(dedupe(['a', 'b', 'a', 'c', 'b']), ['a', 'b', 'c']);
  assert.deepEqual(dedupe([{ id: 1 }, { id: 2 }, { id: 1 }], (x) => x.id), [{ id: 1 }, { id: 2 }]);
  assert.deepEqual(dedupe(null), []);
  assert.deepEqual(dedupe(undefined), []);
  assert.deepEqual(dedupe('single'), ['single']);
});

test('normalizeHeaderMap and canonicalHeadersString sort and sanitize headers deterministically', async () => {
  const { normalizeHeaderMap, canonicalHeadersString } = await import('../src/http-utils.js');
  
  assert.deepEqual(normalizeHeaderMap({ 'Authorization': 'Bearer token', 'Cookie': 'sid=123' }), [
    ['authorization', 'Bearer token'],
    ['cookie', 'sid=123'],
  ]);

  assert.equal(
    canonicalHeadersString({ 'B': '2', 'A': '1', 'Empty': '' }),
    'a=1\nb=2',
  );

  assert.equal(canonicalHeadersString(null), '');
  assert.equal(canonicalHeadersString(undefined), '');
});

test('atomicWriteJson safely creates target directory and writes valid JSON atomically', async () => {
  const { atomicWriteJson } = await import('../src/http-utils.js');
  const os = await import('node:os');
  const path = await import('node:path');
  const fsp = await import('node:fs/promises');

  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'atomic-json-'));
  const targetFile = path.join(tmpDir, 'nested', 'sub', 'test.json');

  try {
    const ok = await atomicWriteJson(targetFile, { a: 1, b: 'two' }, { mode: 0o600 });
    assert.equal(ok, true);

    const content = JSON.parse(await fsp.readFile(targetFile, 'utf8'));
    assert.deepEqual(content, { a: 1, b: 'two' });

    assert.equal(await atomicWriteJson(null, { a: 1 }), false);
  } finally {
    await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
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
