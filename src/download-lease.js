import {
  createLeaseStore as baseCreateLeaseStore,
  createSignedChunk,
  DEFAULT_LEASE_MAX_BYTES as DEFAULT_MAX_BYTES,
  DEFAULT_LEASE_MAX_CONCURRENCY as DEFAULT_MAX_CONCURRENCY,
  DEFAULT_LEASE_TTL_MS as DEFAULT_TTL_MS,
  isChunkSignatureValid,
  publicLeaseView,
  verifySignedChunk,
} from './http-utils.js';

export {
  DEFAULT_TTL_MS,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_CONCURRENCY,
  publicLeaseView,
  isChunkSignatureValid,
  createSignedChunk,
  verifySignedChunk,
};

export function createLeaseStore(options = {}) {
  return baseCreateLeaseStore(options);
}
