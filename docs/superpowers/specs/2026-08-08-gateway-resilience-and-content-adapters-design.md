# RSSHub Gateway Resilience and Content Adapters Design

## Goal

Make the gateway reliably serve readable, locally proxied RSSHub content when an upstream site or proxy node is unstable, while making source-specific detail handling extensible for Telegram, X, Instagram, and Iwara.

## Scope

This iteration adds a shared resilience policy around upstream requests and evolves source adapters from header-only configuration into content-detail policies.

It covers:

- bounded retries, retry classification, and per-source circuit breakers;
- explicit gateway status responses and safe diagnostic response headers;
- liveness and readiness endpoints;
- a Telegram adapter that owns its `?embed=1` detail-page behavior;
- a common adapter contract for X, Instagram, and Iwara detail retrieval and fallback pages;
- automated tests for retry, timeout, circuit recovery, status mapping, and source-detail behavior.

It does not add a user-facing management UI, a database, a job queue, bypasses for login-protected/private content, or new third-party scraping services. OpenResty's existing 5 GB media cache remains the persistent cache in this iteration.

## Current Constraints

The gateway is a single Node 24 service behind OpenResty. RSSHub and the gateway share the embedded Mihomo HTTP proxy over `1panel-network`. Request tokens allow only HTTPS URLs on an explicit host allowlist. Media responses stream through the gateway and are cached by OpenResty; reader pages are generated on demand.

The current implementation has two reliability gaps:

1. transient network failures are returned after one failed `fetch`, even though proxy-node selection can recover on a subsequent request;
2. request failures are flattened to `403` or `502`, making an invalid signed URL indistinguishable from an unreachable source.

Existing adapters only add optional source credentials. Telegram's special reader URL is currently an inline condition in `server.js`, which will not scale to additional source-specific rules.

## Architecture

```text
RSS reader / browser
        |
    OpenResty
        |
RSSHub Gateway
  |       |        |
feed    item     media
  |       |        |
RSSHub  request policy -> source adapter -> Mihomo -> external source
```

### Request Policy

`src/upstream.js` becomes the single owner of outbound request policy. It keeps redirect validation and optional adapter headers, then adds the following behavior for `GET` and `HEAD` requests:

- maximum three attempts inside a 30-second total deadline;
- jittered exponential delays of roughly 250 ms then 750 ms, shortened when the remaining deadline is smaller;
- retries only for transport errors, timeouts, HTTP `408`, `425`, `429`, and `5xx` responses;
- no retry for token validation failures, malformed URLs, source `401`, `403`, `404`, or `410` responses;
- a per-source circuit breaker that opens after three consecutive retry-exhausted failures, stays open for 30 seconds, then permits one probe request;
- redirect targets remain allowlisted before every hop.

The circuit-breaker key is the logical source hostname (for example `t.me` or `x.com`), not the full URL. RSSHub is tracked as its own `rsshub` source. Breaker state is process-local by design: a gateway restart clears it, avoiding a new persistence dependency.

The policy returns typed outcomes rather than throwing unclassified errors. `src/server.js` maps them as follows:

| Condition | Response |
| --- | --- |
| invalid or expired signed target | `403` |
| open circuit | `503` plus bounded `Retry-After` |
| upstream timeout after retries | `504` |
| transport failure or retriable upstream failure after retries | `502` |
| final source `401`, `403`, `404`, `410` | source status preserved |

Responses include `X-Gateway-Source` and `X-Gateway-Attempts`; neither header includes full URLs, credentials, signed-token contents, or proxy details. Structured logs record source, outcome, HTTP status, attempt count, and duration only.

### Health Model

- `GET /healthz` stays a no-dependency liveness probe and returns `200 ok` whenever Node is accepting requests.
- `GET /readyz` checks the local RSSHub health endpoint with a short, non-proxied timeout and returns JSON containing `ready`, `rsshub`, and currently open circuit keys. It returns `503` when RSSHub is not ready.

Mihomo remains managed by the container entrypoint. Its provider health check and `AUTO` group use `https://t.me`, so the selected proxy is validated against the service that caused the observed production failures. The runtime subscription and provider cache remain ignored by Git.

### Source Adapter Contract

`src/adapters/index.js` returns a default adapter for unknown allowlisted targets and a named adapter for supported sources. Every adapter exposes:

```js
{
  name,
  matches(hostname),
  headers(config),
  readerTarget(url),
  unavailableMessage(url, status),
}
```

`readerTarget` receives the verified canonical URL and returns the URL that should be fetched for the reader page. The default is identity. `unavailableMessage` returns a short source-specific Chinese explanation for a safe gateway-generated fallback page; it never exposes a configured cookie or token.

Initial policies are:

- Telegram: convert public post URLs of the form `https://t.me/<channel>/<message-id>` to `?embed=1`; retain the original post URL as the "原始来源" link.
- X and Instagram: use the canonical URL and optional configured credentials. A login, consent, or blocked shell does not pretend to be an article; it produces a readable unavailable page with the source link.
- Iwara: use the canonical URL and optional session cookie. Images, video posters, video/audio sources, and links continue to be rewritten through signed gateway routes.

`server.js` asks the adapter for the reader target and fallback text; it no longer contains source-name conditions. `reader.js` remains the sanitizer and local-link rewriter. It gains a small safe renderer for source-unavailable pages, so all fallback output has the same no-script presentation as normal reader pages.

## Data Flow

1. An RSS reader requests a feed, item, or media URL from the gateway.
2. The gateway validates a signed target for item/media routes.
3. The request policy selects the source adapter, derives headers and the reader target, validates redirects, and performs bounded retries through Mihomo.
4. On success, feed XML is transformed, media is streamed, or HTML is sanitized and rendered.
5. On a classified failure, the server sends the mapped status and safe diagnostic headers. For a source-generated login/blocked page, the reader renderer provides a readable fallback rather than a broken embed shell.
6. Every external link or media URL remains signed and allowlisted before it is emitted to the reader.

## Security and Privacy

- Existing HTTPS-only host allowlist and signed-token verification are preserved for every redirect hop.
- `SOURCE_CONFIG_FILE`, Mihomo subscriptions, cookies, and gateway secrets remain runtime-only and ignored by Git.
- Logs and response headers use source names/hostnames only. They do not include signed tokens, source URLs with query strings, request headers, proxy nodes, or credentials.
- Retry logic is limited to idempotent reads, preventing duplicate state-changing requests.

## Testing and Acceptance Criteria

Unit and server tests must prove:

1. retryable transport/status failures retry up to the bound and then succeed or map to `502`/`504`;
2. non-retryable source statuses are returned without additional attempts;
3. a circuit opens after the configured threshold, rejects immediately with `503`, and permits a successful half-open probe after cooldown;
4. `readyz` reports RSSHub availability independently from `healthz`;
5. Telegram reader requests use `?embed=1` and render post text rather than Embed/View/Copy controls;
6. X, Instagram, and Iwara use their adapter headers and produce a safe fallback page for unreadable source shells;
7. redirect allowlisting, media range streaming, XML transformation, and all existing signed-target behavior remain green.

Production verification must include:

- `npm test` with no failures;
- `mihomo -t` against the production runtime configuration;
- `GET /healthz` and `GET /readyz`;
- the Telegram channel feed plus three consecutive detail-page requests returning readable body text;
- one media range request returning the expected `206` response.

## Rollout and Rollback

Deploy by rebuilding only `rsshub-gateway`; RSSHub keeps `PROXY_URI=http://rsshub-gateway:7890`. Watch structured gateway logs and Mihomo logs during the first Telegram, X, Instagram, and Iwara requests.

Rollback is a normal Docker image rollback to the prior gateway image or Git commit. The OpenResty upstream remains `127.0.0.1:1300`, so no proxy configuration change is required for application rollback. The runtime Mihomo configuration can be restored independently if a subscription provider changes its health-check behavior.
