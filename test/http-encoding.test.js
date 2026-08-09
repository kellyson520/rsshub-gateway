import test from 'node:test';
import assert from 'node:assert/strict';
import { brotliDecompressSync } from 'node:zlib';
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

test('keeps HTML uncompressed when the client does not advertise br', () => {
  const result = encodeHtmlResponse({
    body: largeBody,
    acceptEncoding: 'gzip',
    contentType: 'text/html; charset=utf-8',
  });

  assert.deepEqual(result.body, largeBody);
  assert.equal(result.headers['content-encoding'], undefined);
  assert.equal(result.headers.vary, 'Accept-Encoding');
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

