import { brotliCompressSync, constants, gzipSync } from 'node:zlib';

export const DEFAULT_HTML_BROTLI_MIN_BYTES = 4 * 1024;
export const DEFAULT_HTML_BROTLI_QUALITY = 4;
export const DEFAULT_TEXT_COMPRESS_MIN_BYTES = 1024;

// Content types eligible for lossless text compression on the gateway edge.
// Media (image/video/audio) and already-compressed formats stay untouched.
const COMPRESSIBLE_CONTENT_TYPES = [
  'text/',
  'application/xml',
  'application/rss+xml',
  'application/atom+xml',
  'application/xhtml+xml',
  'application/json',
  'application/javascript',
  'application/manifest+json',
  'image/svg+xml',
];

export function isCompressibleContentType(contentType) {
  const value = String(contentType || '').toLowerCase();
  return COMPRESSIBLE_CONTENT_TYPES.some((prefix) => value.includes(prefix));
}

function acceptsCoding(value, coding) {
  return String(value || '').split(',').some((part) => {
    const [name, ...parameters] = part.trim().toLowerCase().split(';');
    if (name.trim() !== coding) return false;
    const quality = parameters
      .map((parameter) => parameter.trim().split('=', 2))
      .find(([key]) => key === 'q')?.[1];
    return quality === undefined || Number(quality) > 0;
  });
}

function acceptsBrotli(value) {
  return acceptsCoding(value, 'br');
}

function acceptsGzip(value) {
  return acceptsCoding(value, 'gzip');
}

function asBuffer(body) {
  return Buffer.isBuffer(body) ? body : Buffer.from(body || '');
}

function withVary(headers) {
  const existing = headers.vary || headers.Vary;
  if (!existing) return 'Accept-Encoding';
  const values = String(existing).split(',').map((value) => value.trim()).filter(Boolean);
  if (!values.some((value) => value.toLowerCase() === 'accept-encoding')) values.push('Accept-Encoding');
  return values.join(', ');
}

/**
 * Lossless edge compression for text responses (charter: 统一后处理层 Brotli/gzip).
 * Prefers brotli, falls back to gzip, and never compresses when the output would
 * grow or the client did not ask for it. HEAD requests get the same headers as a
 * GET would, without a body.
 */
export function encodeTextResponse({
  body,
  contentType = 'text/plain; charset=utf-8',
  acceptEncoding,
  method = 'GET',
  headers = {},
  minBytes = DEFAULT_TEXT_COMPRESS_MIN_BYTES,
  quality = DEFAULT_HTML_BROTLI_QUALITY,
} = {}) {
  const source = asBuffer(body);
  const resultHeaders = { ...headers, 'content-length': String(source.length) };
  delete resultHeaders['content-encoding'];
  delete resultHeaders['Content-Encoding'];
  const compressible = isCompressibleContentType(contentType);
  if (compressible && source.length >= minBytes) {
    resultHeaders.vary = withVary(resultHeaders);
  }
  if (method === 'HEAD' || !compressible || source.length < minBytes
    || (!acceptsBrotli(acceptEncoding) && !acceptsGzip(acceptEncoding))) {
    return { body: source, headers: resultHeaders, encoding: undefined };
  }
  try {
    if (acceptsBrotli(acceptEncoding)) {
      const encoded = brotliCompressSync(source, {
        params: { [constants.BROTLI_PARAM_QUALITY]: quality },
      });
      if (encoded.length < source.length) {
        resultHeaders['content-encoding'] = 'br';
        resultHeaders['content-length'] = String(encoded.length);
        return { body: encoded, headers: resultHeaders, encoding: 'br' };
      }
    }
    if (acceptsGzip(acceptEncoding)) {
      const encoded = gzipSync(source, { level: 6 });
      if (encoded.length < source.length) {
        resultHeaders['content-encoding'] = 'gzip';
        resultHeaders['content-length'] = String(encoded.length);
        return { body: encoded, headers: resultHeaders, encoding: 'gzip' };
      }
    }
  } catch {
    // Compression must never fail the response.
  }
  return { body: source, headers: resultHeaders, encoding: undefined };
}

export function encodeHtmlResponse({
  body,
  contentType = 'text/html; charset=utf-8',
  acceptEncoding,
  method = 'GET',
  headers = {},
  minBytes = DEFAULT_HTML_BROTLI_MIN_BYTES,
  quality = DEFAULT_HTML_BROTLI_QUALITY,
} = {}) {
  // HTML keeps its dedicated brotli-only path so long-standing behavior and
  // tests stay unchanged; text/xml/feed responses go through encodeTextResponse.
  const source = asBuffer(body);
  const resultHeaders = { ...headers, 'content-length': String(source.length) };
  delete resultHeaders['content-encoding'];
  delete resultHeaders['Content-Encoding'];
  if (String(contentType).toLowerCase().includes('text/html') && source.length >= minBytes) {
    resultHeaders.vary = withVary(resultHeaders);
  }
  if (method === 'HEAD' || !String(contentType).toLowerCase().includes('text/html')
    || source.length < minBytes || (!acceptsBrotli(acceptEncoding) && !acceptsGzip(acceptEncoding))) {
    return { body: source, headers: resultHeaders };
  }
  try {
    if (acceptsBrotli(acceptEncoding)) {
      const encoded = brotliCompressSync(source, {
        params: { [constants.BROTLI_PARAM_QUALITY]: quality },
      });
      if (encoded.length < source.length) {
        resultHeaders['content-encoding'] = 'br';
        resultHeaders['content-length'] = String(encoded.length);
        return { body: encoded, headers: resultHeaders };
      }
    }
    if (acceptsGzip(acceptEncoding)) {
      const encoded = gzipSync(source, { level: 6 });
      if (encoded.length < source.length) {
        resultHeaders['content-encoding'] = 'gzip';
        resultHeaders['content-length'] = String(encoded.length);
        return { body: encoded, headers: resultHeaders };
      }
    }
  } catch {
    // Compression must never fail the response.
  }
  return { body: source, headers: resultHeaders };
}
