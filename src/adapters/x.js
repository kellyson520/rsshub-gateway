import * as cheerio from 'cheerio';
import {
  DEFAULT_X_UNAVAILABLE_MESSAGE as DEFAULT_UNAVAILABLE_MESSAGE,
  isXReaderUnavailable,
  matchesHost,
  X_AUTH_FLOW_LOGIN_PATTERN as AUTH_FLOW_LOGIN_PATTERN,
  X_MATCH_HOSTS as MATCH_HOSTS,
  xHeaders,
} from '../http-utils.js';

export const name = 'x';
export const publiclyReadable = true;

export {
  MATCH_HOSTS,
  DEFAULT_UNAVAILABLE_MESSAGE,
  AUTH_FLOW_LOGIN_PATTERN,
  xHeaders,
  isXReaderUnavailable,
};

export function matches(hostname) {
  return matchesHost(hostname, MATCH_HOSTS);
}

export function headers(config = {}, { includeCredentials = false } = {}) {
  return xHeaders(config, { includeCredentials });
}

export function readerTarget(url) {
  return String(url);
}

export function unavailableMessage() {
  return DEFAULT_UNAVAILABLE_MESSAGE;
}

export function isReaderUnavailable(html) {
  return isXReaderUnavailable(html, cheerio);
}

export function isAuthenticationChallenge({ status, headers, body } = {}) {
  if (status === 401) return true;
  const location = headers?.get?.('location') || headers?.location || '';
  if (status >= 300 && status < 400 && AUTH_FLOW_LOGIN_PATTERN.test(location)) return true;
  return status >= 200 && status < 300 && typeof body === 'string' && isReaderUnavailable(body);
}
