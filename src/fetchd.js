import { GatewayUpstreamError } from './upstream-errors.js';

const DEFAULT_BASE_URL = process.env.IWARA_FETCHD_URL || 'http://127.0.0.1:7899';

export {
  DEFAULT_BASE_URL,
};

export function createFetchdClient({
  baseUrl = DEFAULT_BASE_URL,
  fetchImpl = fetch,
} = {}) {
  const endpoint = `${String(baseUrl).replace(/\/$/, '')}/fetch`;
  return async function fetchdFetch(url, {
    method = 'GET',
    headers = {},
    body,
    timeout = 20_000,
  } = {}) {
    let response;
    let payload;
    try {
      response = await fetchImpl(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url, method, headers, body, timeout }),
        signal: AbortSignal.timeout(Math.min(timeout + 5_000, 65_000)),
      });
      payload = await response.json();
    } catch (error) {
      throw new GatewayUpstreamError(`browser fetch unavailable: ${error.message}`, {
        code: 'FETCHD_UNAVAILABLE',
        source: 'fetchd',
        status: 502,
        attempts: 1,
      });
    }
    if (!response.ok || payload.error) {
      throw new GatewayUpstreamError(payload.error || `browser fetch returned ${response.status}`, {
        code: 'FETCHD_ERROR',
        source: 'fetchd',
        status: 502,
        attempts: 1,
      });
    }
    const bodyBuffer = payload.body ? Buffer.from(payload.body, 'base64') : Buffer.alloc(0);
    return {
      status: Number(payload.status) || 502,
      headers: new Headers(payload.headers || {}),
      body: bodyBuffer,
      ok: Number(payload.status) >= 200 && Number(payload.status) < 300,
      json: async () => JSON.parse(bodyBuffer.toString('utf8')),
      text: async () => bodyBuffer.toString('utf8'),
    };
  };
}

export async function fetchdJson(fetchdFetch, url, {
  method = 'GET',
  headers = {},
  body,
  timeout = 20_000,
} = {}) {
  const response = await fetchdFetch(url, { method, headers, body, timeout });
  if (!response.ok) {
    throw new GatewayUpstreamError(`upstream returned ${response.status}`, {
      code: 'UPSTREAM_RETRYABLE_STATUS',
      source: new URL(url).hostname,
      status: response.status,
      attempts: 1,
    });
  }
  return response.json();
}
