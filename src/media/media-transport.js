import {
  CACHE_RESPONSE_HEADERS,
  createMediaTransport as baseCreateMediaTransport,
  DEFAULT_KNOWN_SIZE_CAP,
  DEFAULT_KNOWN_SIZE_TTL_MS,
  DEFAULT_MEDIA_BROWSER_CACHE_SECONDS,
  DEFAULT_MEDIA_CACHE_MAX_FILE_BYTES,
  DEFAULT_PREFETCH_STATES_CAP,
  DEFAULT_SLICE_LOOKAHEAD_BYTES,
  DEFAULT_SLICE_SIZE,
  DEFAULT_VIDEO_CACHE_MAX_FILE_BYTES,
  defaultNamespaceFor,
  defaultSessionNamespace,
  IMAGE_VARIANT_CACHE_VERSION,
  imageVariantCacheUrl,
  parseByteRange,
  responseFromCachedDocument,
  responseHeaders,
  SLICE_ALIGN,
  sliceRanges,
} from '../http-utils.js';

export {
  CACHE_RESPONSE_HEADERS,
  IMAGE_VARIANT_CACHE_VERSION,
  SLICE_ALIGN,
  DEFAULT_SLICE_SIZE,
  DEFAULT_SLICE_LOOKAHEAD_BYTES,
  DEFAULT_MEDIA_CACHE_MAX_FILE_BYTES,
  DEFAULT_VIDEO_CACHE_MAX_FILE_BYTES,
  DEFAULT_MEDIA_BROWSER_CACHE_SECONDS,
  DEFAULT_KNOWN_SIZE_TTL_MS,
  DEFAULT_KNOWN_SIZE_CAP,
  DEFAULT_PREFETCH_STATES_CAP,
  defaultSessionNamespace,
  defaultNamespaceFor,
  responseHeaders,
  responseFromCachedDocument,
  imageVariantCacheUrl,
  parseByteRange,
  sliceRanges,
};

export function createMediaTransport(options = {}) {
  return baseCreateMediaTransport(options);
}
