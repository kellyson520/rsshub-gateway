import { randomBytes } from 'node:crypto';
import { decode, encode, isAllowedTarget, EGRESS_SCOPES } from './signed-target.js';
import {
  CHUNK_METADATA_KEYS,
  constantTimeEquals,
  createSignedChunk,
  DEFAULT_LEASE_MAX_BYTES as DEFAULT_MAX_BYTES,
  DEFAULT_LEASE_MAX_CONCURRENCY as DEFAULT_MAX_CONCURRENCY,
  DEFAULT_LEASE_TTL_MS as DEFAULT_TTL_MS,
  dedupe,
  hmacSha256,
  isChunkSignatureValid,
  isSignatureMatch,
  publicLeaseView,
  safeJsonParse,
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

/**
 * One-time, short-lived download leases.
 *
 * A lease gives a client temporary proxy credentials (Basic auth) so it can act
 * as its own downloader: open several parallel connections and pull the video
 * directly from the upstream through the gateway's egress pool. Leases are
 * revoked on expiry, when the byte cap is reached, or after the download
 * session (all active connections) finishes.
 */
export function createLeaseStore({ now = Date.now } = {}) {
  const leases = new Map();

  function createLease({
    targetUrl,
    resolvedUrl,
    allowHosts,
    ttlMs = DEFAULT_TTL_MS,
    maxBytes = DEFAULT_MAX_BYTES,
    maxConcurrency = DEFAULT_MAX_CONCURRENCY,
    metadata = {},
  }) {
    const createdAt = now();
    const lease = {
      username: randomBytes(12).toString('base64url'),
      password: randomBytes(18).toString('base64url'),
      targetUrl: String(targetUrl),
      resolvedUrl: String(resolvedUrl || targetUrl),
      allowHosts: dedupe((allowHosts || []).map((host) => String(host).toLowerCase())),
      createdAt,
      expiresAt: createdAt + ttlMs,
      maxBytes: Number.isFinite(maxBytes) && maxBytes > 0 ? maxBytes : DEFAULT_MAX_BYTES,
      maxConcurrency: Number.isInteger(maxConcurrency) && maxConcurrency >= 1 && maxConcurrency <= 32
        ? maxConcurrency
        : DEFAULT_MAX_CONCURRENCY,
      usedBytes: 0,
      activeConnections: 0,
      completedConnections: 0,
      revoked: false,
      source: metadata.source || 'unknown',
    };
    leases.set(lease.username, lease);
    return lease;
  }

  function verify(username, password) {
    const lease = leases.get(String(username));
    if (!lease || lease.revoked || now() >= lease.expiresAt) {
      return null;
    }
    // Constant-time comparison, matching the HMAC verification style elsewhere.
    if (!constantTimeEquals(password, lease.password)) {
      return null;
    }
    return lease;
  }

  function revoke(username) {
    const lease = leases.get(String(username));
    if (lease) lease.revoked = true;
    return lease || null;
  }

  function revokeExpired() {
    const expired = [];
    for (const lease of leases.values()) {
      if (lease.revoked || now() >= lease.expiresAt) {
        leases.delete(lease.username);
        expired.push(lease.username);
      }
    }
    return expired;
  }

  function publicView(lease, options) {
    return publicLeaseView(lease, options, now);
  }

  function stats() {
    return { leases: leases.size, active: [...leases.values()].filter((l) => l.activeConnections > 0).length };
  }

  return { createLease, verify, revoke, revokeExpired, publicView, stats };
}
