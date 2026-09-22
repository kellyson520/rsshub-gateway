import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createDynamicRouteRegistry,
} from '../src/dynamic-registry.js';

test('dynamic route registry registers new paths on access', () => {
  const registry = createDynamicRouteRegistry();
  const res1 = registry.recordAccess('/linuxdo/latest');
  assert.equal(res1.isNew, true);
  assert.equal(res1.path, '/linuxdo/latest');

  const res2 = registry.recordAccess('/linuxdo/latest');
  assert.equal(res2.isNew, false);
  assert.equal(res2.hitCount, 2);

  const paths = registry.getWarmupPaths();
  assert.ok(paths.includes('/linuxdo/latest'));
});

test('registry normalizes paths and ignores non-feed paths', () => {
  const registry = createDynamicRouteRegistry();
  assert.equal(registry.recordAccess('/favicon.ico'), null);
  assert.equal(registry.recordAccess('/_gateway/status'), null);
  assert.equal(registry.recordAccess('/healthz'), null);

  const res = registry.recordAccess('/javbus/home?sort=date#top');
  assert.equal(res.path, '/javbus/home');
});

test('registry sorts warmup paths by popularity / hit count', () => {
  const registry = createDynamicRouteRegistry({ maxWarmupPaths: 2 });
  registry.recordAccess('/route1');
  registry.recordAccess('/route2');
  registry.recordAccess('/route2');
  registry.recordAccess('/route3');
  registry.recordAccess('/route3');
  registry.recordAccess('/route3');

  const warmup = registry.getWarmupPaths();
  assert.equal(warmup.length, 2);
  assert.equal(warmup[0], '/route3');
  assert.equal(warmup[1], '/route2');
});

test('registry seeds initial routes if provided', () => {
  const registry = createDynamicRouteRegistry({
    seedPaths: ['/javbus/home', '/airav/home'],
  });
  const warmup = registry.getWarmupPaths();
  assert.ok(warmup.includes('/javbus/home'));
  assert.ok(warmup.includes('/airav/home'));
});

test('registry prunes stale inactive routes when limit is exceeded', () => {
  let currentTime = 1000;
  const registry = createDynamicRouteRegistry({
    maxRoutes: 2,
    now: () => currentTime,
  });

  registry.recordAccess('/p1'); // t=1000
  currentTime = 2000;
  registry.recordAccess('/p2'); // t=2000
  currentTime = 3000;
  registry.recordAccess('/p3'); // t=3000, should evict p1

  const all = registry.getAllRoutes();
  assert.equal(all.length, 2);
  assert.ok(!all.some((r) => r.path === '/p1'));
  assert.ok(all.some((r) => r.path === '/p2'));
  assert.ok(all.some((r) => r.path === '/p3'));
});
