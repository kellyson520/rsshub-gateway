import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSessionAffinity } from '../src/session-affinity.js';

async function withRegistry(options, callback) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rsshub-session-affinity-'));
  try {
    return await callback({
      root,
      file: path.join(root, 'session-affinity.json'),
      registry: createSessionAffinity({
        root,
        secret: 'test-session-affinity-secret',
        laneIds: ['session-01', 'session-02', 'session-03'],
        now: () => 1_000,
        ...options,
      }),
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('keeps one credential on a stable persisted lane without storing its plaintext', async () => {
  await withRegistry({}, async ({ root, file, registry }) => {
    const first = await registry.resolve('x', { ct0: 'csrf-a', authToken: 'token-a' });
    const second = await registry.resolve('x', { authToken: 'token-a', ct0: 'csrf-a' });

    assert.equal(first.laneId, second.laneId);
    assert.notEqual(first.fingerprint, 'token-a');
    assert.notEqual(first.fingerprint, '');
    await registry.flush();

    const saved = await readFile(file, 'utf8');
    assert.doesNotMatch(saved, /token-a|csrf-a/);
    assert.equal((await stat(file)).mode & 0o077, 0);

    const reloaded = createSessionAffinity({
      root,
      secret: 'test-session-affinity-secret',
      laneIds: ['session-01', 'session-02', 'session-03'],
      now: () => 2_000,
    });
    const restored = await reloaded.resolve('x', { authToken: 'token-a', ct0: 'csrf-a' });
    assert.equal(restored.laneId, first.laneId);
    assert.equal(restored.fingerprint, first.fingerprint);
  });
});

test('migrates only sessions assigned to an unhealthy lane', async () => {
  await withRegistry({}, async ({ registry }) => {
    const affected = await registry.resolve('x', { authToken: 'token-a' });
    let unaffected;
    let unaffectedCredential;
    for (let index = 0; index < 32; index += 1) {
      const credential = `token-${index}`;
      const candidate = await registry.resolve('x', { authToken: credential });
      if (candidate.laneId !== affected.laneId) {
        unaffected = candidate;
        unaffectedCredential = credential;
        break;
      }
    }
    assert.ok(unaffected, 'test inputs should select at least two lanes');

    const migrated = await registry.markLaneUnhealthy(affected.laneId);
    const replacement = await registry.resolve('x', { authToken: 'token-a' });
    const stillHealthy = await registry.resolve('x', { authToken: unaffectedCredential });

    assert.equal(migrated, 1);
    assert.notEqual(replacement.laneId, affected.laneId);
    assert.equal(stillHealthy.laneId, unaffected.laneId);
  });
});

test('starts empty when the affinity file is malformed or stale', async () => {
  await withRegistry({ now: () => 10_000, maxAgeMs: 100 }, async ({ file, registry }) => {
    await writeFile(file, '{invalid', 'utf8');
    const malformed = await registry.resolve('x', { authToken: 'token-a' });
    assert.match(malformed.fingerprint, /^[a-f0-9]{64}$/);
    await registry.flush();

    await writeFile(file, JSON.stringify({
      version: 1,
      records: [{
        fingerprint: malformed.fingerprint,
        source: 'x',
        laneId: malformed.laneId,
        createdAt: 0,
        updatedAt: 0,
      }],
    }), 'utf8');
    const staleRegistry = createSessionAffinity({
      root: path.dirname(file),
      secret: 'test-session-affinity-secret',
      laneIds: ['session-01', 'session-02', 'session-03'],
      now: () => 10_000,
      maxAgeMs: 100,
    });
    const refreshed = await staleRegistry.resolve('x', { authToken: 'token-a' });
    assert.equal(refreshed.createdAt, 10_000);
  });
});

test('session-affinity throws typed SESSION_LANE_UNAVAILABLE when all lanes are unhealthy', async () => {
  await withRegistry({ laneIds: ['session-01'] }, async ({ registry }) => {
    await registry.resolve('x', { authToken: 'user-token' });
    await registry.markLaneUnhealthy('session-01');
    await assert.rejects(
      () => registry.resolve('x', { authToken: 'user-token' }),
      (err) => err.code === 'SESSION_LANE_UNAVAILABLE',
    );
  });
});
