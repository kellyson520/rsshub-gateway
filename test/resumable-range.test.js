import test from 'node:test';
import assert from 'node:assert/strict';
import { pumpResumableRange } from '../src/media/resumable-range.js';

function webStreamFromBuffer(buffer, { failAfter, failDelayMs = 5 } = {}) {
  return new ReadableStream({
    start(controller) {
      if (failAfter === undefined) {
        controller.enqueue(buffer);
        controller.close();
        return;
      }
      controller.enqueue(buffer.subarray(0, failAfter));
      setTimeout(() => controller.error(new Error('simulated upstream drop')), failDelayMs);
    },
  });
}

function streamResponse(buffer, options) {
  return { ok: true, body: webStreamFromBuffer(buffer, options) };
}

function createFakeRes() {
  const listeners = new Map();
  const res = {
    destroyed: false,
    writableEnded: false,
    bytes: [],
    write(chunk, callback) {
      if (this.destroyed) {
        callback(new Error('response destroyed'));
        return false;
      }
      this.bytes.push(Buffer.from(chunk));
      queueMicrotask(() => callback());
      return this.bytes.length % 3 === 0 ? false : true;
    },
    on(event, fn) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(fn);
      return this;
    },
    off(event, fn) {
      const fns = listeners.get(event) || [];
      const index = fns.indexOf(fn);
      if (index >= 0) fns.splice(index, 1);
      return this;
    },
    emit(event) {
      for (const fn of [...(listeners.get(event) || [])]) fn();
    },
    destroy() {
      this.destroyed = true;
    },
  };
  return res;
}

const totalBytes = () => {
  const res = createFakeRes();
  return { res, read: () => Buffer.concat(res.bytes).length };
};

test('pumps a single stream fully without resuming', async () => {
  const { res, read } = totalBytes();
  const body = Buffer.alloc(1000, 1);
  const result = await pumpResumableRange({
    response: streamResponse(body),
    fetchRange: async () => { throw new Error('unexpected refetch'); },
    res,
    start: 0,
    end: 999,
  });
  assert.equal(result.written, 1000);
  assert.equal(result.resumed, 0);
  assert.equal(read(), 1000);
  assert.equal(res.destroyed, false);
});

test('resumes from the flushed offset after a mid-stream error', async () => {
  const { res, read } = totalBytes();
  const body = Buffer.alloc(1000, 2);
  const requested = [];
  const result = await pumpResumableRange({
    response: streamResponse(body, { failAfter: 100 }),
    fetchRange: async (range) => {
      requested.push(range);
      return streamResponse(body.subarray(100), {});
    },
    res,
    start: 0,
    end: 999,
  });
  assert.deepEqual(requested, ['bytes=100-999']);
  assert.equal(result.written, 1000);
  assert.equal(result.resumed, 1);
  assert.equal(read(), 1000);
  assert.equal(res.destroyed, false);
});

test('destroy res when retries are exhausted before the range completes', async () => {
  const { res, read } = totalBytes();
  const body = Buffer.alloc(1000, 3);
  const requested = [];
  const result = await pumpResumableRange({
    response: streamResponse(body, { failAfter: 100 }),
    fetchRange: async (range) => {
      requested.push(range);
      return streamResponse(body.subarray(Number(range.match(/^bytes=(\d+)-/)[1])), { failAfter: 50 });
    },
    res,
    start: 0,
    end: 999,
    maxAttempts: 3,
    backoffMs: 1,
  });
  assert.equal(requested.length, 2);
  assert.equal(result.resumed, 2);
  assert.ok(result.written < 1000, `written=${result.written}`);
  assert.equal(res.destroyed, true);
  assert.equal(read(), result.written);
});

test('skips unavailable continuation fetches and keeps retrying', async () => {
  const { res, read } = totalBytes();
  const body = Buffer.alloc(500, 4);
  let calls = 0;
  const result = await pumpResumableRange({
    response: streamResponse(body, { failAfter: 100 }),
    fetchRange: async () => {
      calls += 1;
      return calls === 1 ? { unavailable: true } : streamResponse(body.subarray(100));
    },
    res,
    start: 0,
    end: 499,
    backoffMs: 1,
  });
  assert.equal(calls, 2);
  assert.equal(result.written, 500);
  assert.equal(result.resumed, 1);
  assert.equal(read(), 500);
  assert.equal(res.destroyed, false);
});

test('reports progress through onBytes and onResume', async () => {
  const { res } = totalBytes();
  const body = Buffer.alloc(600, 5);
  const progress = [];
  const resumes = [];
  const result = await pumpResumableRange({
    response: streamResponse(body, { failAfter: 200 }),
    fetchRange: async () => streamResponse(body.subarray(200)),
    res,
    start: 0,
    end: 599,
    backoffMs: 1,
    onBytes: (flushed) => progress.push(flushed),
    onResume: (flushed, attempt) => resumes.push([flushed, attempt]),
  });
  assert.equal(result.written, 600);
  assert.equal(progress.at(-1), 600);
  assert.deepEqual(resumes, [[200, 1]]);
});

test('handles immediate client disconnect when res is destroyed before pump', async () => {
  const { res } = totalBytes();
  res.destroyed = true;

  const result = await pumpResumableRange({
    response: streamResponse(Buffer.from('hello-world')),
    fetchRange: async () => streamResponse(Buffer.from('hello-world')),
    res,
    start: 0,
    end: 10,
  });

  assert.equal(result.written, 0);
  assert.equal(result.resumed, 0);
});

test('calls onComplete when range is fully transferred', async () => {
  const { res } = totalBytes();
  const body = Buffer.alloc(100, 9);
  let completedInfo = null;

  const result = await pumpResumableRange({
    response: streamResponse(body),
    fetchRange: async () => streamResponse(body),
    res,
    start: 0,
    end: 99,
    onComplete: (info) => {
      completedInfo = info;
    },
  });

  assert.equal(result.written, 100);
  assert.deepEqual(completedInfo, { written: 100, resumed: 0 });
});

test('pumpResumableRange returns zero written when start exceeds end', async () => {
  const { res } = totalBytes();
  const result = await pumpResumableRange({
    response: streamResponse(Buffer.from('test')),
    fetchRange: async () => streamResponse(Buffer.from('test')),
    res,
    start: 10,
    end: 5,
  });
  assert.equal(result.written, 0);
  assert.equal(result.resumed, 0);
});

test('pumpResumableRange handles null or invalid response gracefully', async () => {
  const { res } = totalBytes();
  let truncatedCalls = 0;
  const result = await pumpResumableRange({
    response: null,
    fetchRange: async () => null,
    res,
    start: 0,
    end: 100,
    onTruncated: () => { truncatedCalls += 1; },
  });
  assert.equal(result.written, 0);
  assert.equal(truncatedCalls, 1);
});

test('isResumableStatus identifies 200 and 206 HTTP status codes correctly', async () => {
  const { isResumableStatus } = await import('../src/media/resumable-range.js');
  assert.equal(isResumableStatus(200), true);
  assert.equal(isResumableStatus(206), true);
  assert.equal(isResumableStatus(404), false);
  assert.equal(isResumableStatus(500), false);
  assert.equal(isResumableStatus(null), false);
  assert.equal(isResumableStatus(undefined), false);
  assert.equal(isResumableStatus('200'), false);
});

test('exports sleep helper function and default resumable constants', async () => {
  const {
    sleep,
    DEFAULT_RESUMABLE_MAX_ATTEMPTS,
    DEFAULT_RESUMABLE_BACKOFF_MS,
  } = await import('../src/media/resumable-range.js');

  assert.equal(DEFAULT_RESUMABLE_MAX_ATTEMPTS, 3);
  assert.equal(DEFAULT_RESUMABLE_BACKOFF_MS, 100);

  const start = Date.now();
  await sleep(10);
  assert.ok(Date.now() - start >= 8);
});
