import * as cheerio from 'cheerio';

export const name = 'instagram';
export const publiclyReadable = true;

export function matches(hostname) {
  return hostname === 'instagram.com' || hostname.endsWith('.instagram.com') || hostname.endsWith('.cdninstagram.com') || hostname.endsWith('.fbcdn.net');
}

export function headers(config = {}, { includeCredentials = false } = {}) {
  return includeCredentials && config.cookie ? { cookie: config.cookie } : {};
}

export function readerTarget(url) {
  return String(url);
}

export function unavailableMessage() {
  return 'Instagram 内容暂时无法读取。公开内容可能受登录或访问限制。';
}

export function isReaderUnavailable(html) {
  const $ = cheerio.load(html);
  return $('article').length === 0
    && $('form input[name="username"], form input[name="password"]').length > 0;
}

export function isAuthenticationChallenge({ status, headers, body } = {}) {
  if (status === 401) return true;
  const location = headers?.get?.('location') || headers?.location || '';
  if (status >= 300 && status < 400 && /\/(?:accounts\/login|login)(?:[/?#]|$)/i.test(location)) return true;
  return status >= 200 && status < 300 && typeof body === 'string' && isReaderUnavailable(body);
}
