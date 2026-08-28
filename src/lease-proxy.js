import http from 'node:http';
import net from 'node:net';
import {
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

export function createLeaseProxy({
  leaseStore,
  upstreamProxyHost = DEFAULT_LEASE_UPSTREAM_PROXY_HOST,
  upstreamProxyPort = DEFAULT_LEASE_UPSTREAM_PROXY_PORT,
  host = DEFAULT_LEASE_PROXY_HOST,
  port,
  onEvent = () => {},
} = {}) {
  const server = http.createServer((req, res) => {
    writeText(res, 405, 'lease proxy supports CONNECT only\n');
  });

  const failuresByIp = new Map();

  function recordFailure(ip) {
    const now = Date.now();
    const entry = failuresByIp.get(ip) || { count: 0, windowStart: now };
    if (now - entry.windowStart > DEFAULT_LEASE_FAILURE_WINDOW_MS) {
      entry.count = 0;
      entry.windowStart = now;
    }
    entry.count += 1;
    failuresByIp.set(ip, entry);
    if (failuresByIp.size > DEFAULT_LEASE_FAILURES_CAP) failuresByIp.clear();
    return entry.count;
  }

  function rateLimited(ip) {
    const entry = failuresByIp.get(ip);
    if (!entry) return false;
    if (Date.now() - entry.windowStart > DEFAULT_LEASE_FAILURE_WINDOW_MS) {
      failuresByIp.delete(ip);
      return false;
    }
    return entry.count >= DEFAULT_LEASE_FAILURE_THRESHOLD;
  }

  function pipeTunnel(clientSocket, proxySocket, lease, onClose) {
    let closed = false;
    const finish = () => {
      if (closed) return;
      closed = true;
      lease.activeConnections = Math.max(0, lease.activeConnections - 1);
      lease.completedConnections += 1;
      onClose(lease);
      clientSocket.destroy();
      proxySocket.destroy();
    };
    clientSocket.on('error', finish);
    proxySocket.on('error', finish);
    clientSocket.on('end', finish);
    proxySocket.on('end', finish);
    clientSocket.on('close', finish);
    proxySocket.on('close', finish);
    const account = (chunk) => {
      lease.usedBytes += chunk.length;
      if (lease.usedBytes >= lease.maxBytes) {
        safeEvent(onEvent, { event: 'lease_byte_cap', username: lease.username, usedBytes: lease.usedBytes });
        finish();
        return false;
      }
      return true;
    };
    proxySocket.on('data', (chunk) => {
      if (account(chunk)) clientSocket.write(chunk);
    });
    clientSocket.on('data', (chunk) => {
      if (account(chunk)) proxySocket.write(chunk);
    });
  }

  function completeLease(lease, reason) {
    if (isLeaseComplete(lease)) {
      leaseStore.revoke(lease.username);
      safeEvent(onEvent, { event: 'lease_completed', username: lease.username, usedBytes: lease.usedBytes, reason });
    }
  }

  server.on('connect', (req, clientSocket, head) => {
    const ip = String(req.headers['x-lease-client-ip'] || req.socket.remoteAddress || 'unknown');
    let tunnelEstablished = false;
    if (rateLimited(ip)) {
      rejectConnect(clientSocket, 403, 'rate limited\n');
      return;
    }
    const credentials = parseProxyAuth(req.headers['proxy-authorization']);
    const lease = credentials ? leaseStore.verify(credentials.username, credentials.password) : null;
    if (!lease) {
      recordFailure(ip);
      safeEvent(onEvent, { event: 'lease_auth_failure', ip });
      rejectConnect(clientSocket, 407, 'proxy authentication required\n');
      return;
    }
    const authority = parseAuthority(req.url);
    if (!authority || !lease.allowHosts.includes(authority.hostname)) {
      safeEvent(onEvent, { event: 'lease_host_denied', username: lease.username, host: authority?.hostname });
      rejectConnect(clientSocket, 403, 'host not allowed by lease\n');
      return;
    }
    if (lease.activeConnections >= lease.maxConcurrency) {
      rejectConnect(clientSocket, 429, 'lease concurrency exhausted\n');
      return;
    }
    const proxySocket = net.connect(upstreamProxyPort, upstreamProxyHost, () => {
      proxySocket.write(formatConnectHeader(authority.hostname, authority.port));
    });
    proxySocket.on('error', () => {
      if (!tunnelEstablished) rejectConnect(clientSocket, 502, 'upstream proxy unavailable\n');
    });
    proxySocket.on('close', () => {
      if (!tunnelEstablished) rejectConnect(clientSocket, 502, 'upstream proxy closed\n');
    });
    // The upstream CONNECT response can arrive split across TCP chunks.
    // Accumulate until the header terminator so a partial first chunk is not
    // misread as a refusal and header bytes are never leaked into the tunnel.
    let handshakeBuffer = Buffer.alloc(0);
    let handshakeDone = false;
    proxySocket.on('data', (chunk) => {
      if (handshakeDone) return;
      handshakeBuffer = Buffer.concat([handshakeBuffer, chunk]);
      if (handshakeBuffer.length > DEFAULT_LEASE_HANDSHAKE_MAX_BYTES) {
        proxySocket.destroy();
        if (!tunnelEstablished) rejectConnect(clientSocket, 502, 'upstream proxy handshake too large\n');
        return;
      }
      const headerEnd = handshakeBuffer.indexOf('\r\n\r\n');
      if (headerEnd < 0) return;
      const headerText = handshakeBuffer.slice(0, headerEnd).toString('latin1');
      if (!/^HTTP\/1\.[01] 200/i.test(headerText)) {
        rejectConnect(clientSocket, 502, 'upstream proxy refused\n');
        proxySocket.destroy();
        return;
      }
      handshakeDone = true;
      const remainder = handshakeBuffer.slice(headerEnd + 4);
      tunnelEstablished = true;
      lease.activeConnections += 1;
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head && head.length) proxySocket.write(head);
      if (remainder.length) clientSocket.write(remainder);
      pipeTunnel(clientSocket, proxySocket, lease, (updatedLease) => {
        completeLease(updatedLease, 'session_end');
      });
    });
  });

  function listen() {
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => {
        server.removeListener('error', reject);
        const boundPort = server.address()?.port || port;
        safeEvent(onEvent, { event: 'lease_proxy_listening', port: boundPort, host });
        resolve(boundPort);
      });
    });
  }

  function close() {
    return new Promise((resolve) => server.close(resolve));
  }

  return { listen, close, server };
}
