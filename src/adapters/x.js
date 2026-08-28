import * as cheerio from 'cheerio';
import {
  DEFAULT_X_UNAVAILABLE_MESSAGE as DEFAULT_UNAVAILABLE_MESSAGE,
  matchesHost,
  X_AUTH_FLOW_LOGIN_PATTERN as AUTH_FLOW_LOGIN_PATTERN,
  X_MATCH_HOSTS as MATCH_HOSTS,
} from '../http-utils.js';

export const name = 'x';
export const publiclyReadable = true;

export {
  MATCH_HOSTS,
  DEFAULT_UNAVAILABLE_MESSAGE,
  AUTH_FLOW_LOGIN_PATTERN,
};

export function matches(hostname) {
  return matchesHost(hostname, MATCH_HOSTS);
}

export function headers(config = {}, { includeCredentials = false } = {}) {
  if (!includeCredentials) return {};
  const cookies = [];
  if (config.authToken) cookies.push(`auth_token=${config.authToken}`);
  if (config.ct0) cookies.push(`ct0=${config.ct0}`);
  return cookies.length ? { cookie: cookies.join('; ') } : {};
}

export function readerTarget(url) {
  return String(url);
}

export function unavailableMessage() {
  return DEFAULT_UNAVAILABLE_MESSAGE;
}

export function isReaderUnavailable(html) {
  const $ = cheerio.load(html);
  return $('[data-testid="tweet"], article').length === 0
    && $('form[action*="login"], form input[name="text"][autocomplete="username"], form input[name="password"], a[href*="/i/flow/login"]').length > 0;
}

export function isAuthenticationChallenge({ status, headers, body } = {}) {
  if (status === 401) return true;
  const location = headers?.get?.('location') || headers?.location || '';
  if (status >= 300 && status < 400 && AUTH_FLOW_LOGIN_PATTERN.test(location)) return true;
  return status >= 200 && status < 300 && typeof body === 'string' && isReaderUnavailable(body);
}
