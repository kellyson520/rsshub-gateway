import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { isAllowedTarget, EGRESS_SCOPES } from './signed-target.js';

const DEFAULT_TTL_MS = 30 * 60 * 1000;
const DEFAULT_MAX_BYTES = 2 * 1024 ** 3;
const DEFAULT_MAX_CONCURRENCY = 8;

function encode(value) {
  return Buffer.from(value).toString('base64url');
}

function decode(value) {
  return Buffer.from(value, 'base64url').toString('utf8');
}

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
      allowHosts: [...new Set((allowHosts || []).map((host) => String(host).toLowerCase()))],
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
    const provided = Buffer.from(String(password));
    const expected = Buffer.from(lease.password);
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
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

  function publicView(lease, { proxyHost, proxyPort, proxyUrl }) {
    let endpoint;
    if (proxyUrl) {
      const url = new URL(String(proxyUrl));
      url.username = lease.username;
      url.password = lease.password;
      endpoint = url.toString().replace(/\/$/, '');
    } else {
      endpoint = `http://${lease.username}:${lease.password}@${proxyHost}:${proxyPort}`;
    }
    return {
      username: lease.username,
      password: lease.password,
      proxyUrl: endpoint,
      url: lease.resolvedUrl,
      allowHosts: lease.allowHosts,
      expiresAt: lease.expiresAt,
      ttlMs: lease.expiresAt - now(),
      maxBytes: lease.maxBytes,
      maxConcurrency: lease.maxConcurrency,
      once: true,
    };
  }

  function stats() {
    return { leases: leases.size, active: [...leases.values()].filter((l) => l.activeConnections > 0).length };
  }

  return { createLease, verify, revoke, revokeExpired, publicView, stats };
}

export function createSignedChunk({ url, start, end, secret, now: nowValue = Math.floor(Date.now() / 1000), ttlSeconds = 24 * 60 * 60, metadata = {} }) {
  const payload = encode(JSON.stringify({
    url: new URL(url).toString(),
    start: Number(start),
    end: Number(end),
    exp: nowValue + ttlSeconds,
    ...metadata,
  }));
  const signature = createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

const CHUNK_METADATA_KEYS = new Set(['egressScope', 'source', 'sessionId', 'index']);

export function verifySignedChunk(token, secret, now = Math.floor(Date.now() / 1000)) {
  const [payload, signature] = String(token).split('.');
  if (!payload || !signature) throw new Error('malformed chunk token');
  const expected = createHmac('sha256', secret).update(payload).digest();
  const actual = Buffer.from(signature, 'base64url');
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new Error('invalid chunk signature');
  }
  const data = JSON.parse(decode(payload));
  if (!data || typeof data !== 'object' || !Number.isInteger(data.exp) || data.exp <= now) {
    throw new Error('chunk expired or malformed');
  }
  if (!Number.isInteger(data.start) || !Number.isInteger(data.end) || data.start < 0 || data.end < data.start) {
    throw new Error('invalid chunk range');
  }
  // Defense in depth: the chunk carries an outbound fetch target, so it must
  // stay inside the same host allowlist as signed item/media targets, and its
  // metadata keys/values must match what the signer can actually emit.
  if (Object.keys(data).some((key) => !['url', 'exp', 'start', 'end', ...CHUNK_METADATA_KEYS].includes(key))) {
    throw new Error('chunk metadata is not allowed');
  }
  if (data.egressScope !== undefined && !EGRESS_SCOPES.has(data.egressScope)) {
    throw new Error('chunk egress scope is not allowed');
  }
  if (data.source !== undefined && !/^[a-z][a-z0-9_-]{0,31}$/.test(String(data.source))) {
    throw new Error('chunk source is not allowed');
  }
  let targetAllowed = false;
  try {
    targetAllowed = isAllowedTarget(data.url);
  } catch {
    targetAllowed = false;
  }
  if (!targetAllowed) throw new Error('chunk target is not allowed');
  return data;
}
