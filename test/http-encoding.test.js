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

