import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { createDownloadSessionStore } from '../src/download-session.js';

const chunks = (count, chunkSize) => Array.from({ length: count }, (_, index) => ({
  index,
  start: index * chunkSize,
  end: index * chunkSize + chunkSize - 1,
  size: chunkSize,
  url: `http://gateway.invalid/chunk-${index}`,
}));

test('creates sessions with pending chunks and tracks completion', async () => {
  const store = createDownloadSessionStore({ now: () => 1000 });
  const session = await store.create({
    id: 'session-1',
    target: 'https://example.com/v.mp4',
    size: 1000,
    chunkSize: 500,
    chunks: chunks(2, 500),
  });
  assert.equal(session.id, 'session-1');
  assert.equal(session.doneBytes, 0);
  assert.deepEqual(session.chunks.map((chunk) => chunk.status), ['pending', 'pending']);

  assert.equal(await store.markChunkDone('session-1', 0), true);
  assert.equal(await store.markChunkDone('session-1', 0), false);
  assert.equal(await store.markChunkDone('missing', 0), false);
  assert.equal((await store.get('session-1')).doneBytes, 500);
  assert.equal((await store.get('session-1')).chunks[0].status, 'done');
  assert.equal((await store.get('session-1')).chunks[1].status, 'pending');
});

test('expires sessions after ttl and evicts beyond the session limit', async () => {
  let clock = 0;
  const store = createDownloadSessionStore({ now: () => clock, ttlMs: 100, maxSessions: 2 });
  await store.create({ id: 'a', target: 'https://example.com/a', size: 10, chunkSize: 10, chunks: chunks(1, 10) });
  await store.create({ id: 'b', target: 'https://example.com/b', size: 10, chunkSize: 10, chunks: chunks(1, 10) });
  clock += 101;
  await store.create({ id: 'c', target: 'https://example.com/c', size: 10, chunkSize: 10, chunks: chunks(1, 10) });
  assert.equal(await store.get('a'), undefined);
  assert.equal(await store.get('b'), undefined);
  assert.equal((await store.get('c')).id, 'c');
  assert.equal((await store.stats()).sessions, 1);

  await store.create({ id: 'd', target: 'https://example.com/d', size: 10, chunkSize: 10, chunks: chunks(1, 10) });
  await store.create({ id: 'e', target: 'https://example.com/e', size: 10, chunkSize: 10, chunks: chunks(1, 10) });
  assert.equal((await store.stats()).sessions, 2);
});

test('reports aggregate stats across sessions', async () => {
  const store = createDownloadSessionStore();
  await store.create({ id: 's1', target: 'https://example.com/a', size: 1000, chunkSize: 500, chunks: chunks(2, 500) });
  await store.create({ id: 's2', target: 'https://example.com/b', size: 1000, chunkSize: 500, chunks: chunks(2, 500) });
  await store.markChunkDone('s1', 0);
  await store.markChunkDone('s1', 1);
  const stats = await store.stats();
  assert.equal(stats.sessions, 2);
  assert.equal(stats.totalBytes, 2000);
  assert.equal(stats.doneBytes, 1000);
});

test('persists sessions and restores progress in a new store', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rsshub-gateway-dlsessions-'));
  try {
    const file = path.join(root, 'download-sessions.json');
    const store = createDownloadSessionStore({ file });
    await store.create({
      id: 'persisted-1',
      target: 'https://example.com/v.mp4',
      size: 1000,
      chunkSize: 500,
      chunks: chunks(2, 500),
    });
    await store.markChunkDone('persisted-1', 0);

    const restored = createDownloadSessionStore({ file });
    const session = await restored.get('persisted-1');
    assert.equal(session.id, 'persisted-1');
    assert.equal(session.doneBytes, 500);
    assert.equal(session.chunks[0].status, 'done');
    assert.equal(session.chunks[1].status, 'pending');

    const expired = createDownloadSessionStore({ file, now: () => Date.now() + 25 * 60 * 60 * 1000 });
    assert.equal(await expired.get('persisted-1'), undefined);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('handles invalid json or corrupted file during load gracefully', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rsshub-gateway-dlsessions-corrupt-'));
  try {
    const file = path.join(root, 'corrupted-sessions.json');
    const { writeFile } = await import('node:fs/promises');
    await writeFile(file, 'not-valid-json-content', 'utf8');

    const store = createDownloadSessionStore({ file });
    const stats = await store.stats();
    assert.equal(stats.sessions, 0);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('markChunkDone handles invalid or non-existent chunkIndex gracefully', async () => {
  const store = createDownloadSessionStore();
  await store.create({
    id: 's1',
    target: 'https://example.com/v.mp4',
    size: 1000,
    chunkSize: 500,
    chunks: chunks(2, 500),
  });

  assert.equal(await store.markChunkDone('s1', 99), false);
  assert.equal(await store.markChunkDone('s1', -1), false);
  assert.equal(await store.markChunkDone('s1', 'abc'), false);
  assert.equal(await store.markChunkDone('s1', null), false);
});
