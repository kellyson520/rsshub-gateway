export const name = 'telegram';
export const publiclyReadable = true;
export const MATCH_HOSTS = Object.freeze(['t.me']);
export const DEFAULT_UNAVAILABLE_MESSAGE = 'Telegram 内容暂时无法读取，请稍后重试或打开原始来源。';

export function matches(hostname) {
  return hostname === 't.me' || hostname.endsWith('.t.me');
}

export function isTelegramChannelPostUrl(value) {
  try {
    const url = new URL(value);
    const parts = url.pathname.split('/').filter(Boolean);
    return (url.hostname === 't.me' || url.hostname.endsWith('.t.me')) && parts.length === 2 && /^\d+$/.test(parts[1]);
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
