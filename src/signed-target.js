import net from 'node:net';
import { boundedInteger, hmacSha256, isHostOrSubdomain, isSignatureMatch, matchesHost, safeJsonParse } from './http-utils.js';

const DEFAULT_TTL_SECONDS = 15 * 60;
const MEDIA_CACHE_TTL_SECONDS = 24 * 60 * 60;
const EGRESS_SCOPES = new Set(['public', 'session', 'sticky']);

const ALLOWED_HOSTS = Object.freeze([
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
  'missav.ws',
  'missav.live',
  'fourhoi.com',
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
  'airav.wiki',
  'airav.io',
  'netflav.com',
  '1024cdn.sx',
  '1025cdn.sx',
  '1026cdn.sx',
  '2024cdn.sx',
  '91porn.com',
  'cdn77.org',
  'playno1.com',
  'onlyfans.com',
  'blogspot.com',
  'bitfan.id',
  '141jav.com',
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
  'linux.do',
  'ldstatic.com',
  'linuxdo.org',
  'chikubi.jp',
  'wnacg.com',
  'wnacg.org',
  'sehuatang.net',
  'uraaka-joshi.com',
  'skeb.jp',
  'imgix.net',
  'kemono.su',
  'kemono.party',
  'kemono.cr',
  'coomer.su',
  'coomer.party',
  'coomer.st',
  'fanbox.cc',
]);

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
  // 白名单内的站点允许 http（个别源站仅提供 http，如 playno1.com）；
  // 白名单本身即是 SSRF 闸门，非白名单主机无论协议一律拒绝。
  if ((target.protocol !== 'https:' && target.protocol !== 'http:') || target.username || target.password) {
    return false;
  }
  if (net.isIP(target.hostname)) {
    return false;
  }
  const hostname = target.hostname.toLowerCase();
  const isHathHost = isHostOrSubdomain(hostname, 'hath.network');
  const isHathMedia = isHathHost
    && (target.pathname.startsWith('/h/') || target.pathname.startsWith('/om/') || /^\/c\d+\//.test(target.pathname));
  const isHathPortMedia = isHathHost
    && (target.pathname.startsWith('/h/') || target.pathname.startsWith('/om/'));
  const port = Number.parseInt(target.port, 10);
  const isValidHathMediaPort = !target.port || (isHathPortMedia && Number.isInteger(port) && port >= 1024 && port <= 65535);
  if ((isHathHost && !isHathMedia) || (target.port && !isValidHathMediaPort)) {
    return false;
  }
  return matchesHost(hostname, ALLOWED_HOSTS);
}

export function createSignedTarget(url, secret, ttlSeconds = DEFAULT_TTL_SECONDS, now = Math.floor(Date.now() / 1000), metadata = {}) {
  const target = new URL(url);
  if (!isAllowedTarget(target)) {
    throw new Error('target host is not allowed');
  }
  const payload = encode(JSON.stringify({ url: target.toString(), exp: now + ttlSeconds, ...routeMetadata(metadata) }));
  const signature = hmacSha256(payload, secret, 'base64url');
  return `${payload}.${signature}`;
}

export function createMediaSignedTarget(url, secret, now = Math.floor(Date.now() / 1000), metadata = {}) {
  const expiresAt = (Math.floor(now / MEDIA_CACHE_TTL_SECONDS) + 1) * MEDIA_CACHE_TTL_SECONDS;
  return createSignedTarget(url, secret, expiresAt - now, now, metadata);
}

export function isTargetSignatureValid(token, secret) {
  const [payload, signature] = String(token || '').split('.');
  if (!payload || !signature) return false;
  return isSignatureMatch(signature, hmacSha256(payload, secret));
}

export function verifySignedTarget(token, secret, now = Math.floor(Date.now() / 1000)) {
  const [payload, signature] = String(token).split('.');
  if (!payload || !signature) {
    throw new Error('malformed target token');
  }
  if (!isSignatureMatch(signature, hmacSha256(payload, secret))) {
    throw new Error('invalid target signature');
  }
  const data = safeJsonParse(decode(payload), null);
  if (!data || typeof data !== 'object'
    || Object.keys(data).some((key) => !['url', 'exp', 'egressScope', 'source'].includes(key))
    || !Number.isInteger(data.exp) || data.exp <= now || !isAllowedTarget(data.url)) {
    throw new Error('target expired or disallowed');
  }
  return { url: new URL(data.url).toString(), exp: data.exp, ...routeMetadata(data) };
}

export {
  ALLOWED_HOSTS,
  EGRESS_SCOPES,
  DEFAULT_TTL_SECONDS,
  MEDIA_CACHE_TTL_SECONDS,
  encode,
  decode,
  routeMetadata,
};
