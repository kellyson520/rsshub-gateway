# 响应驱动会话出口 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 Iwara、Telegram、X、Instagram 的公开请求使用共享多出口池，并在上游明确要求认证后把同一 Cookie/Token 固定到稳定 session lane。

**Architecture:** `egress-policy` 只判断公开能力和显式路由范围；`upstream` 负责匿名请求、认证挑战升级、Header 与租约；`session-affinity` 用网关密钥生成不可逆会话指纹并持久化 lane 绑定；`signed-target` 和缓存携带受保护的路由范围，保证详情与媒体请求不跨公开/会话边界。Mihomo 将公共 lane 与 session lane 分开，公共刷新不重绑正在使用的 session lane。

**Tech Stack:** Node.js 24、node:test、Undici `ProxyAgent`、Mihomo Meta Controller API、Docker Compose、HMAC-SHA256。

---

### Task 1: Request Scope and Source Capabilities

**Files:**
- Modify: `src/egress-policy.js`
- Modify: `src/adapters/index.js`
- Modify: `src/adapters/iwara.js`
- Modify: `src/adapters/telegram.js`
- Modify: `src/adapters/x.js`
- Modify: `src/adapters/instagram.js`
- Test: `test/egress-policy.test.js`
- Test: `test/adapters.test.js`

- [ ] **Step 1: Write failing scope tests**

Add `egressPolicyForRequest(url, { scope })` and assert these exact outcomes:

```js
assert.equal(egressPolicyForRequest('https://iwara.tv/video/1', { scope: 'public' }), EGRESS_POLICIES.PUBLIC);
assert.equal(egressPolicyForRequest('https://x.com/a/status/1', { scope: 'public' }), EGRESS_POLICIES.PUBLIC);
assert.equal(egressPolicyForRequest('https://instagram.com/p/1', { scope: 'public' }), EGRESS_POLICIES.PUBLIC);
assert.equal(egressPolicyForRequest('https://t.me/s/channel', { scope: 'public' }), EGRESS_POLICIES.PUBLIC);
assert.equal(egressPolicyForRequest('https://x.com/a/status/1', { scope: 'session' }), EGRESS_POLICIES.STICKY);
assert.equal(egressPolicyForRequest('https://exhentai.org/g/1/a/'), EGRESS_POLICIES.STICKY);
assert.equal(egressPolicyForRequest('https://example.com/page', { scope: 'public' }), EGRESS_POLICIES.STICKY);
```

Add adapter assertions that each module exports `publiclyReadable`, `headers(config, { includeCredentials })`, and `isAuthenticationChallenge({ status, headers, body })`; public headers must not contain `cookie` or `authorization`.

- [ ] **Step 2: Run the focused tests and verify the expected red failure**

Run: `node --test test/egress-policy.test.js test/adapters.test.js`

Expected: FAIL because `egressPolicyForRequest` and the new adapter capability contract do not exist.

- [ ] **Step 3: Implement the minimal capability contract**

Keep `egressPolicyForUrl` as the backward-compatible URL-only function. Add a public-host set for `iwara.tv`, `t.me`, `telesco.pe`, X/Twitter/Twimg, Instagram and its CDN domains. Implement:

```js
export function egressPolicyForRequest(value, { scope = 'auto' } = {}) {
  if (scope === 'session' || scope === 'sticky') return EGRESS_POLICIES.STICKY;
  if (scope === 'public' && isPublicEgressTarget(value)) return EGRESS_POLICIES.PUBLIC;
  return egressPolicyForUrl(value);
}
```

Give adapters anonymous headers by default. Keep credential headers behind `includeCredentials: true`. Add login-shell detection for Iwara using its login form/session markers; preserve the existing X and Instagram checks; Telegram always returns `false` because it has no configured session mode.

- [ ] **Step 4: Run the focused tests and verify green**

Run: `node --test test/egress-policy.test.js test/adapters.test.js`

Expected: all scope and adapter capability tests pass with no credential values printed.

- [ ] **Step 5: Commit the isolated task**

```bash
git add src/egress-policy.js src/adapters test/egress-policy.test.js test/adapters.test.js
git commit -m "feat: classify public and session egress scopes"
```

### Task 2: Persistent Session Affinity Registry

**Files:**
- Create: `src/session-affinity.js`
- Create: `test/session-affinity.test.js`

- [ ] **Step 1: Write failing persistence and stability tests**

Test the public API `createSessionAffinity({ root, secret, laneIds, now })` with these behaviors:

```js
const first = await registry.resolve('x', { authToken: 'token-a' });
const second = await registry.resolve('x', { authToken: 'token-a' });
assert.equal(first.laneId, second.laneId);
assert.notEqual(first.fingerprint, 'token-a');
assert.notEqual(first.fingerprint, '');
```

Persist the mapping, create a second registry with the same root and secret, and assert it resolves the same lane. Assert a different credential receives a deterministic lane from the configured lane list and does not reveal the credential in the JSON file. Assert `markLaneUnhealthy(laneId)` leaves healthy sessions unchanged and only a session using that lane receives a replacement lane.

- [ ] **Step 2: Run the new test and verify red**

Run: `node --test test/session-affinity.test.js`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `src/session-affinity.js`.

- [ ] **Step 3: Implement HMAC fingerprinting and atomic persistence**

Normalize credentials by sorting header names and trimming values, then compute:

```js
createHmac('sha256', secret)
  .update(`${source}\n${normalizedCredentials}`)
  .digest('hex');
```

Use rendezvous hashing over the healthy lane IDs so adding or removing a lane changes as few mappings as possible. Persist only fingerprint, source, lane ID, proxy identity hash, timestamps and schema version. Write a temporary JSON file and rename it atomically with mode `0600`; load malformed or stale records as empty state.

- [ ] **Step 4: Run the test and verify green**

Run: `node --test test/session-affinity.test.js`

Expected: all persistence, deterministic assignment, migration and redaction tests pass.

- [ ] **Step 5: Commit the isolated task**

```bash
git add src/session-affinity.js test/session-affinity.test.js
git commit -m "feat: persist credential session affinity"
```

### Task 3: Dedicated Mihomo Session Lanes

**Files:**
- Modify: `src/mihomo-egress.js`
- Modify: `test/mihomo-egress.test.js`
- Modify: `docker-compose.yml`
- Modify: `config/mihomo/config.example.yaml`
- Runtime-only modify: `/opt/1panel/apps/rsshub-gateway/config/mihomo/config.yaml`

- [ ] **Step 1: Write failing Controller binding tests**

Extend the fake Controller test to assert `refreshSessionLanes()` binds `SESSION_LANE_01..12` to listeners starting at `7921`, returns stable `{ id, proxyName, proxyUrl, dispatcher }` entries, and does not issue a second PUT for an already assigned session lane during a public refresh. Add a test that a failed session node is replaced only after `markSessionLaneUnhealthy`.

- [ ] **Step 2: Run the adapter tests and verify red**

Run: `node --test test/mihomo-egress.test.js`

Expected: FAIL because session lane groups and the session refresh API do not exist.

- [ ] **Step 3: Add separate session lane infrastructure**

Add adapter options `sessionLaneCount` and `sessionListenerBasePort`, and expose `refreshPublicLanes()`, `sessionLanes()`, `assignSessionLane(laneId, node)`, `releaseSessionLane(laneId)`, and `markSessionLaneUnhealthy(laneId)`. Keep public refresh limited to `EGRESS_LANE_*`; never overwrite `SESSION_LANE_*` during the 60-second public refresh. Use the same candidate filtering and E-Hentai probe logic, but retain the session node until an explicit health failure.

Add non-secret example entries documenting the separate group/listener names. The example must show `SESSION_LANE_01` mapped to `session-lane-01` and a local mixed listener at `127.0.0.1:7921`, with the remaining listeners following the same numbered pattern through `SESSION_LANE_12` and port `7932`. Update Compose with `EGRESS_SESSION_LANE_COUNT`, `EGRESS_SESSION_LISTENER_BASE_PORT`, and `SESSION_AFFINITY_FILE`; do not add provider URLs or credentials. Add the same groups and local listeners to the runtime Mihomo config under `/opt/1panel`, preserving the existing private provider file.

- [ ] **Step 4: Run tests and validate the runtime config**

Run: `node --test test/mihomo-egress.test.js` and `sudo -n docker run --rm --entrypoint mihomo -v /home/ubuntu/.config/rsshub-gateway/config/mihomo:/root/.config/mihomo:ro rsshub-gateway-gateway -t -d /root/.config/mihomo`

Expected: adapter tests pass and Mihomo prints `configuration file ... test is successful`.

- [ ] **Step 5: Commit source/config-example changes**

```bash
git add src/mihomo-egress.js test/mihomo-egress.test.js docker-compose.yml config/mihomo/config.example.yaml
git commit -m "feat: reserve stable Mihomo session lanes"
```

### Task 4: Scope-Aware Upstream Headers and Retry

**Files:**
- Modify: `src/upstream.js`
- Modify: `test/upstream.test.js`

- [ ] **Step 1: Write failing upstream tests**

Inject a public pool and a session dispatcher. Assert a public Iwara/X/Instagram/TG request acquires the public pool and its fetch headers contain no credential. Assert `{ egressScope: 'session', sessionLane }` uses only the session dispatcher and sends the adapter credential. Assert a `401` or authentication redirect can request exactly one session retry, while `429` and `503` remain public retries.

- [ ] **Step 2: Run the upstream tests and verify red**

Run: `node --test test/upstream.test.js`

Expected: the new scope, header and authentication-retry assertions fail because upstream currently derives policy only from the URL and always builds credential headers.

- [ ] **Step 3: Implement scope-aware transport**

Change `sourceHeaders(url, sources, { includeCredentials = false })` so credentials are included only for session scope. Extend `fetchExternal` options with `egressScope`, `sessionDispatcher`, `sessionCredentials`, `authChallenge`, and `allowSessionRetry`. Public requests use `egressPolicyForRequest`; session requests bypass the public pool and use the resolved session dispatcher. Release every public or session lease on body completion, cancellation, retry, redirect and error.

Treat only `401`, authentication redirects and an explicit `authChallenge` result as session escalation. Pass `429`, `5xx`, timeout and transport failures through the existing public retry/backoff path. Cap escalation at one retry per logical request to prevent public/session loops.

- [ ] **Step 4: Run the upstream tests and verify green**

Run: `node --test test/upstream.test.js`

Expected: all existing lease/retry tests and new public/session assertions pass.

- [ ] **Step 5: Commit the transport task**

```bash
git add src/upstream.js test/upstream.test.js
git commit -m "feat: route upstream requests by session scope"
```

### Task 5: Signed Route and Cache Scope Isolation

**Files:**
- Modify: `src/signed-target.js`
- Modify: `src/reader.js`
- Modify: `src/feed-transform.js`
- Modify: `src/cache.js`
- Modify: `test/signed-target.test.js`
- Modify: `test/cache.test.js`
- Modify: `test/reader.test.js`

- [ ] **Step 1: Write failing metadata and cache tests**

Add a signed-target test that `createSignedTarget(url, secret, ttl, now, { egressScope: 'session', source: 'x' })` verifies to the same metadata, rejects an unknown scope, and does not put a credential in the token. Add a cache test that the same upstream URL stored under `public` and `session:<fingerprint>` produces two independent entries and that a public read never returns the session body.

- [ ] **Step 2: Run the focused tests and verify red**

Run: `node --test test/signed-target.test.js test/cache.test.js test/reader.test.js`

Expected: metadata is discarded by the current signed target and the current URL-only cache key collides.

- [ ] **Step 3: Implement protected scope metadata and namespace keys**

Allow only `public`, `session` and `sticky` in signed payload metadata. Preserve existing call signatures and default old tokens to no explicit scope. Add a cache namespace argument to `getOrLoad`, `peek` and `keyFor`; use `public` for anonymous content and `session:<credentialFingerprint>` for session content. Ensure namespace is hashed into the filename and never exposed as a path or response header.

Pass the scope metadata through `localUrl`, `createMediaSignedTarget` and reader page objects so media URLs retain the session route without containing the token fingerprint.

- [ ] **Step 4: Run the focused tests and verify green**

Run: `node --test test/signed-target.test.js test/cache.test.js test/reader.test.js`

Expected: signed metadata, legacy token compatibility, media scope propagation and cache isolation all pass.

- [ ] **Step 5: Commit the route/cache task**

```bash
git add src/signed-target.js src/reader.js src/feed-transform.js src/cache.js test/signed-target.test.js test/cache.test.js test/reader.test.js
git commit -m "feat: isolate signed session routes and cache entries"
```

### Task 6: Response-Driven Server Integration

**Files:**
- Modify: `src/server.js`
- Modify: `src/adapters/index.js`
- Modify: `src/adapters/iwara.js`
- Modify: `src/adapters/x.js`
- Modify: `src/adapters/instagram.js`
- Modify: `src/adapters/telegram.js`
- Modify: `test/server.test.js`
- Modify: `test/adapters.test.js`

- [ ] **Step 1: Write failing end-to-end route tests**

Add server tests with an injected fake public pool and session affinity:

```js
// First anonymous response is an authentication shell.
// Second response is returned only through the stable session dispatcher.
assert.deepEqual(dispatchers, ['public-lane', 'session-lane-x']);
assert.match(body, /_gateway\/media/);
assert.doesNotMatch(body, /auth_token|sessionid|credentialFingerprint/);
```

Add cases where public HTML is readable and therefore never sends credentials, where no credentials exist and the gateway renders a safe fallback, and where a media request carrying `egressScope=session` uses the same session lane. Assert a `503` and a `429` do not cause a session retry.

- [ ] **Step 2: Run server tests and verify red**

Run: `node --test test/server.test.js test/adapters.test.js`

Expected: the server currently sends source credentials on the first request and cannot carry route scope from an authentication challenge into signed media URLs.

- [ ] **Step 3: Wire the response-driven flow**

Create one helper in `server.js` that fetches a document anonymously, reads only the bounded HTML needed for challenge detection, and, on an adapter-confirmed challenge with configured credentials, retries once with `egressScope: 'session'`. Pass the resulting scope and fingerprint namespace to the response cache and reader renderer. Make every generated detail/media token carry only `egressScope` and source name. Construct the session dispatcher from `SessionAffinityRegistry` and the Mihomo session lane snapshot.

The gateway route for an existing signed token must validate scope metadata before fetching. If a session token is presented while the source credential is unavailable, return the safe unavailable page rather than silently falling back to a public request. Public RSS transformation remains unchanged except that generated public media uses the shared pool.

- [ ] **Step 4: Run server tests and verify green**

Run: `node --test test/server.test.js test/adapters.test.js test/upstream.test.js test/signed-target.test.js test/cache.test.js`

Expected: public requests use multiple fake lanes, session requests reuse one fake lane, challenge escalation occurs once, and all existing reader/cache behavior remains green.

- [ ] **Step 5: Commit the integration task**

```bash
git add src/server.js src/adapters test/server.test.js test/adapters.test.js
git commit -m "feat: escalate authenticated sources to stable sessions"
```

### Task 7: Runtime Wiring and Documentation

**Files:**
- Modify: `docker-compose.yml`
- Modify: `README.md`
- Modify: `config/mihomo/config.example.yaml`
- Runtime-only modify: `/opt/1panel/apps/rsshub-gateway/config/mihomo/config.yaml`
- Runtime-only modify: `/opt/1panel/apps/rsshub-gateway/docker-compose.yml`

- [ ] **Step 1: Add explicit session runtime settings**

Set `EGRESS_SESSION_LANE_COUNT=12`, `EGRESS_SESSION_LISTENER_BASE_PORT=7921`, and `SESSION_AFFINITY_FILE=/var/cache/rsshub-gateway/session-affinity.json` in the public Compose example. Keep all provider URLs, tokens, cookies and actual source config in ignored runtime files only.

- [ ] **Step 2: Validate the private Mihomo configuration before restart**

Run: `sudo -n docker run --rm --entrypoint mihomo -v /home/ubuntu/.config/rsshub-gateway/config/mihomo:/root/.config/mihomo:ro rsshub-gateway-gateway -t -d /root/.config/mihomo`

Expected: `configuration file ... test is successful`.

- [ ] **Step 3: Document the routing contract**

Update README to state that anonymous public Iwara/Telegram/X/Instagram requests use the shared pool, authentication is triggered by the upstream response, session credentials are never sent to public lanes, and a credential fingerprint retains one session lane. Document only generic example hosts and local listener ports.

- [ ] **Step 4: Commit runtime wiring documentation**

```bash
git add docker-compose.yml README.md config/mihomo/config.example.yaml
git commit -m "docs: document session-aware multi-egress runtime"
```

### Task 8: Full Verification, Deployment and Push

**Files:**
- Verify: all `src/` and `test/` files
- Verify: `Dockerfile`, `docker-compose.yml`, runtime Mihomo config

- [ ] **Step 1: Run the complete automated suite**

Run: `npm test`

Expected: all tests pass with zero failures, including public/session routing, challenge escalation, stable affinity and cache isolation.

- [ ] **Step 2: Run static and deployment checks**

Run: `git diff --check` and `sudo -n docker compose config --quiet`.

Expected: both exit successfully; `git grep -nI -E '(gateway_secret|subscription\.yaml|[A-Za-z_]*(token|cookie|password|secret)[A-Za-z_]*)' HEAD -- ':!package-lock.json'` returns no committed runtime credentials or subscription files.

- [ ] **Step 3: Rebuild and restart the gateway**

Run: `sudo -n docker compose up -d --build gateway`.

Expected: the container starts without `EISDIR`, Mihomo starts with both public and session listeners, and no restart loop occurs.

- [ ] **Step 4: Verify runtime behavior**

Run: `curl --fail --silent http://127.0.0.1:1300/readyz`, `sudo -n docker inspect --format '{{.State.Status}} {{.RestartCount}}' rsshub-gateway`, and `sudo -n docker logs --tail 200 rsshub-gateway`.

Expected: readiness JSON reports `ready:true`, restart count remains zero after startup, logs report public lane refresh without exposing node names or credentials, and session assignment/migration events contain only lane IDs and hashes.

- [ ] **Step 5: Push only the verified public commits**

```bash
GIT_SSH_COMMAND='ssh -o BatchMode=yes -o IdentitiesOnly=yes -i /home/ubuntu/.ssh/id_ed25519_legado_hub_github' git push origin main
```

Expected: remote `refs/heads/main` equals the local `git rev-parse HEAD`; ignored runtime configuration remains absent from `git ls-files`.
