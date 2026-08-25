import assert from 'node:assert/strict';
import net from 'node:net';
import { test } from 'node:test';
import { createLeaseStore } from '../src/download-lease.js';
import { createLeaseProxy } from '../src/lease-proxy.js';

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function fakeMihomoProxy() {
  const server = net.createServer((socket) => {
    let buffer = '';
    let tunneled = false;
    socket.on('data', (chunk) => {
      if (!tunneled) {
        buffer += chunk.toString('latin1');
        const headerEnd = buffer.indexOf('\r\n\r\n');
        if (headerEnd >= 0) {
          const head = buffer.slice(0, headerEnd);
          buffer = '';
          if (/^CONNECT [^ ]+ HTTP\/1\.1/i.test(head)) {
            tunneled = true;
            socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
          } else {
            socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
            socket.destroy();
          }
        }
        return;
      }
      socket.write(chunk); // echo back
    });
    socket.on('error', () => {});
  });
  return { server };
}

function connectProxy(port, hostname, { auth }) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => {
      socket.write(`CONNECT ${hostname}:443 HTTP/1.1\r\nHost: ${hostname}:443\r\nProxy-Authorization: Basic ${Buffer.from(auth).toString('base64')}\r\n\r\n`);
    });
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString('latin1');
      const headerEnd = buffer.indexOf('\r\n\r\n');
      if (headerEnd >= 0) {
        socket.removeAllListeners('data');
        const head = buffer.slice(0, headerEnd);
        const remainder = buffer.slice(headerEnd + 4);
        if (/^HTTP\/1\.[01] 2\d\d/.test(head)) {
          resolve({ socket, head, remainder });
        } else {
          socket.destroy();
          reject(new Error(`proxy responded ${head.split('\r\n')[0]}`));
        }
      }
    });
    socket.on('error', (error) => reject(error));
    socket.on('close', () => reject(new Error('closed before headers')));
  });
}

function waitFor(predicate, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (predicate()) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        reject(new Error('waitFor timed out'));
      }
    }, 10);
  });
}

test('lease proxy tunnels CONNECT with valid lease credentials', async () => {
  const upstream = fakeMihomoProxy();
  const upstreamPort = await listen(upstream.server);
  const store = createLeaseStore();
  const events = [];
  const proxy = createLeaseProxy({
    leaseStore: store,
    upstreamProxyHost: '127.0.0.1',
    upstreamProxyPort: upstreamPort,
    port: 0,
    host: '127.0.0.1',
    onEvent: (event) => events.push(event),
  });
  const proxyPort = await proxy.listen();
  const lease = store.createLease({
    targetUrl: 'https://filesq.iwara.tv/v.mp4',
    allowHosts: ['filesq.iwara.tv'],
    maxBytes: 1024 * 1024,
    maxConcurrency: 4,
  });
  const { socket, head } = await connectProxy(proxyPort, 'filesq.iwara.tv', { auth: `${lease.username}:${lease.password}` });
  assert.match(head, /^HTTP\/1\.1 200/);
  const echoed = new Promise((resolve) => {
    socket.on('data', (chunk) => resolve(chunk.toString()));
  });
  socket.write('hello-tunnel');
  assert.equal(await echoed, 'hello-tunnel');
  assert.equal(lease.activeConnections, 1);
  socket.destroy();
  await waitFor(() => store.verify(lease.username, lease.password) === null);
  assert.equal(lease.usedBytes > 0, true);
  assert.equal(events.some((e) => e.event === 'lease_completed'), true);
  proxy.close();
  upstream.server.close();
});

test('lease proxy rejects bad credentials, denied hosts and revoked leases', async () => {
  const upstream = fakeMihomoProxy();
  const upstreamPort = await listen(upstream.server);
  const store = createLeaseStore();
  const proxy = createLeaseProxy({
    leaseStore: store,
    upstreamProxyHost: '127.0.0.1',
    upstreamProxyPort: upstreamPort,
    port: 0,
    host: '127.0.0.1',
  });
  const proxyPort = await proxy.listen();
  const lease = store.createLease({
    targetUrl: 'https://filesq.iwara.tv/v.mp4',
    allowHosts: ['filesq.iwara.tv'],
  });
  await assert.rejects(() => connectProxy(proxyPort, 'filesq.iwara.tv', { auth: 'wrong:wrong' }), /proxy responded/);
  await assert.rejects(() => connectProxy(proxyPort, 'evil.example', { auth: `${lease.username}:${lease.password}` }), /proxy responded/);
  store.revoke(lease.username);
  await assert.rejects(() => connectProxy(proxyPort, 'filesq.iwara.tv', { auth: `${lease.username}:${lease.password}` }), /proxy responded/);
  proxy.close();
  upstream.server.close();
});

test('lease proxy enforces the concurrency cap', async () => {
  const upstream = fakeMihomoProxy();
  const upstreamPort = await listen(upstream.server);
  const store = createLeaseStore();
  const proxy = createLeaseProxy({
    leaseStore: store,
    upstreamProxyHost: '127.0.0.1',
    upstreamProxyPort: upstreamPort,
    port: 0,
    host: '127.0.0.1',
  });
  const proxyPort = await proxy.listen();
  const lease = store.createLease({
    targetUrl: 'https://filesq.iwara.tv/v.mp4',
    allowHosts: ['filesq.iwara.tv'],
    maxConcurrency: 1,
  });
  const first = await connectProxy(proxyPort, 'filesq.iwara.tv', { auth: `${lease.username}:${lease.password}` });
  assert.match(first.head, /^HTTP\/1\.1 200/);
  await assert.rejects(() => connectProxy(proxyPort, 'filesq.iwara.tv', { auth: `${lease.username}:${lease.password}` }), /proxy responded/);
  first.socket.destroy();
  proxy.close();
  upstream.server.close();
});

test('lease proxy enforces the byte cap', async () => {
  const upstream = fakeMihomoProxy();
  const upstreamPort = await listen(upstream.server);
  const store = createLeaseStore();
  const events = [];
  const proxy = createLeaseProxy({
    leaseStore: store,
    upstreamProxyHost: '127.0.0.1',
    upstreamProxyPort: upstreamPort,
    port: 0,
    host: '127.0.0.1',
    onEvent: (event) => events.push(event),
  });
  const proxyPort = await proxy.listen();
  const lease = store.createLease({
    targetUrl: 'https://filesq.iwara.tv/v.mp4',
    allowHosts: ['filesq.iwara.tv'],
    maxBytes: 8,
  });
  const { socket } = await connectProxy(proxyPort, 'filesq.iwara.tv', { auth: `${lease.username}:${lease.password}` });
  await new Promise((resolve) => {
    socket.on('close', resolve);
    socket.write(Buffer.alloc(64, 1));
  });
  await waitFor(() => events.some((e) => e.event === 'lease_byte_cap'));
  assert.equal(store.verify(lease.username, lease.password), null);
  proxy.close();
  upstream.server.close();
});

test('lease proxy rejects non-CONNECT standard HTTP requests with 405', async () => {
  const store = createLeaseStore();
  const proxy = createLeaseProxy({
    leaseStore: store,
    port: 0,
    host: '127.0.0.1',
  });
  const proxyPort = await proxy.listen();

  const responseText = await new Promise((resolve) => {
    const req = net.connect(proxyPort, '127.0.0.1', () => {
      req.write('GET / HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n');
    });
    let data = '';
    req.on('data', (chunk) => {
      data += chunk.toString('utf8');
    });
    req.on('end', () => resolve(data));
  });

  assert.match(responseText, /^HTTP\/1\.1 405/);
  assert.match(responseText, /lease proxy supports CONNECT only/);
  proxy.close();
});
