# Flare Cold-Start Reader Design

## Goal

Reduce the cold E-Hentai gallery reader path so Flare can display the first visible image within two seconds under a normal warm egress lane, without requiring reader-side configuration, JavaScript, a second subscription, or a change to RSSHub.

The full gallery remains available through the same continuous reader. The first request returns the smallest usable reader shell as soon as the initial gallery document and a bounded first-image resolution are ready. Gallery pagination, later image-detail pages, media downloads, and cache writes continue through the existing background pipeline. Subsequent requests use the unified cache and can render the complete assembled gallery without repeating upstream work.

This is the first delivery slice of the broader gateway foundation. The same pipeline contract will be reusable by image, video, audio, and embed adapters.

## Non-Goals

- Do not modify RSSHub source code or RSSHub token semantics.
- Do not require Flare users to configure a proxy, JavaScript, or another RSS subscription.
- Do not promise a fixed two-second completion time for every upstream failure, cold proxy lane, source rate limit, or full-gallery download.
- Do not expose source URLs, cookies, access tokens, egress node names, or private IP addresses in reader HTML, RSS, cache metadata, or logs.
- Do not reduce source image quality as part of this cold-start change. Existing bounded WebP variants remain an optional media optimization.

## Current Root Cause

The default `/_gateway/item` request currently performs the following work before writing any reader HTML:

1. Fetch the initial gallery page.
2. Fetch every gallery pagination document discovered in that page.
3. Render a sequence whose first image points to a signed E-Hentai image-detail URL.

Flare then requests that signed media URL. On a cold cache, the gateway must fetch and parse the image-detail document before it can fetch the actual image bytes. The first paint therefore waits on two independent upstream document stages, while the original request has already waited on all gallery pagination stages. A second open hits the document and media caches, which explains the observed black first open and successful second open.

## Chosen Approach

Use a two-tier cold-start pipeline with a bounded foreground budget:

1. Fetch or read the initial gallery document using the existing scope-aware upstream client and document cache.
2. Extract the image-detail URLs present in the initial gallery page immediately. Do not wait for gallery pagination before returning the first reader response.
3. Resolve the first image-detail URL on the foreground path with a bounded deadline derived from the two-second first-paint budget. If it resolves in time, render its actual media target as a signed `/_gateway/media` URL. This removes the client-visible detail-page hop for the first image.
4. If detail resolution exceeds the foreground deadline or fails, render the existing signed image-detail media resolver as a safe fallback. The response must still be returned and the background pipeline must retain the retry/cache opportunity.
5. Render the remaining image-detail URLs from the initial gallery page as signed media resolver URLs. They remain in the same ordered reader and lazy-load as the user scrolls.
6. Start full gallery discovery in the background: fetch pagination documents, resolve all bounded image-detail pages in parallel across public egress shards, enqueue actual media targets, and persist cache entries through the existing cache and prefetch queue.
7. When a later request can assemble a complete gallery from cache, render the full resolved sequence using the existing reader contract. No token or source URL is used as a cache key.

This approach makes the first visible image independent of full-gallery discovery while retaining the existing complete-gallery behavior after background warming.

## Domain And Application Boundaries

### Domain: Reader Manifest

Introduce a transport-neutral manifest concept with these fields:

- ordered page number;
- source detail target, kept internal to the application layer;
- resolved media target, optional until detail parsing completes;
- signed reader media URL, generated only at the delivery boundary;
- page title/alt text;
- resolution state: `resolved`, `deferred`, or `failed`.

The domain model does not know Flare, Mihomo, HTTP, or RSSHub. It only preserves order, bounded page count, and safe failure state.

### Application: Cold-Start Orchestrator

The application service coordinates initial-page extraction, first-detail resolution, full discovery, and media warming. It receives ports for:

- source adapter capabilities;
- document/media fetch;
- cache lookup and storage;
- signed delivery URL generation;
- bounded concurrency and deadline control.

Foreground and background work have separate priorities. Foreground work is allowed to use a healthy public/session lane immediately; background work uses the adaptive pool and must not starve foreground requests.

### Infrastructure: Existing Gateway Components

Reuse and extend the existing `cache.js`, `upstream.js`, `egress-pool.js`, `session-affinity.js`, `media-prefetch.js`, and OpenResty media cache. The initial implementation may keep the HTTP composition in `server.js`, but the new orchestration logic must be isolated behind a focused module so future adapters do not duplicate E-Hentai-specific timing logic.

## Request Flow

```text
Flare -> signed item route
      -> verify token and route scope
      -> initial gallery document cache/upstream
      -> extract initial image-detail URLs
      -> foreground resolve page 1 within budget
      -> render page 1 as direct media URL when resolved
      -> render remaining known pages as resolver media URLs
      -> send reader HTML
      -> background: pagination + detail + media warming + cache writes
Flare -> direct media route for page 1
      -> public/session routing -> image cache/upstream -> stream bytes
```

The first media response must be streamed to the caller before any deferred cache write completes. Cache persistence is asynchronous and must not replace a foreground response with a stale or incomplete cache result.

## Timing Budget

The service exposes a configurable foreground budget, with a default of 1,200 ms reserved for the first image-detail resolution. The remaining budget covers gateway processing and client transfer. The budget is a response deadline, not a source retry deadline.

- Initial gallery document: use a fresh cache hit immediately; on a miss, use normal upstream timeout/retry policy.
- First image-detail resolution: one bounded foreground attempt; no full-gallery wait.
- First media: direct streaming and existing media cache behavior.
- Background tasks: adaptive concurrency and existing retry/backoff policy.

Metrics record elapsed durations for initial document, first-detail resolution, reader HTML emission, and first-media cache state. Metrics contain only adapter names, states, counts, and durations.

## Error Handling

- If the initial gallery document is unavailable, preserve the existing safe unavailable page and typed upstream status mapping.
- If the first image-detail page fails, keep the reader usable with the deferred resolver or an explicit page warning; never render an upstream denial shell.
- If a direct media target cannot be parsed, fall back to the signed detail resolver rather than emitting an external source URL.
- Background pagination/detail/media failures remain per-page failures and do not fail an already usable reader response.
- Public and session cache namespaces remain isolated. An authenticated response can never satisfy an anonymous request.
- All foreground promises that outlive the response must have attached rejection handling and bounded resource ownership.

## Testing And Acceptance

TDD coverage will be added before production changes:

- a cold gallery response does not wait for a delayed pagination document;
- the first detail page is resolved on the foreground path and its actual media target is rendered when it completes within the budget;
- a delayed/failed first detail page returns the deferred resolver without an unhandled rejection;
- the first media request streams before its deferred cache write completes;
- background pagination and later media warming continue with background priority and preserve page order;
- a cached complete gallery still renders all resolved pages;
- public/session cache isolation and signed-target privacy remain unchanged;
- Flare-compatible HTML contains one direct first-image media URL, no link wrapper around continuous-reader images, valid dimensions/alt text, and no external source media URLs.

Acceptance uses a fresh uncached synthetic upstream with controlled delays plus a live deployment check:

- `npm test` passes with no failures;
- a cold reader request reports `readerHtmlMs < 2,000` and emits a first-image route without waiting for pagination;
- the first image response begins independently of cache storage completion;
- `/readyz` remains 200 after deployment;
- repeated requests demonstrate document/media cache hits without exposing signed targets in diagnostics.

The live check reports actual measurements and source availability separately. A source `403`/`404`/rate limit is not counted as a client rendering success or as a gateway latency optimization.

## Rollback

The cold-start path is feature-gated by configuration. Disabling it restores the existing full-discovery reader path while retaining cache data and signed URL compatibility. No RSSHub changes or migration is required.
