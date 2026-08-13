import { createHmac, timingSafeEqual } from 'node:crypto';
import net from 'node:net';

const DEFAULT_TTL_SECONDS = 15 * 60;
const MEDIA_CACHE_TTL_SECONDS = 24 * 60 * 60;
const EGRESS_SCOPES = new Set(['public', 'session', 'sticky']);

const ALLOWED_HOSTS = [
  'iwara.tv',
  'x.com',
  'twitter.com',
  'twimg.com',
  'instagram.com',
  'cdninstagram.com',
  'fbcdn.net',
  'v2ex.com',
  't.me',
  'telesco.pe',
  'e-hentai.org',
  'ehgt.org',
  'hath.network',
  'nhentai.net',
  'hitomi.la',
  'pururin.io',
  'pururin.com',
  'hanime.tv',
  'hentai.tv',
  'hentai-foundry.com',
  '8muses.com',
  'rule34.xxx',
  'gelbooru.com',
  'danbooru.donmai.us',
  'donmai.us',
  'sankakucomplex.com',
  'hiyobi.me',
  'pornhub.com',
  'phncdn.com',
  'xvideos.com',
  'xv-cdn.com',
  'missav.com',
  'missav.ai',
  'javdb.com',
  'jdbstatic.com',
  'javbus.com',
  'javbus.one',
  'jpgcdn.com',
  'mgstage.com',
  'jable.tv',
  'dmm.co.jp',
  'ggjav.com',
  'ggjav.tv',
  'imgur.com',
  'i.imgur.com',
  'cdn.discordapp.com',
  'media.discordapp.net',
  'i.redd.it',
  'preview.redd.it',
  'v.redd.it',
  'external-preview.redd.it',
  'redditmedia.com',
  'ytimg.com',
  'static.flickr.com',
  'live.staticflickr.com',
  'cdn.myanimelist.net',
  's4.anilist.co',
  'image.tmdb.org',
  'media.steampowered.com',
  'i.ebayimg.com',
  'i.postimg.cc',
  'githubusercontent.com',
  'googleusercontent.com',
  'mzstatic.com',
  'm.media-amazon.com',
  'images.unsplash.com',
  'wikia.nocookie.net',
  'upload.wikimedia.org',
  'steamstatic.com',
  'scdn.co',
  'sndcdn.com',
  'cdn.telegram.org',
  'tiktok.com',
  'tiktokcdn.com',
  'tiktokcdn-us.com',
  'tiktokcdn-eu.com',
  'cloudinary.com',
  'images.weserv.nl',
  'wsrv.nl',
  'pixiv.net',
  'pximg.net',
  'sspai.com',
  'joeytoday.com',
  'share-text.org',
  'imgdd.cc',
  'hdslb.com',
  'biliimg.com',
  'sinaimg.cn',
  'zhimg.com',
  'doubanio.com',
  'music.126.net',
  'xhscdn.com',
];

function encode(value) {
  return Buffer.from(value).toString('base64url');
}

function decode(value) {
  return Buffer.from(value, 'base64url').toString('utf8');
}

function routeMetadata(metadata = {}) {
  const result = {};
  if (metadata?.egressScope !== undefined) {
    if (!EGRESS_SCOPES.has(metadata.egressScope)) throw new Error('unsupported egress scope');
    result.egressScope = metadata.egressScope;
  }
  if (metadata?.source !== undefined) {
    const source = String(metadata.source).trim().toLowerCase();
    if (!/^[a-z][a-z0-9_-]{0,31}$/.test(source)) throw new Error('unsupported route source');
    result.source = source;
  }
  return result;
}

export function isAllowedTarget(value) {
  const target = value instanceof URL ? value : new URL(value);
  if (target.protocol !== 'https:' || target.username || target.password) {
    return false;
  }
  if (net.isIP(target.hostname)) {
    return false;
  }
  const hostname = target.hostname.toLowerCase();
  const isHathHost = hostname === 'hath.network' || hostname.endsWith('.hath.network');
  const isHathMedia = isHathHost
    && (target.pathname.startsWith('/h/') || target.pathname.startsWith('/om/') || /^\/c\d+\//.test(target.pathname));
  const isHathPortMedia = isHathHost
    && (target.pathname.startsWith('/h/') || target.pathname.startsWith('/om/'));
  const port = Number.parseInt(target.port, 10);
  const isValidHathMediaPort = !target.port || (isHathPortMedia && Number.isInteger(port) && port >= 1024 && port <= 65535);
  if ((isHathHost && !isHathMedia) || (target.port && !isValidHathMediaPort)) {
    return false;
  }
  return ALLOWED_HOSTS.some((base) => hostname === base || hostname.endsWith(`.${base}`));
}

export function createSignedTarget(url, secret, ttlSeconds = DEFAULT_TTL_SECONDS, now = Math.floor(Date.now() / 1000), metadata = {}) {
  const target = new URL(url);
  if (!isAllowedTarget(target)) {
    throw new Error('target host is not allowed');
  }
  const payload = encode(JSON.stringify({ url: target.toString(), exp: now + ttlSeconds, ...routeMetadata(metadata) }));
  const signature = createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

export function createMediaSignedTarget(url, secret, now = Math.floor(Date.now() / 1000), metadata = {}) {
  const expiresAt = (Math.floor(now / MEDIA_CACHE_TTL_SECONDS) + 1) * MEDIA_CACHE_TTL_SECONDS;
  return createSignedTarget(url, secret, expiresAt - now, now, metadata);
}

export function verifySignedTarget(token, secret, now = Math.floor(Date.now() / 1000)) {
  const [payload, signature] = String(token).split('.');
  if (!payload || !signature) {
    throw new Error('malformed target token');
  }
  const expected = createHmac('sha256', secret).update(payload).digest();
  const actual = Buffer.from(signature, 'base64url');
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new Error('invalid target signature');
  }
  const data = JSON.parse(decode(payload));
  if (!data || typeof data !== 'object'
    || Object.keys(data).some((key) => !['url', 'exp', 'egressScope', 'source'].includes(key))
    || !Number.isInteger(data.exp) || data.exp <= now || !isAllowedTarget(data.url)) {
    throw new Error('target expired or disallowed');
  }
  return { url: new URL(data.url).toString(), exp: data.exp, ...routeMetadata(data) };
}

export { ALLOWED_HOSTS, EGRESS_SCOPES };
