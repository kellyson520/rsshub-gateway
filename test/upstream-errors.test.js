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

test('isClientAbortError: detects client disconnection, premature close, and stream aborts', async () => {
  const { isClientAbortError } = await import('../src/upstream-errors.js');
  assert.equal(isClientAbortError(new Error('client response closed')), true);
  assert.equal(isClientAbortError(new Error('stream aborted')), true);
  assert.equal(isClientAbortError({ code: 'ECONNRESET' }), true);
  assert.equal(isClientAbortError({ code: 'ERR_STREAM_PREMATURE_CLOSE' }), true);
  assert.equal(isClientAbortError({ code: 'ABORT_ERR' }), true);

  // Non-abort errors
  assert.equal(isClientAbortError(new Error('network timeout')), false);
  assert.equal(isClientAbortError(new Error('unauthorized')), false);
  assert.equal(isClientAbortError(null), false);
  assert.equal(isClientAbortError(undefined), false);
});

test('isSuccessfulStatus: identifies 2xx HTTP success statuses correctly', async () => {
  const { isSuccessfulStatus } = await import('../src/upstream-errors.js');
  assert.equal(isSuccessfulStatus(200), true);
  assert.equal(isSuccessfulStatus(204), true);
  assert.equal(isSuccessfulStatus(206), true);
  assert.equal(isSuccessfulStatus(299), true);
  assert.equal(isSuccessfulStatus(199), false);
  assert.equal(isSuccessfulStatus(300), false);
  assert.equal(isSuccessfulStatus(404), false);
  assert.equal(isSuccessfulStatus(500), false);
  assert.equal(isSuccessfulStatus('200'), false);
  assert.equal(isSuccessfulStatus(null), false);
});

test('exports default upstream error status, source, retryable and blocked status constants', async () => {
  const {
    DEFAULT_UPSTREAM_ERROR_STATUS,
    DEFAULT_UPSTREAM_SOURCE,
    RETRYABLE_STATUSES,
    DEFAULT_BLOCKED_STATUSES,
  } = await import('../src/upstream-errors.js');
  assert.equal(DEFAULT_UPSTREAM_ERROR_STATUS, 502);
  assert.equal(DEFAULT_UPSTREAM_SOURCE, 'unknown');

  assert.ok(RETRYABLE_STATUSES instanceof Set);
  assert.ok(RETRYABLE_STATUSES.has(408));
  assert.ok(RETRYABLE_STATUSES.has(425));
  assert.ok(RETRYABLE_STATUSES.has(429));

  assert.ok(DEFAULT_BLOCKED_STATUSES instanceof Set);
  assert.ok(DEFAULT_BLOCKED_STATUSES.has(401));
  assert.ok(DEFAULT_BLOCKED_STATUSES.has(403));
  assert.ok(DEFAULT_BLOCKED_STATUSES.has(407));
  assert.ok(DEFAULT_BLOCKED_STATUSES.has(429));
});
