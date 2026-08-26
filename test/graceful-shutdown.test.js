import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { installGracefulShutdown } from '../src/graceful-shutdown.js';

function fakeServer({ listening = true, closeEmit = true, idleCalls = [] } = {}) {
  const emitter = new EventEmitter();
  const server = {
    listening,
    closeIdleConnections: () => idleCalls.push(true),
    close: () => {
      if (!closeEmit || !listening) return;
      queueMicrotask(() => emitter.emit('close'));
    },
    once: (name, fn) => emitter.once(name, fn),
  };
  return server;
}

test('drains active servers then exits with code 0', async () => {
  const exits = [];
  const idleCalls = [];
  const server = fakeServer({ idleCalls });
  const shutdown = installGracefulShutdown({
    servers: [server],
    timeoutMs: 500,
    exitImpl: (code) => exits.push(code),
    logger: null,
  });
  assert.equal(shutdown.isDraining(), false);
  assert.equal(shutdown.shutdown('SIGTERM'), true);
  assert.equal(shutdown.isDraining(), true);
  assert.equal(idleCalls.length, 1);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(exits, [0]);
  shutdown.dispose();
});

test('force-exits with code 1 when servers never drain', async () => {
  const exits = [];
  const shutdown = installGracefulShutdown({
    servers: [fakeServer({ closeEmit: false })],
    timeoutMs: 30,
    exitImpl: (code) => exits.push(code),
    logger: null,
  });
  shutdown.shutdown();
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.deepEqual(exits, [1]);
  shutdown.dispose();
});

test('resolves immediately when a server is not listening', async () => {
  const exits = [];
  const shutdown = installGracefulShutdown({
    servers: [fakeServer({ listening: false })],
    timeoutMs: 200,
    exitImpl: (code) => exits.push(code),
    logger: null,
  });
  shutdown.shutdown();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(exits, [0]);
  shutdown.dispose();
});

test('ignores a second shutdown request while draining', async () => {
  const exits = [];
  const shutdown = installGracefulShutdown({
    servers: [fakeServer()],
    timeoutMs: 200,
    exitImpl: (code) => exits.push(code),
    logger: null,
  });
  assert.equal(shutdown.shutdown(), true);
  assert.equal(shutdown.shutdown('SIGINT'), false);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(exits, [0]);
  shutdown.dispose();
});

test('dispose removes signal handlers', () => {
  const shutdown = installGracefulShutdown({
    servers: [fakeServer()],
    exitImpl: () => {},
    logger: null,
  });
  shutdown.dispose();
  const listeners = process.listeners('SIGTERM');
  assert.equal(listeners.some((listener) => listener.toString().includes('shutdown')), false);
});

test('handles server.close throwing an error gracefully during shutdown', async () => {
  const exits = [];
  const brokenServer = {
    listening: true,
    close: () => {
      throw new Error('Already closed or socket error');
    },
    closeIdleConnections: () => {},
    once: (name, fn) => {
      // simulate immediate close event
      queueMicrotask(fn);
    },
  };

  const shutdown = installGracefulShutdown({
    servers: [brokenServer],
    timeoutMs: 200,
    exitImpl: (code) => exits.push(code),
    logger: null,
  });

  assert.equal(shutdown.shutdown('SIGTERM'), true);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(exits, [0]);
  shutdown.dispose();
});

test('handles null or undefined elements in servers array without throwing', async () => {
  const exits = [];
  const shutdown = installGracefulShutdown({
    servers: [null, undefined, fakeServer()],
    timeoutMs: 200,
    exitImpl: (code) => exits.push(code),
    logger: null,
  });

  assert.equal(shutdown.shutdown('SIGTERM'), true);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(exits, [0]);
  shutdown.dispose();
});

test('serverCount reports number of valid active servers registered', () => {
  const shutdown = installGracefulShutdown({
    servers: [fakeServer(), null, fakeServer()],
    exitImpl: () => {},
    logger: null,
  });
  assert.equal(shutdown.serverCount(), 2);
  shutdown.dispose();
});
