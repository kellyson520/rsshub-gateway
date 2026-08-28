import {
  ALLOWED_HOSTS,
  base64UrlDecode,
  base64UrlEncode,
  boundedInteger,
  DEFAULT_TTL_SECONDS,
  EGRESS_SCOPES,
  hmacSha256,
  isAllowedTarget,
  isHostOrSubdomain,
  isSignatureMatch,
  isTargetSignatureValid,
  matchesHost,
  MEDIA_CACHE_TTL_SECONDS,
  routeMetadata,
  safeJsonParse,
} from './http-utils.js';

const encode = base64UrlEncode;
const decode = base64UrlDecode;

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
  isAllowedTarget,
  isTargetSignatureValid,
};
