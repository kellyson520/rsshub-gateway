import {
  DEFAULT_TELEGRAM_UNAVAILABLE_MESSAGE as DEFAULT_UNAVAILABLE_MESSAGE,
  isTelegramChannelPostUrl as baseIsTelegramChannelPostUrl,
  matchesHost,
  TELEGRAM_MATCH_HOSTS as MATCH_HOSTS,
} from '../http-utils.js';

export const name = 'telegram';
export const publiclyReadable = true;

export {
  MATCH_HOSTS,
  DEFAULT_UNAVAILABLE_MESSAGE,
};

export function matches(hostname) {
  return matchesHost(hostname, MATCH_HOSTS);
}

export function isTelegramChannelPostUrl(value) {
  return baseIsTelegramChannelPostUrl(value, MATCH_HOSTS);
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
