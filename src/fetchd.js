import {
  DEFAULT_FETCHD_BASE_URL,
  DEFAULT_FETCHD_TIMEOUT_MS,
  FETCHD_TIMEOUT_SLACK_MS,
  fetchdJson,
  GatewayUpstreamError,
  MAX_FETCHD_TIMEOUT_MS,
} from './http-utils.js';

export const DEFAULT_BASE_URL = process.env.IWARA_FETCHD_URL || DEFAULT_FETCHD_BASE_URL;

export {
  DEFAULT_FETCHD_TIMEOUT_MS,
  MAX_FETCHD_TIMEOUT_MS,
  FETCHD_TIMEOUT_SLACK_MS,
  fetchdJson,
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
    timeout = DEFAULT_FETCHD_TIMEOUT_MS,
  } = {}) {
    let response;
    let payload;
    try {
      response = await fetchImpl(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url, method, headers, body, timeout }),
        signal: AbortSignal.timeout(Math.min(timeout + FETCHD_TIMEOUT_SLACK_MS, MAX_FETCHD_TIMEOUT_MS)),
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
