# EhViewer Single-Page Reader Design

**Date:** 2026-08-08

## Goal

Make a clicked public E-Hentai gallery entry readable in Flare and other RSS readers as one full-size image at a time. The reader must stay on the signed gateway for images and navigation, without client-side proxy settings, custom subscriptions, or changes to RSSHub.

## Problem

The gateway's gallery renderer emits every thumbnail as a real `<img>` so Flare's Readability extraction preserves the images. Flare then renders all thumbnails as one vertical article. The existing E-Hentai image-page renderer already produces one proxied full-size image with signed previous and next links.

## Chosen Design

For a signed E-Hentai gallery item URL without `view=gallery`, the gateway will:

1. Fetch the verified gallery page as it does today.
2. Extract and validate the first `/s/<token>/<page>` image-page link from `#gdt > a[href]`.
3. Fetch that first image page through the existing upstream client.
4. Render the existing one-image reader page, including signed media, `上一页`, and `下一页` links.

The client receives ordinary HTML, not a reader-specific redirect or a user-agent-dependent response. The same item link works consistently in Flare, browser webviews, and other RSS readers.

Appending `?view=gallery` preserves the current semantic gallery preview grid for browser inspection. This option is intentionally outside the RSS workflow; transformed feed links keep their existing clean signed URL and therefore open the single-page reader by default.

## Boundaries And Errors

- The E-Hentai adapter owns recognition and extraction of E-Hentai gallery/image URLs. It validates the extracted link is an HTTPS E-Hentai `/s/` path before the server fetches it.
- The gateway continues to own signed URLs, proxy routing, response sanitization, image access, retries, timeouts, and circuit behavior.
- RSSHub remains unmodified and continues to own route parsing and optional source credentials.
- If a gallery page has no valid first image link, the gateway returns the existing gallery renderer rather than manufacturing an unsafe target or failing an otherwise usable page.
- If the first image request fails, existing typed upstream errors and unavailable-page handling remain in effect.

## Tests

Add deterministic tests for:

- extracting only a valid first E-Hentai image-page URL from a gallery page;
- opening a signed gallery item as a single full-size image page and requesting the gallery then its first image page;
- retaining signed previous/next navigation and proxied media URLs;
- keeping `?view=gallery` on the structured thumbnail preview route without a second upstream request;
- preserving the existing test suite for ranking feeds and other source adapters.

## Non-Goals

- Detecting Flare by User-Agent or depending on application-specific headers.
- Serving every gallery image in a single article.
- Altering RSSHub source code, token handling, or subscriptions.
- Adding ExHentai private-content support or a gallery download/cache feature.
