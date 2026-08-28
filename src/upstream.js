import { ProxyAgent } from 'undici';
import { adapterForUrl } from './adapters/index.js';
import {
  createUpstreamClient as baseCreateUpstreamClient,
  DEFAULT_MAX_REDIRECTS as MAX_REDIRECTS_PER_ATTEMPT,
  DEFAULT_UPSTREAM_MAX_ATTEMPTS as DEFAULT_MAX_ATTEMPTS,
  DEFAULT_UPSTREAM_PROXY as DEFAULT_PROXY,
  DEFAULT_UPSTREAM_TIMEOUT as DEFAULT_TIMEOUT,
  HOTLINK_REFERERS,
  isAuthenticationChallenge,
  isAuthenticationRedirect,
  parseRetryAfter as retryAfter,
  refererFor,
  responseWithLease,
  sourceHeaders as baseSourceHeaders,
  upstreamRetryDelay as retryDelay,
  withoutCredentials,
} from './http-utils.js';

export {
  DEFAULT_PROXY,
  DEFAULT_TIMEOUT,
  DEFAULT_MAX_ATTEMPTS,
  MAX_REDIRECTS_PER_ATTEMPT,
  HOTLINK_REFERERS,
  refererFor,
  withoutCredentials,
  isAuthenticationRedirect,
  isAuthenticationChallenge,
  responseWithLease,
  retryDelay,
  retryAfter,
};

export function sourceHeaders(url, sources = {}, { includeCredentials = false, credentials } = {}) {
  return baseSourceHeaders(url, sources, { includeCredentials, credentials, adapterFor: adapterForUrl });
}

export function createUpstreamClient(options = {}) {
  return baseCreateUpstreamClient({
    adapterFor: adapterForUrl,
    ProxyAgentImpl: ProxyAgent,
    ...options,
  });
}
