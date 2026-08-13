import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { transformFeed } from './feed-transform.js';
import { verifySignedTarget } from './signed-target.js';
import { GatewayUpstreamError } from './upstream-errors.js';
import { adapterForUrl } from './adapters/index.js';
import { parseRankingHtml, rankingTarget, renderRankingFeed } from './adapters/ehviewer.js';
import { renderReaderPage, renderUnavailablePage } from './reader.js';
import { createInitialReaderManifest, mergeResolvedPage } from './reader-manifest.js';
import { createSignedChunk, verifySignedChunk } from './download-lease.js';
import { chunkSizeFor } from './media/chunks.js';
import { encodeHtmlResponse } from './http-encoding.js';
import {
  fetchCachedDocument,
  isEhImagePageTarget,
  mediaFileName,
  publicBaseUrl,
  readLimited,
  requestedImageVariantWidth,
  writeBuffer,
  writeGatewayError,
  writeJson,
  writeText,
} from './http-utils.js';
import {
  fetchIwaraUser,
  fetchIwaraVideoDetail,
  fetchIwaraVideos,
  isIwaraVideoTarget,
  iwaraVideoId,
  renderIwaraFeed,
  renderIwaraReaderPage,
} from './adapters/iwara.js';

function sourceMetricName(source) {
  const name = String(source || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 32);
  return name ? `source_${name}_duration_seconds` : null;
}

export function createRequestHandler(deps) {
  const {
    cache,
    cacheNamespaceFor,
    client,
    currentEhPrefetchConcurrency,
    discoverCachedEhGallery,
    discoverEhGallery,
    egressAdapter,
    egressPool,
    egressProbeTargets,
    ehColdStartEnabled,
    ehFirstDetailBudgetMs,
    ehFirstPaintCount,
    ehMaxPrefetchPages,
    ehMediaForegroundWarmConcurrency,
    ehMediaForegroundWarmCount,
    fetchCachedMedia,
    fetchExternal,
    fetchExternalDocument,
    fetchGatewayDocument,
    fetchGatewayMedia,
    fetchJsonViaFetchd,
    fetchResolvedEhMedia,
    fetchRssHub,
    htmlBrotliMinBytes,
    htmlBrotliQuality,
    histogramBucketsMs,
    histograms,
    initialEhGalleryManifest,
    iwaraToken,
    leaseBackfillQueue,
    leaseMaxBytes,
    leaseMaxConcurrency,
    leaseProxy,
    leaseProxyBoundPort,
    leaseProxyPublicUrl,
    leaseStore,
    leaseTtlMs,
    logger,
    mediaBrowserCacheSeconds,
    mediaCacheMaxFileBytes,
    mediaPreloadQueue,
    mediaSizeFor,
    metricCounts,
    poller,
    prefetchEhGallery,
    recordDuration,
    recordMetric,
    resolveForegroundEhPage,
    resolveIwaraVideo,
    routeBucket,
    secret,
    signedTargetMetadata,
    videoCacheMaxFileBytes,
    warmEhMedia
  } = deps;
  async function handleRequest(req, res, attribution) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      writeText(res, 405, 'method not allowed\n');
      return;
    }
    const requestStartedAt = Date.now();
    const requestUrl = new URL(req.url || '/', 'http://gateway.internal');
    const requestId = String(req.headers['x-request-id'] || crypto.randomUUID()).slice(0, 64);
    res.setHeader('x-request-id', requestId);
    recordMetric('gateway_request', { path: requestUrl.pathname });
    recordMetric(`route_${routeBucket(requestUrl.pathname)}`, { path: requestUrl.pathname });
    if (requestUrl.pathname === '/healthz') {
      writeText(res, 200, 'ok\n');
      return;
    }
    if (requestUrl.pathname === '/readyz') {
      try {
        const rsshub = await fetchRssHub('/healthz', { timeout: 3_000 });
        const body = await readLimited(rsshub, 16 * 1024);
        const rsshubReady = rsshub.ok && body.trim() === 'ok';
        const egress = egressAdapter?.verifyGroups ? await egressAdapter.verifyGroups() : null;
        const egressLanes = egress ? egressAdapter.lanes().length : 0;
        const egressReady = egress ? egress.ready && egressLanes > 0 : true;
        const ready = rsshubReady && egressReady;
        const payload = {
          ready,
          rsshub: rsshubReady ? 'ok' : 'unavailable',
          ...(egress ? {
            egress: {
              ready: egressReady,
              lanes: egressLanes,
              sessionLanes: egressAdapter.sessionLanes().length,
              missingGroups: egress.missing,
            },
          } : {}),
          openCircuits: client.openCircuits?.() || [],
        };
        writeJson(res, ready ? 200 : 503, payload);
      } catch {
        writeJson(res, 503, { ready: false, rsshub: 'unavailable', openCircuits: client.openCircuits?.() || [] });
      }
      return;
    }
    if (requestUrl.pathname === '/_gateway/metrics') {
      const cacheStats = cache ? cache.stats() : null;
      const egressStats = egressPool.stats();
      const backfillStats = leaseBackfillQueue ? leaseBackfillQueue.stats() : null;
      const lines = [
        '# TYPE rsshub_gateway_requests_total counter',
        `rsshub_gateway_requests_total ${metricCounts.get('gateway_request') || 0}`,
        '# TYPE rsshub_gateway_cache_hits_total counter',
        `rsshub_gateway_cache_hits_total ${cacheStats?.counters?.hits || 0}`,
        '# TYPE rsshub_gateway_cache_misses_total counter',
        `rsshub_gateway_cache_misses_total ${cacheStats?.counters?.misses || 0}`,
        '# TYPE rsshub_gateway_cache_bytes gauge',
        `rsshub_gateway_cache_bytes ${cacheStats?.bytes || 0}`,
        '# TYPE rsshub_gateway_cache_entries gauge',
        `rsshub_gateway_cache_entries ${cacheStats?.entries || 0}`,
        '# TYPE rsshub_gateway_egress_lanes gauge',
        `rsshub_gateway_egress_lanes ${egressStats.lanes?.length || 0}`,
        '# TYPE rsshub_gateway_egress_active gauge',
        `rsshub_gateway_egress_active ${egressStats.active || 0}`,
        '# TYPE rsshub_gateway_egress_session_lanes gauge',
        `rsshub_gateway_egress_session_lanes ${egressAdapter?.sessionLanes?.().length || 0}`,
        '# TYPE rsshub_gateway_egress_degraded gauge',
        `rsshub_gateway_egress_degraded ${egressAdapter?.stats?.()?.degraded ? 1 : 0}`,
      ];
      for (const [metric, count] of metricCounts) {
        if (/^[a-z0-9_]+$/.test(metric)) {
          lines.push(`# TYPE rsshub_gateway_${metric}_total counter`);
          lines.push(`rsshub_gateway_${metric}_total ${count}`);
        }
      }
      for (const [metric, entry] of histograms) {
        if (!/^[a-z0-9_]+$/.test(metric)) continue;
        lines.push(`# TYPE rsshub_gateway_${metric} histogram`);
        for (const bucketMs of histogramBucketsMs) {
          const le = (bucketMs / 1000).toFixed(3);
          lines.push(`rsshub_gateway_${metric}_bucket{le="${le}"} ${entry.buckets.get(bucketMs) || 0}`);
        }
        lines.push(`rsshub_gateway_${metric}_bucket{le="+Inf"} ${entry.count}`);
        lines.push(`rsshub_gateway_${metric}_sum ${(entry.sumMs / 1000).toFixed(6)}`);
        lines.push(`rsshub_gateway_${metric}_count ${entry.count}`);
      }
      if (backfillStats) {
        lines.push('# TYPE rsshub_gateway_lease_backfill_completed counter');
        lines.push(`rsshub_gateway_lease_backfill_completed ${backfillStats.completed}`);
        lines.push('# TYPE rsshub_gateway_lease_backfill_failed counter');
        lines.push(`rsshub_gateway_lease_backfill_failed ${backfillStats.failed}`);
        lines.push('# TYPE rsshub_gateway_lease_backfill_skipped counter');
        lines.push(`rsshub_gateway_lease_backfill_skipped ${backfillStats.skipped}`);
        lines.push('# TYPE rsshub_gateway_lease_backfill_bytes gauge');
        lines.push(`rsshub_gateway_lease_backfill_bytes ${backfillStats.bytesFilled}`);
      }
      writeText(res, 200, `${lines.join('\n')}\n`, 'text/plain; version=0.0.4; charset=utf-8');
      return;
    }
    if (requestUrl.pathname === '/_gateway/infra') {
      const memory = process.memoryUsage();
      writeJson(res, 200, {
        uptimeMs: Math.round(process.uptime() * 1000),
        memory: {
          rss: memory.rss,
          heapUsed: memory.heapUsed,
          heapTotal: memory.heapTotal,
        },
        poller: poller.stats(),
        cache: cache ? cache.stats() : null,
        egress: {
          ...egressPool.stats(),
          probeTargets: egressProbeTargets,
          adapter: egressAdapter?.stats?.() || null,
        },
        leases: leaseStore.stats(),
        leaseBackfill: leaseBackfillQueue ? leaseBackfillQueue.stats() : null,
        circuits: client.circuitStats ? client.circuitStats() : { openKeys: client.openCircuits?.() || [] },
        metrics: Object.fromEntries(metricCounts),
        histograms: Object.fromEntries([...histograms].map(([metric, entry]) => [
          metric,
          {
            count: entry.count,
            sumMs: entry.sumMs,
            buckets: Object.fromEntries(entry.buckets),
          },
        ])),
        limits: {
          leaseTtlMs,
          leaseMaxBytes,
          leaseMaxConcurrency,
          mediaCacheMaxFileBytes,
          videoCacheMaxFileBytes,
        },
      });
      return;
    }
    const rankingMatch = requestUrl.pathname.match(/^\/ehviewer\/ranking(?:\/(month|year|all))?$/);
    if (rankingMatch) {
      const period = rankingMatch[1] || 'day';
      try {
        const remote = await fetchExternalDocument(rankingTarget(period), undefined, 'html');
        if (!remote.ok) {
          writeText(res, remote.status, 'source unavailable\n');
          return;
        }
        const body = await readLimited(remote);
        const feed = renderRankingFeed(parseRankingHtml(body, { period }));
        const output = transformFeed(feed, {
          baseUrl: publicBaseUrl(req),
          selfUrl: `${publicBaseUrl(req)}${requestUrl.pathname}${requestUrl.search}`,
          secret,
          signedTargetMetadata: { egressScope: 'public' },
        });
        writeText(res, 200, output, 'application/rss+xml; charset=utf-8', { 'cache-control': 'public, max-age=300' });
      } catch (error) {
        if (error instanceof GatewayUpstreamError) {
          logger.error('ehviewer_failure', {
            source: error.source,
            code: error.code,
            status: error.status,
            attempts: error.attempts,
          });
          writeGatewayError(res, error);
        } else {
          writeText(res, 502, 'source unavailable\n');
        }
      }
      return;
    }
    if (requestUrl.pathname.startsWith('/ehviewer/ranking/')) {
      writeText(res, 404, 'not found\n');
      return;
    }
    const iwaraFeedMatch = requestUrl.pathname.match(/^\/iwara\/users\/([^/]+)(?:\/(video|image))?$/);
    if (iwaraFeedMatch) {
      attribution.source = 'iwara';
      const username = decodeURIComponent(iwaraFeedMatch[1]);
      const kind = iwaraFeedMatch[2] || 'video';
      try {
        const output = await fetchCachedDocument({
          cache,
          fetcher: async () => {
            const token = await iwaraToken();
            const user = await fetchIwaraUser(fetchJsonViaFetchd, username, { token });
            if (!user?.id) {
              return new Response('user not found\n', {
                status: 404,
                headers: { 'content-type': 'text/plain; charset=utf-8' },
              });
            }
            const videos = await fetchIwaraVideos(fetchJsonViaFetchd, user.id, { kind, token });
            const feed = renderIwaraFeed({ username, kind, videos });
            return new Response(feed, {
              status: 200,
              headers: { 'content-type': 'application/rss+xml; charset=utf-8' },
            });
          },
          requestUrl: requestUrl.pathname,
          cacheUrl: new URL(requestUrl.pathname, 'http://gateway.internal').toString(),
          kind: 'rss',
          request: { priority: 'foreground' },
        });
        const body = await readLimited(output);
        const transformed = transformFeed(body, {
          baseUrl: publicBaseUrl(req),
          selfUrl: `${publicBaseUrl(req)}${requestUrl.pathname}${requestUrl.search}`,
          secret,
          signedTargetMetadata: { egressScope: 'public' },
        });
        writeText(res, output.status, transformed, 'application/rss+xml; charset=utf-8', { 'cache-control': 'public, max-age=300' });
      } catch (error) {
        if (error instanceof GatewayUpstreamError) {
          logger.error('iwara_failure', {
            source: error.source,
            code: error.code,
            status: error.status,
            attempts: error.attempts,
          });
          writeGatewayError(res, error);
        } else {
          logger.error('iwara_failure', { code: 'IWARA_FEED_ERROR', status: 502, error: error.message });
          writeText(res, 502, 'source unavailable\n');
        }
      }
      return;
    }
    const chunkMatch = requestUrl.pathname.match(/^\/_gateway\/chunk\/(.+)$/);
    if (chunkMatch) {
      let chunk;
      try {
        chunk = verifySignedChunk(chunkMatch[1], secret);
      } catch {
        writeText(res, 403, 'resource unavailable\n');
        return;
      }
      attribution.source = chunk.source || 'unknown';
      try {
        const routed = await fetchGatewayMedia(
          chunk.url,
          { range: `bytes=${chunk.start}-${chunk.end}`, circuit: false, priority: 'foreground' },
          { egressScope: chunk.egressScope || 'public', source: chunk.source },
          undefined,
        );
        if (routed.unavailable) {
          writeText(res, 503, 'source unavailable\n');
          return;
        }
        const remote = routed.response;
        const headers = {};
        for (const name of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified']) {
          const value = remote.headers.get(name);
          if (value) headers[name] = value;
        }
        headers['content-disposition'] = `attachment; filename="chunk-${chunk.start}-${chunk.end}.bin"`;
        res.writeHead(remote.status, headers);
        if (req.method === 'HEAD') return res.end();
        if (remote.body) Readable.fromWeb(remote.body).pipe(res);
        else res.end();
      } catch (error) {
        if (error instanceof GatewayUpstreamError) {
          writeGatewayError(res, error);
        } else {
          writeText(res, 502, 'upstream unavailable\n');
        }
      }
      return;
    }
    const leaseMatch = requestUrl.pathname.match(/^\/_gateway\/lease\/(.+)$/);
    if (leaseMatch) {
      let verified;
      try {
        verified = verifySignedTarget(leaseMatch[1], secret);
      } catch {
        writeText(res, 403, 'resource unavailable\n');
        return;
      }
      if (!leaseProxy) {
        writeText(res, 503, 'lease proxy disabled\n');
        return;
      }
      attribution.source = verified.source || 'unknown';
      try {
        const target = verified.url;
        let resolvedUrl = target;
        let allowHosts = [new URL(target).hostname];
        if (isIwaraVideoTarget(target)) {
          const resolved = await resolveIwaraVideo(target);
          if (!resolved?.url) throw new Error('video resolution unavailable');
          resolvedUrl = resolved.url;
          allowHosts = [new URL(resolvedUrl).hostname];
        }
        const lease = leaseStore.createLease({
          targetUrl: target,
          resolvedUrl,
          allowHosts,
          ttlMs: leaseTtlMs,
          maxBytes: leaseMaxBytes,
          maxConcurrency: leaseMaxConcurrency,
          metadata: { source: verified.source || 'unknown' },
        });
        const requestHost = (req.headers.host || 'localhost:1300').split(':')[0];
        const view = leaseStore.publicView(lease, {
          proxyHost: requestHost,
          proxyPort: leaseProxyBoundPort,
          proxyUrl: leaseProxyPublicUrl || undefined,
        });
        logger.info('lease_created', {
          host: allowHosts[0],
          ttlMs: view.ttlMs,
          maxBytes: view.maxBytes,
        });
        if (leaseBackfillQueue) {
          leaseBackfillQueue.enqueue(lease).catch(() => {
            // Backfill must never fail the lease response.
          });
        }
        writeJson(res, 200, view);
      } catch (error) {
        logger.error('lease_failure', { error: error.message });
        writeText(res, 502, 'lease unavailable\n');
      }
      return;
    }
    const gatewayMatch = requestUrl.pathname.match(/^\/_gateway\/(item|media)\/(.+)$/);
    if (gatewayMatch) {
      const mediaVariant = gatewayMatch[1] === 'media'
        ? requestedImageVariantWidth(requestUrl.searchParams)
        : { width: undefined };
      if (mediaVariant.error) {
        writeText(res, 400, 'unsupported image variant\n');
        return;
      }
      let target;
      let routeMetadata;
      try {
        const verified = verifySignedTarget(gatewayMatch[2], secret);
        target = verified.url;
        routeMetadata = { egressScope: verified.egressScope, source: verified.source };
      } catch {
        writeText(res, 403, 'resource unavailable\n');
        return;
      }
      attribution.source = routeMetadata.source;
      const chunksParam = gatewayMatch[1] === 'media' ? requestUrl.searchParams.get('chunks') : null;
      if (chunksParam !== null && chunksParam !== '') {
        const wanted = Number.parseInt(chunksParam, 10);
        const size = await mediaSizeFor(target);
        if (!size) {
          writeText(res, 503, 'size unavailable\n');
          return;
        }
        const { count, size: chunkSize } = chunkSizeFor(size, Number.isInteger(wanted) ? wanted : 1);
        const urls = [];
        for (let index = 0; index < count; index += 1) {
          const start = index * chunkSize;
          const end = Math.min(size - 1, start + chunkSize - 1);
          const token = createSignedChunk({
            url: target,
            start,
            end,
            secret,
            metadata: { egressScope: routeMetadata.egressScope, source: routeMetadata.source },
          });
          urls.push(`${publicBaseUrl(req)}/_gateway/chunk/${token}`);
        }
        writeJson(res, 200, { size, chunkSize, count, urls });
        return;
      }
      try {
        const adapter = adapterForUrl(target);
        if (gatewayMatch[1] === 'item' && isIwaraVideoTarget(target)) {
          try {
            const token = await iwaraToken();
            const detail = await fetchIwaraVideoDetail(fetchJsonViaFetchd, iwaraVideoId(target), { token });
            if (detail?.id) {
              const page = renderIwaraReaderPage({ video: detail, baseUrl: publicBaseUrl(req), secret });
              writeText(res, 200, page, 'text/html; charset=utf-8');
              return;
            }
          } catch {
            // Fall through to the standard item handling when metadata is unavailable.
          }
        }
        const ehImageMediaTarget = gatewayMatch[1] === 'media' && isEhImagePageTarget(target);
        const responseDriven = adapter.publiclyReadable
          || ['session', 'sticky'].includes(routeMetadata.egressScope)
          || mediaVariant.width !== undefined
          || ehImageMediaTarget;
        const routed = responseDriven
          ? (gatewayMatch[1] === 'item'
            ? await fetchGatewayDocument(target, { range: req.headers.range, priority: 'foreground' }, routeMetadata)
            : (ehImageMediaTarget
              ? await fetchResolvedEhMedia(
                target,
                { range: req.headers.range, circuit: false, priority: 'foreground' },
                routeMetadata,
                mediaVariant.width,
                publicBaseUrl(req),
              )
              : await fetchGatewayMedia(target, { range: req.headers.range, circuit: false, priority: 'foreground' }, routeMetadata, mediaVariant.width)))
          : {
            adapter,
            egressScope: routeMetadata.egressScope || 'public',
            response: gatewayMatch[1] === 'item'
              ? await fetchExternalDocument(adapter.readerTarget(target), { range: req.headers.range, priority: 'foreground' }, 'html')
              : await fetchCachedMedia({
                cache,
                fetcher: fetchExternal,
                target,
                range: req.headers.range,
                maxBytes: mediaCacheMaxFileBytes,
                request: { priority: 'foreground' },
              }),
          };
        if (routed.unavailable) {
          if (gatewayMatch[1] === 'media') {
            writeText(res, 503, 'source unavailable\n');
          } else {
            const page = renderUnavailablePage({
              url: target,
              title: adapter.name,
              message: adapter.unavailableMessage(target, 503),
              baseUrl: publicBaseUrl(req),
              secret,
              signedTargetMetadata: signedTargetMetadata(adapter, 'session'),
            });
            writeText(res, 503, page, 'text/html; charset=utf-8');
          }
          return;
        }
        const remote = routed.response;
        if (gatewayMatch[1] === 'media') {
          const headers = {};
          for (const name of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified']) {
            const value = remote.headers.get(name);
            if (value) headers[name] = value;
          }
          if (requestUrl.searchParams.get('download') === '1') {
            headers['content-disposition'] = `attachment; filename="${mediaFileName(target, remote.headers.get('content-type') || '')}"`;
          }
          const mediaContentType = remote.headers.get('content-type') || '';
          if (remote.ok && mediaContentType.toLowerCase().startsWith('image/')) {
            headers['cache-control'] = `${routed.egressScope === 'public' ? 'public' : 'private'}, max-age=${mediaBrowserCacheSeconds}`;
          }
          res.writeHead(remote.status, headers);
          if (req.method === 'HEAD') return res.end();
          if (remote.body) Readable.fromWeb(remote.body).pipe(res);
          else res.end();
          return;
        }
        let body = await readLimited(remote);
        let contentType = remote.headers.get('content-type') || '';
        let prefetchedGallery;
        let readerState = 'standard';
        let unavailableStatus = remote.status;
        const shouldPrefetchGallery = requestUrl.searchParams.get('view') !== 'gallery'
          && adapter.isGalleryUrl(target)
          && remote.ok
          && contentType.includes('html');
        if (shouldPrefetchGallery) {
          const initial = initialEhGalleryManifest({
            adapter,
            target,
            initialHtml: body,
            maxPages: ehMaxPrefetchPages,
          });
          const cachedDiscovery = await discoverCachedEhGallery({
            adapter,
            target,
            initialHtml: body,
            concurrency: currentEhPrefetchConcurrency(),
            maxPages: ehMaxPrefetchPages,
            namespace: cacheNamespaceFor(routed.egressScope, routed.session),
          });
          let discovery = cachedDiscovery;
          if (!discovery && (!ehColdStartEnabled || !initial.imageUrls.length)) {
            discovery = await discoverEhGallery({
              adapter,
              target,
              initialHtml: body,
              fetchExternal: fetchExternalDocument,
              concurrency: currentEhPrefetchConcurrency(),
              maxPages: ehMaxPrefetchPages,
            });
          }
          let pageTargets = discovery?.selectedImageUrls || initial.imageUrls;
          if (!discovery && ehColdStartEnabled && initial.imageUrls.length) {
            const firstDetailStartedAt = Date.now();
            recordMetric('eh_first_detail_started', { source: adapter.name });
            const firstPage = await resolveForegroundEhPage({
              adapter,
              imageUrl: initial.imageUrls[0],
              pageNumber: 1,
              fetchDocument: fetchExternalDocument,
              baseUrl: publicBaseUrl(req),
              secret,
              signedTargetMetadata: signedTargetMetadata(adapter, routed.egressScope),
              budgetMs: ehFirstDetailBudgetMs,
            });
            recordMetric(firstPage ? 'eh_first_detail_resolved' : 'eh_first_detail_deferred', {
              source: adapter.name,
              durationMs: Date.now() - firstDetailStartedAt,
            });
            let manifest = createInitialReaderManifest({
              imageUrls: initial.imageUrls,
              maxPages: ehMaxPrefetchPages,
            });
            if (firstPage) manifest = mergeResolvedPage(manifest, firstPage);
            pageTargets = manifest.pages.map((page) => page.mediaTarget);
          }
          readerState = discovery ? 'complete' : 'cold';
          const gallery = discovery || initial;
          prefetchedGallery = {
            title: gallery.title,
            pages: pageTargets.map((mediaTarget, index) => ({
              pageNumber: index + 1,
              mediaTarget,
              alt: `第 ${index + 1} 页`,
            })),
            failures: gallery.failures,
            totalPages: gallery.totalPages,
            truncated: gallery.truncated,
            preloadCount: ehFirstPaintCount,
            status: gallery.status,
          };
          unavailableStatus = gallery.status;
          void (async () => {
            const resolvedGallery = await prefetchEhGallery({
              adapter,
              target,
              initialHtml: body,
              fetchExternal: (url, request) => fetchExternalDocument(url, {
                ...request,
                priority: 'background',
              }),
              baseUrl: publicBaseUrl(req),
              secret,
              concurrency: currentEhPrefetchConcurrency(),
              maxPages: ehMaxPrefetchPages,
              discovery: discovery || undefined,
              onPage: (page) => {
                recordMetric('gallery_detail_completed', { source: adapter.name, count: 1 });
                if (page.pageNumber > ehMediaForegroundWarmCount && page.mediaTarget) {
                  mediaPreloadQueue.enqueue([page.mediaTarget]);
                }
              },
            });
            const foregroundWarm = await warmEhMedia({
              pages: resolvedGallery.pages,
              cache,
              fetcher: (url, request) => fetchExternal(url, { ...request, priority: 'background' }),
              maxBytes: mediaCacheMaxFileBytes,
              count: ehMediaForegroundWarmCount,
              concurrency: ehMediaForegroundWarmConcurrency,
            });
            const readyCount = foregroundWarm.targets.length - foregroundWarm.failedTargets.length;
            if (readyCount > 0) recordMetric('media_cache_ready', { source: adapter.name, count: readyCount });
            const warmed = new Set(foregroundWarm.targets);
            mediaPreloadQueue.enqueue([
              ...foregroundWarm.failedTargets,
              ...resolvedGallery.pages.map((page) => page.mediaTarget).filter((mediaTarget) => !warmed.has(mediaTarget)),
            ]);
          })().catch(() => {
            recordMetric('gallery_background_prefetch_failed', { source: adapter.name });
          });
        }
        const unavailable = !remote.ok
          || (contentType.includes('html') && adapter.isReaderUnavailable?.(body))
          || (shouldPrefetchGallery && !prefetchedGallery.pages.length);
        const page = unavailable
          ? renderUnavailablePage({
            url: target,
            title: adapter.name,
            message: adapter.unavailableMessage(target, remote.status),
            baseUrl: publicBaseUrl(req),
            secret,
            signedTargetMetadata: signedTargetMetadata(adapter, routed.egressScope),
          })
          : (contentType.includes('html')
            ? renderReaderPage({
              url: target,
              html: body,
              baseUrl: publicBaseUrl(req),
              secret,
              prefetchedGallery,
              signedTargetMetadata: signedTargetMetadata(adapter, routed.egressScope),
            })
            : body);
        const status = unavailable ? unavailableStatus : (remote.ok ? 200 : remote.status);
        const renderedHtml = !unavailable && contentType.includes('html');
        if (renderedHtml) {
          const encodingStartedAt = Date.now();
          const encoded = encodeHtmlResponse({
            body: page,
            contentType: 'text/html; charset=utf-8',
            acceptEncoding: req.headers['accept-encoding'],
            method: req.method,
            minBytes: htmlBrotliMinBytes,
            quality: htmlBrotliQuality,
          });
          if (encoded.headers['content-encoding'] === 'br') {
            recordMetric('html_brotli_encoded', {
              source: adapter.name,
              bytesIn: Buffer.byteLength(page),
              bytesOut: encoded.body.length,
              durationMs: Date.now() - encodingStartedAt,
            });
          }
          recordMetric('reader_html_emitted', {
            source: adapter.name,
            state: readerState,
            durationMs: Date.now() - requestStartedAt,
            requestId,
          });
          writeBuffer(res, status, encoded.body, 'text/html; charset=utf-8', encoded.headers);
        } else {
          writeText(res, status, page, contentType.includes('html') ? 'text/html; charset=utf-8' : contentType);
        }
      } catch (error) {
        if (error instanceof GatewayUpstreamError) {
          logger.error('upstream_failure', {
            source: error.source,
            code: error.code,
            status: error.status,
            attempts: error.attempts,
          });
          writeGatewayError(res, error);
          return;
        }
        writeText(res, 502, 'upstream unavailable\n');
      }
      return;
    }
    attribution.source = requestUrl.pathname.split('/')[1] || '';
    try {
      const rsshubPath = `${requestUrl.pathname}${requestUrl.search}`;
      const rsshubTarget = new URL(rsshubPath, process.env.RSSHUB_URL || 'http://rsshub:1200').toString();
      const remote = await fetchCachedDocument({
        cache,
        fetcher: fetchRssHub,
        requestUrl: rsshubPath,
        cacheUrl: rsshubTarget,
        kind: 'rss',
        logger,
        request: {
          headers: {
            host: req.headers.host || 'localhost:1300',
            'x-forwarded-host': req.headers.host || 'localhost:1300',
            'x-forwarded-proto': req.headers['x-forwarded-proto'] || 'https',
          },
        },
      });
      const body = await readLimited(remote);
      const contentType = remote.headers.get('content-type') || '';
      const output = contentType.includes('xml') ? transformFeed(body, {
        baseUrl: publicBaseUrl(req),
        selfUrl: `${publicBaseUrl(req)}${requestUrl.pathname}${requestUrl.search}`,
        secret,
        signedTargetMetadata: { egressScope: 'public' },
      }) : body;
      writeText(res, remote.status, output, contentType || 'application/octet-stream');
    } catch (error) {
      if (error instanceof GatewayUpstreamError) {
        logger.error('rsshub_failure', {
          source: error.source,
          code: error.code,
          status: error.status,
          attempts: error.attempts,
        });
        writeGatewayError(res, error);
        return;
      }
      writeText(res, 502, 'upstream unavailable\n');
    }
  }

  return async (req, res) => {
    const startedAt = Date.now();
    const attribution = { source: null };
    try {
      await handleRequest(req, res, attribution);
    } finally {
      const durationMs = Date.now() - startedAt;
      recordDuration('request_duration_seconds', durationMs);
      try {
        const pathname = new URL(req.url || '/', 'http://gateway.internal').pathname;
        recordDuration(`route_${routeBucket(pathname)}_duration_seconds`, durationMs);
        const sourceMetric = sourceMetricName(attribution.source);
        if (sourceMetric) recordDuration(sourceMetric, durationMs);
      } catch {
        // Routing metrics must never affect the response.
      }
    }
  };
}
