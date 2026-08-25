import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createLeaseStore,
  createSignedChunk,
  verifySignedChunk,
} from '../src/download-lease.js';

test('lease store creates, verifies, revokes and expires leases', () => {
  let now = 1_000_000;
  const store = createLeaseStore({ now: () => now });
  const lease = store.createLease({
    targetUrl: 'https://acheron.iwara.tv/video/abc.mp4',
    resolvedUrl: 'https://acheron.iwara.tv/v/abc.mp4?token=x',
    allowHosts: ['acheron.iwara.tv'],
    ttlMs: 60_000,
    maxBytes: 1024,
    maxConcurrency: 4,
  });
  assert.ok(lease.username.length >= 16);
  assert.ok(lease.password.length >= 16);
  assert.equal(store.verify(lease.username, lease.password), lease);
  assert.equal(store.verify(lease.username, 'wrong'), null);
  assert.equal(store.verify('nobody', 'nothing'), null);
  now += 61_000;
  assert.equal(store.verify(lease.username, lease.password), null);
  now -= 61_000;
  const lease2 = store.createLease({ targetUrl: 'https://x.example/a', allowHosts: ['x.example'], ttlMs: 60_000 });
  store.revoke(lease2.username);
  assert.equal(store.verify(lease2.username, lease2.password), null);
  assert.equal(store.stats().leases >= 1, true);
  store.revokeExpired();
});

test('lease public view includes proxy url and one-time semantics', () => {
  const store = createLeaseStore();
  const lease = store.createLease({
    targetUrl: 'https://filesq.iwara.tv/f.mp4',
    allowHosts: ['filesq.iwara.tv'],
    metadata: { source: 'iwara' },
  });
  const view = store.publicView(lease, { proxyHost: 'gateway.example', proxyPort: 1301 });
  assert.equal(view.once, true);
  assert.ok(view.proxyUrl.startsWith(`http://${lease.username}:${lease.password}@gateway.example:1301`));
  const publicView = store.publicView(lease, { proxyUrl: 'https://gateway.example:81' });
  assert.ok(publicView.proxyUrl.startsWith(`https://${lease.username}:${lease.password}@gateway.example:81`));
  assert.equal(publicView.proxyUrl.endsWith('/'), false);
  assert.equal(view.url, 'https://filesq.iwara.tv/f.mp4');
  assert.deepEqual(view.allowHosts, ['filesq.iwara.tv']);
  assert.equal(view.maxConcurrency >= 1, true);
  assert.equal(view.ttlMs > 0, true);
});

test('signed chunks verify and reject tampering', () => {
  const secret = 'test-secret';
  const token = createSignedChunk({
    url: 'https://acheron.iwara.tv/video/abc.mp4',
    start: 0,
    end: 1_048_575,
    secret,
    metadata: { egressScope: 'public', source: 'iwara' },
  });
  const data = verifySignedChunk(token, secret);
  assert.equal(data.start, 0);
  assert.equal(data.end, 1_048_575);
  assert.equal(data.egressScope, 'public');
  assert.equal(data.source, 'iwara');
  assert.throws(() => verifySignedChunk(token, 'other-secret'));
  assert.throws(() => verifySignedChunk('not-a-token', secret));
  const [payload, signature] = token.split('.');
  const tampered = `${payload}.${signature.slice(0, 10)}${signature[10] === 'x' ? 'y' : 'x'}${signature.slice(11)}`;
  assert.throws(() => verifySignedChunk(tampered, secret));
});

test('verifySignedChunk rejects non-allowlisted target URLs', () => {
  const secret = 'test-secret';
  const token = createSignedChunk({
    url: 'http://127.0.0.1:8080/private',
    start: 0,
    end: 100,
    secret,
  });
  assert.throws(
    () => verifySignedChunk(token, secret),
    /chunk target is not allowed/,
  );
});

test('revokeExpired cleans up revoked and expired leases accurately', () => {
  let time = 1000;
  const store = createLeaseStore({ now: () => time });
  const l1 = store.createLease({ targetUrl: 'https://filesq.iwara.tv/1.mp4', ttlMs: 100 });
  const l2 = store.createLease({ targetUrl: 'https://filesq.iwara.tv/2.mp4', ttlMs: 1000 });
  const l3 = store.createLease({ targetUrl: 'https://filesq.iwara.tv/3.mp4', ttlMs: 1000 });

  store.revoke(l2.username);
  time += 200; // l1 expired, l2 revoked, l3 still valid

  const expiredUsernames = store.revokeExpired();
  assert.equal(expiredUsernames.includes(l1.username), true);
  assert.equal(expiredUsernames.includes(l2.username), true);
  assert.equal(expiredUsernames.includes(l3.username), false);
  assert.equal(store.stats().leases, 1);
});
