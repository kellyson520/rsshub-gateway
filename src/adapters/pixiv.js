export const name = 'pixiv';
export const publiclyReadable = true;

export function matches(hostname) {
  return hostname === 'pixiv.net'
    || hostname.endsWith('.pixiv.net')
    || hostname === 'i.pximg.net'
    || hostname.endsWith('.pximg.net');
}

export function headers(config = {}, { includeCredentials = false } = {}) {
  const result = { referer: config?.referer || 'https://www.pixiv.net/' };
  if (includeCredentials && config?.cookie) result.cookie = config.cookie;
  return result;
}

export function readerTarget(url) {
  return String(url);
}

export function unavailableMessage() {
  return 'Pixiv 内容暂时无法读取，请稍后重试或打开原始来源。';
}
