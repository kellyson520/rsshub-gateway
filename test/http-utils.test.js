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

test('isEhImagePageTarget, isEhentaiPage, EH_GALLERY_PATH, EH_IMAGE_PATH and imageVariantCacheUrl', async () => {
  const { isEhImagePageTarget, isEhentaiPage, EH_GALLERY_PATH, EH_IMAGE_PATH, imageVariantCacheUrl } = await import('../src/http-utils.js');
  assert.equal(isEhImagePageTarget('https://e-hentai.org/s/abc/123-1'), true);
  assert.equal(isEhImagePageTarget('https://e-hentai.org/g/123/'), false);
  assert.equal(isEhentaiPage('https://e-hentai.org/g/123/456/', EH_GALLERY_PATH), true);
  assert.equal(isEhentaiPage('https://e-hentai.org/s/123/456-1', EH_IMAGE_PATH), true);
  assert.equal(isEhentaiPage('https://other.org/g/123/456/', EH_GALLERY_PATH), false);
  assert.equal(isEhentaiPage(null, EH_GALLERY_PATH), false);
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

test('isAllowedTarget, routeMetadata and isTargetSignatureValid validate URL targets, route scopes and target tokens', async () => {
  const {
    isAllowedTarget,
    routeMetadata,
    isTargetSignatureValid,
    ALLOWED_HOSTS,
    EGRESS_SCOPES,
    hmacSha256,
  } = await import('../src/http-utils.js');

  assert.equal(isAllowedTarget('https://x.com/user/avatar.jpg'), true);
  assert.equal(isAllowedTarget('https://e-hentai.org/g/123/456/'), true);
  assert.equal(isAllowedTarget('http://playno1.com/cover.jpg'), true);
  assert.equal(isAllowedTarget('https://127.0.0.1/malicious'), false);
  assert.equal(isAllowedTarget('https://evil.attacker.com/image.jpg'), false);
  assert.equal(isAllowedTarget('ftp://example.com/file'), false);
  assert.equal(isAllowedTarget(null), false);

  assert.deepEqual(routeMetadata({ egressScope: 'session', source: 'twitter' }), { egressScope: 'session', source: 'twitter' });
  assert.deepEqual(routeMetadata({}), {});
  assert.throws(() => routeMetadata({ egressScope: 'invalid' }), /unsupported egress scope/);
  assert.throws(() => routeMetadata({ source: '??bad source' }), /unsupported route source/);

  const payload = 'eyJ1cmwiOiJodHRwczovL3guY29tIn0';
  const secret = 'sig-secret';
  const validSig = hmacSha256(payload, secret, 'base64url');
  assert.equal(isTargetSignatureValid(`${payload}.${validSig}`, secret), true);
  assert.equal(isTargetSignatureValid(`${payload}.invalid`, secret), false);
  assert.equal(isTargetSignatureValid(null, secret), false);

  assert.equal(EGRESS_SCOPES.has('public'), true);
  assert.equal(EGRESS_SCOPES.has('session'), true);
  assert.equal(EGRESS_SCOPES.has('sticky'), true);
  assert.equal(ALLOWED_HOSTS.includes('x.com'), true);
  assert.equal(ALLOWED_HOSTS.includes('e-hentai.org'), true);
});

test('publicLeaseView, isChunkSignatureValid and DEFAULT_LEASE constants project leases and validate chunk signatures', async () => {
  const {
    publicLeaseView,
    isChunkSignatureValid,
    DEFAULT_LEASE_TTL_MS,
    DEFAULT_LEASE_MAX_BYTES,
    DEFAULT_LEASE_MAX_CONCURRENCY,
    hmacSha256,
  } = await import('../src/http-utils.js');

  const dummyLease = {
    username: 'user123',
    password: 'pwd456',
    targetUrl: 'https://example.com/stream.mp4',
    resolvedUrl: 'https://example.com/stream.mp4?auth=ok',
    allowHosts: ['example.com'],
    expiresAt: 1700000000000 + 1800000,
    maxBytes: DEFAULT_LEASE_MAX_BYTES,
    maxConcurrency: DEFAULT_LEASE_MAX_CONCURRENCY,
  };

  const view = publicLeaseView(dummyLease, { proxyHost: '127.0.0.1', proxyPort: 1301 }, () => 1700000000000);
  assert.equal(view.username, 'user123');
  assert.equal(view.password, 'pwd456');
  assert.equal(view.proxyUrl, 'http://user123:pwd456@127.0.0.1:1301');
  assert.equal(view.url, 'https://example.com/stream.mp4?auth=ok');
  assert.equal(view.ttlMs, 1800000);
  assert.equal(view.maxConcurrency, 8);
  assert.equal(view.once, true);

  assert.equal(publicLeaseView(null), null);

  const payload = 'eyJ1cmwiOiJodHRwczovL2V4YW1wbGUuY29tIn0';
  const secret = 'test-secret';
  const validSig = hmacSha256(payload, secret, 'base64url');
  assert.equal(isChunkSignatureValid(`${payload}.${validSig}`, secret), true);
  assert.equal(isChunkSignatureValid(`${payload}.invalid`, secret), false);
  assert.equal(isChunkSignatureValid(null, secret), false);

  assert.equal(DEFAULT_LEASE_TTL_MS, 1800000);
});

test('encodeTextResponse, encodeHtmlResponse and HTTP compression helpers compress payloads safely', async () => {
  const {
    encodeTextResponse,
    encodeHtmlResponse,
    isCompressibleContentType,
    acceptsCoding,
    acceptsBrotli,
    acceptsGzip,
    withVary,
    COMPRESSIBLE_CONTENT_TYPES,
  } = await import('../src/http-utils.js');

  assert.equal(isCompressibleContentType('text/html; charset=utf-8'), true);
  assert.equal(isCompressibleContentType('application/json'), true);
  assert.equal(isCompressibleContentType('image/jpeg'), false);

  assert.equal(acceptsCoding('gzip, deflate, br', 'br'), true);
  assert.equal(acceptsCoding('gzip, deflate', 'br'), false);
  assert.equal(acceptsCoding('gzip;q=0, br;q=0.5', 'gzip'), false);
  assert.equal(acceptsBrotli('gzip, br'), true);
  assert.equal(acceptsGzip('gzip, br'), true);

  assert.equal(withVary({}), 'Accept-Encoding');
  assert.equal(withVary({ vary: 'Origin' }), 'Origin, Accept-Encoding');
  assert.equal(withVary({ vary: 'Accept-Encoding' }), 'Accept-Encoding');

  const largeText = 'Hello RSSHub Gateway! '.repeat(200);
  const textRes = encodeTextResponse({
    body: largeText,
    contentType: 'text/plain',
    acceptEncoding: 'br, gzip',
    minBytes: 100,
  });
  assert.equal(textRes.encoding, 'br');
  assert.equal(textRes.headers['content-encoding'], 'br');
  assert.ok(Number(textRes.headers['content-length']) < Buffer.byteLength(largeText));

  const htmlRes = encodeHtmlResponse({
    body: `<html><body>${largeText}</body></html>`,
    contentType: 'text/html',
    acceptEncoding: 'gzip',
    minBytes: 100,
  });
  assert.equal(htmlRes.headers['content-encoding'], 'gzip');
  assert.ok(Number(htmlRes.headers['content-length']) > 0);
  assert.equal(COMPRESSIBLE_CONTENT_TYPES.length > 0, true);
});

test('cache helpers and download session record validators normalize and validate persistence structures', async () => {
  const {
    canonicalUrl,
    normalizedNamespace,
    cacheKeyFor,
    normalizeCacheHeaders,
    normalizeCacheBody,
    resultFromCacheEntry,
    isValidChunkRecord,
    isValidSessionRecord,
    DEFAULT_CACHE_TTL_SECONDS,
    DEFAULT_CACHE_MAX_BYTES,
    CHUNK_STATUSES,
  } = await import('../src/http-utils.js');

  assert.equal(canonicalUrl('https://example.com/a/b?c=1'), 'https://example.com/a/b?c=1');
  assert.equal(normalizedNamespace('  custom  '), 'custom');
  assert.equal(normalizedNamespace(''), 'public');
  assert.equal(normalizedNamespace(null), 'public');

  const key1 = cacheKeyFor('https://example.com/test', 'html', 'public');
  const key2 = cacheKeyFor('https://example.com/test', 'html', 'public');
  assert.equal(key1, key2);
  assert.equal(typeof key1, 'string');
  assert.equal(key1.length, 64);

  const headers = normalizeCacheHeaders({
    'Content-Type': 'text/html',
    'X-Custom': 'ignored',
    etag: '"12345"',
  });
  assert.deepEqual(headers, {
    'content-type': 'text/html',
    etag: '"12345"',
  });

  assert.deepEqual(normalizeCacheBody('text body'), {
    value: 'text body',
    buffer: Buffer.from('text body', 'utf8'),
    type: 'string',
  });
  assert.deepEqual(normalizeCacheBody(Buffer.from('binary')), {
    value: Buffer.from('binary'),
    buffer: Buffer.from('binary'),
    type: 'buffer',
  });
  assert.equal(normalizeCacheBody(null), null);

  const entry = {
    status: 200,
    headers: { 'content-type': 'text/html', etag: '"abc"' },
    bodyType: 'string',
    storedAt: Date.now() - 5000,
    expiresAt: Date.now() + 60000,
  };
  const result = resultFromCacheEntry(entry, Buffer.from('hello'), 'HIT');
  assert.equal(result.state, 'HIT');
  assert.equal(result.body, 'hello');
  assert.equal(result.headers['content-type'], 'text/html');
  assert.equal(resultFromCacheEntry(null), null);

  const validChunk = {
    index: 0,
    start: 0,
    end: 1023,
    size: 1024,
    url: 'https://example.com/chunk-0',
    status: 'pending',
    updatedAt: Date.now(),
  };
  assert.equal(isValidChunkRecord(validChunk), true);
  assert.equal(isValidChunkRecord({ ...validChunk, status: 'unknown' }), false);
  assert.equal(isValidChunkRecord(null), false);

  const validSession = {
    id: 'session-123',
    target: 'https://example.com/video.mp4',
    size: 1024,
    chunkSize: 1024,
    createdAt: Date.now(),
    expiresAt: Date.now() + 60000,
    chunks: [validChunk],
  };
  assert.equal(isValidSessionRecord(validSession, Date.now()), true);
  assert.equal(isValidSessionRecord({ ...validSession, expiresAt: Date.now() - 1000 }, Date.now()), false);
  assert.equal(isValidSessionRecord(null), false);

  assert.equal(DEFAULT_CACHE_TTL_SECONDS.rss, 300);
  assert.equal(DEFAULT_CACHE_MAX_BYTES > 0, true);
  assert.equal(CHUNK_STATUSES.has('pending'), true);
  assert.equal(CHUNK_STATUSES.has('done'), true);
});

test('image variant helpers and gallery benchmark url extractors parse and validate targets safely', async () => {
  const {
    normalizedImageContentType,
    originalImageResult,
    unsupportedImageVariantWidthError,
    DEFAULT_WEBP_OPTIONS,
    localGatewayUrl,
    mediaUrls,
    numericContentLength,
    variantUrl,
    BENCHMARK_LOCAL_HOSTS,
  } = await import('../src/http-utils.js');

  assert.equal(normalizedImageContentType('image/jpeg; charset=utf-8'), 'image/jpeg');
  assert.equal(normalizedImageContentType('IMAGE/PNG'), 'image/png');
  assert.equal(normalizedImageContentType(''), '');

  const orig = originalImageResult(Buffer.from('test'), 'image/png');
  assert.deepEqual(orig, {
    body: Buffer.from('test'),
    contentType: 'image/png',
    usedVariant: false,
  });

  const widthErr = unsupportedImageVariantWidthError();
  assert.equal(widthErr.code, 'IMAGE_VARIANT_UNSUPPORTED_WIDTH');

  assert.equal(DEFAULT_WEBP_OPTIONS.quality, 92);
  assert.equal(DEFAULT_WEBP_OPTIONS.nearLossless, true);

  const localItem = localGatewayUrl('http://127.0.0.1:1300/_gateway/item/eyJ1cmwiOiJodHRwczovL2V4YW1wbGUuY29tIn0');
  assert.equal(localItem.hostname, '127.0.0.1');
  assert.throws(() => localGatewayUrl('http://attacker.com/_gateway/item/123'), /local gateway item URL is required/);
  assert.throws(() => localGatewayUrl('http://127.0.0.1:1300/other/path'), /local gateway item URL is required/);

  const html = '<p><img src="/_gateway/media/abc"><img src="https://other.com/media/def"><img src="/_gateway/media/abc"></p>';
  const base = new URL('http://127.0.0.1:1300/_gateway/item/123');
  const urls = mediaUrls(html, base);
  assert.deepEqual(urls, ['http://127.0.0.1:1300/_gateway/media/abc']);

  assert.equal(numericContentLength({ headers: { 'content-length': '2048' } }), 2048);
  assert.equal(numericContentLength({ headers: new Headers({ 'content-length': '4096' }) }), 4096);
  assert.equal(numericContentLength(null), 0);

  assert.equal(variantUrl('http://127.0.0.1:1300/_gateway/media/abc', 1920), 'http://127.0.0.1:1300/_gateway/media/abc?w=1920');
  assert.equal(BENCHMARK_LOCAL_HOSTS.has('127.0.0.1'), true);
});

test('createSignedTarget, createMediaSignedTarget, verifySignedTarget, signedGatewayUrl, resolveGatewayUrl and matchesFeedFilters operate cleanly', async () => {
  const {
    createSignedTarget,
    createMediaSignedTarget,
    verifySignedTarget,
    signedGatewayUrl,
    resolveGatewayUrl,
    matchesFeedFilters,
  } = await import('../src/http-utils.js');

  const secret = 'super-secret-key-123';
  const url = 'https://x.com/demo/status/1';

  const token = createSignedTarget(url, secret);
  assert.equal(typeof token, 'string');
  const verified = verifySignedTarget(token, secret);
  assert.equal(verified.url, url);

  const mediaToken = createMediaSignedTarget('https://twimg.com/media/test.jpg', secret);
  assert.equal(typeof mediaToken, 'string');
  const mediaVerified = verifySignedTarget(mediaToken, secret);
  assert.equal(mediaVerified.url, 'https://twimg.com/media/test.jpg');

  const gwItemUrl = signedGatewayUrl('http://127.0.0.1:1300', 'item', url, { secret });
  assert.ok(gwItemUrl.startsWith('http://127.0.0.1:1300/_gateway/item/'));

  const gwMediaUrl = signedGatewayUrl('http://127.0.0.1:1300', 'media', 'https://twimg.com/media/test.jpg', secret);
  assert.ok(gwMediaUrl.startsWith('http://127.0.0.1:1300/_gateway/media/'));

  const resolved = resolveGatewayUrl('http://127.0.0.1:1300', 'item', '/status/2', 'https://x.com/status/1', { secret });
  assert.ok(resolved.startsWith('http://127.0.0.1:1300/_gateway/item/'));

  assert.equal(resolveGatewayUrl('http://127.0.0.1:1300', 'item', '', 'https://x.com'), '');

  assert.equal(matchesFeedFilters({ title: 'Ad: Buy now', description: 'good' }, { keywordBlacklist: ['ad:'] }), true);
  assert.equal(matchesFeedFilters({ title: 'Normal post', author: 'spammer' }, { authorBlacklist: ['spammer'] }), true);
  assert.equal(matchesFeedFilters({ title: 'Normal post', author: 'alice' }, { keywordBlacklist: ['ad:'], authorBlacklist: ['spammer'] }), false);
  assert.equal(matchesFeedFilters(null, null), false);
});

test('GatewayUpstreamError and reader manifest lifecycle helpers construct and merge manifests cleanly', async () => {
  const {
    GatewayUpstreamError,
    DEFAULT_UPSTREAM_ERROR_STATUS,
    DEFAULT_UPSTREAM_SOURCE,
    createInitialReaderManifest,
    mergeResolvedPage,
    isManifestComplete,
    DEFAULT_PAGE_STATE_DEFERRED,
    DEFAULT_PAGE_STATE_RESOLVED,
    DEFAULT_FIRST_DETAIL_BUDGET_MS,
    withForegroundDeadline,
  } = await import('../src/http-utils.js');

  const err = new GatewayUpstreamError('Upstream timeout', { code: 'ETIMEDOUT', source: 'iwara', status: 504, attempts: 2 });
  assert.equal(err.name, 'GatewayUpstreamError');
  assert.equal(err.code, 'ETIMEDOUT');
  assert.equal(err.source, 'iwara');
  assert.equal(err.status, 504);
  assert.equal(err.attempts, 2);

  const defaultErr = new GatewayUpstreamError('Failed');
  assert.equal(defaultErr.status, DEFAULT_UPSTREAM_ERROR_STATUS);
  assert.equal(defaultErr.source, DEFAULT_UPSTREAM_SOURCE);

  const manifest = createInitialReaderManifest({ imageUrls: ['https://example.com/p1.jpg', 'https://example.com/p2.jpg'] });
  assert.equal(manifest.totalPages, 2);
  assert.equal(manifest.complete, false);
  assert.equal(manifest.pages[0].state, DEFAULT_PAGE_STATE_DEFERRED);
  assert.equal(isManifestComplete(manifest), false);

  const merged = mergeResolvedPage(manifest, { pageNumber: 1, detailTarget: 'https://example.com/p1.jpg', mediaTarget: 'https://example.com/p1_full.jpg' });
  assert.equal(merged.pages[0].state, DEFAULT_PAGE_STATE_RESOLVED);
  assert.equal(merged.pages[0].mediaTarget, 'https://example.com/p1_full.jpg');
  assert.equal(isManifestComplete(merged), false);

  const fullyMerged = mergeResolvedPage(merged, { pageNumber: 2, detailTarget: 'https://example.com/p2.jpg', mediaTarget: 'https://example.com/p2_full.jpg' });
  assert.equal(isManifestComplete(fullyMerged), true);

  assert.equal(DEFAULT_FIRST_DETAIL_BUDGET_MS, 1200);
  assert.equal(typeof withForegroundDeadline, 'function');
});

test('parseRetryAfter, upstreamRetryDelay, responseWithLease and upstream constants format and handle responses correctly', async () => {
  const {
    parseRetryAfter,
    upstreamRetryDelay,
    responseWithLease,
    DEFAULT_UPSTREAM_PROXY,
    DEFAULT_UPSTREAM_TIMEOUT,
    DEFAULT_UPSTREAM_MAX_ATTEMPTS,
    DEFAULT_MAX_REDIRECTS,
  } = await import('../src/http-utils.js');

  assert.equal(DEFAULT_UPSTREAM_PROXY, 'http://127.0.0.1:7890');
  assert.equal(DEFAULT_UPSTREAM_TIMEOUT, 30000);
  assert.equal(DEFAULT_UPSTREAM_MAX_ATTEMPTS, 3);
  assert.equal(DEFAULT_MAX_REDIRECTS, 5);

  assert.equal(upstreamRetryDelay(1), 250);
  assert.equal(upstreamRetryDelay(2), 750);
  assert.equal(upstreamRetryDelay(3), 750);

  assert.equal(parseRetryAfter({ headers: { get: (k) => k === 'retry-after' ? '10' : null } }), 10);
  assert.equal(parseRetryAfter({ headers: { 'retry-after': '120' } }), 60); // Clamped to 60
  assert.equal(parseRetryAfter({ headers: {} }), undefined);
  assert.equal(parseRetryAfter(null), undefined);

  let releasedResult = null;
  const fakeLease = {
    release: (res) => {
      releasedResult = res;
    },
  };
  const streamRes = new Response('stream body', { status: 200 });
  const wrapped = responseWithLease(streamRes, fakeLease);
  const text = await wrapped.text();
  assert.equal(text, 'stream body');
  assert.deepEqual(releasedResult, { status: 200 });

  const nullLeaseRes = new Response('test');
  assert.equal(responseWithLease(nullLeaseRes, null), nullLeaseRes);
});

test('CircuitBreaker, graceful shutdown helpers and fetchdJson execute resilience workflows', async () => {
  const {
    CircuitBreaker,
    CIRCUIT_STATE_CLOSED,
    CIRCUIT_STATE_OPEN,
    CIRCUIT_STATE_HALF_OPEN,
    stopAcceptingServers,
    drainServers,
    installGracefulShutdown,
    fetchdJson,
    DEFAULT_FETCHD_BASE_URL,
    DEFAULT_FETCHD_TIMEOUT_MS,
    MAX_FETCHD_TIMEOUT_MS,
    FETCHD_TIMEOUT_SLACK_MS,
  } = await import('../src/http-utils.js');

  let now = 1000;
  const cb = new CircuitBreaker({ failureThreshold: 2, cooldownMs: 5000, now: () => now });
  assert.equal(cb.state('iwara'), CIRCUIT_STATE_CLOSED);
  assert.equal(cb.canRequest('iwara'), true);

  cb.recordFailure('iwara');
  assert.equal(cb.state('iwara'), CIRCUIT_STATE_CLOSED);
  cb.recordFailure('iwara');
  assert.equal(cb.state('iwara'), CIRCUIT_STATE_OPEN);
  assert.equal(cb.canRequest('iwara'), false);

  now += 5001;
  assert.equal(cb.state('iwara'), CIRCUIT_STATE_HALF_OPEN);
  assert.equal(cb.canRequest('iwara'), true);
  cb.recordSuccess('iwara');
  assert.equal(cb.state('iwara'), CIRCUIT_STATE_CLOSED);

  assert.equal(DEFAULT_FETCHD_BASE_URL, 'http://127.0.0.1:7899');
  assert.equal(DEFAULT_FETCHD_TIMEOUT_MS, 20000);
  assert.equal(MAX_FETCHD_TIMEOUT_MS, 65000);
  assert.equal(FETCHD_TIMEOUT_SLACK_MS, 5000);

  const fakeFetchd = async (url) => ({
    ok: true,
    json: async () => ({ ok: true, data: 'test' }),
  });
  const json = await fetchdJson(fakeFetchd, 'https://example.com/data');
  assert.deepEqual(json, { ok: true, data: 'test' });

  // Test server drain and graceful shutdown setup
  let closed = false;
  const fakeServer = {
    close: () => { closed = true; },
    closeIdleConnections: () => {},
    listening: false,
  };
  stopAcceptingServers([fakeServer]);
  assert.equal(closed, true);
  await drainServers([fakeServer]);

  const shutdownMgr = installGracefulShutdown({
    servers: [fakeServer],
    logger: null,
    exitImpl: () => {},
  });
  assert.equal(shutdownMgr.serverCount(), 1);
  assert.equal(shutdownMgr.isDraining(), false);
  shutdownMgr.dispose();
});

test('createSiteFailureTracker, adaptive chunk planners and structured logger operate reliably', async () => {
  const {
    createSiteFailureTracker,
    failureKey,
    adaptiveChunkSize,
    chunkSizeFor,
    planChunks,
    MIN_CHUNK_SIZE,
    MAX_CHUNK_SIZE,
    DEFAULT_TARGET_SECONDS,
    createLogger,
    createNoopLogger,
    redactValue,
    redactFields,
    LOG_LEVELS,
    DEFAULT_LOG_LEVEL,
  } = await import('../src/http-utils.js');

  assert.equal(failureKey(1, 'E-Hentai.org'), '1\ne-hentai.org');

  let now = 1000;
  const tracker = createSiteFailureTracker({ threshold: 2, windowMs: 10000, now: () => now });
  assert.equal(tracker.blocked(1, 'e-hentai.org'), false);
  assert.equal(tracker.record(1, 'e-hentai.org', 429), false);
  assert.equal(tracker.record(1, 'e-hentai.org', 429), true);
  assert.equal(tracker.blocked(1, 'e-hentai.org'), true);
  assert.equal(tracker.stats().length, 1);
  tracker.reset(1, 'e-hentai.org');
  assert.equal(tracker.blocked(1, 'e-hentai.org'), false);

  assert.equal(adaptiveChunkSize(10 * 1024 * 1024), 1024 * 1024);
  assert.equal(adaptiveChunkSize(0), MIN_CHUNK_SIZE);

  const plan = planChunks(2 * 1024 * 1024, { chunkSize: 1024 * 1024 });
  assert.equal(plan.length, 2);
  assert.equal(plan[0].size, 1024 * 1024);
  assert.equal(plan[1].size, 1024 * 1024);

  assert.equal(redactValue('cookie', 'secret=abc'), '[redacted]');
  assert.equal(redactValue('authToken', 'secret=abc'), '[redacted]');
  assert.deepEqual(redactFields({ token: '123', name: 'user' }), { token: '[redacted]', name: 'user' });

  const logs = [];
  const logger = createLogger({
    level: 'info',
    sink: (line) => logs.push(JSON.parse(line)),
    now: () => 1700000000000,
  });
  logger.info('test_event', { key: 'val', password: 'pass' });
  assert.equal(logs.length, 1);
  assert.equal(logs[0].event, 'test_event');
  assert.equal(logs[0].password, '[redacted]');

  const noopLogger = createNoopLogger();
  assert.doesNotThrow(() => noopLogger.info('ignore'));
  assert.doesNotThrow(() => noopLogger.child().error('ignore'));
});

test('session affinity helpers and background poller service orchestrate tasks cleanly', async () => {
  const {
    fingerprintFor,
    normalizedLaneIds,
    normalizedCredentials,
    chooseLane,
    proxyIdentityHash,
    isValidAffinityRecord,
    createPoller,
    DEFAULT_POLLER_INTERVAL_MS,
    DEFAULT_SESSION_AFFINITY_VERSION,
  } = await import('../src/http-utils.js');

  assert.equal(DEFAULT_SESSION_AFFINITY_VERSION, 1);
  assert.deepEqual(normalizedLaneIds(['lane-b', 'lane-a', 'lane-a', '']), ['lane-a', 'lane-b']);
  assert.equal(normalizedCredentials({ b: 2, a: 1 }), 'a=1\nb=2');

  const fp = fingerprintFor('x', { token: 'abc' }, 'secret-key');
  assert.equal(typeof fp, 'string');
  assert.equal(fp.length, 64);

  const lane = chooseLane(fp, ['lane-1', 'lane-2'], new Set(['lane-1']));
  assert.equal(lane, 'lane-2');

  assert.throws(() => chooseLane(fp, ['lane-1'], new Set(['lane-1'])), /no healthy session lane/);

  assert.equal(proxyIdentityHash('http://127.0.0.1:7890').length, 64);
  assert.equal(proxyIdentityHash(''), '');

  const validRec = {
    fingerprint: 'a'.repeat(64),
    source: 'x',
    laneId: 'lane-1',
    createdAt: 1000,
    updatedAt: 2000,
  };
  assert.equal(isValidAffinityRecord(validRec, 3000, 10000), true);
  assert.equal(isValidAffinityRecord({ ...validRec, updatedAt: 5000 }, 3000, 10000), false);

  assert.equal(DEFAULT_POLLER_INTERVAL_MS, 60000);

  let runCount = 0;
  const poller = createPoller({
    intervalMs: 10,
    jitterRatio: 0,
    now: () => Date.now(),
  });
  poller.register('test-task', async () => { runCount += 1; }, { interval: 10 });
  poller.start();
  await poller.tick();
  assert.equal(runCount, 1);
  const st = poller.stats();
  assert.equal(st.tasks.length, 1);
  assert.equal(st.tasks[0].ticks, 1);
  poller.stop();
  poller.unregister('test-task');
  assert.equal(poller.stats().tasks.length, 0);
});

test('egress policies and resumable range stream pump operate accurately', async () => {
  const {
    isPublicEgressTarget,
    isPublicRequestTarget,
    egressPolicyForUrl,
    egressPolicyForRequest,
    EGRESS_POLICIES,
    DEFAULT_PUBLIC_HOSTS,
    DEFAULT_PUBLIC_REQUEST_HOSTS,
    isResumableStatus,
    DEFAULT_RESUMABLE_MAX_ATTEMPTS,
    DEFAULT_RESUMABLE_BACKOFF_MS,
    pumpResumableRange,
  } = await import('../src/http-utils.js');

  assert.equal(isPublicEgressTarget('https://e-hentai.org/g/1/2'), true);
  assert.equal(isPublicEgressTarget('https://unknown-domain.xyz/'), false);
  assert.equal(isPublicRequestTarget('https://x.com/status/123'), true);
  assert.equal(egressPolicyForUrl('https://e-hentai.org/g/1/2'), EGRESS_POLICIES.PUBLIC);
  assert.equal(egressPolicyForUrl('https://other.com/'), EGRESS_POLICIES.STICKY);

  assert.equal(egressPolicyForRequest('https://x.com/status/1', { scope: 'session' }), EGRESS_POLICIES.STICKY);
  assert.equal(egressPolicyForRequest('https://x.com/status/1', { scope: 'public' }), EGRESS_POLICIES.PUBLIC);

  assert.equal(isResumableStatus(200), true);
  assert.equal(isResumableStatus(206), true);
  assert.equal(isResumableStatus(404), false);
  assert.equal(isResumableStatus(500), false);

  assert.equal(DEFAULT_RESUMABLE_MAX_ATTEMPTS, 3);
  assert.equal(DEFAULT_RESUMABLE_BACKOFF_MS, 100);

  // Test pumpResumableRange with mock stream and response
  const chunks = [];
  const fakeRes = {
    destroyed: false,
    writableEnded: false,
    write: (chunk, cb) => {
      chunks.push(Buffer.from(chunk));
      cb?.();
      return true;
    },
    end: () => {
      fakeRes.writableEnded = true;
    },
  };
  const webStream = new ReadableStream({
    start(controller) {
      controller.enqueue(Buffer.from('hello range'));
      controller.close();
    },
  });
  const fakeResponse = new Response(webStream, { status: 206 });

  const result = await pumpResumableRange({
    response: fakeResponse,
    fetchRange: async () => null,
    res: fakeRes,
    start: 0,
    end: 10,
  });

  assert.equal(result.written, 11);
  assert.equal(Buffer.concat(chunks).toString('utf8'), 'hello range');
});

test('tileStyle, tileImage and EH_METADATA_LABELS format thumbnail sprite tiles and localize metadata labels', async () => {
  const { tileStyle, tileImage, EH_METADATA_LABELS } = await import('../src/http-utils.js');

  const tile = { width: 200, height: 289, x: -10, y: -20, media: 'https://example.com/sprite.jpg' };
  assert.equal(tileStyle(tile), 'width:200px;height:289px;overflow:hidden');
  assert.equal(tileStyle(null), '');

  const img = tileImage(tile, 'eh-thumb-tile', 'Page 1', 'lazy');
  assert.equal(img, '<img class="eh-thumb-tile" src="https://example.com/sprite.jpg" alt="Page 1" loading="lazy" style="transform:translate(-10px,-20px)">');
  assert.equal(tileImage(null), '');

  assert.equal(EH_METADATA_LABELS.Posted, '发布');
  assert.equal(EH_METADATA_LABELS.Language, '语言');
  assert.equal(EH_METADATA_LABELS.Favorited, '收藏');
});

test('mediaSrcset and numericStyle construct responsive image candidate sets and clamp CSS pixel styles', async () => {
  const { mediaSrcset, numericStyle } = await import('../src/http-utils.js');

  const srcset = mediaSrcset('https://example.com/cover.jpg', [1280, 1920]);
  assert.equal(srcset, 'https://example.com/cover.jpg?w=1280 1280w, https://example.com/cover.jpg?w=1920 1920w');
  assert.equal(mediaSrcset(''), '');
  assert.equal(mediaSrcset(null), '');

  assert.equal(numericStyle('width: 200px; height: 100px', 'width', 50), 200);
  assert.equal(numericStyle('width: 6000px', 'width', 50), 5000);
  assert.equal(numericStyle('width: -10px', 'width', 50), 1);
  assert.equal(numericStyle('color: red', 'width', 50), 50);
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
