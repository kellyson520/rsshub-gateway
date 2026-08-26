import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { transformFeed } from './feed-transform.js';
import { verifySignedTarget } from './signed-target.js';
import { GatewayUpstreamError } from './upstream-errors.js';
import { adapterForUrl } from './adapters/index.js';

import { renderReaderPage, renderUnavailablePage } from './reader.js';
import { createInitialReaderManifest, mergeResolvedPage } from './reader-manifest.js';
import { createSignedChunk, verifySignedChunk } from './download-lease.js';
import { resolveRedirect } from './dispatcher.js';
import { chunkSizeFor } from './media/chunks.js';
import { pumpResumableRange } from './media/resumable-range.js';
import { encodeHtmlResponse, encodeTextResponse } from './http-encoding.js';
import {
  boundedInteger,
  fetchCachedDocument,
  isBearerAuthorized,
  isEhImagePageTarget,
  mediaFileName,
  positiveInteger,
  publicBaseUrl,
  readJsonBody,
  readLimited,
  readRequestBody,
  requestedImageVariantWidth,
  sleep,
  writeBuffer,
  writeGatewayError,
  writeJson,
  writeText,
} from './http-utils.js';
import {
  fetchIwaraVideoDetail,
  isIwaraVideoTarget,
  iwaraVideoId,
  renderIwaraReaderPage,
} from './adapters/iwara.js';
import {
  fetchLinuxdoTopicDetail,
  isLinuxdoTopicTarget,
  linuxdoTopicId,
  renderLinuxdoReaderPage,
} from './adapters/linuxdo.js';

export {
  downloadSessionView,
  withPrefetchStatus,
  promLabel,
  sourceMetricName,
  writeEncodedText,
  DEFAULT_PREFETCH_WAIT_MS,
  MAX_PREFETCH_WAIT_MS,
};

function downloadSessionView(session) {
  return {
    id: session.id,
    size: session.size,
    chunkSize: session.chunkSize,
    count: session.chunks.length,
    doneChunks: session.chunks.filter((chunk) => chunk.status === 'done').length,
    doneBytes: session.doneBytes,
    urls: session.chunks.map((chunk) => chunk.url),
    chunks: session.chunks.map((chunk) => ({
      index: chunk.index,
      start: chunk.start,
      end: chunk.end,
      size: chunk.size,
      status: chunk.status,
      url: chunk.url,
    })),
  };
}

function withPrefetchStatus(view, target, prefetchStatus) {
  return { ...view, prefetch: prefetchStatus?.(target) ?? null };
}

function promLabel(value) {
  return String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', '\\n');
}

const DEFAULT_PREFETCH_WAIT_MS = 30_000;
const MAX_PREFETCH_WAIT_MS = 60_000;

function sourceMetricName(source) {
  const name = String(source || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 32);
  return name ? `source_${name}_duration_seconds` : null;
}

// Unified post-processing text writer: brotli/gzip edge compression for every
// text-ish response (charter: 所有流量统一经过后处理层) and correct HEAD
// semantics (headers without a body).
function writeEncodedText(res, req, status, body, contentType = 'text/plain; charset=utf-8', headers = {}) {
  // Compute headers exactly as a GET would (content-encoding + compressed
  // content-length), then suppress the body for HEAD so HEAD answers are
  // faithful previews of GET.
  const encoded = encodeTextResponse({
    body,
    contentType,
    acceptEncoding: req.headers['accept-encoding'],
    method: 'GET',
    headers,
  });
  res.writeHead(status, { 'content-type': contentType, ...encoded.headers });
  if (req.method === 'HEAD') res.end();
  else res.end(encoded.body);
}

export function createRequestHandler(deps) {
  const {
    cache,
    cacheNamespaceFor,
    client,
    currentEhPrefetchConcurrency,
    discoverCachedEhGallery,
    discoverEhGallery,
    dispatcher,
    dispatcherRegistrationToken,
    downloadSessions,
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
    feedPrefetchQueue,
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
    prefetchVideoFile,
    prefetchStatus,
    videoPrefetchEnabled,
    recordDuration,
    recordMetric,
    resolveForegroundEhPage,
    resolveIwaraVideo,
    routeBucket,
    secret,
    signedTargetMetadata,
    slowSourceThresholdMs,
    videoCacheMaxFileBytes,
    warmEhMedia
  } = deps;
  async function handleRequest(req, res, attribution) {
    const downloadCreate = req.method === 'POST'
      && /^\/_gateway\/download\/[^/]+$/.test(String(req.url || '').split('?')[0]);
    const controlPath = String(req.url || '').split('?')[0];
    const controlWrite = (controlPath === '/_gateway/dispatcher/routes' || controlPath === '/_gateway/prefetch' || controlPath === '/_gateway/revoke-session')
      && (req.method === 'POST' || req.method === 'DELETE');
    if (req.method !== 'GET' && req.method !== 'HEAD' && !downloadCreate && !controlWrite) {
      writeText(res, 405, 'method not allowed\n');
      return;
    }
    const requestStartedAt = Date.now();
    const requestUrl = new URL(req.url || '/', 'http://gateway.internal');
    const requestId = String(req.headers['x-request-id'] || randomUUID()).slice(0, 64);
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
      const prefetchStats = feedPrefetchQueue ? feedPrefetchQueue.stats() : null;
      if (prefetchStats) {
        lines.push('# TYPE rsshub_gateway_prefetch_enabled gauge');
        lines.push(`rsshub_gateway_prefetch_enabled ${prefetchStats.enabled ? 1 : 0}`);
        lines.push('# TYPE rsshub_gateway_prefetch_configured gauge');
        lines.push(`rsshub_gateway_prefetch_configured ${prefetchStats.configured}`);
        lines.push('# TYPE rsshub_gateway_prefetch_queue_length gauge');
        lines.push(`rsshub_gateway_prefetch_queue_length ${prefetchStats.queueLength}`);
        lines.push('# TYPE rsshub_gateway_prefetch_in_flight gauge');
        lines.push(`rsshub_gateway_prefetch_in_flight ${prefetchStats.inFlight}`);
        lines.push('# TYPE rsshub_gateway_prefetch_completed_total counter');
        lines.push(`rsshub_gateway_prefetch_completed_total ${prefetchStats.completed}`);
        lines.push('# TYPE rsshub_gateway_prefetch_failed_total counter');
        lines.push(`rsshub_gateway_prefetch_failed_total ${prefetchStats.failed}`);
        if (prefetchStats.lastRunAt) {
          lines.push('# TYPE rsshub_gateway_prefetch_last_run_ms gauge');
          lines.push(`rsshub_gateway_prefetch_last_run_ms ${prefetchStats.lastRunAt}`);
        }
        for (const [path, entry] of Object.entries(prefetchStats.paths || {})) {
          const label = `path="${promLabel(path)}"`;
          lines.push(`rsshub_gateway_prefetch_path_completed_total{${label}} ${entry.completed}`);
          lines.push(`rsshub_gateway_prefetch_path_failed_total{${label}} ${entry.failed}`);
          if (entry.lastStatus !== null && entry.lastStatus !== undefined) {
            lines.push(`rsshub_gateway_prefetch_path_last_status{${label}} ${entry.lastStatus}`);
          }
          if (entry.lastDurationMs !== null && entry.lastDurationMs !== undefined) {
            lines.push(`rsshub_gateway_prefetch_path_last_duration_ms{${label}} ${entry.lastDurationMs}`);
          }
        }
      }
      for (const lane of egressStats.lanes || []) {
        const label = `lane="${promLabel(lane.id)}"`;
        lines.push(`rsshub_gateway_egress_lane_active{${label}} ${lane.active ?? 0}`);
        lines.push(`rsshub_gateway_egress_lane_target_concurrency{${label}} ${lane.targetConcurrency ?? 0}`);
        lines.push(`rsshub_gateway_egress_lane_samples{${label}} ${lane.samples ?? 0}`);
        if (lane.ewmaMs !== undefined && lane.ewmaMs !== null) {
          lines.push(`rsshub_gateway_egress_lane_ewma_ms{${label}} ${lane.ewmaMs}`);
        }
        lines.push(`rsshub_gateway_egress_lane_site_blocked_count{${label}} ${(lane.siteBlocked || []).length}`);
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
        feedPrefetch: feedPrefetchQueue ? feedPrefetchQueue.stats() : null,
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
    if (requestUrl.pathname === '/_gateway/dispatcher/routes') {
      if (!dispatcherRegistrationToken || !dispatcher) {
        writeText(res, 404, 'not found\n');
        return;
      }
      if (!isBearerAuthorized(req, dispatcherRegistrationToken)) {
        writeText(res, 401, 'unauthorized\n');
        return;
      }
      if (req.method === 'GET') {
        writeJson(res, 200, {
          routes: [...dispatcher.routes, ...dispatcher.runtimeRoutes].map(({ pattern, ...route }) => route),
          total: dispatcher.routes.length + dispatcher.runtimeRoutes.length,
        });
        return;
      }
      if (req.method === 'POST') {
        let body;
        try {
          body = await readJsonBody(req);
        } catch {
          writeJson(res, 400, { error: 'invalid json body' });
          return;
        }
        if (!Array.isArray(body?.routes)) {
          writeJson(res, 400, { error: 'routes array is required' });
          return;
        }
        const result = dispatcher.registerRoutes(body.routes);
        writeJson(res, 200, { ...result, total: dispatcher.routes.length + dispatcher.runtimeRoutes.length });
        return;
      }
      if (req.method === 'DELETE') {
        let body;
        try {
          body = await readJsonBody(req);
        } catch {
          writeJson(res, 400, { error: 'invalid json body' });
          return;
        }
        if (!Array.isArray(body?.routeIds)) {
          writeJson(res, 400, { error: 'routeIds array is required' });
          return;
        }
        const result = dispatcher.unregisterRoutes(body.routeIds);
        writeJson(res, 200, { ...result, total: dispatcher.routes.length + dispatcher.runtimeRoutes.length });
        return;
      }
      writeText(res, 405, 'method not allowed\n');
      return;
    }
    if (requestUrl.pathname === '/_gateway/prefetch') {
      if (!dispatcherRegistrationToken || !feedPrefetchQueue) {
        writeText(res, 404, 'not found\n');
        return;
      }
      if (!isBearerAuthorized(req, dispatcherRegistrationToken)) {
        writeText(res, 401, 'unauthorized\n');
        return;
      }
      if (req.method === 'GET') {
        writeJson(res, 200, feedPrefetchQueue.stats());
        return;
      }
      if (req.method === 'POST') {
        let body;
        try {
          body = await readJsonBody(req);
        } catch {
          writeJson(res, 400, { error: 'invalid json body' });
          return;
        }
        if (typeof body?.path !== 'string' || !body.path.trim()) {
          writeJson(res, 400, { error: 'path is required' });
          return;
        }
        if (body.action === 'toggle' || typeof body.paused === 'boolean') {
          const isPaused = feedPrefetchQueue.togglePause(body.path.trim(), body.paused);
          writeJson(res, 200, { path: body.path.trim(), paused: isPaused });
          return;
        }
        const result = feedPrefetchQueue.enqueue(body.path.trim(), { force: true });
        writeJson(res, 200, { ...result, queueLength: feedPrefetchQueue.stats().queueLength });
        return;
      }
      writeText(res, 405, 'method not allowed\n');
      return;
    }
    if (requestUrl.pathname === '/_gateway/revoke-session') {
      if (!dispatcherRegistrationToken || !downloadSessions) {
        writeText(res, 404, 'not found\n');
        return;
      }
      if (!isBearerAuthorized(req, dispatcherRegistrationToken)) {
        writeText(res, 401, 'unauthorized\n');
        return;
      }
      if (req.method === 'POST') {
        let body;
        try {
          body = await readJsonBody(req);
        } catch {
          writeJson(res, 400, { error: 'invalid json body' });
          return;
        }
        const query = body?.sessionId || body?.targetUrl || body?.query;
        if (!query || typeof query !== 'string' || !query.trim()) {
          writeJson(res, 400, { error: 'sessionId or targetUrl is required' });
          return;
        }
        const result = await downloadSessions.revoke(query.trim());
        writeJson(res, 200, { ok: true, query: query.trim(), ...result });
        return;
      }
      writeText(res, 405, 'method not allowed\n');
      return;
    }
    const dispatched = dispatcher?.match(requestUrl.pathname) || null;
    if (dispatched?.route.redirectTo) {
      const targetPath = resolveRedirect(dispatched.route.redirectTo, dispatched.params);
      const destination = `${targetPath}${requestUrl.search}`;
      res.writeHead(301, {
        location: destination,
        'cache-control': 'public, max-age=86400',
      });
      res.end(`redirecting to ${destination}\n`);
      return;
    }
    if (dispatched?.route.backend.startsWith('sidecar://')) {
      const { route, params } = dispatched;
      attribution.source = route.routeId.split('/').filter(Boolean)[0] || 'sidecar';
      try {
        let sidecarHint = null;
        const output = await fetchCachedDocument({
          cache,
          fetcher: async () => {
            const result = await dispatcher.callSidecar(route, params, {
              egressLane: 'public',
              cookies: req.headers.cookie,
              requestId,
            });
            sidecarHint = result.cacheHint || null;
            return new Response(result.rssXml, {
              status: 200,
              headers: { 'content-type': 'application/rss+xml; charset=utf-8' },
            });
          },
          requestUrl: `${requestUrl.pathname}${requestUrl.search}`,
          cacheUrl: new URL(requestUrl.pathname, 'http://gateway.internal').toString(),
          kind: 'rss',
          logger,
          request: { priority: 'foreground' },
        });
        const body = await readLimited(output);
        const transformed = transformFeed(body, {
          baseUrl: publicBaseUrl(req),
          selfUrl: `${publicBaseUrl(req)}${requestUrl.pathname}${requestUrl.search}`,
          secret,
          signedTargetMetadata: { egressScope: 'public' },
        });
        // Honor the Fetcher-API cacheHint.ttl (falls back to the route cacheTtl,
        // then the gateway default) so sidecar feeds expire on the reader side
        // consistently with the gateway's own rss cache kind.
        const feedTtl = Number.isInteger(sidecarHint?.ttl) && sidecarHint.ttl > 0
          ? sidecarHint.ttl
          : (Number.isInteger(route.cacheTtl) && route.cacheTtl > 0 ? route.cacheTtl : 300);
        writeEncodedText(res, req, output.status, transformed, 'application/rss+xml; charset=utf-8', {
          'cache-control': `public, max-age=${feedTtl}`,
        });
        return;
      } catch (error) {
        logger.error('sidecar_route_failure', { routeId: route.routeId, error: error.message });
        if (!route.fallbackUpstream) {
          writeGatewayError(res, new GatewayUpstreamError(
            `sidecar unavailable: ${error.message}`,
            { code: 'SIDECAR_UNAVAILABLE', source: route.backend, status: 502, attempts: 1 },
          ));
          return;
        }
        await serveRssHubPassthrough(req, res, requestUrl, attribution, requestId);
        return;
      }
    }
    // /ehviewer/ranking* has no built-in handler: the charter forbids site
    // scraping in the gateway base. It is served by the fetcher-eh sidecar when
    // a route is registered, and transparently proxied to upstream RSSHub
    // otherwise.
    // /iwara/users/* has no built-in handler: the charter forbids site
    // scraping in the gateway base. It is served by the fetcher-iwara sidecar
    // when a route is registered, and transparently proxied to upstream RSSHub
    // otherwise.
    const downloadWaitMatch = requestUrl.pathname.match(/^\/_gateway\/download\/([^/]+)\/wait$/);
    if (downloadWaitMatch) {
      if (req.method !== 'GET') {
        writeText(res, 405, 'method not allowed\n');
        return;
      }
      const session = await downloadSessions.get(downloadWaitMatch[1]);
      if (!session) {
        writeText(res, 404, 'download session not found\n');
        return;
      }
      const waitMs = boundedInteger(
        requestUrl.searchParams.get('timeout'),
        DEFAULT_PREFETCH_WAIT_MS,
        0,
        MAX_PREFETCH_WAIT_MS,
      );
      const deadline = Date.now() + waitMs;
      let prefetch;
      while (true) {
        prefetch = prefetchStatus?.(session.target) ?? null;
        if (!prefetch || prefetch.status === 'done' || Date.now() >= deadline) break;
        await sleep(Math.min(250, Math.max(1, deadline - Date.now())));
      }
      writeJson(res, 200, { prefetch, timedOut: prefetch ? prefetch.status !== 'done' : false });
      return;
    }
    const downloadMatch = requestUrl.pathname.match(/^\/_gateway\/download\/([^/]+)$/);
    if (downloadMatch) {
      if (req.method === 'POST') {
        let verified;
        try {
          verified = verifySignedTarget(downloadMatch[1], secret);
        } catch {
          writeText(res, 403, 'resource unavailable\n');
          return;
        }
        const wanted = positiveInteger(requestUrl.searchParams.get('chunks'), 1);
        const size = await mediaSizeFor(verified.url);
        if (!size) {
          writeText(res, 503, 'size unavailable\n');
          return;
        }
        const { count, size: chunkSize } = chunkSizeFor(size, wanted);
        const sessionId = randomUUID();
        const entries = [];
        for (let index = 0; index < count; index += 1) {
          const start = index * chunkSize;
          const end = Math.min(size - 1, start + chunkSize - 1);
          const token = createSignedChunk({
            url: verified.url,
            start,
            end,
            secret,
            metadata: {
              egressScope: verified.egressScope,
              source: verified.source,
              sessionId,
              index,
            },
          });
          entries.push({
            index,
            start,
            end,
            size: end - start + 1,
            url: `${publicBaseUrl(req)}/_gateway/chunk/${token}`,
          });
        }
        const session = await downloadSessions.create({
          id: sessionId,
          target: verified.url,
          size,
          chunkSize,
          chunks: entries,
        });
        if (prefetchVideoFile && videoPrefetchEnabled !== false) {
          void prefetchVideoFile(verified.url, { size }).catch(() => {
            // Background slice prefetch must never affect session creation.
          });
        }
        recordMetric('download_session_created');
        writeJson(res, 200, withPrefetchStatus(downloadSessionView(session), session.target, prefetchStatus));
        return;
      }
      if (req.method === 'GET') {
        const session = await downloadSessions.get(downloadMatch[1]);
        if (!session) {
          writeText(res, 404, 'download session not found\n');
          return;
        }
        writeJson(res, 200, withPrefetchStatus(downloadSessionView(session), session.target, prefetchStatus));
        return;
      }
      writeText(res, 405, 'method not allowed\n');
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
        if (remote.body) {
          const expectedBytes = chunk.end - chunk.start + 1;
          await pumpResumableRange({
            response: remote,
            fetchRange: async (range) => {
              const routed = await fetchGatewayMedia(
                chunk.url,
                { range, circuit: false, priority: 'foreground' },
                { egressScope: chunk.egressScope || 'public', source: chunk.source },
                undefined,
              );
              return routed.unavailable ? null : routed.response;
            },
            res,
            start: chunk.start,
            end: chunk.end,
            onComplete: ({ resumed }) => {
              if (resumed > 0) recordMetric('download_chunk_resumed', { count: resumed });
              if (chunk.sessionId !== undefined && Number.isInteger(chunk.index)) {
                void downloadSessions.markChunkDone(chunk.sessionId, chunk.index).then((done) => {
                  if (done) recordMetric('download_chunk_completed');
                });
              }
            },
            onTruncated: () => recordMetric('download_chunk_truncated'),
          });
        } else {
          res.end();
        }
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
        const wanted = positiveInteger(chunksParam, 1);
        const size = await mediaSizeFor(target);
        if (!size) {
          writeText(res, 503, 'size unavailable\n');
          return;
        }
        const { count, size: chunkSize } = chunkSizeFor(size, wanted);
        const urls = [];
        const chunks = [];
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
          const url = `${publicBaseUrl(req)}/_gateway/chunk/${token}`;
          urls.push(url);
          chunks.push({ index, start, end, size: end - start + 1, url });
        }
        writeJson(res, 200, { size, chunkSize, count, urls, chunks });
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
              const encoded = encodeHtmlResponse({
                body: page,
                contentType: 'text/html; charset=utf-8',
                acceptEncoding: req.headers['accept-encoding'],
                method: 'GET',
                minBytes: htmlBrotliMinBytes,
                quality: htmlBrotliQuality,
              });
              writeBuffer(res, 200, encoded.body, 'text/html; charset=utf-8', encoded.headers);
              return;
            }
          } catch {
            // Fall through to the standard item handling when metadata is unavailable.
          }
        }
        if (gatewayMatch[1] === 'item' && isLinuxdoTopicTarget(target)) {
          try {
            const topicId = linuxdoTopicId(target);
            const detail = await fetchLinuxdoTopicDetail(fetchJsonViaFetchd, topicId);
            if (detail?.id || detail?.post_stream) {
              const page = renderLinuxdoReaderPage({ topic: detail, baseUrl: publicBaseUrl(req), secret });
              const encoded = encodeHtmlResponse({
                body: page,
                contentType: 'text/html; charset=utf-8',
                acceptEncoding: req.headers['accept-encoding'],
                method: 'GET',
                minBytes: htmlBrotliMinBytes,
                quality: htmlBrotliQuality,
              });
              writeBuffer(res, 200, encoded.body, 'text/html; charset=utf-8', encoded.headers);
              return;
            }
          } catch {
            // Fall through to standard item handling when metadata is unavailable.
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
            const encoded = encodeHtmlResponse({
              body: page,
              contentType: 'text/html; charset=utf-8',
              acceptEncoding: req.headers['accept-encoding'],
              method: 'GET',
              minBytes: htmlBrotliMinBytes,
              quality: htmlBrotliQuality,
            });
            writeBuffer(res, 503, encoded.body, 'text/html; charset=utf-8', encoded.headers);
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
          if (remote.body) {
            const bodyStream = Buffer.isBuffer(remote.body) ? Readable.from(remote.body) : Readable.fromWeb(remote.body);
            bodyStream.pipe(res);
          } else {
            res.end();
          }
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
          // Compute headers exactly as a GET would (Node suppresses the body
          // for HEAD requests) so HEAD/GET responses stay consistent.
          const encoded = encodeHtmlResponse({
            body: page,
            contentType: 'text/html; charset=utf-8',
            acceptEncoding: req.headers['accept-encoding'],
            method: 'GET',
            minBytes: htmlBrotliMinBytes,
            quality: htmlBrotliQuality,
          });
          if (encoded.headers['content-encoding']) {
            recordMetric('html_compressed', {
              source: adapter.name,
              encoding: encoded.headers['content-encoding'],
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
    await serveRssHubPassthrough(req, res, requestUrl, attribution, requestId);
  }

  async function readRequestBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });
  }

  async function serveRssHubPassthrough(req, res, requestUrl, attribution, requestId) {
    attribution.source = requestUrl.pathname.split('/')[1] || '';
    try {
      const rsshubPath = `${requestUrl.pathname}${requestUrl.search}`;
      const rsshubTarget = new URL(rsshubPath, process.env.RSSHUB_URL || 'http://rsshub:1200').toString();
      // HEAD responses carry no body: never cache them under the GET key, and
      // forward the method so upstream RSSHub answers with headers only.
      const remote = await fetchCachedDocument({
        cache: req.method === 'HEAD' ? null : cache,
        fetcher: fetchRssHub,
        requestUrl: rsshubPath,
        cacheUrl: rsshubTarget,
        kind: 'rss',
        logger,
        request: {
          method: req.method,
          headers: {
            host: req.headers.host || 'localhost:1300',
            'x-forwarded-host': req.headers.host || 'localhost:1300',
            'x-forwarded-proto': req.headers['x-forwarded-proto'] || 'https',
            'x-request-id': requestId,
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
      // Preserve upstream entity headers so reader caches and validators behave
      // exactly as they would against RSSHub directly (interface compatibility).
      const upstreamHeaders = {};
      for (const name of ['etag', 'last-modified', 'cache-control', 'expires', 'content-disposition', 'content-language']) {
        const value = remote.headers.get(name);
        if (value) upstreamHeaders[name] = value;
      }
      writeEncodedText(res, req, remote.status, output, contentType || 'application/octet-stream', upstreamHeaders);
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
    } catch (error) {
      // Last-resort boundary: a gateway request must never take the process
      // down through an unhandled rejection.
      logger.error('request_crashed', { error: error?.message });
      if (!res.headersSent) {
        writeText(res, 502, 'upstream unavailable\n');
      } else {
        res.destroy();
      }
    } finally {
      const durationMs = Date.now() - startedAt;
      recordDuration('request_duration_seconds', durationMs);
      try {
        const pathname = new URL(req.url || '/', 'http://gateway.internal').pathname;
        recordDuration(`route_${routeBucket(pathname)}_duration_seconds`, durationMs);
        const sourceMetric = sourceMetricName(attribution.source);
        if (sourceMetric) recordDuration(sourceMetric, durationMs);
        if (slowSourceThresholdMs > 0 && durationMs >= slowSourceThresholdMs) {
          logger.warn('slow_source', { source: attribution.source, durationMs });
          recordMetric('slow_source', { source: attribution.source, durationMs });
        }
      } catch {
        // Routing metrics must never affect the response.
      }
    }
  };
}
