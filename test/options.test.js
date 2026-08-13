import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveGatewayOptions } from '../src/options.js';

const ENV = {};

test('resolveGatewayOptions applies defaults when nothing is provided', () => {
  const options = resolveGatewayOptions({ secret: 'secret' }, ENV);
  assert.equal(options.egressLaneCount, 12);
  assert.equal(options.egressSessionLaneCount, 12);
  assert.equal(options.egressMinConcurrencyPerLane, 3);
  assert.equal(options.egressMaxConcurrencyPerLane, 6);
  assert.equal(options.egressMaxTotalConcurrency, 48);
  assert.equal(options.egressRefreshIntervalMs, 60_000);
  assert.equal(options.mediaCacheMaxFileBytes, 32 * 1024 ** 2);
  assert.equal(options.videoCacheMaxFileBytes, 256 * 1024 ** 2);
  assert.equal(options.mediaBrowserCacheSeconds, 300);
  assert.equal(options.leaseTtlMs, 30 * 60_000);
  assert.equal(options.leaseMaxBytes, 2 * 1024 ** 3);
  assert.equal(options.leaseMaxConcurrency, 8);
  assert.equal(options.leaseBackfillEnabled, true);
  assert.equal(options.ehColdStartEnabled, true);
  assert.deepEqual([...options.egressBlockedStatuses], [401, 403, 407, 429]);
  assert.ok(options.egressProbeTargets.public.length > 0);
});

test('resolveGatewayOptions prefers options over env over defaults', () => {
  const env = { EGRESS_LANE_COUNT: '4', GATEWAY_LEASE_BACKFILL: 'false', EH_COLD_START_ENABLED: 'false' };
  const fromEnv = resolveGatewayOptions({ secret: 'secret' }, env);
  assert.equal(fromEnv.egressLaneCount, 4);
  assert.equal(fromEnv.leaseBackfillEnabled, false);
  assert.equal(fromEnv.ehColdStartEnabled, false);

  const fromOptions = resolveGatewayOptions({
    secret: 'secret',
    egressLaneCount: 6,
    leaseBackfillEnabled: true,
    ehColdStartEnabled: true,
  }, env);
  assert.equal(fromOptions.egressLaneCount, 6);
  assert.equal(fromOptions.leaseBackfillEnabled, true);
  assert.equal(fromOptions.ehColdStartEnabled, true);
});

test('resolveGatewayOptions clamps values to bounds', () => {
  const options = resolveGatewayOptions({
    secret: 'secret',
    egressSessionLaneCount: 100,
    ehMaxPrefetchPages: 999_999,
    egressMinConcurrencyPerLane: 0,
    leaseMaxConcurrency: 999,
  }, ENV);
  assert.equal(options.egressSessionLaneCount, 12);
  assert.equal(options.ehMaxPrefetchPages, 300);
  assert.equal(options.egressMinConcurrencyPerLane, 3);
  assert.equal(options.leaseMaxConcurrency, 32);
});

test('resolveGatewayOptions resolves the slow source threshold', () => {
  assert.equal(resolveGatewayOptions({ secret: 'secret' }, ENV).slowSourceThresholdMs, 5000);
  assert.equal(resolveGatewayOptions({ secret: 'secret' }, { GATEWAY_SLOW_SOURCE_MS: '3000' }).slowSourceThresholdMs, 3000);
  assert.equal(resolveGatewayOptions({ secret: 'secret', slowSourceThresholdMs: 0 }, ENV).slowSourceThresholdMs, 0);
  assert.equal(resolveGatewayOptions({ secret: 'secret', slowSourceThresholdMs: 'abc' }, ENV).slowSourceThresholdMs, 5000);
});

test('resolveGatewayOptions parses blocked statuses from arrays and strings', () => {
  const fromArray = resolveGatewayOptions({ secret: 'secret', egressBlockedStatuses: [403, 429] }, ENV);
  assert.deepEqual([...fromArray.egressBlockedStatuses], [403, 429]);

  const fromString = resolveGatewayOptions({ secret: 'secret', egressBlockedStatuses: '401, 403' }, ENV);
  assert.deepEqual([...fromString.egressBlockedStatuses], [401, 403]);
});
