# Unified Gateway Cache

## Goal

Improve E-Hentai gallery construction speed, image preloading readiness, and upstream stability by caching the upstream documents used to build reader pages, while keeping media delivery efficient and range-safe.

## Scope

The gateway will use one cache policy across these response classes:

- RSS/XML responses: 5 minutes.
- E-Hentai gallery pages and image-detail pages: 3 days.
- Images and videos: 7 days.
- The configured logical cache budget is 5 GB.

Signed tokens are never cache keys. The canonical upstream URL and response class are the cache identity, so refreshed RSS entries reuse the same cached source document.

## Architecture

The existing OpenResty `/_gateway/media/` cache remains the media layer. It already has a 5 GB disk limit, seven-day inactivity expiry, request coalescing, stale-on-upstream-error behavior, and Range bypass for video seeking. The Node gateway must not duplicate large media bodies or alter token validation.

The Node gateway adds a file-backed response cache for small upstream documents. Each entry has a SHA-256 key, response metadata, body file, creation time, expiry time, and last-access time. Writes are atomic through a temporary file and rename. A bounded in-memory single-flight map prevents concurrent requests for the same URL/class from issuing duplicate upstream requests.

Cache files are mounted at `/var/cache/rsshub-gateway` and persisted by the Compose volume `./config/gateway-cache`. The cache index is disposable: missing or corrupt entries are ignored and rebuilt without affecting application startup.

## Request flow

1. A route canonicalizes the upstream URL and selects `rss` or `html`.
2. A fresh cache entry is returned immediately on a hit.
3. On a miss, one request fetches the upstream response while concurrent callers await the same promise.
4. Only successful, bounded, text-compatible responses are stored.
5. The original response status and relevant headers are reconstructed for route rendering.
6. If refresh fails and an expired entry still exists, the stale document is used and marked with an internal cache state; otherwise the existing upstream error handling is preserved.
7. Media requests continue through OpenResty, which caches the signed target by upstream URL and serves cached files/ranges at the edge.

## Safety and limits

- Cache keys include the response class and full canonical URL, including query parameters.
- Authorization headers and signed gateway tokens are never persisted in cache metadata.
- Error responses, redirects, oversized documents, and malformed cache entries are not stored.
- Eviction removes least-recently-used entries until the configured byte budget is satisfied.
- Cache operations are best-effort; filesystem errors fall back to the network path and never take down the gateway.
- Stale content is used only when refresh fails, not when a fresh upstream response is available.

## Verification

Automated tests cover TTL hit/miss behavior, stale fallback, atomic writes, LRU eviction, concurrent single-flight requests, and server integration for RSS and E-Hentai pages. Deployment verification checks the mounted cache directory, readiness, cache headers/state in application logs, and a repeated E-Hentai gallery request showing that the second construction avoids upstream page fetches.

## Alternatives considered

1. Mihomo-only caching: rejected because it cannot cache parsed-document inputs with gateway TTLs or provide deterministic single-flight behavior.
2. Node caching of all media: rejected because it duplicates the existing OpenResty media cache and complicates Range/video streaming.
3. Redis/MinIO: rejected for this single-container deployment because it adds an operational dependency without improving the current bottleneck.
