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

The gateway caches small source documents by canonical upstream URL, never by expiring signed gateway tokens. RSS/XML responses use a 5-minute TTL; E-Hentai ranking, gallery, and image-detail HTML use a 3-day TTL. Cache writes are atomic, concurrent requests for the same document are coalesced, and expired documents are used only when an upstream refresh fails. The logical cache limit is 5 GB and the persistent application cache is mounted at `/var/cache/rsshub-gateway`. Eviction is kind-aware: RSS entries leave first, then HTML, media, and finally image variants (`media-variant`), so variant regeneration cost is protected; entries of the same kind evict by least-recent use.

Images use the gateway's persistent media cache with a 7-day TTL and the same 5 GB disk budget. E-Hentai continuous readers retain the original image as a fallback and advertise high-quality WebP candidates at 1280, 1920, and 2560 pixels. A candidate is cached only when it is smaller than the original and remains in the same public or session cache namespace. `GATEWAY_IMAGE_VARIANT_CONCURRENCY` defaults to 2 CPU tasks and `GATEWAY_IMAGE_VARIANT_MAX_SOURCE_BYTES` defaults to 32 MiB, so image conversion cannot exhaust outbound or request capacity.

When an E-Hentai continuous reader opens, one original high-quality image is preloaded for first paint. Later images use lazy loading and quality-aware variants, while up to 8 image bytes are warmed in the background as their detail pages resolve. The reader defers later image decoding and rendering while preserving a fixed layout reserve. `EH_FIRST_PAINT_COUNT` controls the client-visible eager count (default `1`); `EH_MEDIA_FOREGROUND_WARM_COUNT` and `EH_MEDIA_FOREGROUND_WARM_CONCURRENCY` control the separate background warm batch. Background detail and media work yields to foreground requests. Successful public image responses use a 5-minute shared browser cache (`GATEWAY_MEDIA_BROWSER_CACHE_SECONDS`); session-scoped media uses the same private browser cache lifetime and is never marked shared.

Cold E-Hentai readers use a bounded foreground path for the first visible image. The initial gallery HTML is returned without waiting for pagination; the first image-detail page receives up to `EH_FIRST_DETAIL_BUDGET_MS` (default `1200` ms, capped below the two-second reader target) to resolve directly to the image media route. Pagination, later detail pages, media warming, and cache persistence continue in the background. If the first detail page is slow or unavailable, the reader remains usable and the gateway media route resolves that page lazily. Set `EH_COLD_START_ENABLED=false` to roll back to synchronous full discovery while retaining signed URL and cache compatibility. The `reader_html_emitted` metric reports gateway HTML emission time; it is not a guarantee that a source image, cold proxy lane, or complete gallery will finish within two seconds.

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

## Source catalog

The gateway proxies media for the major adult sources and their CDNs, in addition to the existing Iwara, X, Instagram, Telegram, and E-Hentai support: nhentai, Hitomi, Pururin, Hanime, Hentai.tv, Hentai-Foundry, 8muses, Rule34, Gelbooru, Danbooru, Sankaku Complex, Hiyobi, Pornhub, XVideos, MissAV, JavDB, JavBus, Jable, DMM/MGStage, and GGJAV (`ggjav.com`, `cdn-1.ggjav.com`). Any RSSHub route for these sources passes through unchanged; feed media (images, videos, enclosures) is rewritten to signed gateway routes, and item links open the safe reader page. Sources RSSHub does not cover — such as GGJAV — are served by their own Sidecar-Fetcher (`fetcher-ggjav`, routes `/ggjav/home`, `/ggjav/censored`, `/ggjav/uncensored`, `/ggjav/amateur`, `/ggjav/cartoon`, `/ggjav/chinese`, `/ggjav/europe`, `/ggjav/video/:id`, `/ggjav/model/:name`, `/ggjav/genre/:tag`, `/ggjav/search/:keyword`, each with optional `/:page?`) with automatic fallback to upstream RSSHub. Requests to these hosts use the shared adaptive egress pool with per-source retries and circuit isolation, so one blocked source cannot stall the rest. Two media-layer adaptations keep these sources playable: hotlink-protected CDNs (JavBus/JpgCDN/MGStage/DMM/JavDB/Jable/MissAV) get a same-origin `Referer` on gateway fetches (they answer `403` without it), and the image bundles Let's Encrypt's 2026 new-hierarchy chain (`ISRG Root YE`/`YE1` intermediates, `config/certs/le-ggjav-chain.pem`) via `NODE_EXTRA_CA_CERTS` because the GGJAV CDN serves its leaf certificate without the intermediate chain. Platform availability matrix (2026-08): JavBus (`/javbus/...`) and JavDB (`/javdb/...`) work through the RSSHub passthrough with proxied covers; GGJAV works through its sidecar; Jable.tv answers a Cloudflare managed challenge to the browser-fingerprint transport but passes the gateway's own headless-Chromium render service, so it is served by `fetcher-jable` (`/jable/new-release`, `/jable/videos`, `/jable/search/:keyword`, `/jable/video/:code`, optional `/:page?`) with covers and previews proxied from `assets-cdn.jable.tv`; MissAV's feed is client-side rendered on missav.ws (the upstream RSSHub route itself requires Playwright), so it is served by `fetcher-missav` (`/missav/new`) through the gateway's own headless-Chromium render service (`browser-render`, puppeteer-core + system Chromium, proxied through the container's Mihomo egress, default on, `GATEWAY_BROWSER_RENDER=false` to disable). 18Comic (jmcomic1.me) and 141PPV answer the same Cloudflare Turnstile challenge as 141jav/Jable and are unsupported for the same reason. PornHub pornstar feeds (and their OnlyFans links) pass through with proxied media. Verified route coverage includes `javdb/search/:query` (URL-encoded, covers proxied), `javbus/star/:id`, `javbus/genre/:gid`, and `pornhub/pornstar/:username` (some model pages are empty upstream — an RSSHub-side issue). AIrav is served by `fetcher-airav` (`/airav/home`, latest-releases feed with `airav.io` covers through the gateway media proxy; its list/video pages are currently 521 from the origin — the fetcher degrades to upstream RSSHub when they recover or are re-added). Because JavBus/JavDB page WAFs reject plain undici TLS fingerprints (covers are exempt), page fetches for `GATEWAY_BROWSER_FETCH_HOSTS` (default `javbus.com,javdb.com,airav.wiki,airav.io`, suffix-matched) are routed through the browser-fingerprint worker with redirect following and a fallback to the regular client when the worker is unavailable; the signed-target allowlist still applies.

## Video playback and caching

Feed attachments are rewritten in both RSS and Atom form: `enclosure@url`, `media:content@url`/`cover`, `media:thumbnail@url`, and Atom `link[rel=enclosure]@href` all point at signed gateway media routes, so readers such as Flare can play video directly from the feed.

Gateway media caching now covers videos as well as images. A complete video response up to `GATEWAY_VIDEO_CACHE_MAX_FILE_BYTES` (default 256 MiB) is stored in the same persistent cache with the 7-day TTL and 5 GB budget. Byte-range requests are served locally from the cached file (`206` with `Content-Range`), so seeking a cached video never touches the upstream source; range requests for uncached or oversized videos continue to stream through the upstream unchanged. Image variants remain image-only; video responses are never sent through the Sharp pipeline.

## Iwara feed and video

The gateway serves `/iwara/users/:username/:type?` (type defaults to `video`) through the **fetcher-iwara Sidecar-Fetcher** — a separate process running beside the gateway (same container, process isolation per the charter) — instead of scraping it in the gateway base, because iwara's Cloudflare protection blocks the plain Node/curl TLS fingerprints RSSHub uses. With no registered route the path is transparently proxied to upstream RSSHub, and when the sidecar fails the route automatically falls back to upstream RSSHub (`fallback_upstream: true`). A bundled browser-fetch worker (Chrome-impersonating `curl_cffi` running inside the gateway image, `src/fetch-worker.py`) performs the iwara API calls for the sidecar; media hosts (`i.iwara.tv`, `filesq.iwara.tv`, `acheron.iwara.tv`) remain reachable with the normal gateway transport. The worker is spawned as a child process by `src/browser-fetch.js` and speaks line-delimited JSON over stdio; a standalone HTTP sidecar (`IWARA_FETCHD_URL`) remains supported as a fallback for deployments that cannot run the worker.

Each feed item includes a signed thumbnail, an `enclosure`/`media:content` pointing at the gateway media route for the video, and an item link that opens a gateway HTML5 reader page. Playing a video resolves `api.iwara.tv/video/{id}` for the signed file URL, picks the highest numeric quality variant, and streams it through the gateway video cache (full `200` cached, `206` byte ranges served from disk). The resolution is cached in memory for 15 minutes so repeated requests reuse one upstream resolution. Detail and variant resolution retries transient transport failures and `5xx` responses up to three times with short backoff, so an intermittent media-host reset no longer fails playback.

An optional iwara account token in `config/sources.json` (`{"iwara": {"token": "<refresh token>"}}`) is sent as `Authorization: Bearer` for metadata and R18 video detail requests; it is never logged or committed. Without a token the feed still lists public videos.

User feeds resolve the profile through `api.iwara.tv/profile/:username`; when iwara no longer finds the old username (renamed accounts), the gateway falls back to `api.iwara.tv/autocomplete/users` and matches the display name or current username exactly, so old feed URLs keep working after renames.

The browser-fetch worker impersonates a Chrome browser via `curl_cffi`; the impersonation target is set with `FETCHD_IMPERSONATE` (default `chrome131`). Cloudflare escalates bot detection against old fingerprints, and iwara challenges the default `chrome` alias on user/profile API paths, so the newer `chrome131` fingerprint is required to keep user feeds working. Per-request overrides are supported through the worker protocol (`impersonate`, `redirect`, `proxy`).

## Video transport, chunks and one-time download leases

Video range requests that miss the gateway cache start a background slice fill: the covering 4 MiB slices plus a 16 MiB lookahead window are fetched from upstream in parallel (bounded by `sliceFillConcurrency`, default 4) and stored as independent cache entries, so the first seek seeds the cache with several connections and later ranges (including parallel seeks and chunk downloads) are served from disk as soon as their slices arrive. Video sizes and cached slices are remembered per target, so repeated seeks skip upstream entirely. `GET /_gateway/media/:token?download=1` adds an attachment `Content-Disposition`, and `GET /_gateway/media/:token?chunks=N` returns a JSON manifest of `N` signed chunk URLs plus a `chunks` array with each range's `index`, `start`, `end`, `size` and `url`; each `/_gateway/chunk/:token` URL serves its byte range (206) independently, so IDM/aria2-style downloaders can pull a file with several parallel connections and resume failed ranges without decoding tokens. `POST /_gateway/download/:mediaToken?chunks=N` creates a download session whose chunk URLs carry the session id; the gateway marks each chunk `done` once its range has streamed out, and `GET /_gateway/download/:sessionId` reports per-chunk status plus `doneChunks`/`doneBytes` so a downloader can track progress and resume only the remaining chunks (sessions expire after 24 hours; chunk URLs are deterministic, so a new session can always be recreated). Sessions are persisted to `<cache root>/download-sessions.json` (override with `GATEWAY_DOWNLOAD_SESSION_FILE`), so in-flight progress survives a gateway restart and a client holding the `sessionId` can keep resuming. If the upstream connection drops mid-chunk, the chunk route automatically resumes the byte range from the flushed offset (up to 3 attempts, backoff between tries) instead of forcing the client to re-fetch from zero, and only marks the chunk `done` after its full range has streamed out; retries that keep failing end the connection so downloaders reliably detect truncation. Large range requests on video targets (2+ slices, 8 MiB+) are assembled from parallel slice fetches instead of a single upstream connection: each 4 MiB slice is pulled concurrently through the egress pool, stored in the slice cache, and streamed to the client in order — so per-connection throughput limits stop capping downloads, and every byte is cached for instant resume/seeks. First large request on an unknown-size video probes the size once (`bytes=0-0`) and remembers it for the session; size probes and whole-file prefetch also record the size, so later range serves skip the probe entirely. All three slice-pull paths — whole-file prefetch, foreground parallel assembly and lookahead fill — share one per-slice in-flight dedup (a single `getOrLoad` per `#slice=` cache key), so a client that starts pulling chunks before warm-up never issues duplicate upstream range requests with the background prefetch or fights it for slow-CDN bandwidth. Creating a download session (`POST /_gateway/download/:mediaToken?chunks=N`) additionally kicks off a background whole-file slice prefetch: every 4 MiB slice of the video is pulled through the egress pool at `background` priority (bounded by `sliceFillConcurrency`), deduplicated per target so concurrent session creations share one prefetch, and bounded by the video cache cap — so parallel chunk downloads and later seeks are served straight from the slice cache instead of racing the same upstream connection. Prefetch completions are reported as `rsshub_gateway_media_prefetch_slices_total` (per-event `count`/`total`); partial failures log a single `media_prefetch_partial` warning per file. The download session view (returned by both `POST /_gateway/download/:mediaToken` and `GET /_gateway/download/:sessionId`) includes a `prefetch` object: `status` (`running`/`done`), `fetchedSlices`/`totalSlices`/`failedSlices` and `startedAt`/`completedAt` — a client downloader can poll it and start pulling chunks as slices land, or wait for `done` before going parallel. Set `GATEWAY_VIDEO_PREFETCH=false` to disable session prefetch entirely, and `GATEWAY_VIDEO_PREFETCH_CONCURRENCY` (default 4, range 1–8) to tune the whole-file prefetch worker count. `GET /_gateway/download/:sessionId/wait?timeout=<ms>` long-polls until that session's prefetch finishes (default 30 s, capped at 60 s) and returns `{ prefetch, timedOut }` — once `prefetch.status` is `done` a downloader can pull every chunk in parallel with every byte served from the gateway cache; `timedOut: true` reports partial progress (`fetchedSlices`/`totalSlices`) so the client can start on the cached slices or keep waiting. Non-video sessions (no prefetch) and missing sessions return immediately with `prefetch: null` / 404 respectively.

Chunk planning is adaptive (`src/media/chunks.js`): preferred chunk size grows with the file (1 MiB below 64 MiB, 4 MiB below 512 MiB, 8 MiB below 2 GiB, 16 MiB above), an optional bandwidth hint sizes chunks to roughly `targetSeconds` of stream, and the plan always covers the complete file with at most 256 aligned ranges. This fixes manifests that previously left large files partially uncovered when few chunks were requested.

## Unified media and infrastructure foundation

Media acceleration is a reusable bottom layer, not server-specific code. `src/media/media-transport.js` exposes `createMediaTransport()` with the full pipeline — cache reads and fills, byte-range serving, image variants, size probes, chunk manifests and session/public routing hooks — so the HTTP server, the RSSHub passthrough, and future services call the same code for every image and video route. Adapters stay thin: they describe targets and headers, and the transport handles caching, slicing, leasing and egress.

`src/infrastructure/logger.js` provides one structured logging shape (`{ event, level, ts, ...fields }`) with automatic redaction of tokens, passwords, cookies and proxy credentials; every service (server, lease proxy, prefetch queue, transport) logs through it. `src/infrastructure/poller.js` is the shared background scheduler (jittered intervals, failure tracking, graceful stop) used for lease expiry sweeps and available for cache maintenance, egress refresh and prefetch queues.

Image acceleration includes background variant warmup: when a full-size image is served, the transport queues generation and caching of all `IMAGE_VARIANT_WIDTHS` (1280/1920/2560 WebP) variants from the cached original, so later `?w=` requests are served from cache without touching upstream.

The signed-target allowlist covers the media CDNs used by RSSHub feeds (imgur, Discord, Reddit, YouTube/ytimg, Google user content, Flickr, MyAnimeList, AniList, TMDB, Steam, eBay, postimg, GitHub user content, weserv/wsrv image resizers, Apple mzstatic, Amazon, Unsplash, Fandom, Wikimedia, Spotify, SoundCloud, Telegram CDN, TikTok, Cloudinary, Bilibili, Weibo, Zhihu, Douban, NetEase Music, Xiaohongshu) on top of the site hosts, so `transformFeed` can rewrite enclosures and images from arbitrary RSSHub routes to the accelerated gateway media path.

`src/infrastructure/request-service.js` is the unified request facade: it composes the upstream client (proxy, retry, circuit breaker, egress lanes, session dispatchers) and the browser-fingerprint worker behind one entry point, exposing `fetchExternal`, `fetchRssHub`, `fetchJsonViaFetchd` and `openCircuits` to routes and adapters. New site adapters plug in through `src/adapters/` — for example `pixiv.js` attaches the required `Referer: https://www.pixiv.net/` to `i.pximg.net` image requests so RSSHub pixiv feed images proxy and cache correctly without credentials.

`GET /_gateway/lease/:mediaToken` issues a one-time, short-lived download lease for the signed media target. The response contains temporary proxy credentials (`proxyUrl`), the resolved upstream URL, the allowed host, and byte/concurrency caps. Point a downloader at the proxy (for example `aria2c -x 8 --all-proxy "$PROXY_URL" "$URL"`) and it fetches the video directly from the source through the gateway's egress pool with multiple connections, without the gateway relaying every byte. The lease is revoked when the session completes, the byte cap is reached, or the TTL (default 30 minutes) expires.

`proxyUrl` defaults to the internal proxy (`http://user:pass@127.0.0.1:1301`, port set by `GATEWAY_LEASE_PROXY_PORT`); when `GATEWAY_LEASE_PROXY_PUBLIC_URL` is configured (for example `https://kellson.dpdns.org:81`), the lease returns that public TLS endpoint instead.

While the client downloads, the gateway runs a one-time **lease backfill**: video slices are fetched in the background through the same egress pool and slice pipeline used by normal playback (`#slice=` cache keys), so the second play is served from the gateway cache without re-downloading from the source. Backfill is best-effort and bounded — it stops when the lease is revoked or expires, deduplicates concurrent leases for the same video, respects the video cache size cap, and skips when the cache lacks headroom for the expected size (a default 128 MiB eviction budget lets a fresh download displace older entries; larger videos are skipped when the cache is full). Tune it with `GATEWAY_LEASE_BACKFILL` (default `true`) and `GATEWAY_LEASE_BACKFILL_CONCURRENCY` (default `2`, range 0–8); `GET /_gateway/infra` exposes `leaseBackfill` counters (`running/completed/failed/skipped/bytesFilled`). CONNECT requests there are tunneled by the OpenResty Lua location (`@__lease_connect`, see `/www/sites/kellson.dpdns.org/proxy/lease-tunnel.lua` on the gateway host) to the lease proxy on `127.0.0.1:1301`, forwarding `Proxy-Authorization` untouched and appending `X-Lease-Client-IP: $remote_addr` so per-client rate limits (8 CONNECTs/minute/IP) see the real client instead of the reverse proxy. The lease proxy validates the Basic Auth credentials, allows only the leased host, enforces the byte/concurrency caps, and chains upstream through the container's Mihomo egress so one-time leases let downloaders use the full bandwidth without the gateway relaying media bytes.

## Dispatcher routing and Sidecar-Fetcher plugins

The gateway base does not implement site-scraping business logic. A config-driven Dispatcher (`src/dispatcher.js`) owns the route registry: when `gateway-routes.yaml` (path overridable with `GATEWAY_ROUTES_FILE`) is absent, the gateway is a pure transparent enhancement proxy and every unmatched path is forwarded to upstream RSSHub (`RSSHUB_URL`). Registering a route maps a path pattern (`:name` single segment, `:name?` optional trailing segment, `*` remainder) to a backend:

```yaml
routes:
  - routeId: "/iwara/users/:username/:kind?"
    backend: "sidecar://fetcher-iwara:8000"
    fallback_upstream: true
    cacheTtl: 900
```

Backends are always `sidecar://host:port` — a standalone Fetcher process speaking the Fetcher-API (the gateway base deliberately ships no built-in site adapters, per the charter). On a sidecar match the gateway POSTs `{ routeId, params, egressLane, cookies, cacheTtl }` to `http://host:port/fetch` and expects `{ rssXml, mediaUrls, cacheHint }`; the response is cached like any RSS document (TTL from `cacheHint.ttl` or the route's `cacheTtl`) and passes through the same unified post-processing (media link rewriting, metrics, Brotli/gzip compression) as upstream RSSHub output. When a sidecar fails and `fallback_upstream: true`, the gateway automatically degrades to the upstream RSSHub route instead of failing; without it the request returns 502. A sidecar crash therefore never takes down a feed or the gateway.

Routes can also be registered at runtime without restarting the gateway: when `DISPATCHER_REGISTRATION_TOKEN` is set, the control endpoint `/_gateway/dispatcher/routes` accepts `GET` (list), `POST` (register `{ routes: [...] }`) and `DELETE` (unregister `{ routeIds: [...] }`) with `Authorization: Bearer <token>`. The reference sidecars (`fetcher-iwara`, `fetcher-eh`) auto-register their routes at startup when `DISPATCHER_REGISTRATION_URL`, `DISPATCHER_REGISTRATION_TOKEN` and `FETCHER_ADVERTISE_HOST` are set, and unregister on graceful shutdown. Without the token the endpoint returns 404, so production stays unchanged by default.

### Supported Sidecar Fetchers & Platform Matrix

The gateway includes standalone microservice Fetchers for demanding sources, communicating via the standard Fetcher-API (`POST /fetch`, `GET /healthz`):

| Sidecar Service | Port | Supported Route Patterns | Upstream Target / Features |
| --- | :---: | --- | --- |
| `fetcher-iwara` | `8000` | `/iwara/users/:username/:kind?` | Iwara.tv 3D videos/images, token refresh |
| `fetcher-eh` | `8001` | `/ehviewer/ranking/:period?` | E-Hentai daily/monthly ranking feeds |
| `fetcher-ggjav` | `8002` | `/ggjav/home`, `/ggjav/search/:keyword` | GGJAV adult streaming catalog |
| `fetcher-airav` | `8003` | `/airav/home`, `/airav/new-release` | AirAV video streaming feeds (`airav.io`) |
| `browser-render`| `8004` | `/render`, `/healthz` | Headless Chromium rendering engine |
| `fetcher-missav`| `8005` | `/missav/new`, `/missav/search/:keyword` | MissAV video streaming (`missav.live`) |
| `fetcher-jable` | `8006` | `/jable/new-release`, `/jable/video/:code` | Jable multi-lane hybrid fetcher |
| `fetcher-javbus`| `8007` | `/javbus/home`, `/javbus/series/:id` | JavBus uncensored/censored releases |
| `fetcher-javdb` | `8008` | `/javdb/home`, `/javdb/rankings/:time?` | JavDB movie database & rankings |
| `fetcher-kemono`| `8009` | `/kemono/posts`, `/kemono/:source?/:id?`| Kemono creator posts & attachments (`kemono.cr`)|
| `fetcher-coomer`| `8010` | `/coomer/posts`, `/coomer/:source?/:id?`| Coomer creator media & attachments (`coomer.st`)|
| `fetcher-wnacg` | `8011` | `/wnacg/home/:cid?/:tag?` | WNACG doujinshi and manga albums |
| `fetcher-fanbox`| `8012` | `/fanbox/:creator` | pixivFANBOX creator sponsor feeds |
| `fetcher-skeb`  | `8013` | `/skeb/:category` | Skeb illustration & voice commissions |
| `fetcher-uraaka`| `8014` | `/uraaka/home` | Uraaka Japanese idol community |
| `fetcher-sehuatang`| `8015` | `/sehuatang/:subforumid?` | 98tang / 色花堂 with 2-stage `_safe` challenge bypass |
| `fetcher-chikubi`| `8016` | `/chikubi/home` | Chikubi photo articles and gravure |
| `fetcher-linuxdo`| `8017` | `/linuxdo/latest`, `/linuxdo/top/:period?`| Linux.do technical forum & topics |

All sidecars share automatic fallback to upstream RSSHub (`fallback_upstream: true`), HMAC-SHA256 URL signing, and TLS fingerprint simulation.

## Async feed prefetch / precache queue

The gateway can keep configured feed paths warm in the shared RSS cache by re-requesting them through its own pipeline on a schedule (`src/feed-prefetch.js`, architecture v0.2 phase 3.2). Each prefetch goes through the exact same dispatcher → sidecar/upstream → cache → post-processing path as a real reader request, so a warm entry means a reader's request is served instantly from cache without touching the source. In-flight and queued paths are deduplicated, concurrency is bounded, and transient failures are retried with backoff. Prefetch is off by default and enabled by listing paths:

| Env / option | Default | Meaning |
| --- | --- | --- |
| `GATEWAY_FEED_PREFETCH_PATHS` (`feedPrefetchPaths`) | empty (off) | Comma-separated feed paths to keep warm, e.g. `/iwara/users/tsyj/video,/ehviewer/ranking` |
| `GATEWAY_FEED_PREFETCH_INTERVAL_MS` | `900000` (15 min) | Minimum time between prefetch runs of the same path |
| `GATEWAY_FEED_PREFETCH_CONCURRENCY` | `2` | Max parallel prefetch fetches |
| `GATEWAY_FEED_PREFETCH_MAX_RETRIES` | `2` | Retries per path before marking failed |

The control endpoint `/_gateway/prefetch` (guarded by the same `DISPATCHER_REGISTRATION_TOKEN` as route registration; 404 when unset) reports queue stats with `GET` and enqueues an on-demand prefetch with `POST {"path": "/..."}`.

## Feed filtering and rules engine

The gateway supports non-intrusive XML feed filtering and content cleaning at the gateway level (`src/feed-transform.js`), allowing subscription sanitization without touching upstream RSSHub instances:

- **Keyword Blacklists (`keywordBlacklist`)**: Strips articles whose title or summary contains configured spam or unwanted keywords.
- **Author Filtering (`authorBlacklist`)**: Automatically excludes posts by specified authors or bots.
- **Custom Rule Injection**: Seamlessly integrates into `transformFeed(xml, { filters: { keywordBlacklist, authorBlacklist } })`.

## Feed and session safety enhancements

- **Adaptive Backoff Scheduling (`src/feed-prefetch.js`)**: Prefetch tasks automatically apply exponential backoff (up to 4 hours) upon receiving HTTP `429` or `5xx` rate-limits/errors, avoiding upstream IP bans. Successful fetches reset the backoff multiplier.
- **Session Revocation (`src/download-session.js`)**: Exposes `revoke(idOrTarget)` and `POST /_gateway/revoke-session` to immediately invalidate leaked or expired download sessions, instantly terminating unauthorized media streams.
- **Dynamic Task Toggling**: Supports `togglePause(path, paused)` for fine-grained per-feed prefetch execution management.

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

`GET /_gateway/metrics` exports Prometheus text counters and gauges (requests, cache hits/misses/bytes, egress lanes with per-lane `active`/`targetConcurrency`/`samples`/`ewmaMs`/`siteBlocked`, feed-prefetch queue plus per-path `completed`/`failed`/`lastStatus`/`lastDurationMs`, lease-backfill, and all internal metric counters) for scraping; every response echoes `X-Request-Id` (incoming header or auto-generated) and gateway logs carry it for tracing. Per-route request counters (`route_feed`, `route_item`, `route_media`, `route_lease`, ...) are included. Request durations are also attributed per upstream source (`source_telegram_duration_seconds`, `source_iwara_duration_seconds`, `source_x_duration_seconds`, ...) via signed-target metadata or the RSSHub path prefix, so slow sources stand out.

The gateway drains gracefully on `SIGTERM`/`SIGINT`: it stops accepting new connections, closes idle keep-alive sockets, and waits up to 10 seconds for in-flight requests (media streams, lease tunnels, backfill) to finish before exiting; a timed-out drain exits with code 1.

`/healthz` is a liveness check and does not call dependencies. `/readyz` checks the local RSSHub instance, verifies that every configured Mihomo egress lane group (`EGRESS_LANE_01..12` and `SESSION_LANE_01..12`) exists on the controller, requires at least one public lane to be populated (the first ~30-60 seconds after a restart report `503` until lane probes finish), and reports the currently open source circuits. A missing group (for example a deployment without the session lane groups) makes `/readyz` fail with `503` and lists it under `egress.missingGroups`. Metrics export `egress_lanes`, `egress_session_lanes`, `egress_active`, and `egress_degraded` gauges. Mihomo's runtime `AUTO` health target is `https://t.me`, so Telegram access selects nodes that can reach the actual source rather than a generic connectivity endpoint. For a cold-start check, use an uncached test gallery with delayed pagination and record only status, HTML emission duration, first-media target kind, and the number of requests still active after HTML emission. A source `403`, `404`, `429`, or timeout is an upstream availability result and must not be counted as a successful client first-paint measurement. Do not put live signed URLs, tokens, cookies, proxy names, or private network addresses into logs or bug reports.

## OpenResty media layer

The public host routes `/_gateway/media/` through a dedicated OpenResty location (see `/www/sites/kellson.dpdns.org/proxy/root.conf` on the gateway host) that adds an image cache and must forward range requests explicitly:

```nginx
location ^~ /_gateway/media/ {
    proxy_pass http://127.0.0.1:1300;
    proxy_set_header Range $http_range;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_cache rsshub_gateway_images;
    proxy_cache_bypass $http_range;
    proxy_no_cache $http_range $rsshub_gateway_skip_image_cache;
}
```

Without `proxy_set_header Range $http_range;`, the range header is dropped at the proxy and the gateway answers every partial request with a full `200` body instead of `206`, which breaks video seeking and forces full downloads on capped links. After editing, run `openresty -t` and reload.

## Upstream behavior

External `GET` and `HEAD` requests use at most three attempts within a 30-second total timeout. Transport errors, timeouts, `408`, `425`, `429`, and `5xx` responses are retried; source authorization and not-found responses are returned without retrying. Three retry-exhausted failures for one source open a 30-second circuit before a single recovery probe is allowed.

Gateway detail routes retain `403` for invalid signed targets. Typed upstream failures return `502`, circuit-open responses return `503` with `Retry-After`, and request deadlines return `504`. Failed responses include `X-Gateway-Source` and `X-Gateway-Attempts`; neither contains source URLs, tokens, or proxy credentials.

## Shared outbound foundation

All site adapters use the gateway's injected `fetchExternal(url, options)` transport. They do not create their own `ProxyAgent`, select Mihomo nodes, or manage retry/concurrency state. Public targets are leased from the adaptive egress pool; sticky targets continue through the fixed authenticated path. The pool filters subscription metadata, probes every lane against the configured public and sticky probe targets on refresh (five-minute probe cache), and only accepts lanes that pass their required scope. A scope passes when any of its probe targets answers `2xx`/`3xx`; if HEAD is rejected (`403`/`405`/`501` or any failure), the probe retries once with GET and discards the body, so bot-guarded sources like Iwara and X no longer disable sticky/session lanes. Probe requests carry an `x-probe-lane` header for diagnostics. Gallery detail pages stripe across the healthy lane set before falling back to least-loaded routing, and lanes are filtered by per-lane `healthyScopes` plus optional per-host scope overrides. Each lane tracks an exponential moving average of successful request latency (clamped samples, preserved across lane refreshes); when loads are tied the pool prefers lower-latency lanes, falling back to round-robin while lanes are still being sampled. This keeps E-Hentai, X, Instagram, Iwara, Telegram, and Pixiv modules on one reusable outbound foundation and allows RSSHub upgrades without source changes.

The foundation exposes only safe transport behavior to modules: target allowlisting, source headers, timeout/retry, circuit policy, egress selection, and response-body lease release. Mihomo Controller details and proxy names remain infrastructure concerns.

### Site-aware egress

Egress health is judged per site, not globally. Each lease records the upstream host on release; repeated `401/403/407/429` responses from one host slide a failure window and temporarily remove the lane from that host's candidate set (emitting `site-blocked`), while a success resets the counter. When every eligible lane is blocked for a host, the pool degrades to the remaining lanes and logs `site-degraded` instead of failing the request. Diagnostics expose per-lane `siteBlocked` host lists and `healthyScopes` on `GET /_gateway/infra`.

## Reusable Subsystem & Infrastructure Utilities

The gateway provides low-level, reusable primitive behaviors and predicates across all modules to ensure zero-redundancy and high composability:

- **HTTP Byte-Range & Partitions (`src/http-utils.js`, `src/media/chunks.js`)**: RFC 7233/9110 parsing with `parseByteRange(rangeHeader, totalBytes)` and structured chunk planning with `planChunks(totalBytes, options)`.
- **Lossless Compression & Content Predicates (`src/http-encoding.js`)**: Edge compression detection via `isCompressibleContentType(contentType)` for text, HTML, XML, JSON, and SVG payloads.
- **Cryptographic Signing & Verification (`src/signed-target.js`, `src/download-lease.js`)**: Constant-time HMAC SHA-256 validation (`isTargetSignatureValid`, `isChunkSignatureValid`) without payload decoding overhead.
- **Circuit Breaker & Failure Tracking (`src/circuit-breaker.js`, `src/infrastructure/site-failure-tracker.js`)**: Sliding-window tracking with full lifecycle controls (`clearAll()`).
- **Resilient Stream & Transport (`src/media/resumable-range.js`, `src/upstream-errors.js`)**: Standardized status assertions (`isResumableStatus`) and client abort diagnostics (`isClientAbortError`).
- **Image Variant Rules (`src/image-variants.js`)**: Supported MIME validation (`isSupportedImageVariantType`) and resolution whitelist assertions (`isValidImageVariantWidth`).
- **Reader Lifecycle & Manifests (`src/reader-manifest.js`)**: Whole-gallery completeness checks (`isManifestComplete`).
- **Background Task Scheduling (`src/infrastructure/poller.js`)**: Periodic jitter task scheduler with dynamic unregistration (`unregister(name)`).
- **Session Affinity & Hash Ring (`src/session-affinity.js`)**: Deterministic HMAC SHA-256 fingerprinting (`fingerprintFor`), credential canonicalization, and consistent lane selection (`chooseLane`).
- **Unified Cache Architecture (`src/cache.js`)**: Key hashing (`keyFor`), namespace canonicalization, and priority eviction constants (`DEFAULT_EVICTION_PRIORITY`).
- **Adapter Ecosystem (`src/adapters/index.js`)**: Source discovery (`getSupportedSourceNames`) and origin matching (`isKnownSourceUrl`).
- **XML/Feed Transforms (`src/feed-transform.js`)**: Entity decoding (`decodeTextEntities`), Unicode normalizer (`normalizeNumericEntities`), and XML code point validation (`isValidXmlCodePoint`).

Probe targets and failure tuning are configurable:

| Environment | Default | Meaning |
| --- | --- | --- |
| `EGRESS_PROBE_TARGETS` | `{"public":["https://e-hentai.org/"],"sticky":["https://www.iwara.tv/","https://x.com/"]}` | JSON object with `public`/`sticky` URL lists and optional `hosts` scope overrides (e.g. `{"i.iwara.tv":"sticky"}`) |
| `EGRESS_SITE_FAILURE_THRESHOLD` | `3` | Blocked responses within the window that trip a lane for a host |
| `EGRESS_SITE_FAILURE_WINDOW_MS` | `60000` | Sliding failure window |
| `EGRESS_SITE_BLOCK_COOLDOWN_MS` | `60000` | How long a tripped lane stays excluded for that host |
| `EGRESS_BLOCKED_STATUSES` | `401,403,407,429` | Statuses counted as site blocks |
| `GATEWAY_SLOW_SOURCE_MS` | `5000` | Per-source request duration threshold in ms; requests at or above it log a `slow_source` warning and increment `rsshub_gateway_slow_source_total` (`0` disables) |
| `EGRESS_PUBLIC_HOSTS` | — | Extra hosts for the public egress policy (comma-separated or JSON array) |
| `EGRESS_PUBLIC_REQUEST_HOSTS` | — | Extra hosts for the public request policy |

Telegram public post details use Telegram's content-bearing embed page. X, Instagram, and Iwara preserve their canonical detail URLs and provide a safe gateway page when an HTML detail request fails instead of rendering an upstream login or error shell.

## Session-aware egress

Public Iwara, Telegram, X, Instagram, E-Hentai ranking, gallery, and media requests start without a source Cookie, token, or `Authorization` header. They are distributed across the public Mihomo pool. A request is upgraded to an authenticated session only after the upstream explicitly signals an authentication challenge: `401`, `403`, a login redirect, or an HTML login page. Timeouts, `429`, and `5xx` responses remain public retry failures and never leak credentials into the public pool.

When a configured source credential is required, the gateway derives an HMAC fingerprint and assigns it to one stable `SESSION_LANE_01..12` listener. For Iwara, the configured refresh token is exchanged for a short-lived access token via `POST api.iwara.tv/user/token` with `Authorization: Bearer` (cached until the JWT `exp`; the refresh token itself is not rotated); session requests and API calls then send the access token, falling back to the configured token if the exchange fails. The Mihomo configuration must define the `SESSION_LANE_01..12` selector groups and one mixed listener per session lane on ports `7921..7932` (see `config/mihomo/config.example.yaml`); without them session lanes cannot be assigned and credentialed requests fail with `502`. The raw credential, its fingerprint, and node names are neither logged nor included in RSS, HTML, signed links, or Git. Session assignment survives a restart through the persistent application cache, while a failed session lane is replaced only after an explicit health failure. Session lanes are also site-aware: blocked statuses from a session response are tracked per (lane, host) with the same threshold and window, and a tripped lane is marked unhealthy, evicted from affinity, and replaced on the next session refresh.

Signed reader links, item pages, media links, and cache entries retain their egress scope. Public cache data is isolated from each `session:<fingerprint>` namespace, preventing anonymous and authenticated responses from being reused across one another. RSS readers keep using their existing RSSHub URL through this gateway; no per-reader proxy configuration or extra subscription is required.

## EhViewer Rankings

The gateway provides public E-Hentai rankings without adding a separate subscription-management step:

```text
https://gateway.example.test/ehviewer/ranking
https://gateway.example.test/ehviewer/ranking/month
https://gateway.example.test/ehviewer/ranking/year
https://gateway.example.test/ehviewer/ranking/all
```

The paths map to yesterday, past month, past year, and all-time rankings respectively; `/ehviewer/ranking/day` is an explicit alias for the daily ranking. The route is served by the **fetcher-eh Sidecar-Fetcher** (separate process, same container) when registered in `gateway-routes.yaml`, and transparently proxied to upstream RSSHub otherwise; sidecar failures fall back to upstream RSSHub. Every item includes its rank, publication time, page count, tags, and proxied cover image in both the RSS description and `content:encoded`, so compatible RSS readers can display the ranking entry directly. Signed gateway reader links remain available for optional full-gallery browsing. Independent media requests retain retries but do not share a host circuit, so one transient thumbnail failure cannot block the rest of the ranking covers. The source is public E-Hentai content and remains subject to source rate limits. Private ExHentai content is not enabled by default.

Ranking item links render one ordered continuous reader page through the signed gateway. The first response uses the cold-start path above, so Flare receives a direct first-image media route without waiting for every pagination, detail page, or media warmup. Detail HTML and media bytes continue to prefetch in the background and are cached for later requests. Failed upstream pages are retained by the background pipeline, and large galleries are bounded by the gateway prefetch limit. Append `?view=gallery` to a signed item URL when a browser thumbnail overview is needed; RSS subscription links do not require this option.

## Low-Level Behavioral Foundations & Reusable Interfaces

All core gateway subsystems export pure functions, type predicates, serialization helpers, and domain constants so upstream callers, sidecars, and external integrations can build upon the low-level behavior without duplicating logic:

- **Egress Routing & Dynamic Selection (`src/egress-policy.js`, `src/mihomo-egress.js`)**:
  - `isPublicEgressTarget(url)`, `isPublicRequestTarget(url)`: Pure predicates for domain-level traffic segregation.
  - `egressPolicyForUrl(url)`, `egressPolicyForRequest(url, opts)`: Declarative policy resolution (`public` vs `sticky`).
  - `isSubscriptionMetadataName(name)`: Subscription node garbage filtering for proxy pool discovery.
  - `laneId(index)`, `laneGroup(index)`, `sessionLaneId(index)`, `sessionLaneGroup(index)`, `listenerUrl(baseUrl, index, port)`: Predictable naming and endpoint formation.
  - `DEFAULT_PROBE_TIMEOUT_MS`, `DEFAULT_PROBE_CACHE_MS`, `PUBLIC_GROUP`, `GROUP_TYPES`, `RESERVED_NAMES`: Egress health probing windows and Mihomo group classifications.
- **Sidecar Routing & Pattern AST Engine (`src/dispatcher.js`)**:
  - `compilePattern(pattern)`: Compiles `/path/:param` into regex with tokenized keys.
  - `matchSegments(compiled, pathname)`: AST segment extraction and parameter mapping.
  - `normalizeRoute(rawRoute)`: Strict schema normalization for sidecar configurations.
  - `sidecarUrl(baseUrl, routePath)`: Safe sidecar reverse-proxy target resolution.
- **Cache Normalization & Cryptographic Keys (`src/cache.js`, `src/options.js`)**:
  - `canonicalUrl(url)`: Deterministic query param sorting and fragment removal.
  - `keyFor(namespace, host, kind, rawUrl)`: SHA-256 stable cache keying.
  - `normalizedNamespace(scope, fingerprint)`: Public vs session scope segregation.
  - `DEFAULT_CACHE_ROOT`, `DEFAULT_EVICTION_PRIORITY`: Standardized `/var/cache/rsshub-gateway` base and weighted tiering for HTML, media, and reader assets.
- **Download Lifecycle & Lease Proxies (`src/download-session.js`, `src/download-lease.js`, `src/lease-proxy.js`)**:
  - `validChunk(chunk)`, `validSession(session, now)`: Strict lifecycle validation predicates.
  - `isChunkSignatureValid(token, secret)`, `isTargetSignatureValid(token, secret)`: Zero-decode HMAC SHA-256 integrity checks.
  - `parseProxyAuth(header)`: Safe Basic Auth decoding.
  - `parseAuthority(value)`: Strict `hostname:port` parsing for HTTP CONNECT tunneling.
- **Browser TLS Workers & Rendering Pipeline (`src/browser-fetch.js`, `src/browser-render.js`)**:
  - `lineError(message, options)`: Typed upstream failure instantiation.
  - `requestTimeoutMs(timeout)`: Adaptive IPC timeout bounds `[25s, 65s]`.
  - `DEFAULT_WORKER_PATH`, `DEFAULT_RENDER_URL`: Zero-config defaults.
- **Unified Request Service & Transport Orchestration (`src/infrastructure/request-service.js`)**:
  - `createRequestService(opts)`: Unified facade combining browser TLS fingerprints and upstream pool dispatchers.
  - `DEFAULT_BROWSER_FETCH_HOSTS`, `parseBrowserFetchHosts(env)`: Configurable list of Cloudflare/WAF-protected domain targets.
  - `safeHost(url)`, `browserFetchHost(url)`: Pure hostname extractors and browser fetch routing predicates.
- **Resilient Media & Feed Prefetchers (`src/media-prefetch.js`, `src/feed-prefetch.js`)**:
  - `originFor(target)`: Whitelist-backed media origin resolution.
  - `retryableStatus(status)`, `successfulStatus(status)`: HTTP status classifiers.
  - `DEFAULT_INITIAL_CONCURRENCY`, `DEFAULT_MAX_CONCURRENCY`, `DEFAULT_PER_ORIGIN_CONCURRENCY`: Tuned concurrency bounds.
- **Session Affinity & Credential Hashing (`src/session-affinity.js`)**:
  - `fingerprintFor(credentials, secret)`: Deterministic SHA-256 hashing preserving zero plaintext.
  - `chooseLane(fingerprint, laneIds)`: Consistent hash-ring candidate selection.
- **HTML Transformation & Enclosure Extractors (`src/feed-transform.js`)**:
  - `decodeEntity(entity)`, `decodeTextEntities(str)`, `normalizeNumericEntities(str)`, `isValidXmlCodePoint(cp)`: Robust XML/HTML entity decoding and code point sanitization.
  - `rewriteHtml(html, transformUrl)`: High-performance streaming image and media tag rewriter.
  - `matchesFilters($, entry, filters)`: Keyword and author blacklist predicate filter.
  - `NAMED_ENTITIES`: XML standard named entity mappings.
- **HTTP Encoding Negotiation & Stream Compression (`src/http-encoding.js`)**:
  - `acceptsCoding(header, coding)`, `acceptsBrotli(header)`, `acceptsGzip(header)`: Safe HTTP `Accept-Encoding` negotiation and quality factor parsing (`q=0`).
  - `isCompressibleContentType(type)`: Safe MIME format text compression predicate.
  - `withVary(headers)`: Idempotent `Vary: Accept-Encoding` response header builder.
  - `COMPRESSIBLE_CONTENT_TYPES`, `DEFAULT_HTML_BROTLI_MIN_BYTES`, `DEFAULT_HTML_BROTLI_QUALITY`: Compression tuning standards.
- **Content Sources, Adapters & Multi-Source Reader Engine (`src/adapters/index.js`, `src/adapters/linuxdo.js`, `src/adapters/ehviewer.js`, `src/adapters/iwara.js`, `src/adapters/pixiv.js`, `src/adapters/telegram.js`, `src/adapters/adult-media.js`, `src/fetchd.js`, `src/reader.js`)**:
  - `adapters`, `defaultAdapter`: Pluggable source adapter registry list and comprehensive fallback strategy object.
  - `MATCH_HOSTS`: Domain array matching standard for each content platform (X, Instagram, Pixiv, Telegram, Iwara, EhViewer).
  - `escapeHtml(value)`: Universal XSS-safe HTML entity escaper.
  - `escapeXml(value)`, `cdata(value)`: Safe XML serializer and CDATA container wrappers.
  - `rewriteCookedHtml(html, opts)`: Discourse topic HTML sanitizer and media gateway link rewriter.
  - `isLinuxdoTopicTarget(url)`, `linuxdoTopicId(url)`: Pure topic route identification and ID extractor.
  - `isTelegramChannelPostUrl(url)`: Telegram post embedding detector (`?embed=1`).
  - `decodeJwtPayload(token)`, `jwtExpiryMs(token, opts)`: Zero-dependency JWT expiry timestamp parser with millisecond TTL calculation.
  - `publicUrl(val, host)`, `asDate(val)`: Safe public URL canonicalizer and UTC ISO date parser.
  - `RANKING_PERIODS`, `MAX_ITEMS`: E-Hentai/EhViewer toplist query configurations and ceiling bounds.
  - `DEFAULT_BASE_URL` (Fetchd Sidecar), `DEFAULT_FETCHD_TIMEOUT_MS`, `MAX_FETCHD_TIMEOUT_MS`, `FETCHD_TIMEOUT_SLACK_MS`, `SITE_BASE` (LINUX DO / Iwara), `API_BASE` (Iwara REST), `DEFAULT_REFERER` (Pixiv): Direct upstream integration bases and browser-fetch timeouts.
  - `ADULT_DOMAINS`, `DEFAULT_USER_AGENT`, `DEFAULT_ACCEPT_LANGUAGE`, `DEFAULT_UNAVAILABLE_MESSAGE`: Standardized adapter error prompts, adult media content routing, and default header profiles.
  - `EH_GALLERY_PATH`, `EH_IMAGE_PATH`, `READER_CSS`, `IMAGE_VARIANT_WIDTHS`: Universal reading engine styles and responsive breakpoints.
  - `isEhentaiPage(url, pattern)`, `extractEhGalleryTitle(opts)`, `extractEhImagePage(opts)`: Pure gallery/image AST parsers.
  - `renderEhGalleryPage(opts)`, `renderEhImagePage(opts)`, `renderGenericReaderPage(opts)`: Responsive reading views.
- **Adaptive Media Transport, Resumable Range & Chunks (`src/media/media-transport.js`, `src/media/resumable-range.js`, `src/media/chunks.js`, `src/image-variants.js`)**:
  - `sliceRanges(start, end, size, opts)`: 64KiB sector-aligned media slice range planner with lookahead.
  - `adaptiveChunkSize(totalBytes, opts)`, `chunkSizeFor(totalBytes, chunks, opts)`, `planChunks(totalBytes, opts)`: Adaptive byte-range partitioning.
  - `pipeAttempt(stream, res, onBytes, onAbort)`: Resilient single stream pump with backpressure (`drain` event pause/resume) and client abort tracking.
  - `isResumableStatus(status)`: HTTP 200/206 status check for range streams.
  - `DEFAULT_RESUMABLE_MAX_ATTEMPTS`, `DEFAULT_RESUMABLE_BACKOFF_MS`: Range streaming error recovery constants.
  - `SLICE_ALIGN`, `MIN_CHUNK_SIZE`, `MAX_CHUNK_SIZE`, `MAX_CHUNKS`: Shared 64KiB alignment and file slicing bounds.
  - `isSupportedImageVariantType(type)`, `isValidImageVariantWidth(w)`, `createImageVariant(opts)`: Lossless Sharp WebP image resizing.
- **Background Tasks, Logging & Infrastructure Schedulers (`src/infrastructure/logger.js`, `src/infrastructure/poller.js`, `src/graceful-shutdown.js`, `src/lease-backfill.js`, `src/infrastructure/site-failure-tracker.js`)**:
  - `createLogger(opts)`, `createNoopLogger()`: Unified structured JSON logger with child context inheritance and zero-breakage error absorption.
  - `redactValue(key, val)`, `redactFields(fields)`: Sensitive field automatic redaction (passwords, tokens, cookies, auth headers).
  - `LOG_LEVELS`, `DEFAULT_LOG_LEVEL`: Standard log level threshold dictionary (`debug` to `error`).
  - `createPoller(opts)`: Periodic background task execution with jitter to prevent thundering herds.
  - `createSiteFailureTracker(opts)`, `failureKey(laneId, host)`: Sliding-window per-host failure detection and circuit trip coordinator.
  - `installGracefulShutdown(opts)`: Connection draining and signal trapping for zero-downtime restarts.
  - `createLeaseBackfillQueue(opts)`: Background slice cache warmer for video download leases.
  - `DEFAULT_POLLER_INTERVAL_MS`, `DEFAULT_POLLER_JITTER_RATIO`, `DEFAULT_SHUTDOWN_TIMEOUT_MS`, `DEFAULT_MAX_CONCURRENCY`: Infrastructure operational defaults.
- **Resilient Request Pipeline, Upstream & Circuit Breakers (`src/upstream.js`, `src/circuit-breaker.js`, `src/signed-target.js`, `src/infrastructure/request-service.js`, `src/upstream-errors.js`)**:
  - `CIRCUIT_STATE_CLOSED`, `CIRCUIT_STATE_OPEN`, `CIRCUIT_STATE_HALF_OPEN`: Standard tri-state circuit breaker identifiers.
  - `DEFAULT_FAILURE_THRESHOLD`, `DEFAULT_COOLDOWN_MS`: Circuit breaker tripping thresholds and cooldown windows.
  - `isRetryableStatus(status)`, `isSuccessfulStatus(status)`, `isClientAbortError(err)`: Standard HTTP status classifiers and client disconnect predicates.
  - `RETRYABLE_STATUSES`, `DEFAULT_BLOCKED_STATUSES`: Unified set definitions for transient retryable codes (408/425/429) and egress blocking codes.
  - `GatewayUpstreamError`: Structured error class capturing retry attempts, source name, status code and `retryAfter` payload.
  - `encode(value)`, `decode(value)`, `base64UrlEncode(value)`, `base64UrlDecode(value, fallback)`: High-performance Base64URL string serializers and decoders.
  - `routeMetadata(metadata)`: Route scope and source validation parser.
  - `DEFAULT_PROXY`, `DEFAULT_TIMEOUT`, `DEFAULT_MAX_ATTEMPTS`, `MAX_REDIRECTS_PER_ATTEMPT`: Upstream proxy and timeout foundations.
  - `isRetryableStatus(status)`, `isSuccessfulStatus(status)`, `isClientAbortError(error)`: Status code predicates and client disconnection detectors.
  - `HOTLINK_REFERERS`, `refererFor(url)`: Anti-hotlinking CDN source referer resolution table.
  - `withoutCredentials(headers)`, `isAuthenticationRedirect(res)`, `isAuthenticationChallenge(res, url, cb)`: Security boundary credentials stripping and challenge detection.
  - `safeHost(url, fallback)`, `isHostOrSubdomain(hostname, base)`, `matchesHost(hostname, hosts)`, `parseHostList(value)`, `parseStatusList(value, fallback)`: Safe URL host normalizer, subdomain matchers, JSON/CSV host list and HTTP status code parser.
  - `browserFetchHost(url)`: TLS browser fingerprint route classifier.
- **Dynamic Microservice Frameworks, Gateways & Server Utilities (`src/fetcher-server.js`, `src/server.js`, `src/request-handler.js`, `src/gallery-benchmark.js`, `src/http-utils.js`)**:
  - `DEFAULT_FETCHER_PORT`, `DEFAULT_FETCHER_HOST`: Sidecar standalone server defaults (`8000` / `0.0.0.0`).
  - `registerDispatcherRoutes(opts)`, `unregisterDispatcherRoutes(opts)`: Sidecar lifecycle self-registration and teardown with backoff.
  - `HttpError`, `readRequestBody(req)`, `readJsonBody(req)`: Standard HTTP status error wrapper and raw/JSON payload buffer readers.
  - `isBearerAuthorized(reqOrHeader, token)`: Constant-time Bearer token authorization validator.
  - `routeBucket(pathname)`: Fast prefix-based route category bucket parser for Prometheus and logging segregation.
  - `initialEhGalleryManifest(opts)`: Pure cold-start gallery preview manifest constructor.
  - `DEFAULT_READ_LIMIT_BYTES`, `IMAGE_VARIANT_CACHE_VERSION`, `IMAGE_VARIANT_WIDTHS`, `SUPPORTED_IMAGE_VARIANT_TYPES`: HTTP response parsing safety ceiling, WebP cache versioning and responsive variant specifications.
  - `isValidImageVariantWidth(width)`, `isSupportedImageVariantType(contentType)`: Responsive media variant dimensions and MIME type validators.
  - `clamp(value, min, max)`, `positiveInteger(value, fallback)`, `nonNegativeInteger(value, fallback)`, `boundedInteger(value, fallback, min, max)`: Pure numeric bounds clampers and safe integer parsers.
  - `dedupe(items, keyMapper)`: Pure array/collection deduplication preserving original sequence order.
  - `sleep(ms)`: High-precision promise-based sleep delay helper with negative-value absorption.
  - `withDeadline(promise, timeoutMs, fallback)`: Generic promise execution bounded by a hard millisecond timeout.
  - `parseByteRange(value, size)`: RFC 7233 byte range parser with unsatisfiable range detection.
  - `normalizeHeaderMap(headers)`, `canonicalHeadersString(headers)`: Deterministic HTTP header/credential normalization and canonical serialization.
  - `atomicWriteJson(file, data, opts)`, `safeJsonParse(value, fallback)`: Crash-resilient POSIX atomic JSON writer and non-throwing safe JSON deserializer.
  - `sha256Hex(value)`, `hmacSha256(value, secret, encoding)`, `isSha256Hex(value)`: High-performance cryptographic digest serializers and 64-char lowercase hex validators.
  - `isSignatureMatch(actual, expected)`, `constantTimeEquals(left, right)`: Timing-safe cryptographic signature and credential verifiers.
  - `safeEvent(onEvent, event)`: Non-intrusive event emitter wrapper absorbing runtime listener failures.
  - `failureMessage(kind, pageNumber)`, `cleanText(value)`: Standardized multilingual gallery degradation messaging and text whitespace normalizer.
  - `escapeHtml(value)`, `escapeXml(value)`, `cdata(value)`: Standardized DOM entity and XML/CDATA payload encoders.
  - `isValidXmlCodePoint(codePoint)`, `decodeEntity(entity)`, `decodeTextEntities(value)`, `normalizeNumericEntities(xml)`, `XML_NAMED_ENTITIES`: XML standard code point validators and numeric/named entity decoders and normalizers.
  - `downloadSessionView(session)`, `withPrefetchStatus(view, target, status)`: Pure state session projection for download managers.
  - `promLabel(value)`, `sourceMetricName(source)`: Prometheus metrics and duration histogram label sanitizers.
  - `mapWithConcurrency(items, concurrency, worker)`, `durationCheckpoint(results, count)`: Concurrency-bounded streaming executor and latency percentile checkpoints.
  - `align64k(value)`, `ALIGN_64K`: 64 KiB boundary memory and byte-range slice aligners.
  - `publicLeaseView(lease, opts, now)`, `isChunkSignatureValid(token, secret)`, `DEFAULT_LEASE_TTL_MS`, `DEFAULT_LEASE_MAX_BYTES`, `DEFAULT_LEASE_MAX_CONCURRENCY`: Download proxy lease projection, chunk token HMAC signature validation and lease quota defaults.
  - `tileStyle(tile)`, `tileImage(tile, className, alt, loading)`, `EH_METADATA_LABELS`: Thumbnail sprite tile styling, localized metadata mappings and lazy image element builder.
  - `isEhentaiPage(url, pattern)`, `isEhImagePageTarget(url)`, `EH_GALLERY_PATH`, `EH_IMAGE_PATH`: E-Hentai gallery and reader image target page URL matchers and route regex patterns.
  - `mediaSrcset(media, widths)`, `numericStyle(style, property, fallback)`: Responsive image candidate set generator and CSS pixel style numeric bounds clamper.
  - `compilePattern(routeId)`, `normalizeRoute(raw)`, `matchSegments(pattern, segments)`, `sidecarUrl(backend)`: Zero-overhead dynamic segment route compiler, config normalizer, path matcher, and sidecar backend URL resolver.
  - `cookiesObject(cookies)`, `resolveRedirect(template, params)`: Cookie header normalizer and dynamic URL redirection template resolver.

## Rollback

Change the OpenResty upstream in `root.conf` from `http://127.0.0.1:1300` back to `http://127.0.0.1:1200`, test with `openresty -t`, and reload OpenResty. The old Mihomo configuration is retained under `/opt/1panel/apps/mihomo` for recovery.
