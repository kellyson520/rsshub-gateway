import { createHmac, timingSafeEqual } from 'node:crypto';
import net from 'node:net';

const DEFAULT_TTL_SECONDS = 15 * 60;
const MEDIA_CACHE_TTL_SECONDS = 24 * 60 * 60;

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
];

function encode(value) {
  return Buffer.from(value).toString('base64url');
}

function decode(value) {
  return Buffer.from(value, 'base64url').toString('utf8');
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

export function createSignedTarget(url, secret, ttlSeconds = DEFAULT_TTL_SECONDS, now = Math.floor(Date.now() / 1000)) {
  const target = new URL(url);
  if (!isAllowedTarget(target)) {
    throw new Error('target host is not allowed');
  }
  const payload = encode(JSON.stringify({ url: target.toString(), exp: now + ttlSeconds }));
  const signature = createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

export function createMediaSignedTarget(url, secret, now = Math.floor(Date.now() / 1000)) {
  const expiresAt = (Math.floor(now / MEDIA_CACHE_TTL_SECONDS) + 1) * MEDIA_CACHE_TTL_SECONDS;
  return createSignedTarget(url, secret, expiresAt - now, now);
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
  if (!Number.isInteger(data.exp) || data.exp <= now || !isAllowedTarget(data.url)) {
    throw new Error('target expired or disallowed');
  }
  return data;
}

export { ALLOWED_HOSTS };
