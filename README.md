# RSSHub Gateway

This project is a transparent companion gateway for RSSHub. Existing RSSHub subscription URLs remain unchanged. The gateway embeds Mihomo for outbound access, rewrites supported RSS/Atom entry and media links to the local domain, and serves reader pages and range-enabled media responses.

## Runtime

The production Compose project lives at `/home/ubuntu/.config/rsshub-gateway`. It joins the existing `1panel-network`, exposes only `127.0.0.1:1300` to OpenResty, and exposes Mihomo port `7890` only to containers on that Docker network.

Runtime-only files are deliberately excluded from Git:

- `config/mihomo/config.yaml` and its provider cache
- `config/sources.json`
- `secrets/gateway_secret`

Source tokens are optional. Iwara, X, and Instagram use public fallback behavior when no source session is configured; a source token can improve detail retrieval but is never printed to logs or committed.

## Unified Cache

The gateway caches small source documents by canonical upstream URL, never by expiring signed gateway tokens. RSS/XML responses use a 5-minute TTL; E-Hentai ranking, gallery, and image-detail HTML use a 3-day TTL. Cache writes are atomic, concurrent requests for the same document are coalesced, and expired documents are used only when an upstream refresh fails. The logical cache limit is 5 GB and the persistent application cache is mounted at `/var/cache/rsshub-gateway`.

Images use the gateway's persistent media cache with a 7-day TTL and the same 5 GB disk budget. E-Hentai continuous readers retain the original image as a fallback and advertise high-quality WebP candidates at 1280, 1920, and 2560 pixels. A candidate is cached only when it is smaller than the original and remains in the same public or session cache namespace. `GATEWAY_IMAGE_VARIANT_CONCURRENCY` defaults to 2 CPU tasks and `GATEWAY_IMAGE_VARIANT_MAX_SOURCE_BYTES` defaults to 32 MiB, so image conversion cannot exhaust outbound or request capacity.

When an E-Hentai continuous reader opens, the first 8 images are fetched in parallel into that cache before the page is returned; their media URLs are preloaded and high priority in the reader. Later image detail pages start background media warming as soon as each detail page resolves. The reader defers later image decoding and rendering while preserving a fixed layout reserve. `EH_MEDIA_FOREGROUND_WARM_COUNT` and `EH_MEDIA_FOREGROUND_WARM_CONCURRENCY` control that bounded first screen. Successful public image responses use a 5-minute shared browser cache (`GATEWAY_MEDIA_BROWSER_CACHE_SECONDS`); session-scoped media uses the same private browser cache lifetime and is never marked shared.

Rendered reader HTML of at least 4 KiB uses Brotli when the client advertises `br` and the compressed form is smaller. `GATEWAY_HTML_BROTLI_MIN_BYTES` and `GATEWAY_HTML_BROTLI_QUALITY` control this behavior. RSS/XML, media, range responses, unavailable pages, and errors remain uncompressed.

E-Hentai gallery image-detail prefetch starts at 8 requests and expands with healthy public egress capacity to a 36-request maximum. At startup this is still bounded by three requests per E-Hentai-verified lane; media warming uses the same adaptive multi-egress pool while reserving one lane slot for foreground requests. Successful upstream downloads ramp up gradually, while 429/5xx/timeouts reduce concurrency and retry with bounded backoff. The queue is deduplicated, persisted under the cache directory, and resumes non-expired work after a restart. Range requests continue to bypass image caching so video seeking behavior is unchanged.

Useful diagnostics:

```sh
sudo docker exec rsshub-gateway du -sh /var/cache/rsshub-gateway
sudo docker compose -f /home/ubuntu/.config/rsshub-gateway/docker-compose.yml logs gateway | grep gateway_cache
sudo docker compose -f /home/ubuntu/.config/rsshub-gateway/docker-compose.yml logs gateway | grep gateway_metric
```

## RSSHub Source Requirements

The gateway can make an existing RSSHub route readable, but it cannot enable a route that RSSHub has disabled. In the installed RSSHub version, `/twitter/...` requires RSSHub Twitter API configuration and `/instagram/user/...` requires `IG_USERNAME` and `IG_PASSWORD`. `/instagram/2/...` is the public web route, but it remains subject to Instagram access limits. Store any RSSHub credentials only in its runtime configuration, never in this repository.

## Verification

```sh
npm test
npm run benchmark:gallery -- http://127.0.0.1:1300/_gateway/item/REDACTED_TOKEN
sudo docker exec rsshub-gateway mihomo -t -d /root/.config/mihomo
sudo docker compose -f /home/ubuntu/.config/rsshub-gateway/docker-compose.yml ps
curl -fsS http://127.0.0.1:1300/healthz
curl -fsS http://127.0.0.1:1300/readyz
sudo docker compose -f /home/ubuntu/.config/rsshub-gateway/docker-compose.yml up -d --build
```

`/healthz` is a liveness check and does not call dependencies. `/readyz` checks the local RSSHub instance and reports the currently open source circuits. Mihomo's runtime `AUTO` health target is `https://t.me`, so Telegram access selects nodes that can reach the actual source rather than a generic connectivity endpoint.

## Upstream behavior

External `GET` and `HEAD` requests use at most three attempts within a 30-second total timeout. Transport errors, timeouts, `408`, `425`, `429`, and `5xx` responses are retried; source authorization and not-found responses are returned without retrying. Three retry-exhausted failures for one source open a 30-second circuit before a single recovery probe is allowed.

Gateway detail routes retain `403` for invalid signed targets. Typed upstream failures return `502`, circuit-open responses return `503` with `Retry-After`, and request deadlines return `504`. Failed responses include `X-Gateway-Source` and `X-Gateway-Attempts`; neither contains source URLs, tokens, or proxy credentials.

## Shared outbound foundation

All site adapters use the gateway's injected `fetchExternal(url, options)` transport. They do not create their own `ProxyAgent`, select Mihomo nodes, or manage retry/concurrency state. Public targets are leased from the adaptive egress pool; sticky targets continue through the fixed authenticated path. The pool filters subscription metadata, validates public lanes against E-Hentai on refresh with a five-minute probe cache, and stripes gallery detail pages across the healthy lane set before falling back to least-loaded routing. This keeps E-Hentai, X, Instagram, Iwara, and Telegram modules on one reusable outbound foundation and allows RSSHub upgrades without source changes.

The foundation exposes only safe transport behavior to modules: target allowlisting, source headers, timeout/retry, circuit policy, egress selection, and response-body lease release. Mihomo Controller details and proxy names remain infrastructure concerns.

Telegram public post details use Telegram's content-bearing embed page. X, Instagram, and Iwara preserve their canonical detail URLs and provide a safe gateway page when an HTML detail request fails instead of rendering an upstream login or error shell.

## Session-aware egress

Public Iwara, Telegram, X, Instagram, E-Hentai ranking, gallery, and media requests start without a source Cookie, token, or `Authorization` header. They are distributed across the public Mihomo pool. A request is upgraded to an authenticated session only after the upstream explicitly signals an authentication challenge: `401`, `403`, a login redirect, or an HTML login page. Timeouts, `429`, and `5xx` responses remain public retry failures and never leak credentials into the public pool.

When a configured source credential is required, the gateway derives an HMAC fingerprint and assigns it to one stable `SESSION_LANE_01..12` listener. The raw credential, its fingerprint, and node names are neither logged nor included in RSS, HTML, signed links, or Git. Session assignment survives a restart through the persistent application cache, while a failed session lane is replaced only after an explicit health failure.

Signed reader links, item pages, media links, and cache entries retain their egress scope. Public cache data is isolated from each `session:<fingerprint>` namespace, preventing anonymous and authenticated responses from being reused across one another. RSS readers keep using their existing RSSHub URL through this gateway; no per-reader proxy configuration or extra subscription is required.

## EhViewer Rankings

The gateway provides public E-Hentai rankings without adding a separate subscription-management step:

```text
https://gateway.example.test/ehviewer/ranking
https://gateway.example.test/ehviewer/ranking/month
https://gateway.example.test/ehviewer/ranking/year
https://gateway.example.test/ehviewer/ranking/all
```

The paths map to yesterday, past month, past year, and all-time rankings respectively. Every item includes its rank, publication time, page count, tags, and proxied cover image in both the RSS description and `content:encoded`, so compatible RSS readers can display the ranking entry directly. Signed gateway reader links remain available for optional full-gallery browsing. Independent media requests retain retries but do not share a host circuit, so one transient thumbnail failure cannot block the rest of the ranking covers. The source is public E-Hentai content and remains subject to source rate limits. Private ExHentai content is not enabled by default.

Ranking item links prefetch the available gallery pages and render them as one ordered continuous reader page through the signed gateway. Failed upstream pages are kept as visible warnings, and large galleries are bounded by the gateway prefetch limit. Append `?view=gallery` to a signed item URL when a browser thumbnail overview is needed; RSS subscription links do not require this option.

## Rollback

Change the OpenResty upstream in `root.conf` from `http://127.0.0.1:1300` back to `http://127.0.0.1:1200`, test with `openresty -t`, and reload OpenResty. The old Mihomo configuration is retained under `/opt/1panel/apps/mihomo` for recovery.
