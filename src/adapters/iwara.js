export const name = 'iwara';

export function matches(hostname) {
  return hostname === 'iwara.tv' || hostname.endsWith('.iwara.tv');
}

export function headers(config = {}) {
  return config.cookie ? { cookie: config.cookie } : {};
}

export function readerTarget(url) {
  return String(url);
}

export function unavailableMessage() {
  return 'Iwara 内容暂时无法读取，请稍后重试或打开原始来源。';
}
