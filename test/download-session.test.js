import test from 'node:test';
import assert from 'node:assert/strict';
import { createDownloadSessionStore } from '../src/download-session.js';

const chunks = (count, chunkSize) => Array.from({ length: count }, (_, index) => ({
  index,
  start: index * chunkSize,
  end: index * chunkSize + chunkSize - 1,
  size: chunkSize,
  url: `http://gateway.invalid/chunk-${index}`,
}));

test('creates sessions with pending chunks and tracks completion', () => {
  const store = createDownloadSessionStore({ now: () => 1000 });
  const session = store.create({
    id: 'session-1',
    target: 'https://example.com/v.mp4',
    size: 1000,
    chunkSize: 500,
    chunks: chunks(2, 500),
  });
  assert.equal(session.id, 'session-1');
  assert.equal(session.doneBytes, 0);
  assert.deepEqual(session.chunks.map((chunk) => chunk.status), ['pending', 'pending']);

  assert.equal(store.markChunkDone('session-1', 0), true);
  assert.equal(store.markChunkDone('session-1', 0), false);
  assert.equal(store.markChunkDone('missing', 0), false);
  assert.equal(store.get('session-1').doneBytes, 500);
  assert.equal(store.get('session-1').chunks[0].status, 'done');
  assert.equal(store.get('session-1').chunks[1].status, 'pending');
});

test('expires sessions after ttl and evicts beyond the session limit', () => {
  let clock = 0;
  const store = createDownloadSessionStore({ now: () => clock, ttlMs: 100, maxSessions: 2 });
  store.create({ id: 'a', target: 'https://example.com/a', size: 10, chunkSize: 10, chunks: chunks(1, 10) });
  store.create({ id: 'b', target: 'https://example.com/b', size: 10, chunkSize: 10, chunks: chunks(1, 10) });
  clock += 101;
  store.create({ id: 'c', target: 'https://example.com/c', size: 10, chunkSize: 10, chunks: chunks(1, 10) });
  assert.equal(store.get('a'), undefined);
  assert.equal(store.get('b'), undefined);
  assert.equal(store.get('c').id, 'c');
  assert.equal(store.stats().sessions, 1);

  store.create({ id: 'd', target: 'https://example.com/d', size: 10, chunkSize: 10, chunks: chunks(1, 10) });
  store.create({ id: 'e', target: 'https://example.com/e', size: 10, chunkSize: 10, chunks: chunks(1, 10) });
  assert.equal(store.stats().sessions, 2);
});

test('reports aggregate stats across sessions', () => {
  const store = createDownloadSessionStore();
  store.create({ id: 's1', target: 'https://example.com/a', size: 1000, chunkSize: 500, chunks: chunks(2, 500) });
  store.create({ id: 's2', target: 'https://example.com/b', size: 1000, chunkSize: 500, chunks: chunks(2, 500) });
  store.markChunkDone('s1', 0);
  store.markChunkDone('s1', 1);
  const stats = store.stats();
  assert.equal(stats.sessions, 2);
  assert.equal(stats.totalBytes, 2000);
  assert.equal(stats.doneBytes, 1000);
});
