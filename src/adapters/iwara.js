export const name = 'iwara';
export const publiclyReadable = true;

export function matches(hostname) {
  return hostname === 'iwara.tv' || hostname.endsWith('.iwara.tv');
}

export function headers(config = {}, { includeCredentials = false } = {}) {
  return includeCredentials && config.cookie ? { cookie: config.cookie } : {};
}

export function readerTarget(url) {
  return String(url);
}

export function unavailableMessage() {
  return 'Iwara 内容暂时无法读取，请稍后重试或打开原始来源。';
}

export function isAuthenticationChallenge({ status, headers, body } = {}) {
  if (status === 401) return true;
  const location = headers?.get?.('location') || headers?.location || '';
  if (status >= 300 && status < 400 && /\/(?:login|signin)(?:[/?#]|$)/i.test(location)) return true;
  if (status < 200 || status >= 300 || typeof body !== 'string') return false;
  return /<form[^>]+action=["'][^"']*\/(?:login|signin)/i.test(body)
    && /(?:name=["']password["']|type=["']password["'])/i.test(body);
}
