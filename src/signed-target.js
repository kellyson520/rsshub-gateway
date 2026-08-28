import {
  ALLOWED_HOSTS,
  base64UrlDecode,
  base64UrlEncode,
  createMediaSignedTarget,
  createSignedTarget,
  DEFAULT_TTL_SECONDS,
  EGRESS_SCOPES,
  isAllowedTarget,
  isTargetSignatureValid,
  MEDIA_CACHE_TTL_SECONDS,
  routeMetadata,
  verifySignedTarget,
} from './http-utils.js';

const encode = base64UrlEncode;
const decode = base64UrlDecode;

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
  createSignedTarget,
  createMediaSignedTarget,
  verifySignedTarget,
};
