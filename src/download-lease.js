import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const DEFAULT_TTL_MS = 30 * 60 * 1000;
const DEFAULT_MAX_BYTES = 2 * 1024 ** 3;
const DEFAULT_MAX_CONCURRENCY = 8;
const DEFAULT_CHUNK_SIZE = 1024 * 1024;
const MIN_CHUNK_SIZE = 256 * 1024;
const MAX_CHUNK_SIZE = 16 * 1024 * 1024;

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
    if (!lease || lease.revoked || lease.password !== String(password) || now() >= lease.expiresAt) {
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

export function chunkSizeFor(totalBytes, chunks, { min = MIN_CHUNK_SIZE, max = MAX_CHUNK_SIZE } = {}) {
  const count = Number.isInteger(chunks) && chunks >= 1 ? Math.min(chunks, 256) : 1;
  if (!Number.isSafeInteger(totalBytes) || totalBytes <= 0) return { count: 1, size: DEFAULT_CHUNK_SIZE };
  const natural = Math.ceil(totalBytes / count);
  const size = Math.max(min, Math.min(max, Math.ceil(natural / (64 * 1024)) * (64 * 1024)));
  return { count: Math.min(count, Math.ceil(totalBytes / size)), size };
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
  return data;
}
