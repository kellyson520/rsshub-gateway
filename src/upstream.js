import { ProxyAgent } from 'undici';
import { adapterForUrl } from './adapters/index.js';
import { CircuitBreaker } from './circuit-breaker.js';
import { egressPolicyForRequest } from './egress-policy.js';
import {
  clamp,
  DEFAULT_MAX_REDIRECTS as MAX_REDIRECTS_PER_ATTEMPT,
  DEFAULT_UPSTREAM_MAX_ATTEMPTS as DEFAULT_MAX_ATTEMPTS,
  DEFAULT_UPSTREAM_PROXY as DEFAULT_PROXY,
  DEFAULT_UPSTREAM_TIMEOUT as DEFAULT_TIMEOUT,
  GatewayUpstreamError,
  HOTLINK_REFERERS,
  isAllowedTarget,
  isAuthenticationChallenge,
  isAuthenticationRedirect,
  isRetryableStatus,
  parseRetryAfter as retryAfter,
  refererFor,
  responseWithLease,
  sleep as defaultSleep,
  sourceHeaders as baseSourceHeaders,
  upstreamRetryDelay as retryDelay,
  withoutCredentials,
} from './http-utils.js';

function sourceHeaders(url, sources = {}, { includeCredentials = false, credentials } = {}) {
  return baseSourceHeaders(url, sources, { includeCredentials, credentials, adapterFor: adapterForUrl });
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
  responseWithLease,
  retryDelay,
  retryAfter,
};
