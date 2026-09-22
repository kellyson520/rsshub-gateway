# RSSHub Gateway Container Log Diagnosis & Improvement Plan

**Date:** 2026-04-20  
**Container:** `rsshub-gateway` & `1Panel-rsshub-JhSx` (RSSHub upstream)  
**Status:** Diagnosed & Root-Cause Verified

## 1. Recurring Log Signatures Observed

1. `{"event":"sidecar_route_failure","level":"error","routeId":"/javbus/home/:page?","error":"sidecar returned 404"}` (recurring continuously every prefetch cycle)
2. Cascading upstream failures:
   ```
   Request https://www.javbus.com fail: Error: Client network socket disconnected before secure TLS connection was established TypeError: fetch failed
   Error in /javbus/home: FetchError: [GET] "https://www.javbus.com": <no response> fetch failed
   ```
3. `{"event":"slow_source","level":"warn","source":"netflav"|"jable"|"missav"}` due to heavy JS rendering / CF challenge delays.

## 2. Root Cause Analysis

When `/javbus/home` is prefetched or requested by clients:
1. **Invalid Target URL Construction:**
   - In `sidecar/fetcher-javbus/fetcher.js`, `javbusTarget('/javbus/home/:page?', ...)` constructed `${base}/home` (and `${base}/home/${page}`).
   - JavBus has no `/home` route. `https://www.javbus.com/home` returns HTTP 404 (`404 Page Not Found! - JavBus`).
   - The real JavBus index route is `https://www.javbus.com/` for page 1, and `https://www.javbus.com/page/${page}` for page > 1.
   - Similarly:
     - `/javbus/censored/:page?`: constructed `${base}/censored/home${pageStr}` which is 404. It should be `${base}${page > 1 ? `/page/${page}` : ''}`.
     - `/javbus/uncensored/:page?`: constructed `${base}/uncensored/home${pageStr}` which is 404. It should be `${base}/uncensored${page > 1 ? `/page/${page}` : ''}`.
2. **Missing Adult Verification & Filter Cookies:**
   - JavBus requires cookies `dv=1; age=verified; existmag=all` on requests; without `dv=1; age=verified`, JavBus presents the adult driver-verify quiz page instead of the movie listing.
   - In `sidecar/fetcher-javbus/server.js`, `browserFetch.fetch(url)` was called with no default cookies or headers, causing empty `.movie-box` extractions and throwing `HttpError(404, 'no videos found')`.
3. **Cascading Route Failure:**
   - Because `sidecar` returned 404, `request-handler.js` logged `sidecar_route_failure` and fell back to upstream RSSHub (`fallback_upstream: true`).
   - Upstream RSSHub (`1Panel-rsshub-JhSx`) running in a separate container does not have Cloudflare TLS bypass / browser fingerprint impersonation or Mihomo egress routing, causing immediate TLS socket disconnections.

## 3. Improvement Strategy

1. **Update `sidecar/fetcher-javbus/fetcher.js`:**
   - Map `/javbus/home/:page?` to `${base}${page > 1 ? `/page/${page}` : ''}`.
   - Map `/javbus/censored/:page?` to `${base}${page > 1 ? `/page/${page}` : ''}`.
   - Map `/javbus/uncensored/:page?` to `${base}/uncensored${page > 1 ? `/page/${page}` : ''}`.
   - Provide default cookie constant: `DEFAULT_JAVBUS_COOKIE = 'dv=1; age=verified; existmag=all'`.
   - Pass cookie header in `fetcher.js` request if not already provided.
2. **Update `sidecar/fetcher-javbus/server.js`:**
   - Pass default cookies and standard browser user-agent in `fetchHtml`.
3. **Update & Expand Unit/Regression Tests:**
   - Update `test/fetcher-javbus.test.js` to assert the correct JavBus URLs and test headers / cookies.
4. **Rebuild / Restart Container & Verify:**
   - Verify that `/fetch` on `fetcher-javbus` succeeds with 200 and returns valid RSS with movie items.
   - Verify that `/javbus/home` on the gateway server succeeds with 200 without falling back to upstream or generating `sidecar_route_failure`.
