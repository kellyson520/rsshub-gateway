import { brotliCompressSync, constants } from 'node:zlib';

export const DEFAULT_HTML_BROTLI_MIN_BYTES = 4 * 1024;
export const DEFAULT_HTML_BROTLI_QUALITY = 4;

function acceptsBrotli(value) {
  return String(value || '').split(',').some((part) => {
    const [coding, ...parameters] = part.trim().toLowerCase().split(';');
    if (coding.trim() !== 'br') return false;
    const quality = parameters
      .map((parameter) => parameter.trim().split('=', 2))
      .find(([name]) => name === 'q')?.[1];
    return quality === undefined || Number(quality) > 0;
  });
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

export function encodeHtmlResponse({
  body,
  contentType = 'text/html; charset=utf-8',
  acceptEncoding,
  method = 'GET',
  headers = {},
  minBytes = DEFAULT_HTML_BROTLI_MIN_BYTES,
  quality = DEFAULT_HTML_BROTLI_QUALITY,
} = {}) {
  const source = asBuffer(body);
  const resultHeaders = { ...headers, 'content-length': String(source.length) };
  delete resultHeaders['content-encoding'];
  delete resultHeaders['Content-Encoding'];
  if (String(contentType).toLowerCase().includes('text/html') && source.length >= minBytes) {
    resultHeaders.vary = withVary(resultHeaders);
  }
  if (method === 'HEAD' || !String(contentType).toLowerCase().includes('text/html')
    || source.length < minBytes || !acceptsBrotli(acceptEncoding)) {
    return { body: source, headers: resultHeaders };
  }

  try {
    const encoded = brotliCompressSync(source, {
      params: { [constants.BROTLI_PARAM_QUALITY]: quality },
    });
    if (encoded.length >= source.length) return { body: source, headers: resultHeaders };
    resultHeaders['content-encoding'] = 'br';
    resultHeaders['content-length'] = String(encoded.length);
    return { body: encoded, headers: resultHeaders };
  } catch {
    return { body: source, headers: resultHeaders };
  }
}
