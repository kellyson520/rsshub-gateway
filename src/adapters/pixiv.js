import {
  DEFAULT_PIXIV_UNAVAILABLE_MESSAGE as DEFAULT_UNAVAILABLE_MESSAGE,
  matchesHost,
  PIXIV_DEFAULT_REFERER as DEFAULT_REFERER,
  PIXIV_MATCH_HOSTS as MATCH_HOSTS,
  pixivHeaders,
} from '../http-utils.js';

export const name = 'pixiv';
export const publiclyReadable = true;

export {
  DEFAULT_REFERER,
  MATCH_HOSTS,
  DEFAULT_UNAVAILABLE_MESSAGE,
  pixivHeaders,
};

export function matches(hostname) {
  return matchesHost(hostname, MATCH_HOSTS);
}

export function headers(config = {}, { includeCredentials = false } = {}) {
  return pixivHeaders(config, { includeCredentials });
}

export function readerTarget(url) {
  return String(url);
}

export function unavailableMessage() {
  return DEFAULT_UNAVAILABLE_MESSAGE;
}
