import * as cheerio from 'cheerio';

export const name = 'x';

export function matches(hostname) {
  return hostname === 'x.com' || hostname.endsWith('.x.com') || hostname === 'twitter.com' || hostname.endsWith('.twitter.com') || hostname.endsWith('.twimg.com');
}

export function headers(config = {}) {
  const cookies = [];
  if (config.authToken) cookies.push(`auth_token=${config.authToken}`);
  if (config.ct0) cookies.push(`ct0=${config.ct0}`);
  return cookies.length ? { cookie: cookies.join('; ') } : {};
}

export function readerTarget(url) {
  return String(url);
}

export function unavailableMessage() {
  return 'X 内容暂时无法读取。公开内容可能受登录或访问限制。';
}

export function isReaderUnavailable(html) {
  const $ = cheerio.load(html);
  return $('[data-testid="tweet"], article').length === 0
    && $('form[action*="login"], form input[name="text"][autocomplete="username"], form input[name="password"], a[href*="/i/flow/login"]').length > 0;
}
