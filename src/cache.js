import {
  CACHE_BODY_PATTERN,
  CACHE_INDEX_VERSION,
  CACHE_SAFE_HEADERS as SAFE_HEADERS,
  cacheBodyFile,
  cacheKeyFor as keyFor,
  canonicalUrl,
  createResponseCache as baseCreateResponseCache,
  DEFAULT_CACHE_MAX_BYTES as DEFAULT_MAX_BYTES,
  DEFAULT_CACHE_ROOT,
  DEFAULT_CACHE_TTL_SECONDS as DEFAULT_TTL_SECONDS,
  DEFAULT_EVICTION_PRIORITY,
  isCacheBodyFile,
  isSha256Hex,
  isValidCacheIndexRecord,
  normalizeCacheBody as normalizeBody,
  normalizeCacheHeaders as normalizedHeaders,
  normalizedNamespace,
  positiveNumber,
  resultFromCacheEntry as resultFromEntry,
} from './http-utils.js';

export {
  keyFor,
  canonicalUrl,
  normalizedNamespace,
  normalizedHeaders,
  normalizeBody,
  positiveNumber,
  resultFromEntry,
  SAFE_HEADERS,
  DEFAULT_TTL_SECONDS,
  DEFAULT_MAX_BYTES,
  DEFAULT_EVICTION_PRIORITY,
  DEFAULT_CACHE_ROOT,
  CACHE_INDEX_VERSION,
  isValidCacheIndexRecord,
  isCacheBodyFile,
  cacheBodyFile,
};

export function createResponseCache(options = {}) {
  return baseCreateResponseCache(options);
}
