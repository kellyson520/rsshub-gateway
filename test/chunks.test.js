import test from 'node:test';
import assert from 'node:assert/strict';
import { adaptiveChunkSize, chunkSizeFor } from '../src/media/chunks.js';

test('plans small files with seek-friendly single chunks', () => {
  const plan = chunkSizeFor(6_293_581, 1);
  assert.equal(plan.count, 1);
  assert.equal(plan.size, 6_293_581 > 0 ? Math.ceil(6_293_581 / 65536) * 65536 : 0);
  assert.equal(plan.count * plan.size >= 6_293_581, true);
});

test('splits parallel downloads across aligned chunks', () => {
  const plan = chunkSizeFor(6_293_581, 4);
  assert.equal(plan.count, 4);
  assert.equal(plan.size % (64 * 1024), 0);
  assert.equal(plan.count * plan.size >= 6_293_581, true);
});

test('covers large files completely even with a single requested chunk', () => {
  const plan = chunkSizeFor(1024 * 1024 * 1024, 1);
  assert.ok(plan.count >= 64, `expected >=64 chunks, got ${plan.count}`);
  assert.equal(plan.size, 16 * 1024 * 1024);
  assert.equal(plan.count * plan.size >= 1024 * 1024 * 1024, true);
});

test('caps chunk count at 256', () => {
  const plan = chunkSizeFor(1024 * 1024 * 1024, 512);
  assert.ok(plan.count <= 256);
  assert.equal(plan.count * plan.size >= 1024 * 1024 * 1024, true);
});

test('respects bandwidth estimates for streaming chunks', () => {
  const plan = chunkSizeFor(512 * 1024 * 1024, 0, { bytesPerSecond: 512 * 1024, targetSeconds: 8 });
  assert.equal(plan.size, 4 * 1024 * 1024);
  assert.ok(plan.count >= 128);
  assert.equal(plan.count * plan.size >= 512 * 1024 * 1024, true);
});

test('adaptive size stays within bounds', () => {
  assert.equal(adaptiveChunkSize(10 * 1024 * 1024), 1024 * 1024);
  assert.equal(adaptiveChunkSize(300 * 1024 * 1024), 4 * 1024 * 1024);
  assert.equal(adaptiveChunkSize(10 * 1024 ** 3), 16 * 1024 * 1024);
  assert.equal(adaptiveChunkSize(0), 256 * 1024);
});
