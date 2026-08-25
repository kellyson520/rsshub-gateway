# Gateway Media Cache

## Goal

Make Iwara and other gateway-proxied thumbnails reliable in RSS readers by caching successful image responses locally. Limit persistent cache storage to 5 GB without changing RSS feed behavior or video playback semantics.

## Decision

OpenResty will own the cache because it is already the public edge and can serve repeat image requests without invoking the Node gateway or its outbound Mihomo proxy.

The gateway will issue one deterministic signed media URL per target per cache day. This keeps the HMAC target validation while ensuring that a refreshed feed refers to the same OpenResty cache key instead of creating a fresh cache entry for the same thumbnail.

An HTTP-level configuration file will define a `proxy_cache_path` under the existing `/www` host mount. The 5 GB limit therefore persists across OpenResty container restarts. The cache will keep entries for up to seven inactive days and evict older entries when it reaches its size limit.

The site proxy configuration will add a more-specific `/_gateway/media/` location. It will use the same upstream and forwarding headers as the existing catch-all proxy location.

## Cache Policy

- Cache only `200` responses whose upstream `Content-Type` begins with `image/`.
- Cache entries for seven days, with request coalescing enabled so concurrent readers do not all fetch the same thumbnail.
- Send `Cache-Control: public, max-age=86400` for image responses, allowing readers such as Flare to reuse a fetched thumbnail for one day.
- Send `Cache-Control: no-store` for non-image media.
- Do not cache any request carrying `Range`; this preserves video seeking and prevents partial video content from occupying the image cache.
- Expose `X-Cache` on media responses so `HIT`, `MISS`, and `BYPASS` can be verified externally.

## Alternatives Considered

1. Cache every media response: increases hit rate but risks filling the 5 GB allocation with large videos and makes Range behavior harder to reason about.
2. Cache inside the Node gateway: enables target-aware keys but adds storage lifecycle and concurrency complexity to the application.
3. Cache only images at OpenResty: selected because thumbnails are the reported failure, it preserves video streaming, and OpenResty already provides eviction and locking.

## Error Handling And Verification

Failed upstream responses, redirects, videos, and range requests will not be stored. The OpenResty configuration test must pass before reload. Verification will request the same valid thumbnail twice and confirm the first response is `MISS`, the second is `HIT`, both are JPEG responses, and image responses no longer contain `Cache-Control: no-cache`.
