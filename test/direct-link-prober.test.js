import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createDirectLinkProber,
  DEFAULT_DIRECT_PROBE_TARGETS,
} from '../src/direct-link-prober.js';

test('direct-link prober exports default targets', () => {
  assert.ok(Array.isArray(DEFAULT_DIRECT_PROBE_TARGETS));
  assert.ok(DEFAULT_DIRECT_PROBE_TARGETS.length >= 2);
});

test('prober detects direct-link capability when probe targets succeed', async () => {
  const fetchMock = async (url) => {
    return {
      ok: true,
      status: 200,
      text: async () => 'visit_scheme=https',
    };
  };

  const prober = createDirectLinkProber({
    fetchImpl: fetchMock,
    targets: ['https://cloudflare.com/cdn-cgi/trace', 'https://api.github.com/zen'],
    timeoutMs: 2000,
  });

  const result = await prober.probe();
  assert.equal(result.canDirectLink, true);
  assert.equal(result.successCount, 2);
  assert.equal(result.failCount, 0);
  assert.equal(prober.canDirectLink(), true);
});

test('prober detects non-direct environment when targets fail or timeout', async () => {
  const fetchMock = async () => {
    const err = new Error('fetch failed / network unreachable');
    err.code = 'ETIMEDOUT';
    throw err;
  };

  const prober = createDirectLinkProber({
    fetchImpl: fetchMock,
    targets: ['https://cloudflare.com/cdn-cgi/trace', 'https://api.github.com/zen'],
    timeoutMs: 1000,
  });

  const result = await prober.probe();
  assert.equal(result.canDirectLink, false);
  assert.equal(result.successCount, 0);
  assert.equal(result.failCount, 2);
  assert.equal(prober.canDirectLink(), false);
});

test('prober supports partial success according to threshold', async () => {
  let count = 0;
  const fetchMock = async () => {
    count++;
    if (count === 1) return { ok: true, status: 200 };
    throw new Error('connection reset');
  };

  const prober = createDirectLinkProber({
    fetchImpl: fetchMock,
    targets: ['https://target1.test', 'https://target2.test'],
    threshold: 0.5,
  });

  const result = await prober.probe();
  assert.equal(result.canDirectLink, true);
  assert.equal(result.successCount, 1);
  assert.equal(result.failCount, 1);
});

test('prober caches status until next refresh interval', async () => {
  let callCount = 0;
  const fetchMock = async () => {
    callCount++;
    return { ok: true, status: 200 };
  };

  const prober = createDirectLinkProber({
    fetchImpl: fetchMock,
    targets: ['https://target1.test'],
    cacheMs: 60_000,
  });

  await prober.probe();
  await prober.probe();
  assert.equal(callCount, 1);
});
