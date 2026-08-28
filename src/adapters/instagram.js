import * as cheerio from 'cheerio';
import {
  DEFAULT_INSTAGRAM_UNAVAILABLE_MESSAGE as DEFAULT_UNAVAILABLE_MESSAGE,
  INSTAGRAM_AUTH_LOGIN_PATTERN as AUTH_LOGIN_PATTERN,
  INSTAGRAM_MATCH_HOSTS as MATCH_HOSTS,
  isInstagramReaderUnavailable,
  matchesHost,
} from '../http-utils.js';

export const name = 'instagram';
export const publiclyReadable = true;

export {
  MATCH_HOSTS,
  DEFAULT_UNAVAILABLE_MESSAGE,
  AUTH_LOGIN_PATTERN,
};

export function matches(hostname) {
  return matchesHost(hostname, MATCH_HOSTS);
}

export function headers(config = {}, { includeCredentials = false } = {}) {
  return includeCredentials && config.cookie ? { cookie: config.cookie } : {};
}

export function readerTarget(url) {
  return String(url);
}

export function unavailableMessage() {
  return DEFAULT_UNAVAILABLE_MESSAGE;
}

export function isReaderUnavailable(html) {
  return isInstagramReaderUnavailable(html, cheerio);
}

export function isAuthenticationChallenge({ status, headers, body } = {}) {
  if (status === 401) return true;
  const location = headers?.get?.('location') || headers?.location || '';
  if (status >= 300 && status < 400 && AUTH_LOGIN_PATTERN.test(location)) return true;
  return status >= 200 && status < 300 && typeof body === 'string' && isReaderUnavailable(body);
}
