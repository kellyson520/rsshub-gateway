import { fetchdJson } from '../fetchd.js';
import { createUpstreamClient } from '../upstream.js';
import { createBrowserFetchClient } from '../browser-fetch.js';
import { isAllowedTarget } from '../signed-target.js';
import { createLogger } from './logger.js';

function safeHost(url) {
  try {
    return new URL(String(url)).hostname.toLowerCase();
  } catch {
    return 'unknown';
  }
}

// 站点 WAF 只放行浏览器 TLS 指纹（javbus/javdb 页面无 Referer/UA 也 403，
// 封面路径例外）。对这些主机，fetchExternal 走 browser-fetch（curl_cffi）
// 指纹传输；worker 不可用时回退普通 undici 客户端。
const BROWSER_FETCH_HOSTS = Object.freeze(
  String(process.env.GATEWAY_BROWSER_FETCH_HOSTS || 'javbus.com,javdb.com,airav.wiki,airav.io,jable.tv,missav.ws,missav.ai,missav.com,missav.live,ggjav.com,ggjav.tv,wnacg.com,wnacg.org,chikubi.jp,skeb.jp,fanbox.cc,sehuatang.net,linux.do')
    .split(',').map((host) => host.trim().toLowerCase()).filter(Boolean),
);

function browserFetchHost(url) {
  try {
    const hostname = new URL(String(url)).hostname.toLowerCase();
    return BROWSER_FETCH_HOSTS.some((base) => hostname === base || hostname.endsWith(`.${base}`));
  } catch {
    return false;
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
    if (browserFetchHost(url)) {
      // 浏览器指纹路径：仍强制目标白名单（signed-target allowlist），
      // 避免绕过 isAllowedTarget 的 SSRF 防护。
      let allowed = false;
      try {
        allowed = isAllowedTarget(url);
      } catch {
        allowed = false;
      }
      if (!allowed) return Promise.reject(new Error('external target is not allowed'));
      // 浏览器路径跟随重定向（javbus 页面 302 到规范 URL）；源站间的跳转
      // 由目标站点控制，仅对这些白名单主机启用。
      const browserRequest = { ...(request || {}), redirect: 'follow' };
      return browser.fetch(url, browserRequest).then((response) => {
        logger.debug('request_external_browser', { host, status: response?.status, durationMs: Date.now() - startedAt });
        return response;
      }).catch((error) => {
        // worker 不可用/失败时回退普通客户端，保证可用性优先。
        logger.warn('request_external_browser_fallback', { host, error: error.message });
        return resolvedFetchExternal(url, request).then((response) => {
          logger.debug('request_external', { host, status: response?.status, durationMs: Date.now() - startedAt });
          return response;
        });
      });
    }
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
