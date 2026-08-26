import { matchesHost } from '../http-utils.js';

export const DEFAULT_REFERER = 'https://www.pixiv.net/';
export const MATCH_HOSTS = Object.freeze(['pixiv.net', 'pximg.net']);
export const DEFAULT_UNAVAILABLE_MESSAGE = 'Pixiv 内容暂时无法读取，请稍后重试或打开原始来源。';
export const name = 'pixiv';
export const publiclyReadable = true;

export function matches(hostname) {
  return matchesHost(hostname, MATCH_HOSTS);
}

export function headers(config = {}, { includeCredentials = false } = {}) {
  const result = { referer: config?.referer || DEFAULT_REFERER };
  if (includeCredentials && config?.cookie) result.cookie = config.cookie;
  return result;
}

export function readerTarget(url) {
  return String(url);
}

export function unavailableMessage() {
  return DEFAULT_UNAVAILABLE_MESSAGE;
}
