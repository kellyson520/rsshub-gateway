export const name = 'adult-media';
export const publiclyReadable = true;

export const DEFAULT_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
export const DEFAULT_ACCEPT_LANGUAGE = 'zh-CN,zh;q=0.9,ja;q=0.8,en;q=0.7';

export const ADULT_DOMAINS = [
  'jable.tv',
  'missav.ws',
  'missav.ai',
  'missav.com',
  'missav.live',
  'javbus.com',
  'javbus.one',
  'javdb.com',
  'airav.wiki',
  'airav.io',
  'ggjav.com',
  'ggjav.tv',
  'wnacg.com',
  'wnacg.org',
  'chikubi.jp',
  'skeb.jp',
  'fanbox.cc',
  'kemono.su',
  'kemono.party',
  'kemono.cr',
  'coomer.su',
  'coomer.party',
  'coomer.st',
  'sehuatang.net',
  'uraaka-joshi.com',
  'netflav.com',
  '91porn.com',
];

export function matches(hostname) {
  return ADULT_DOMAINS.some((d) => hostname === d || hostname.endsWith(`.${d}`));
}

export function headers() {
  return {
    'User-Agent': DEFAULT_USER_AGENT,
    'Accept-Language': DEFAULT_ACCEPT_LANGUAGE,
  };
}

export function readerTarget(url) {
  return String(url);
}

export function unavailableMessage() {
  return '该视频/漫画页面暂时无法直接读取，请稍后刷新或点击打开原始来源。';
}

export function isAuthenticationChallenge({ status, headers, body } = {}) {
  if (status === 401 || status === 403) return true;
  if (status < 200 || status >= 300 || typeof body !== 'string') return false;
  return body.includes('Just a moment...') || body.includes('cf-challenge') || body.includes('ddos-guard');
}
