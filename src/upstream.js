import { ProxyAgent } from 'undici';
import { isAllowedTarget } from './signed-target.js';
import { adapterForUrl } from './adapters/index.js';
import { CircuitBreaker } from './circuit-breaker.js';
import { GatewayUpstreamError, isRetryableStatus } from './upstream-errors.js';
import { egressPolicyForRequest } from './egress-policy.js';
import { clamp, sleep as defaultSleep } from './http-utils.js';

const DEFAULT_PROXY = 'http://127.0.0.1:7890';
const DEFAULT_TIMEOUT = 30_000;
const DEFAULT_MAX_ATTEMPTS = 3;
const MAX_REDIRECTS_PER_ATTEMPT = 5;

// 防盗链 CDN/图床：不带 Referer 直接返回 403（javbus/jpgcdn 等已验证）。
// 匹配目标主机名或其子域时，给请求附加源站 Referer。
const HOTLINK_REFERERS = Object.freeze({
  'javbus.com': 'https://www.javbus.com/',
  'javbus.one': 'https://www.javbus.com/',
  'jpgcdn.com': 'https://www.javbus.com/',
  'mgstage.com': 'https://www.mgstage.com/',
  'dmm.co.jp': 'https://www.dmm.co.jp/',
  'javdb.com': 'https://javdb.com/',
  'jdbstatic.com': 'https://javdb.com/',
  'missav.ai': 'https://missav.ai/',
  'missav.com': 'https://missav.com/',
  'jable.tv': 'https://jable.tv/',
});

function refererFor(url) {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    for (const [base, referer] of Object.entries(HOTLINK_REFERERS)) {
      if (hostname === base || hostname.endsWith(`.${base}`)) return referer;
    }
  } catch {
    // Malformed diagnostic URLs never carry a referer.
  }
  return undefined;
}

function sourceHeaders(url, sources = {}, { includeCredentials = false, credentials } = {}) {
  const adapter = adapterForUrl(url);
  const referer = refererFor(url);
  return {
    'user-agent': 'rsshub-gateway/0.1',
    ...(referer ? { referer } : {}),
    ...adapter.headers(credentials ?? sources[adapter.name], { includeCredentials }),
  };
}

function withoutCredentials(headers = {}) {
  return Object.fromEntries(Object.entries(headers)
    .filter(([name]) => !/^(cookie|authorization)$/i.test(name)));
}

function isAuthenticationRedirect(response) {
  if (response.status < 300 || response.status >= 400) return false;
  const location = response.headers.get('location') || '';
  return /(?:\/login|\/signin|\/i\/flow\/login|accounts\/login)(?:[/?#]|$)/i.test(location);
}

async function isAuthenticationChallenge(response, url, callback) {
  if (response.status === 401 || isAuthenticationRedirect(response)) return true;
  if (typeof callback !== 'function') return false;
  try {
    return Boolean(await callback({ response, url }));
  } catch {
    return false;
  }
}

function responseWithLease(response, lease) {
  if (!lease) return response;
  let released = false;
  const release = (result = {}) => {
    if (released) return;
    released = true;
    lease.release({ status: response.status, ...result });
  };
  if (!response.body) {
    release();
    return response;
  }
  const reader = response.body.getReader();
  const body = new ReadableStream({
    async pull(controller) {
      try {
        const item = await reader.read();
        if (item.done) {
          release();
          controller.close();
          return;
        }
        controller.enqueue(item.value);
      } catch (error) {
        release({ error });
        controller.error(error);
      }
    },
    async cancel(reason) {
      await reader.cancel(reason).catch(() => {});
      release({ error: reason });
    },
  });
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

export function createUpstreamClient({
  proxyUrl = DEFAULT_PROXY,
  sourceConfig = {},
  fetchImpl = fetch,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  totalTimeoutMs = DEFAULT_TIMEOUT,
  sleep: sleepImpl,
  now: nowImpl,
  breaker: breakerImpl,
  onRequestPolicy,
  egressPool,
} = {}) {
  const dispatcher = new ProxyAgent(proxyUrl);
  const sleep = sleepImpl || defaultSleep;
  const now = nowImpl || (() => Date.now());
  const breaker = breakerImpl || new CircuitBreaker({ now });

  function sourceName(url) {
    return new URL(url).hostname.toLowerCase();
  }

  function retryDelay(attempt) {
    return attempt === 1 ? 250 : 750;
  }

  function retryAfter(response) {
    const value = response.headers.get('retry-after');
    if (value === null || value === undefined || value === '') return undefined;
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? clamp(parsed, 0, 60) : undefined;
  }

  async function requestWithPolicy(url, {
    headers = {},
    range,
    priority = 'foreground',
    galleryShard,
    timeout = totalTimeoutMs,
    source = sourceName(url),
    useProxy = true,
    allowTarget = false,
    recordResponseFailures = true,
    circuit = true,
    egressScope = 'auto',
    sessionDispatcher,
    sessionCredentials,
    allowSessionRetry = false,
    authChallenge,
    method = 'GET',
  } = {}) {
    let current = new URL(url);
    const original = new URL(url);
    let currentScope = egressScope;
    let sessionRetried = currentScope === 'session';
    const startedAt = now();
    const deadline = startedAt + timeout;
    if (circuit && !breaker.canRequest(source)) {
      throw new GatewayUpstreamError(`upstream circuit is open for ${source}`, {
        code: 'UPSTREAM_CIRCUIT_OPEN',
        source,
        status: 503,
        retryAfter: Math.ceil(breaker.cooldownMs / 1000),
      });
    }

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      let redirects = 0;
      let retryableFailure;
      while (true) {
        const remaining = deadline - now();
        if (remaining <= 0) {
          if (circuit) breaker.recordFailure(source);
          throw new GatewayUpstreamError(`upstream request timed out for ${source}`, {
            code: 'UPSTREAM_TIMEOUT',
            source,
            status: 504,
            attempts: attempt,
          });
        }
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), remaining);
        const requestPolicy = egressPolicyForRequest(current, { scope: currentScope });
        const requestHeaders = useProxy
          ? {
            ...sourceHeaders(current.toString(), sourceConfig, {
              includeCredentials: currentScope === 'session',
              credentials: sessionCredentials,
            }),
            ...(currentScope === 'session' ? headers : withoutCredentials(headers)),
          }
          : headers;
        if (range) requestHeaders.range = range;
        let lease;
        try {
          let response;
          try {
            if (useProxy && currentScope === 'session') {
              response = await fetchImpl(current, {
                dispatcher: sessionDispatcher || dispatcher,
                headers: requestHeaders,
                method,
                redirect: 'manual',
                signal: controller.signal,
              });
            } else {
              if (useProxy && egressPool && requestPolicy === 'public') {
              try {
                lease = await egressPool.acquire({ host: current.hostname.toLowerCase(), priority, galleryShard });
              } catch (error) {
                if (error?.code !== 'EGRESS_POOL_EMPTY') throw error;
              }
              }
              response = await fetchImpl(current, {
                ...(useProxy ? { dispatcher: lease?.dispatcher || dispatcher } : {}),
                headers: requestHeaders,
                method,
                redirect: 'manual',
                signal: controller.signal,
              });
            }
          } catch (error) {
            lease?.release({ error });
            lease = undefined;
            if (controller.signal.aborted) {
              if (circuit) breaker.recordFailure(source);
              throw new GatewayUpstreamError(`upstream request timed out for ${source}`, {
                code: 'UPSTREAM_TIMEOUT',
                source,
                status: 504,
                attempts: attempt,
              });
            }
            retryableFailure = error;
            break;
          }

          if (response.status >= 300 && response.status < 400) {
            const location = response.headers.get('location');
            if (!location) {
              // Terminal outcome: clear the half-open probe so the circuit
              // cannot wedge open on redirects that skip success recording.
              if (circuit) breaker.recordSuccess(source);
              return responseWithLease(response, lease);
            }
            if (useProxy && allowSessionRetry && !sessionRetried && currentScope !== 'session'
              && sessionDispatcher && sessionCredentials
              && isAuthenticationRedirect(response)) {
              await response.body?.cancel();
              lease?.release({ status: response.status });
              lease = undefined;
              currentScope = 'session';
              sessionRetried = true;
              current = original;
              continue;
            }
            if (!allowTarget) {
              // Terminal outcome (RSSHub passthrough never follows redirects):
              // clear the half-open probe so the circuit cannot wedge open.
              if (circuit) breaker.recordSuccess(source);
              return responseWithLease(response, lease);
            }
            await response.body?.cancel();
            lease?.release({ status: response.status });
            lease = undefined;
            current = new URL(location, current);
            if (allowTarget && !isAllowedTarget(current)) {
              throw new GatewayUpstreamError(`redirect target is outside the allowlist: ${current.hostname}`, {
                code: 'UPSTREAM_REDIRECT_DISALLOWED',
                source,
                status: 502,
                attempts: attempt,
              });
            }
            redirects += 1;
            if (redirects > MAX_REDIRECTS_PER_ATTEMPT) {
              throw new GatewayUpstreamError(`too many redirects for ${source}`, {
                code: 'UPSTREAM_REDIRECT_LIMIT',
                source,
                status: 502,
                attempts: attempt,
              });
            }
            continue;
          }

          if (isRetryableStatus(response.status)) {
            retryableFailure = new GatewayUpstreamError(`upstream returned ${response.status}`, {
              code: 'UPSTREAM_RETRYABLE_STATUS',
              source,
              status: response.status,
              attempts: attempt,
              retryAfter: retryAfter(response),
            });
            await response.body?.cancel();
            lease?.release({ status: response.status });
            lease = undefined;
            break;
          }

          if (useProxy && allowSessionRetry && !sessionRetried && currentScope !== 'session'
            && sessionDispatcher && sessionCredentials
            && await isAuthenticationChallenge(response, current, authChallenge)) {
            await response.body?.cancel();
            lease?.release({ status: response.status });
            lease = undefined;
            currentScope = 'session';
            sessionRetried = true;
            current = original;
            continue;
          }

          if (circuit) breaker.recordSuccess(source);
          return responseWithLease(response, lease);
        } finally {
          clearTimeout(timer);
        }
      }

      if (attempt >= maxAttempts) {
        if (circuit && (recordResponseFailures || retryableFailure?.code !== 'UPSTREAM_RETRYABLE_STATUS')) breaker.recordFailure(source);
        throw new GatewayUpstreamError(retryableFailure?.message || `upstream request failed for ${source}`, {
          code: 'UPSTREAM_RETRY_EXHAUSTED',
          source,
          status: 502,
          attempts: attempt,
          retryAfter: retryableFailure?.retryAfter,
        });
      }
      const remaining = deadline - now();
      if (remaining <= 0) {
        if (circuit) breaker.recordFailure(source);
        throw new GatewayUpstreamError(`upstream request timed out for ${source}`, {
          code: 'UPSTREAM_TIMEOUT',
          source,
          status: 504,
          attempts: attempt,
        });
      }
      const retryAfterDelay = retryableFailure?.retryAfter !== undefined && retryableFailure.retryAfter > 0
        ? retryableFailure.retryAfter * 1000
        : retryDelay(attempt);
      await sleep(Math.min(retryAfterDelay, remaining));
    }
    throw new GatewayUpstreamError(`upstream request failed for ${source}`, {
      code: 'UPSTREAM_RETRY_EXHAUSTED',
      source,
      status: 502,
      attempts: maxAttempts,
    });
  }

  async function fetchExternal(url, {
    headers = {},
    range,
    timeout,
    priority = 'foreground',
    galleryShard,
    circuit = true,
    egressScope = 'auto',
    sessionDispatcher,
    sessionCredentials,
    allowSessionRetry = false,
    authChallenge,
  } = {}) {
    const target = new URL(url);
    if (!isAllowedTarget(target)) throw new Error('external target is not allowed');
    try {
      onRequestPolicy?.({
        host: target.hostname.toLowerCase(),
        policy: egressPolicyForRequest(target, { scope: egressScope }),
      });
    } catch {
      // Diagnostics must never affect upstream requests.
    }
    return requestWithPolicy(target, {
      headers,
      range,
      priority,
      galleryShard,
      timeout: timeout ?? totalTimeoutMs,
      source: target.hostname.toLowerCase(),
      useProxy: true,
      allowTarget: true,
      circuit,
      egressScope,
      sessionDispatcher,
      sessionCredentials,
      allowSessionRetry,
      authChallenge,
    });
  }

  async function fetchRssHub(pathAndQuery, rsshubUrl, headers = {}, { timeout, method = 'GET' } = {}) {
    const base = rsshubUrl || process.env.RSSHUB_URL || 'http://rsshub:1200';
    const target = new URL(pathAndQuery, base);
    return requestWithPolicy(target, {
      headers,
      method: method === 'HEAD' ? 'HEAD' : 'GET',
      timeout: timeout ?? totalTimeoutMs,
      source: 'rsshub',
      useProxy: false,
      allowTarget: false,
      recordResponseFailures: false,
    });
  }

  return {
    fetchExternal,
    fetchRssHub,
    openCircuits: () => breaker.openKeys(),
    circuitStats: () => breaker.stats(),
  };
}

export {
  DEFAULT_PROXY,
  DEFAULT_TIMEOUT,
  DEFAULT_MAX_ATTEMPTS,
  MAX_REDIRECTS_PER_ATTEMPT,
  HOTLINK_REFERERS,
  refererFor,
  sourceHeaders,
  withoutCredentials,
  isAuthenticationRedirect,
  isAuthenticationChallenge,
};
