import test from 'node:test';
import assert from 'node:assert/strict';
import { createLogger, redactFields, redactValue } from '../src/infrastructure/logger.js';

test('redactValue: redacts sensitive keys and patterns', () => {
  assert.equal(redactValue('token', 'secret-12345'), '[redacted]');
  assert.equal(redactValue('authorization', 'Bearer abc.def.ghi'), '[redacted]');
  assert.equal(redactValue('cookie', 'sessionid=xyz; id=1'), '[redacted]');
  assert.equal(redactValue('password', 'p@ssword'), '[redacted]');
  assert.equal(redactValue('apiKeySecret', 'supersecret'), '[redacted]');

  // Non-sensitive key
  assert.equal(redactValue('path', '/_gateway/media/123'), '/_gateway/media/123');
  assert.equal(redactValue('status', 200), 200);
});

test('createLogger: formats json payload with event, level and timestamp', () => {
  const lines = [];
  const fixedNow = 1700000000000;
  const logger = createLogger({
    level: 'info',
    sink: (line) => lines.push(JSON.parse(line)),
    now: () => fixedNow,
  });

  logger.info('request_started', { path: '/items', status: 200 });

  assert.equal(lines.length, 1);
  assert.equal(lines[0].event, 'request_started');
  assert.equal(lines[0].level, 'info');
  assert.equal(lines[0].ts, new Date(fixedNow).toISOString());
  assert.equal(lines[0].path, '/items');
  assert.equal(lines[0].status, 200);
});

test('createLogger: respects log levels threshold', () => {
  const lines = [];
  const logger = createLogger({
    level: 'warn',
    sink: (line) => lines.push(JSON.parse(line)),
  });

  logger.debug('debug_event', { foo: 'bar' });
  logger.info('info_event', { foo: 'bar' });
  logger.warn('warn_event', { foo: 'bar' });
  logger.error('error_event', { foo: 'bar' });

  assert.equal(lines.length, 2);
  assert.equal(lines[0].event, 'warn_event');
  assert.equal(lines[1].event, 'error_event');
});

test('createLogger: redacts sensitive fields in payload automatically', () => {
  const lines = [];
  const logger = createLogger({
    sink: (line) => lines.push(JSON.parse(line)),
  });

  logger.info('auth_attempt', {
    user: 'admin',
    password: 'plaintext_password',
    token: 'jwt.token.here',
    headers: { authorization: 'Bearer 123456' },
  });

  assert.equal(lines[0].password, '[redacted]');
  assert.equal(lines[0].token, '[redacted]');
});

test('createLogger: child logger inherits and merges context fields', () => {
  const lines = [];
  const logger = createLogger({
    sink: (line) => lines.push(JSON.parse(line)),
  });

  const child = logger.child({ requestId: 'req-001', component: 'media-streamer' });
  child.info('chunk_downloaded', { bytes: 65536 });

  assert.equal(lines.length, 1);
  assert.equal(lines[0].requestId, 'req-001');
  assert.equal(lines[0].component, 'media-streamer');
  assert.equal(lines[0].bytes, 65536);
});

test('createLogger: survives throwing sink without crashing caller', () => {
  const logger = createLogger({
    sink: () => {
      throw new Error('disk full or stdout broken pipe');
    },
  });

  assert.doesNotThrow(() => {
    logger.info('test_event', { key: 'val' });
    logger.error('failed_event', { err: 'oops' });
  });
});

test('createLogger: handles null or undefined fields without throwing', () => {
  const lines = [];
  const logger = createLogger({
    sink: (line) => lines.push(JSON.parse(line)),
  });

  logger.info('empty_fields', null);
  logger.info('undefined_fields', undefined);
  assert.equal(lines.length, 2);
  assert.equal(lines[0].event, 'empty_fields');
  assert.equal(lines[1].event, 'undefined_fields');
});

test('createNoopLogger: returns a silent noop logger instance', async () => {
  const { createNoopLogger, LOG_LEVELS, DEFAULT_LOG_LEVEL } = await import('../src/infrastructure/logger.js');
  assert.equal(DEFAULT_LOG_LEVEL, 'info');
  assert.deepEqual(LOG_LEVELS, { debug: 10, info: 20, warn: 30, error: 40 });
  const noop = createNoopLogger();
  assert.doesNotThrow(() => {
    noop.debug('test');
    noop.info('test');
    noop.warn('test');
    noop.error('test');
    const child = noop.child({ req: 1 });
    child.info('child_test');
  });
  assert.equal(noop.threshold, 100);
});
