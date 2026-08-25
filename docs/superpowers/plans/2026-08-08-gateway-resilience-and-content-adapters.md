# RSSHub Gateway Resilience and Content Adapters Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add bounded upstream retries, circuit breaking, explicit gateway error semantics, readiness diagnostics, and source-specific reader policies for Telegram, X, Instagram, and Iwara.

**Architecture:** Keep `src/upstream.js` as the single outbound request policy and add a small circuit-breaker module that can be injected in tests. Move source-specific reader URLs and fallback messages into adapters; keep sanitization and signed-link rewriting in `src/reader.js`. Keep runtime Mihomo subscriptions outside Git and deploy the Node gateway as the only rebuilt image.

**Tech Stack:** Node.js 24, native `node:test`, Undici `ProxyAgent`, Cheerio, sanitize-html, Docker Compose, Mihomo, OpenResty.

---

## File Map

- Create: `src/circuit-breaker.js` — process-local closed/open/half-open state machine.
- Create: `src/upstream-errors.js` — typed transport, timeout, circuit, and final-response errors.
- Modify: `src/upstream.js` — bounded retry policy for RSSHub and external sources, safe source classification, and breaker integration.
- Modify: `src/server.js` — adapter-driven reader targets, error/status mapping, response diagnostics, structured logs, and `/readyz`.
- Modify: `src/reader.js` — safe unavailable-source page rendering.
- Create: `src/adapters/telegram.js` — Telegram public-post reader target policy.
- Modify: `src/adapters/index.js` — adapter registry and default adapter contract.
- Modify: `src/adapters/iwara.js` — reader target and fallback message.
- Modify: `src/adapters/x.js` — reader target and fallback message.
- Modify: `src/adapters/instagram.js` — reader target and fallback message.
- Create: `test/circuit-breaker.test.js` — deterministic breaker state tests.
- Create: `test/upstream.test.js` — retry, timeout, redirect, status, and circuit tests.
- Modify: `test/server.test.js` — readiness, error mapping, and diagnostic headers.
- Modify: `test/adapters.test.js` — adapter contracts and Telegram URL behavior.
- Create: `test/reader.test.js` — sanitized unavailable pages.
- Modify: `README.md` — runtime endpoints, error semantics, and rollout checks.

## Task 1: Add the deterministic circuit breaker

**Files:**

- Create: `src/circuit-breaker.js`
- Test: `test/circuit-breaker.test.js`

- [x] **Step 1: Write the failing tests**

Create a `CircuitBreaker` with injected clock and the following public methods:

```js
const breaker = new CircuitBreaker({ failureThreshold: 3, cooldownMs: 30_000, now: () => clock });
breaker.canRequest('t.me');
breaker.recordFailure('t.me');
breaker.recordSuccess('t.me');
breaker.state('t.me');
```

Cover these exact behaviors:

```js
test('opens after three failures and rejects requests during cooldown', () => {
  const breaker = new CircuitBreaker({ failureThreshold: 3, cooldownMs: 30_000, now: () => now });
  assert.equal(breaker.canRequest('t.me'), true);
  breaker.recordFailure('t.me');
  breaker.recordFailure('t.me');
  breaker.recordFailure('t.me');
  assert.equal(breaker.state('t.me'), 'open');
  assert.equal(breaker.canRequest('t.me'), false);
});

test('permits one half-open probe and closes on success', () => {
  const breaker = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 30_000, now: () => now });
  breaker.recordFailure('x.com');
  now += 30_000;
  assert.equal(breaker.canRequest('x.com'), true);
  assert.equal(breaker.canRequest('x.com'), false);
  breaker.recordSuccess('x.com');
  assert.equal(breaker.state('x.com'), 'closed');
  assert.equal(breaker.canRequest('x.com'), true);
});

test('success clears consecutive failures without affecting another source', () => {
  const breaker = new CircuitBreaker({ failureThreshold: 2, now: () => now });
  breaker.recordFailure('t.me');
  breaker.recordSuccess('t.me');
  breaker.recordFailure('t.me');
  assert.equal(breaker.state('t.me'), 'closed');
  breaker.recordFailure('x.com');
  breaker.recordFailure('x.com');
  assert.equal(breaker.state('x.com'), 'open');
});
```

- [x] **Step 2: Run the focused test and verify the expected failure**

Run:

```sh
npm test -- test/circuit-breaker.test.js
```

Expected: the test file fails because `src/circuit-breaker.js` does not exist yet.

- [x] **Step 3: Implement the minimal breaker**

Implement `CircuitBreaker` with a `Map` keyed by source name. Store `{ state, failures, openedAt, probeInFlight }`. `canRequest` returns false for an open circuit before cooldown, changes an eligible open circuit to half-open, and allows only one half-open probe. `recordFailure` opens at the threshold and releases a half-open probe back to open. `recordSuccess` deletes the entry. Do not add persistence, timers, or background work.

- [x] **Step 4: Run the focused test and the existing suite**

Run:

```sh
npm test -- test/circuit-breaker.test.js
npm test
```

Expected: the new breaker tests and all pre-existing tests pass.

- [x] **Step 5: Commit the isolated component**

```sh
git add src/circuit-breaker.js test/circuit-breaker.test.js
git commit -m "feat: add source circuit breaker"
```

## Task 2: Introduce typed upstream retry policy

**Files:**

- Create: `src/upstream-errors.js`
- Modify: `src/upstream.js`
- Test: `test/upstream.test.js`

- [x] **Step 1: Write failure-classification and retry tests**

Inject `fetchImpl`, `sleep`, and `now` into `createUpstreamClient`. Use `Response` objects and counters rather than real network calls. Cover:

```js
test('retries a transport error and returns the next successful response', async () => {
  let attempts = 0;
  const client = createUpstreamClient({
    fetchImpl: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('connection reset');
      return new Response('ok', { status: 200 });
    },
    sleep: async () => {},
  });
  const response = await client.fetchExternal('https://t.me/s/baipiaotg');
  assert.equal(response.status, 200);
  assert.equal(attempts, 2);
});

test('does not retry a source authorization failure', async () => {
  let attempts = 0;
  const client = createUpstreamClient({
    fetchImpl: async () => {
      attempts += 1;
      return new Response('forbidden', { status: 403 });
    },
    sleep: async () => {},
  });
  const response = await client.fetchExternal('https://x.com/example/status/1');
  assert.equal(response.status, 403);
  assert.equal(attempts, 1);
});

test('retries a 503 and throws a typed error after the attempt limit', async () => {
  const client = createUpstreamClient({
    fetchImpl: async () => new Response('unavailable', { status: 503 }),
    sleep: async () => {},
  });
  await assert.rejects(
    client.fetchExternal('https://t.me/s/baipiaotg'),
    (error) => error.code === 'UPSTREAM_RETRY_EXHAUSTED' && error.status === 502,
  );
});

test('validates every manual redirect target', async () => {
  const client = createUpstreamClient({
    fetchImpl: async () => new Response('', { status: 302, headers: { location: 'https://example.com/private' } }),
    sleep: async () => {},
  });
  await assert.rejects(client.fetchExternal('https://t.me/s/baipiaotg'), /disallowed|allowlist/i);
});
```

Add a timeout test using an injected `AbortSignal` observer and a `timeoutMs` option, asserting the final error has code `UPSTREAM_TIMEOUT` and status `504`.

- [x] **Step 2: Run the focused tests to verify they fail for the missing policy**

Run:

```sh
npm test -- test/upstream.test.js
```

Expected: the new file fails because the typed errors, retry injection, and retry behavior are not present.

- [x] **Step 3: Add typed errors and status classifiers**

In `src/upstream-errors.js`, define `GatewayUpstreamError` with `{ code, source, status, attempts, retryAfter }`, plus constructors or subclasses for `UPSTREAM_TIMEOUT`, `UPSTREAM_RETRY_EXHAUSTED`, and `UPSTREAM_CIRCUIT_OPEN`. Export `isRetryableStatus(status)` for `408`, `425`, `429`, and `500` through `599`.

- [x] **Step 4: Implement bounded retries in `upstream.js`**

Extend `createUpstreamClient` options with:

```js
{
  maxAttempts: 3,
  totalTimeoutMs: 30_000,
  sleep: defaultSleep,
  breaker: new CircuitBreaker()
}
```

Use the source hostname for external requests and the literal key `rsshub` for local RSSHub requests. Check `breaker.canRequest` before the first attempt. For each attempt, derive the remaining deadline, create an `AbortController`, preserve existing source headers and range headers, and call the injected fetch implementation. Cancel response bodies before retrying a retryable HTTP response. Follow manual redirects within the same attempt and re-run the allowlist check for every location. Record success for 2xx/3xx/allowed final source responses and record failure only after the retry loop is exhausted.

Implement `fetchRssHub` with the same retry policy but without the external-target allowlist, because its fixed target is the local `RSSHUB_URL`. Keep its existing request headers and manual redirect behavior.

- [x] **Step 5: Run upstream tests and the full suite**

Run:

```sh
npm test -- test/upstream.test.js
npm test
```

Expected: retry counts, typed errors, redirect rejection, and all existing tests pass.

- [x] **Step 6: Commit the request policy**

```sh
git add src/upstream.js src/upstream-errors.js test/upstream.test.js
git commit -m "feat: add resilient upstream requests"
```

## Task 3: Map errors and add readiness diagnostics

**Files:**

- Modify: `src/server.js`
- Modify: `test/server.test.js`

- [x] **Step 1: Write failing server tests**

Add tests that inject `fetchRssHub` and `fetchExternal` errors and assert:

```js
test('returns readiness JSON without changing liveness behavior', async () => {
  const server = createGatewayServer({
    secret: 'secret',
    fetchRssHub: async (path) => new Response(path === '/healthz' ? 'ok' : '', { status: 200 }),
  });
  const { response, body } = await request(server, '/readyz');
  assert.equal(response.status, 200);
  assert.deepEqual(JSON.parse(body), { ready: true, rsshub: 'ok', openCircuits: [] });
});

test('maps an exhausted upstream retry to 502 with safe diagnostics', async () => {
  const server = createGatewayServer({
    secret: 'secret',
    fetchExternal: async () => { throw new GatewayUpstreamError('network failed', { code: 'UPSTREAM_RETRY_EXHAUSTED', source: 't.me', status: 502, attempts: 3 }); },
  });
  const token = createSignedTarget('https://t.me/baipiaotg/67336', 'secret');
  const { response, body } = await request(server, `/_gateway/item/${token}`);
  assert.equal(response.status, 502);
  assert.equal(response.headers.get('x-gateway-source'), 't.me');
  assert.equal(response.headers.get('x-gateway-attempts'), '3');
  assert.equal(body, 'upstream unavailable\n');
  assert.doesNotMatch(body, /67336|secret|eyJ/);
});

test('maps an open circuit to 503 with bounded Retry-After', async () => {
  const server = createGatewayServer({
    secret: 'secret',
    fetchExternal: async () => { throw new GatewayUpstreamError('circuit open', { code: 'UPSTREAM_CIRCUIT_OPEN', source: 't.me', status: 503, attempts: 0, retryAfter: 30 }); },
  });
  const token = createSignedTarget('https://t.me/baipiaotg/67336', 'secret');
  const { response } = await request(server, `/_gateway/item/${token}`);
  assert.equal(response.status, 503);
  assert.equal(response.headers.get('retry-after'), '30');
});
```

- [x] **Step 2: Run the focused tests and confirm the expected failures**

Run:

```sh
npm test -- test/server.test.js
```

Expected: readiness and typed-error assertions fail because `/readyz` and error response mapping do not exist.

- [x] **Step 3: Implement readiness and response mapping**

Add a JSON writer and a `writeGatewayError` helper. Keep malformed/expired token failures at `403`. For typed upstream errors, use the error status, `Retry-After` when present, `X-Gateway-Source`, and `X-Gateway-Attempts`. Log one JSON object per failed request with source, code, status, attempts, and duration; never log the target URL or request headers. Add `/readyz` before gateway-token routing and return the exact JSON shape in the test.

Use the source adapter for `readerTarget` before `fetchExternal`, while retaining the original verified URL for the “原始来源” link and fallback title.

- [x] **Step 4: Run the server tests and full suite**

```sh
npm test -- test/server.test.js
npm test
```

Expected: all server and existing tests pass with correct statuses and no sensitive values in response bodies.

- [x] **Step 5: Commit the server boundary changes**

```sh
git add src/server.js test/server.test.js
git commit -m "feat: expose gateway readiness and upstream errors"
```

## Task 4: Move source-specific reader policies into adapters

**Files:**

- Create: `src/adapters/telegram.js`
- Modify: `src/adapters/index.js`
- Modify: `src/adapters/iwara.js`
- Modify: `src/adapters/x.js`
- Modify: `src/adapters/instagram.js`
- Modify: `src/reader.js`
- Modify: `test/adapters.test.js`
- Create: `test/reader.test.js`
- Modify: `test/server.test.js`

- [x] **Step 1: Write failing adapter and reader tests**

Add a Telegram adapter test:

```js
test('uses the Telegram embed endpoint for public post details', () => {
  const adapter = adapterForUrl('https://t.me/baipiaotg/67336');
  assert.equal(adapter.readerTarget('https://t.me/baipiaotg/67336'), 'https://t.me/baipiaotg/67336?embed=1');
  assert.equal(adapter.readerTarget('https://t.me/s/baipiaotg'), 'https://t.me/s/baipiaotg');
});
```

Add a reader test that passes a source-specific unavailable message containing a source title and original URL, then asserts that scripts, iframes, and event-handler attributes are absent while the message and HTTPS link remain.

- [x] **Step 2: Run the focused tests and verify failure**

```sh
npm test -- test/adapters.test.js test/reader.test.js
```

Expected: the new adapter methods and unavailable renderer are missing.

- [x] **Step 3: Implement the adapter contract**

Create a default adapter with identity `readerTarget`, source-neutral headers, and a generic unavailable message. Add Telegram matching for `t.me` and `readerTarget` logic that only changes `/channel/message-id` paths with a numeric message ID. Preserve existing optional cookies and X token headers. Add `unavailableMessage` to Iwara, X, and Instagram without printing credentials.

Update `adapterForUrl` to include Telegram and return the default adapter for allowlisted hosts with no specialized policy. Remove the Telegram URL helper from `server.js`; the server asks the adapter for the target.

- [x] **Step 4: Implement safe unavailable-page rendering**

Add `renderUnavailablePage({ url, title, message, baseUrl, secret })` to `reader.js`. Reuse the existing page shell and `escapeHtml`, render only a paragraph, the source-specific message, and the signed/localized original link. Do not pass source HTML through the renderer for this path.

- [x] **Step 5: Connect adapter fallbacks in the server**

When a source response is a final non-success HTML response, use the adapter fallback renderer while preserving the upstream status. When the response is successful, keep the existing sanitizer and media/link rewriting. Ensure the original verified URL, not the adapter’s `?embed=1` URL, is displayed as the source link.

- [x] **Step 6: Run focused and full tests**

```sh
npm test -- test/adapters.test.js test/reader.test.js test/server.test.js
npm test
```

Expected: Telegram detail tests still render actual post text, source credentials remain header-only, and all tests pass.

- [x] **Step 7: Commit the adapter work**

```sh
git add src/adapters src/reader.js src/server.js test/adapters.test.js test/reader.test.js test/server.test.js
git commit -m "feat: add source reader adapters"
```

## Task 5: Document runtime checks and perform production rollout

**Files:**

- Modify: `README.md`
- No source change: `/opt/1panel/apps/rsshub-gateway/config/mihomo/config.yaml` remains runtime-only.

- [x] **Step 1: Update the runtime documentation**

Document the following commands in `README.md`:

```sh
npm test
sudo docker exec rsshub-gateway mihomo -t -d /root/.config/mihomo
curl -fsS http://127.0.0.1:1300/healthz
curl -fsS http://127.0.0.1:1300/readyz
sudo docker compose -f /opt/1panel/apps/rsshub-gateway/docker-compose.yml up -d --build
```

State that `healthz` is liveness-only, `readyz` depends on RSSHub, and the Mihomo health target is `https://t.me`. Keep provider URLs, cookies, and gateway secrets out of the repository.

- [x] **Step 2: Run local verification before deployment**

```sh
git diff --check
npm test
```

Expected: clean diff check and zero failed tests.

- [x] **Step 3: Validate and deploy the runtime configuration**

Run the configuration test, rebuild the gateway, and wait for the health endpoint:

```sh
sudo docker exec rsshub-gateway mihomo -t -d /root/.config/mihomo
sudo docker compose -f /opt/1panel/apps/rsshub-gateway/docker-compose.yml up -d --build
curl -fsS http://127.0.0.1:1300/healthz
curl -fsS http://127.0.0.1:1300/readyz
```

Expected: Mihomo syntax is successful, the container is running, and both probes report ready.

- [x] **Step 4: Perform production acceptance checks**

Use the public Telegram channel URL and verify the transformed feed is XML, the first three item links return HTML containing real body text, and a media URL accepts a one-byte range request with `206`. Also request one X, Instagram, and Iwara feed route already configured in RSSHub and record the returned status and content type.

- [x] **Step 5: Commit the documentation and verify repository state**

```sh
git add README.md
git commit -m "docs: document gateway rollout checks"
git status --short
```

Expected: the working tree is clean; runtime-only configuration remains untracked/ignored.

## Completion Checklist

- [x] Circuit breaker tests pass with deterministic time.
- [x] Retry policy tests prove both retry and no-retry classes.
- [x] Error responses distinguish invalid tokens, unavailable sources, and timeouts.
- [x] `/healthz` and `/readyz` have independent tests.
- [x] Telegram behavior is adapter-owned and no longer hard-coded in `server.js`.
- [x] X, Instagram, and Iwara retain credential safety and readable fallback pages.
- [x] Existing feed XML, signed target, media range, and cache behavior remain green.
- [x] Production deployment and three consecutive Telegram detail checks pass.
- [x] No secrets or provider subscription URLs enter Git.
