import test from 'node:test';
import assert from 'node:assert/strict';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import { encodeHtmlResponse } from '../src/http-encoding.js';

const largeBody = Buffer.from(`<main>${'reader content '.repeat(500)}</main>`);

test('encodes large HTML with Brotli when the client advertises br', () => {
  const result = encodeHtmlResponse({
    body: largeBody,
    acceptEncoding: 'gzip, br',
    contentType: 'text/html; charset=utf-8',
  });

  assert.equal(result.headers['content-encoding'], 'br');
  assert.equal(result.headers.vary, 'Accept-Encoding');
  assert.equal(Number(result.headers['content-length']), result.body.length);
  assert.deepEqual(brotliDecompressSync(result.body), largeBody);
  assert.ok(result.body.length < largeBody.length);
});

test('serves gzip HTML when the client does not advertise br', () => {
  const result = encodeHtmlResponse({
    body: largeBody,
    acceptEncoding: 'gzip',
    contentType: 'text/html; charset=utf-8',
  });

  assert.equal(result.headers['content-encoding'], 'gzip');
  assert.equal(result.headers.vary, 'Accept-Encoding');
  assert.deepEqual(gunzipSync(result.body), largeBody);
  assert.ok(result.body.length < largeBody.length);
});

test('does not encode HTML below the configured threshold', () => {
  const body = Buffer.from('<html><body>small</body></html>');
  const result = encodeHtmlResponse({
    body,
    acceptEncoding: 'br',
    contentType: 'text/html; charset=utf-8',
  });

  assert.deepEqual(result.body, body);
  assert.equal(result.headers['content-encoding'], undefined);
});

test('handles HEAD requests without generating compressed body bytes', () => {
  const result = encodeHtmlResponse({
    body: largeBody,
    acceptEncoding: 'br',
    contentType: 'text/html; charset=utf-8',
    method: 'HEAD',
  });

  assert.deepEqual(result.body, largeBody);
  assert.equal(result.headers['content-encoding'], undefined);
  assert.equal(result.headers['content-length'], String(largeBody.length));
  assert.equal(result.headers.vary, 'Accept-Encoding');
});

test('leaves incompressible media content types uncompressed', () => {
  const binary = Buffer.alloc(8192, 1);
  const result = encodeHtmlResponse({
    body: binary,
    acceptEncoding: 'gzip, br',
    contentType: 'image/jpeg',
  });

  assert.deepEqual(result.body, binary);
  assert.equal(result.headers['content-encoding'], undefined);
});

test('handles q=0 quality parameter by ignoring rejected encoding', () => {
  const result = encodeHtmlResponse({
    body: largeBody,
    acceptEncoding: 'br;q=0, gzip',
    contentType: 'text/html; charset=utf-8',
  });

  assert.equal(result.headers['content-encoding'], 'gzip');
  assert.deepEqual(gunzipSync(result.body), largeBody);
});

test('isCompressibleContentType identifies text, xml, json and ignores binary media', async () => {
  const { isCompressibleContentType } = await import('../src/http-encoding.js');
  assert.equal(isCompressibleContentType('text/html; charset=utf-8'), true);
  assert.equal(isCompressibleContentType('application/rss+xml'), true);
  assert.equal(isCompressibleContentType('application/json'), true);
  assert.equal(isCompressibleContentType('application/atom+xml'), true);
  assert.equal(isCompressibleContentType('image/svg+xml'), true);
  assert.equal(isCompressibleContentType('image/png'), false);
  assert.equal(isCompressibleContentType('video/mp4'), false);
  assert.equal(isCompressibleContentType('application/octet-stream'), false);
  assert.equal(isCompressibleContentType(null), false);
  assert.equal(isCompressibleContentType(undefined), false);
});

test('exports COMPRESSIBLE_CONTENT_TYPES and header parsing helpers', async () => {
  const {
    COMPRESSIBLE_CONTENT_TYPES,
    acceptsCoding,
    acceptsBrotli,
    acceptsGzip,
    asBuffer,
    withVary,
    DEFAULT_HTML_BROTLI_MIN_BYTES,
    DEFAULT_HTML_BROTLI_QUALITY,
    DEFAULT_TEXT_COMPRESS_MIN_BYTES,
    DEFAULT_GZIP_LEVEL,
  } = await import('../src/http-encoding.js');

  assert.ok(Array.isArray(COMPRESSIBLE_CONTENT_TYPES));
  assert.ok(COMPRESSIBLE_CONTENT_TYPES.includes('application/json'));

  assert.equal(acceptsBrotli('gzip, br'), true);
  assert.equal(acceptsBrotli('gzip, deflate'), false);

  assert.equal(acceptsGzip('gzip;q=0.8, br'), true);
  assert.equal(acceptsGzip('br, identity'), false);

  assert.equal(acceptsCoding('gzip, custom', 'custom'), true);
  assert.equal(acceptsCoding('custom;q=0', 'custom'), false);

  const buf = asBuffer('hello');
  assert.ok(Buffer.isBuffer(buf));
  assert.equal(buf.toString('utf8'), 'hello');

  assert.equal(withVary({}), 'Accept-Encoding');
  assert.equal(withVary({ vary: 'Origin' }), 'Origin, Accept-Encoding');
  assert.equal(withVary({ vary: 'Accept-Encoding' }), 'Accept-Encoding');

  assert.equal(DEFAULT_HTML_BROTLI_MIN_BYTES, 4096);
  assert.equal(DEFAULT_HTML_BROTLI_QUALITY, 4);
  assert.equal(DEFAULT_TEXT_COMPRESS_MIN_BYTES, 1024);
  assert.equal(DEFAULT_GZIP_LEVEL, 6);
});

