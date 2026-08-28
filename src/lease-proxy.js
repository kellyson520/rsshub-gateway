import {
  createLeaseProxy as baseCreateLeaseProxy,
  DEFAULT_LEASE_FAILURE_THRESHOLD,
  DEFAULT_LEASE_FAILURE_WINDOW_MS,
  DEFAULT_LEASE_FAILURES_CAP,
  DEFAULT_LEASE_HANDSHAKE_MAX_BYTES,
  DEFAULT_LEASE_PROXY_HOST,
  DEFAULT_LEASE_UPSTREAM_PROXY_HOST,
  DEFAULT_LEASE_UPSTREAM_PROXY_PORT,
  formatConnectHeader,
  isLeaseComplete,
  parseAuthority,
  parseProxyAuth,
  positiveInteger,
  rejectConnect,
  safeEvent,
  writeText,
} from './http-utils.js';

export {
  parseProxyAuth,
  parseAuthority,
  isLeaseComplete,
  rejectConnect,
  formatConnectHeader,
  DEFAULT_LEASE_UPSTREAM_PROXY_HOST,
  DEFAULT_LEASE_UPSTREAM_PROXY_PORT,
  DEFAULT_LEASE_PROXY_HOST,
  DEFAULT_LEASE_FAILURES_CAP,
  DEFAULT_LEASE_FAILURE_WINDOW_MS,
  DEFAULT_LEASE_FAILURE_THRESHOLD,
  DEFAULT_LEASE_HANDSHAKE_MAX_BYTES,
};

export function createLeaseProxy(options = {}) {
  return baseCreateLeaseProxy(options);
}
