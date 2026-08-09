import * as cheerio from 'cheerio';

export const name = 'instagram';

export function matches(hostname) {
  return hostname === 'instagram.com' || hostname.endsWith('.instagram.com') || hostname.endsWith('.cdninstagram.com') || hostname.endsWith('.fbcdn.net');
}

export function headers(config = {}) {
  return config.cookie ? { cookie: config.cookie } : {};
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
