# E-Hentai Gallery End-to-End Acceleration Design

## Goal

Make continuous E-Hentai galleries faster from reader click through later-page scrolling without changing RSS subscription URLs or requiring reader configuration. The design combines visual-quality-preserving image derivatives, server-side pipeline warming, native HTTP compression, and browser-native rendering hints.

The target is lower time to usable first page and lower bytes transferred while scrolling the full gallery. A fixed percentage is not guaranteed: source latency, source image dimensions, reader bandwidth, and cache state determine the observed improvement.

## Non-Goals

- Do not overwrite or delete the upstream source image while creating a derivative.
- Do not send tokens, cookies, proxy data, or image source URLs to the reader.
- Do not use JavaScript image decoders, archive formats, or a second RSS subscription.
- Do not transform range requests, video, animated images, or unsupported media types.

## Quality Policy

The gateway keeps the original media cache entry as the fallback. It may create a WebP reading derivative only when all conditions hold:

- The request is for a supported still image (`image/jpeg`, `image/png`, or non-animated `image/webp`).
- The requested width is one of `1280`, `1920`, or `2560` pixels and never enlarges an image.
- The source body is at most the existing 32 MiB media limit.
- WebP uses `quality=92`, `nearLossless=true`, `effort=4`, and `smartSubsample=false`.
- The derivative is smaller than the original image bytes.

If decoding, resizing, encoding, size comparison, or cache storage fails, the gateway serves the original image. This makes image optimization opportunistic and preserves the source rendering path. "Visual quality" means the high-quality WebP setting above; pixel-exact output is not claimed for a lossy derivative.

## Media Variants

`/_gateway/media/<signed-token>?w=<width>` requests a bounded reading derivative. The width is validated against the fixed set, is not forwarded upstream, and is included in a separate cache key. The signed target continues to authenticate the source target and its routing scope.

The reader emits a `srcset` for `1280w`, `1920w`, and `2560w` variants, with `sizes="(min-width:1120px) 1120px, 100vw"`. The ordinary `src` remains the original-media URL, so clients without `srcset` support retain the source image. Public variants are stored in the public cache namespace. Session-scoped variants use the existing session namespace and receive only private cache headers.

Variant work is CPU-bound and uses an independent default concurrency of 2. It is not allowed to consume the media prefetch queue's outbound slots. Large source bodies and unsupported formats bypass transformation.

## Gallery Pipeline

Today the gallery waits for every image-detail page, then starts later media warming. The new pipeline starts background warming as each detail page resolves:

1. Gallery pagination and image-detail pages remain distributed through public egress shards.
2. The first configured reader pages stay reserved for foreground warming.
3. Each later resolved image target is immediately added to the persistent media queue.
4. The page is still emitted in original page-number order after detail parsing finishes.
5. The reader uses eager/high priority only for the foreground set. Later images stay lazy with asynchronous decoding and render containment.

This overlaps upstream detail discovery, image downloading, image variant construction, cache writes, and client scrolling without unbounded downloads. Queue deduplication and cache single-flight loading prevent the foreground and background paths from downloading the same image twice.

## HTML Compression

Reader HTML and gallery manifests of at least 4 KiB are encoded with Brotli quality 4 when the request advertises `br` support and the compressed body is smaller. Responses include `Content-Encoding: br` and `Vary: Accept-Encoding`; requests without Brotli support receive the original payload. Browsers and WebViews perform native decompression, so no reader-side JavaScript decompression is required.

Image responses are never wrapped in HTTP content encoding. Images already use a native image codec, and additional HTTP compression would waste CPU without materially reducing transfer bytes.

## Failure Handling

- An image transformation error, timeout, cache-full condition, or oversize output falls back to the original proxied image.
- A background warming failure records normal queue retry state and never fails the reader HTML response.
- Failed image-detail pages remain visible as the existing per-page warnings.
- Existing public/session namespace isolation applies to originals and variants alike.

## Tests And Measurement

Tests cover variant width validation, original fallback, source-size comparison, session cache isolation, `srcset` markup, early queueing while later details are still pending, and Brotli negotiation/fallback headers.

Deployment verification measures one public gallery at four points: reader HTML response, first eight images ready, 25% pages cached, and all available pages cached. It records byte totals and completion time without logging signed URLs, source URLs, credentials, or proxy details.
