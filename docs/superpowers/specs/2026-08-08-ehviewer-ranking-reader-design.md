# EhViewer Ranking Reader Design

**Date:** 2026-08-08

## Goal

Add first-class EhViewer/E-Hentai ranking feeds to the RSSHub companion gateway and make each gallery readable online through the existing signed detail and media proxy routes.

## Scope

The feature targets the public E-Hentai site used by EhViewer. It adds four gateway feed paths:

- `/ehviewer/ranking` - yesterday's view ranking (`tl=11`)
- `/ehviewer/ranking/month` - monthly view ranking (`tl=12`)
- `/ehviewer/ranking/year` - yearly view ranking (`tl=13`)
- `/ehviewer/ranking/all` - all-time view ranking (`tl=15`)

The gateway will fetch and parse the public E-Hentai toplist page, emit RSS 2.0 entries whose links point to E-Hentai galleries, and let the existing feed transformer rewrite those links to signed local gateway URLs. No new RSS subscription-management step is introduced.

The existing RSSHub E-Hentai search, tag, and favorites routes remain unchanged. This feature does not add account login, favorites mutation, torrent downloads, or gallery content mirroring.

## Architecture

### Ranking source adapter

Create a focused E-Hentai adapter module responsible for:

- mapping the four public route names to the E-Hentai `toplist.php` `tl` values;
- validating that only the expected E-Hentai toplist URL is fetched;
- parsing gallery rows into title, canonical gallery URL, published date when present, thumbnail, and category metadata;
- emitting a bounded RSS document with XML-safe text and CDATA descriptions.

The adapter will use the existing upstream client, so proxy selection, timeout, retries, circuit handling, and typed errors remain centralized. The parser will use Cheerio, matching the existing feed and reader code.

### Gateway routing

Handle `/ehviewer/ranking` and its period variants before the normal RSSHub proxy route. The route will call the adapter, transform generated gallery links and media links through the existing signing logic, and return `application/rss+xml` with a short cache policy appropriate for rankings.

The existing `/_gateway/item/:token` path will recognize E-Hentai gallery URLs through a source adapter. It will fetch the canonical gallery page, sanitize its HTML, rewrite gallery and page links to signed gateway item URLs, and rewrite allowed thumbnail/full-image URLs to signed media URLs. The original gallery URL remains visible as the source link.

### Allowed hosts

Add only the hosts required by public E-Hentai pages:

- `e-hentai.org` and its subdomains for toplists, galleries, and gallery pages;
- `ehgt.org` and its subdomains for E-Hentai thumbnail/image assets;
- `exhentai.org` and its subdomains only if the public gallery response uses them.

The signed-target validator remains the final boundary. No arbitrary image host or redirect target is accepted.

### Content handling

E-Hentai gallery pages may lazy-load images through `data-src` or equivalent attributes. The reader sanitizer will preserve only safe image attributes and normalize supported lazy-load attributes into signed media URLs before sanitization. Gallery navigation links remain signed item links, allowing the reader to move through the gallery without leaving the gateway.

If the source returns a login, denial, or non-HTML error page, the existing safe unavailable-page renderer will be used. Credentials, cookies, and upstream URLs with private query values are never included in responses or logs.

## Error and cache behavior

- Upstream failures use the existing typed `502`/`503`/`504` mapping and retry policy.
- A route-level E-Hentai `403` or `429` is returned as an unavailable source response and does not bypass target validation.
- Ranking responses may be cached by the existing OpenResty cache; the gateway itself will not add an unbounded in-memory cache.
- Generated feeds are bounded to the source result set and reject oversized HTML before rendering.

## Testing

Add deterministic tests for:

- period-to-`tl` mapping and unknown-period rejection;
- parsing representative E-Hentai toplist rows into valid RSS entries;
- XML escaping and signed item/media link transformation;
- E-Hentai host allowlisting and redirect rejection;
- lazy-loaded gallery images becoming signed media URLs;
- safe fallback rendering for blocked or non-success HTML;
- the gateway route using injected upstream responses without external network access.

Production acceptance will verify the four feed paths, at least three gallery detail links, one gallery image range request returning `206`, `/readyz`, and that existing Telegram/Iwara feeds remain unaffected.

## Non-goals

- scraping private ExHentai content without user-provided runtime credentials;
- downloading or caching complete galleries in the gateway;
- adding a new web UI or subscription database;
- changing RSSHub's own route implementation.
