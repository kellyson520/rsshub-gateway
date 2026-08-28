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

test('clamp, positiveInteger, nonNegativeInteger and boundedInteger restrict numbers within bounds', async () => {
  const { nonNegativeInteger, positiveInteger } = await import('../src/http-utils.js');

  assert.equal(clamp(5, 1, 10), 5);
  assert.equal(clamp(50, 1, 10), 10);
  assert.equal(clamp(-5, 0, 10), 0);
  assert.equal(clamp(NaN, 0, 10), 0);
  assert.equal(clamp('invalid', 0, 10), 0);

  assert.equal(positiveInteger('5', 1), 5);
  assert.equal(positiveInteger('0', 1), 1);
  assert.equal(positiveInteger('-5', 1), 1);
  assert.equal(positiveInteger('abc', 1), 1);

  assert.equal(nonNegativeInteger('5', 0), 5);
  assert.equal(nonNegativeInteger('0', 10), 0);
  assert.equal(nonNegativeInteger('-5', 0), 0);
  assert.equal(nonNegativeInteger('abc', 0), 0);

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

test('requestedImageVariantWidth, isValidImageVariantWidth and isSupportedImageVariantType validate widths and mime types', async () => {
  const {
    isValidImageVariantWidth,
    isSupportedImageVariantType,
    IMAGE_VARIANT_WIDTHS,
    SUPPORTED_IMAGE_VARIANT_TYPES,
  } = await import('../src/http-utils.js');

  assert.deepEqual(requestedImageVariantWidth(new URLSearchParams('w=1920')), { width: 1920 });
  assert.deepEqual(requestedImageVariantWidth(new URLSearchParams('w=111')), { error: true });
  assert.deepEqual(requestedImageVariantWidth(new URLSearchParams('')), { width: undefined });

  assert.equal(isValidImageVariantWidth(1280), true);
  assert.equal(isValidImageVariantWidth(1920), true);
  assert.equal(isValidImageVariantWidth(2560), true);
  assert.equal(isValidImageVariantWidth(100), false);
  assert.equal(isValidImageVariantWidth(null), false);

  assert.equal(isSupportedImageVariantType('image/jpeg'), true);
  assert.equal(isSupportedImageVariantType('image/png; charset=utf-8'), true);
  assert.equal(isSupportedImageVariantType('image/webp'), true);
  assert.equal(isSupportedImageVariantType('image/gif'), false);
  assert.equal(isSupportedImageVariantType('text/plain'), false);
  assert.equal(isSupportedImageVariantType(null), false);

  assert.ok(IMAGE_VARIANT_WIDTHS.includes(1920));
  assert.ok(SUPPORTED_IMAGE_VARIANT_TYPES.has('image/webp'));
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

test('align64k and ALIGN_64K round positive byte sizes up to nearest 64KiB boundary', async () => {
  const { align64k, ALIGN_64K } = await import('../src/http-utils.js');
  assert.equal(ALIGN_64K, 65536);
  assert.equal(align64k(1), 65536);
  assert.equal(align64k(65536), 65536);
  assert.equal(align64k(65537), 131072);
  assert.equal(align64k(0), 65536);
  assert.equal(align64k(-100), 65536);
  assert.equal(align64k(null), 65536);
  assert.equal(align64k(undefined), 65536);
});

test('mapWithConcurrency and durationCheckpoint run bounded tasks and compute latency checkpoints', async () => {
  const { durationCheckpoint } = await import('../src/http-utils.js');
  const seen = [];
  const results = await mapWithConcurrency([1, 2, 3, 4, 5], 2, async (value) => {
    seen.push(value);
    return value * 2;
  });
  assert.deepEqual(results, [2, 4, 6, 8, 10]);
  assert.equal(seen.length, 5);

  const samples = [
    { completedAt: 120 },
    { completedAt: 50 },
    { completedAt: 300 },
    { completedAt: 80 },
  ];
  assert.equal(durationCheckpoint(samples, 1), 50);
  assert.equal(durationCheckpoint(samples, 2), 80);
  assert.equal(durationCheckpoint(samples, 3), 120);
  assert.equal(durationCheckpoint(samples, 4), 300);
  assert.equal(durationCheckpoint(samples, 0), 0);
  assert.equal(durationCheckpoint([], 2), 0);
  assert.equal(durationCheckpoint(null, 2), 0);
});

test('HttpError creates typed Error with status property', async () => {
  const { HttpError } = await import('../src/http-utils.js');
  const err = new HttpError(404, 'not found');
  assert.ok(err instanceof Error);
  assert.equal(err.name, 'HttpError');
  assert.equal(err.status, 404);
  assert.equal(err.message, 'not found');
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

test('sha256Hex and isSha256Hex format and validate 64-character lowercase hexadecimal digests', async () => {
  const { sha256Hex, isSha256Hex } = await import('../src/http-utils.js');
  const digest = sha256Hex('hello world');
  assert.equal(digest, 'b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9');
  assert.equal(isSha256Hex(digest), true);
  assert.equal(isSha256Hex(digest.toUpperCase()), false);
  assert.equal(isSha256Hex('short'), false);
  assert.equal(isSha256Hex(null), false);
  assert.equal(isSha256Hex(undefined), false);
  assert.equal(isSha256Hex(123), false);

  assert.equal(sha256Hex(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assert.equal(sha256Hex(null), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
});

test('base64UrlEncode and base64UrlDecode serialize and deserialize Base64URL strings safely', async () => {
  const { base64UrlEncode, base64UrlDecode } = await import('../src/http-utils.js');

  const text = 'hello-world-payload?123';
  const encoded = base64UrlEncode(text);
  assert.equal(encoded, Buffer.from(text).toString('base64url'));
  assert.equal(base64UrlDecode(encoded), text);

  assert.equal(base64UrlEncode(Buffer.from('binary-data')), Buffer.from('binary-data').toString('base64url'));
  assert.equal(base64UrlEncode(null), '');
  assert.equal(base64UrlEncode(undefined), '');

  assert.equal(base64UrlDecode(null, 'fallback'), 'fallback');
  assert.equal(base64UrlDecode(undefined, 'fallback'), 'fallback');
  assert.equal(base64UrlDecode('', 'default'), '');
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

test('withoutCredentials, isAuthenticationRedirect and isAuthenticationChallenge handle security challenges properly', async () => {
  const { withoutCredentials, isAuthenticationRedirect, isAuthenticationChallenge } = await import('../src/http-utils.js');

  const headers = {
    'cookie': 'session=xyz',
    'authorization': 'Bearer secret',
    'accept': 'text/html',
    'user-agent': 'custom-agent',
  };
  assert.deepEqual(withoutCredentials(headers), {
    'accept': 'text/html',
    'user-agent': 'custom-agent',
  });
  assert.deepEqual(withoutCredentials(null), {});

  assert.equal(isAuthenticationRedirect({ status: 302, headers: { location: 'https://example.com/login' } }), true);
  assert.equal(isAuthenticationRedirect({ status: 301, headers: { get: () => '/accounts/login' } }), true);
  assert.equal(isAuthenticationRedirect({ status: 200, headers: { location: '/login' } }), false);
  assert.equal(isAuthenticationRedirect({ status: 302, headers: { location: 'https://example.com/item/123' } }), false);
  assert.equal(isAuthenticationRedirect(null), false);

  assert.equal(await isAuthenticationChallenge({ status: 401 }), true);
  assert.equal(await isAuthenticationChallenge({ status: 302, headers: { location: '/login' } }), true);
  assert.equal(await isAuthenticationChallenge({ status: 200 }, 'https://example.com', () => true), true);
  assert.equal(await isAuthenticationChallenge({ status: 200 }, 'https://example.com', () => false), false);
  assert.equal(await isAuthenticationChallenge({ status: 200 }, 'https://example.com', () => { throw new Error('fail'); }), false);
});

test('HOTLINK_REFERERS and refererFor correctly identify hotlinking-protected upstream media targets', async () => {
  const { HOTLINK_REFERERS, refererFor } = await import('../src/http-utils.js');

  assert.equal(refererFor('https://www.javbus.com/pics/thumb.jpg'), 'https://www.javbus.com/');
  assert.equal(refererFor('https://img.jpgcdn.com/sample.jpg'), 'https://www.javbus.com/');
  assert.equal(refererFor('https://pics.dmm.co.jp/cover.jpg'), 'https://www.dmm.co.jp/');
  assert.equal(refererFor('https://cdn.jable.tv/video.mp4'), 'https://jable.tv/');
  assert.equal(refererFor('https://custom.example.com/pic.png', { 'example.com': 'https://example.com/' }), 'https://example.com/');
  assert.equal(refererFor('https://github.com/'), undefined);
  assert.equal(refererFor('invalid-url'), undefined);
  assert.equal(refererFor(null), undefined);
  assert.ok(Object.isFrozen(HOTLINK_REFERERS));
});

test('isRetryableStatus, isSuccessfulStatus and isClientAbortError handle status codes and network disconnections', async () => {
  const {
    isRetryableStatus,
    isSuccessfulStatus,
    isClientAbortError,
    RETRYABLE_STATUSES,
    DEFAULT_BLOCKED_STATUSES,
  } = await import('../src/http-utils.js');

  assert.equal(isRetryableStatus(429), true);
  assert.equal(isRetryableStatus(503), true);
  assert.equal(isRetryableStatus('500'), false);
  assert.equal(isRetryableStatus(404), false);
  assert.equal(isRetryableStatus(200), false);
  assert.equal(isRetryableStatus(null), false);

  assert.equal(isSuccessfulStatus(200), true);
  assert.equal(isSuccessfulStatus(204), true);
  assert.equal(isSuccessfulStatus('206'), false);
  assert.equal(isSuccessfulStatus(302), false);
  assert.equal(isSuccessfulStatus(500), false);

  assert.equal(isClientAbortError(new Error('Premature close')), false);
  assert.equal(isClientAbortError({ code: 'ECONNRESET' }), true);
  assert.equal(isClientAbortError({ code: 'ERR_STREAM_PREMATURE_CLOSE' }), true);
  assert.equal(isClientAbortError({ code: 'ABORT_ERR' }), true);
  assert.equal(isClientAbortError(new Error('request was aborted')), true);
  assert.equal(isClientAbortError(new Error('client response closed')), true);
  assert.equal(isClientAbortError(null), false);

  assert.ok(RETRYABLE_STATUSES.has(429));
  assert.ok(DEFAULT_BLOCKED_STATUSES.has(403));
});

test('safeJsonParse parses valid json safely and returns fallback for corrupt payloads', async () => {
  const { safeJsonParse } = await import('../src/http-utils.js');

  assert.deepEqual(safeJsonParse('{"a":1,"b":"two"}'), { a: 1, b: 'two' });
  assert.deepEqual(safeJsonParse(Buffer.from('["item1","item2"]')), ['item1', 'item2']);
  assert.deepEqual(safeJsonParse({ already: 'object' }), { already: 'object' });
  assert.equal(safeJsonParse('{corrupted json', 'fallback-val'), 'fallback-val');
  assert.equal(safeJsonParse(null, 'default'), 'default');
  assert.equal(safeJsonParse(undefined, 'default'), 'default');
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

test('safeHost, isHostOrSubdomain, matchesHost, parseHostList and parseStatusList handle hosts and HTTP status codes safely', async () => {
  const { safeHost, isHostOrSubdomain, matchesHost, parseHostList, parseStatusList } = await import('../src/http-utils.js');

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

  assert.deepEqual(parseStatusList('401, 403, 429, 403'), [401, 403, 429]);
  assert.deepEqual(parseStatusList([408, 429, 503]), [408, 429, 503]);
  assert.deepEqual(parseStatusList(new Set([403, 404, 403])), [403, 404]);
  assert.deepEqual(parseStatusList('invalid, 99, 600, 502'), [502]);
  assert.deepEqual(parseStatusList(null, [403, 429]), [403, 429]);
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

test('isValidXmlCodePoint, decodeEntity, decodeTextEntities and normalizeNumericEntities handle XML/HTML character entities safely', async () => {
  const {
    isValidXmlCodePoint,
    decodeEntity,
    decodeTextEntities,
    normalizeNumericEntities,
    XML_NAMED_ENTITIES,
  } = await import('../src/http-utils.js');

  assert.equal(isValidXmlCodePoint(0x9), true);
  assert.equal(isValidXmlCodePoint(0x20), true);
  assert.equal(isValidXmlCodePoint(0x0), false);
  assert.equal(isValidXmlCodePoint(0x1), false);
  assert.equal(isValidXmlCodePoint(0xd800), false);

  assert.equal(decodeEntity('&amp;'), '&');
  assert.equal(decodeEntity('&apos;'), "'");
  assert.equal(decodeEntity('&quot;'), '"');
  assert.equal(decodeEntity('&lt;'), '<');
  assert.equal(decodeEntity('&gt;'), '>');
  assert.equal(decodeEntity('&#x4f60;'), '你');
  assert.equal(decodeEntity('&#20320;'), '你');
  assert.equal(decodeEntity('&unknown;'), '&unknown;');
  assert.equal(decodeEntity('plain'), 'plain');
  assert.equal(decodeEntity(null), null);
  assert.equal(decodeEntity(undefined), undefined);

  assert.equal(decodeTextEntities('&lt;hello&gt; &amp; &quot;world&quot;'), '<hello> & "world"');
  assert.equal(decodeTextEntities(null), '');

  assert.equal(normalizeNumericEntities('&#x4f60;&#x597d;'), '你好');
  assert.equal(normalizeNumericEntities('&#60;&#62;&#38;'), '&#60;&#62;&#38;'); // brackets & amp preserved
  assert.equal(normalizeNumericEntities(null), '');

  assert.equal(XML_NAMED_ENTITIES.quot, '"');
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

test('cleanText collapses whitespace and trims string cleanly', async () => {
  const { cleanText } = await import('../src/http-utils.js');

  assert.equal(cleanText('  hello   world \n \t  '), 'hello world');
  assert.equal(cleanText(''), '');
  assert.equal(cleanText(null), '');
  assert.equal(cleanText(undefined), '');
  assert.equal(cleanText(12345), '12345');
});

test('escapeHtml, escapeXml and cdata safely encode text entities and CDATA payload blocks', async () => {
  const { escapeHtml, escapeXml, cdata } = await import('../src/http-utils.js');

  assert.equal(escapeHtml('<div class="box" id=\'1\'>Tom & Jerry</div>'), '&lt;div class=&quot;box&quot; id=&#39;1&#39;&gt;Tom &amp; Jerry&lt;/div&gt;');
  assert.equal(escapeHtml(null), '');

  assert.equal(escapeXml('<item title="A&B\'s">test</item>'), '&lt;item title=&quot;A&amp;B&apos;s&quot;&gt;test&lt;/item&gt;');
  assert.equal(escapeXml(null), '');

  assert.equal(cdata('raw text'), '<![CDATA[raw text]]>');
  assert.equal(cdata('a ]]> b'), '<![CDATA[a ]]]]><![CDATA[> b]]>');
  assert.equal(cdata(null), '<![CDATA[]]>');
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

test('promLabel and sourceMetricName sanitize prometheus metric and label names', async () => {
  const { promLabel, sourceMetricName } = await import('../src/http-utils.js');
  assert.equal(promLabel('normal_value'), 'normal_value');
  assert.equal(promLabel('line1\nline2'), 'line1\\nline2');
  assert.equal(promLabel('quote"and\\backslash'), 'quote\\"and\\\\backslash');
  assert.equal(promLabel(null), '');

  assert.equal(sourceMetricName('iwara'), 'source_iwara_duration_seconds');
  assert.equal(sourceMetricName('e-hentai'), 'source_e_hentai_duration_seconds');
  assert.equal(sourceMetricName('  Custom.Source--Name  '), 'source_custom_source_name_duration_seconds');
  assert.equal(sourceMetricName(''), null);
  assert.equal(sourceMetricName(null), null);
});

test('downloadSessionView and withPrefetchStatus project download session and prefetch state safely', async () => {
  const { downloadSessionView, withPrefetchStatus } = await import('../src/http-utils.js');
  const dummySession = {
    id: 'session-123',
    size: 1048576,
    chunkSize: 524288,
    doneBytes: 524288,
    chunks: [
      { index: 0, start: 0, end: 524287, size: 524288, status: 'done', url: 'https://example.com/c0' },
      { index: 1, start: 524288, end: 1048575, size: 524288, status: 'pending', url: 'https://example.com/c1' },
    ],
  };

  const view = downloadSessionView(dummySession);
  assert.equal(view.id, 'session-123');
  assert.equal(view.count, 2);
  assert.equal(view.doneChunks, 1);
  assert.equal(view.doneBytes, 524288);
  assert.deepEqual(view.urls, ['https://example.com/c0', 'https://example.com/c1']);

  const withPrefetch = withPrefetchStatus(view, 'https://example.com/video.mp4', (target) => ({
    target,
    state: 'running',
  }));
  assert.deepEqual(withPrefetch.prefetch, { target: 'https://example.com/video.mp4', state: 'running' });

  assert.equal(downloadSessionView(null), null);
  assert.equal(withPrefetchStatus(null, 'target', () => {}), null);
});

test('initialEhGalleryManifest constructs gallery initial cold-state structure cleanly', async () => {
  const { initialEhGalleryManifest } = await import('../src/http-utils.js');
  const mockAdapter = {
    imagePageUrls: (html, target) => ['https://example.com/p1', 'https://example.com/p2', 'https://example.com/p3'],
    galleryPageUrls: (html, target) => ['https://example.com/g/1', 'https://example.com/g/2'],
  };

  const manifest = initialEhGalleryManifest({
    adapter: mockAdapter,
    target: 'https://example.com/g/1',
    initialHtml: '<html><head><title>Sample Gallery</title></head></html>',
    maxPages: 2,
    extractTitle: () => 'Sample Gallery Title',
  });

  assert.deepEqual(manifest.imageUrls, ['https://example.com/p1', 'https://example.com/p2']);
  assert.deepEqual(manifest.galleryUrls, ['https://example.com/g/1', 'https://example.com/g/2']);
  assert.equal(manifest.totalPages, 2);
  assert.equal(manifest.status, 200);
  assert.equal(manifest.title, 'Sample Gallery Title');
  assert.equal(manifest.truncated, false);
  assert.deepEqual(manifest.failures, []);

  assert.equal(initialEhGalleryManifest(null), null);
  assert.equal(initialEhGalleryManifest({}), null);
});

test('failureMessage and routeBucket provide degradation messaging and route classification', async () => {
  const { failureMessage, routeBucket } = await import('../src/http-utils.js');
  assert.equal(failureMessage('gallery', 2), '画廊分页 2 暂时无法读取');
  assert.equal(failureMessage('image', 5), '第 5 页暂时无法读取');

  assert.equal(routeBucket('/healthz'), 'healthz');
  assert.equal(routeBucket('/readyz'), 'readyz');
  assert.equal(routeBucket('/_gateway/lease/create'), 'lease');
  assert.equal(routeBucket('/_gateway/chunk/123'), 'chunk');
  assert.equal(routeBucket('/_gateway/infra/stats'), 'infra');
  assert.equal(routeBucket('/_gateway/prefetch/queue'), 'prefetch');
  assert.equal(routeBucket('/_gateway/metrics'), 'metrics');
  assert.equal(routeBucket('/_gateway/item/token'), 'item');
  assert.equal(routeBucket('/_gateway/media/token'), 'media');
  assert.equal(routeBucket('/ehviewer/ranking'), 'ehviewer');
  assert.equal(routeBucket('/feed/rss.xml'), 'feed');
  assert.equal(routeBucket(null), 'feed');
});

test('compilePattern, normalizeRoute, matchSegments and sidecarUrl provide route pattern matching and sidecar url resolution', async () => {
  const {
    compilePattern,
    normalizeRoute,
    matchSegments,
    sidecarUrl,
  } = await import('../src/http-utils.js');

  const pattern = compilePattern('/user/:id/posts/:page?/*');
  assert.deepEqual(pattern, [
    { type: 'literal', value: 'user' },
    { type: 'param', name: 'id' },
    { type: 'literal', value: 'posts' },
    { type: 'optional', name: 'page' },
    { type: 'star' },
  ]);

  assert.throws(() => compilePattern('/*/extra'), /must be the last segment/);

  const route = normalizeRoute({
    routeId: '/iwara/video/:id',
    backend: 'sidecar://127.0.0.1:8001',
    fallback_upstream: true,
    cacheTtl: 3600,
  });
  assert.equal(route.routeId, '/iwara/video/:id');
  assert.equal(route.backend, 'sidecar://127.0.0.1:8001');
  assert.equal(route.fallbackUpstream, true);
  assert.equal(route.cacheTtl, 3600);
  assert.equal(normalizeRoute(null), null);
  assert.equal(normalizeRoute({}), null);

  const matched = matchSegments(pattern, ['user', 'alice', 'posts', '2', 'deep', 'link']);
  assert.deepEqual(matched, { id: 'alice', page: '2' });

  const optionalPattern = compilePattern('/user/:id/:page?');
  const matchedOptional = matchSegments(optionalPattern, ['user', 'bob']);
  assert.deepEqual(matchedOptional, { id: 'bob' });

  assert.equal(matchSegments(pattern, ['user']), null);
  assert.equal(matchSegments(null, ['user']), null);

  assert.equal(sidecarUrl('sidecar://127.0.0.1:8000/'), 'http://127.0.0.1:8000');
  assert.equal(sidecarUrl('https://example.com'), null);
  assert.equal(sidecarUrl(null), null);
});

test('cookiesObject and resolveRedirect parse cookie headers and resolve route templates', async () => {
  const { cookiesObject, resolveRedirect } = await import('../src/http-utils.js');

  const cookieStr = 'session=abc; token=123; tracking=xyz; empty=';
  assert.deepEqual(cookiesObject(cookieStr), {
    session: 'abc',
    token: '123',
    tracking: 'xyz',
    empty: '',
  });

  assert.deepEqual(cookiesObject({ a: 1, b: 'two' }), { a: '1', b: 'two' });
  assert.deepEqual(cookiesObject(null), {});
  assert.deepEqual(cookiesObject(undefined), {});

  assert.equal(resolveRedirect('/user/:id/posts/:page?', { id: 'alice', page: 2 }), '/user/alice/posts/2');
  assert.equal(resolveRedirect('/user/:id/posts/:page?', { id: 'alice' }), '/user/alice/posts');
  assert.equal(resolveRedirect('/tag/:name', { name: 'c++ & rust' }), '/tag/c%2B%2B%20%26%20rust');
  assert.equal(resolveRedirect(null), null);
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
