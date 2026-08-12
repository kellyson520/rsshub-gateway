import { fetchdJson } from '../fetchd.js';
import { createUpstreamClient } from '../upstream.js';
import { createBrowserFetchClient } from '../browser-fetch.js';
import { createLogger } from './logger.js';

function safeHost(url) {
  try {
    return new URL(String(url)).hostname.toLowerCase();
  } catch {
    return 'unknown';
  }
}

/**
 * Unified request facade.
 *
 * Composes the two transports the gateway owns — the upstream client
 * (proxy, retry, circuit breaker, egress lanes, session dispatchers) and the
 * browser-fingerprint worker (Cloudflare-protected sources) — behind one
 * service. Every adapter and route gets fetchExternal / fetchRssHub /
 * fetchJsonViaFetchd from here, so request policy and logging stay in one
 * place and future services reuse the same entry points.
 */
export function createRequestService({
  sourceConfig = {},
  client,
  fetchImpl,
  egressPool,
  browserFetch,
  fetchdFetch,
  fetchExternal,
  fetchRssHub,
  logger = createLogger(),
} = {}) {
  const upstreamClient = client || createUpstreamClient({ sourceConfig, fetchImpl, egressPool });
  const browser = browserFetch || createBrowserFetchClient();
  const resolvedFetchdFetch = fetchdFetch || browser.fetchdFetch;
  const resolvedFetchExternal = fetchExternal || ((url, request) => upstreamClient.fetchExternal(url, request));
  const resolvedFetchRssHub = fetchRssHub || ((path, request) => upstreamClient.fetchRssHub(path, undefined, request?.headers, request));

  function fetchJsonViaFetchd(url, request) {
    const startedAt = Date.now();
    const host = safeHost(url);
    return fetchdJson(resolvedFetchdFetch, url, request).catch((error) => {
      logger.debug('request_json_failed', { host, error: error.message, durationMs: Date.now() - startedAt });
      throw error;
    });
  }

  function fetchExternalInstrumented(url, request) {
    const startedAt = Date.now();
    const host = safeHost(url);
    return resolvedFetchExternal(url, request).then((response) => {
      logger.debug('request_external', { host, status: response?.status, durationMs: Date.now() - startedAt });
      return response;
    });
  }

  function fetchRssHubInstrumented(path, request) {
    const startedAt = Date.now();
    return resolvedFetchRssHub(path, request).then((response) => {
      logger.debug('request_rsshub', { path, status: response?.status, durationMs: Date.now() - startedAt });
      return response;
    });
  }

  return {
    client: upstreamClient,
    browserFetch: browser,
    fetchdFetch: resolvedFetchdFetch,
    fetchExternal: fetchExternalInstrumented,
    fetchRssHub: fetchRssHubInstrumented,
    fetchJsonViaFetchd,
    openCircuits: () => upstreamClient.openCircuits?.(),
  };
}
