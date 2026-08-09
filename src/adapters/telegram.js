export const name = 'telegram';

export function matches(hostname) {
  return hostname === 't.me' || hostname.endsWith('.t.me');
}

export function headers() {
  return {};
}

export function readerTarget(value) {
  const url = new URL(value);
  const parts = url.pathname.split('/').filter(Boolean);
  if (url.hostname === 't.me' && parts.length === 2 && /^\d+$/.test(parts[1])) {
    url.searchParams.set('embed', '1');
  }
  return url.toString();
}

export function unavailableMessage() {
  return 'Telegram 内容暂时无法读取，请稍后重试或打开原始来源。';
}
