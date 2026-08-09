import { ProxyAgent } from 'undici';
import { isAllowedTarget } from './signed-target.js';
import { adapterForUrl } from './adapters/index.js';
import { CircuitBreaker } from './circuit-breaker.js';
import { GatewayUpstreamError, isRetryableStatus } from './upstream-errors.js';
import { egressPolicyForRequest } from './egress-policy.js';

const DEFAULT_PROXY = 'http://127.0.0.1:7890';
const DEFAULT_TIMEOUT = 30_000;
const DEFAULT_MAX_ATTEMPTS = 3;
const MAX_REDIRECTS_PER_ATTEMPT = 5;

function sourceHeaders(url, sources = {}, { includeCredentials = false, credentials } = {}) {
  const adapter = adapterForUrl(url);
  return {
    'user-agent': 'rsshub-gateway/0.1',
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
  const sleep = sleepImpl || ((delay) => new Promise((resolve) => setTimeout(resolve, delay)));
  const now = nowImpl || (() => Date.now());
  const breaker = breakerImpl || new CircuitBreaker({ now });

  function sourceName(url) {
    return new URL(url).hostname.toLowerCase();
  }

  function retryDelay(attempt) {
    return attempt === 1 ? 250 : 750;
  }

  function retryAfter(response) {
    const value = Number.parseInt(response.headers.get('retry-after') || '', 10);
    return Number.isFinite(value) ? Math.min(Math.max(value, 0), 60) : undefined;
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
            if (!location) return responseWithLease(response, lease);
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
            if (!allowTarget) return responseWithLease(response, lease);
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
      await sleep(Math.min(retryDelay(attempt), remaining));
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

  async function fetchRssHub(pathAndQuery, rsshubUrl, headers = {}, { timeout } = {}) {
    const base = rsshubUrl || process.env.RSSHUB_URL || 'http://rsshub:1200';
    const target = new URL(pathAndQuery, base);
    return requestWithPolicy(target, { headers, timeout: timeout ?? totalTimeoutMs, source: 'rsshub', useProxy: false, allowTarget: false, recordResponseFailures: false });
  }

  return { fetchExternal, fetchRssHub, openCircuits: () => breaker.openKeys() };
}

export { sourceHeaders };
