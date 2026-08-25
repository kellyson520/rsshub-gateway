import test from 'node:test';
import assert from 'node:assert/strict';
import { GatewayUpstreamError, isRetryableStatus } from '../src/upstream-errors.js';

test('GatewayUpstreamError: sets default and custom properties', () => {
  const errDefault = new GatewayUpstreamError('Upstream failure');
  assert.equal(errDefault.name, 'GatewayUpstreamError');
  assert.equal(errDefault.message, 'Upstream failure');
  assert.equal(errDefault.source, 'unknown');
  assert.equal(errDefault.status, 502);
  assert.equal(errDefault.attempts, 0);
  assert.equal(errDefault.retryAfter, undefined);

  const errCustom = new GatewayUpstreamError('Rate limited', {
    code: 'RATE_LIMIT',
    source: 'iwara',
    status: 429,
    attempts: 3,
    retryAfter: 60,
  });
  assert.equal(errCustom.code, 'RATE_LIMIT');
  assert.equal(errCustom.source, 'iwara');
  assert.equal(errCustom.status, 429);
  assert.equal(errCustom.attempts, 3);
  assert.equal(errCustom.retryAfter, 60);
});

test('isRetryableStatus: correctly identifies retryable and non-retryable HTTP statuses', () => {
  // Retryable statuses
  assert.equal(isRetryableStatus(408), true);
  assert.equal(isRetryableStatus(425), true);
  assert.equal(isRetryableStatus(429), true);
  assert.equal(isRetryableStatus(500), true);
  assert.equal(isRetryableStatus(502), true);
  assert.equal(isRetryableStatus(503), true);
  assert.equal(isRetryableStatus(504), true);
  assert.equal(isRetryableStatus(599), true);

  // Non-retryable statuses
  assert.equal(isRetryableStatus(200), false);
  assert.equal(isRetryableStatus(301), false);
  assert.equal(isRetryableStatus(400), false);
  assert.equal(isRetryableStatus(401), false);
  assert.equal(isRetryableStatus(403), false);
  assert.equal(isRetryableStatus(404), false);
  assert.equal(isRetryableStatus(null), false);
  assert.equal(isRetryableStatus(undefined), false);
  assert.equal(isRetryableStatus('500'), false);
});
