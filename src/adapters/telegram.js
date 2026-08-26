import { matchesHost } from '../http-utils.js';

export const name = 'telegram';
export const publiclyReadable = true;
export const MATCH_HOSTS = Object.freeze(['t.me']);
export const DEFAULT_UNAVAILABLE_MESSAGE = 'Telegram 内容暂时无法读取，请稍后重试或打开原始来源。';

export function matches(hostname) {
  return matchesHost(hostname, MATCH_HOSTS);
}

export function isTelegramChannelPostUrl(value) {
  try {
    const url = new URL(value);
    const parts = url.pathname.split('/').filter(Boolean);
    return matches(url.hostname) && parts.length === 2 && /^\d+$/.test(parts[1]);
  } catch {
    return false;
  }
}

export function headers(_config = {}, _options = {}) {
  return {};
}

export function readerTarget(value) {
  try {
    const url = new URL(value);
    if (isTelegramChannelPostUrl(url)) {
      url.searchParams.set('embed', '1');
    }
    return url.toString();
  } catch {
    return String(value || '');
  }
}

export function unavailableMessage() {
  return DEFAULT_UNAVAILABLE_MESSAGE;
}

export function isAuthenticationChallenge() {
  return false;
}
