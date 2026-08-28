import { Readable } from 'node:stream';
import {
  CACHE_RESPONSE_HEADERS,
  clamp,
  DEFAULT_KNOWN_SIZE_CAP,
  DEFAULT_KNOWN_SIZE_TTL_MS,
  DEFAULT_MEDIA_BROWSER_CACHE_SECONDS,
  DEFAULT_MEDIA_CACHE_MAX_FILE_BYTES,
  DEFAULT_PREFETCH_STATES_CAP,
  DEFAULT_SLICE_LOOKAHEAD_BYTES,
  DEFAULT_SLICE_SIZE,
  DEFAULT_VIDEO_CACHE_MAX_FILE_BYTES,
  defaultNamespaceFor,
  defaultSessionNamespace,
  IMAGE_VARIANT_CACHE_VERSION,
  imageVariantCacheUrl,
  nonNegativeInteger,
  parseByteRange,
  responseFromCachedDocument,
  responseHeaders,
  SLICE_ALIGN,
  sliceRanges,
} from '../http-utils.js';

export {
  CACHE_RESPONSE_HEADERS,
  IMAGE_VARIANT_CACHE_VERSION,
  SLICE_ALIGN,
  DEFAULT_SLICE_SIZE,
  DEFAULT_SLICE_LOOKAHEAD_BYTES,
  DEFAULT_MEDIA_CACHE_MAX_FILE_BYTES,
  DEFAULT_VIDEO_CACHE_MAX_FILE_BYTES,
  DEFAULT_MEDIA_BROWSER_CACHE_SECONDS,
  DEFAULT_KNOWN_SIZE_TTL_MS,
  DEFAULT_KNOWN_SIZE_CAP,
  DEFAULT_PREFETCH_STATES_CAP,
  defaultSessionNamespace,
  defaultNamespaceFor,
  responseHeaders,
  responseFromCachedDocument,
  imageVariantCacheUrl,
  parseByteRange,
  sliceRanges,
};

/**
 * Unified media transport.
 *
 * The bottom layer shared by every service that moves image/video bytes:
 * cache reads and fills, byte-range serving, image variants, size probes,
 * chunk manifests and one-time lease targets. The HTTP server, RSSHub
 * passthrough, and future services all call the same pipeline so media
 * acceleration stays consistent across routes.
 */
export function createMediaTransport({
  cache,
  fetchExternal,
  resolveMediaUrl,
  isVideoTarget = () => false,
  makeImageVariant,
  variantLimiter = async (task) => task(),
  imageVariantMaxSourceBytes = 32 * 1024 ** 2,
  mediaCacheMaxFileBytes = 32 * 1024 ** 2,
  videoCacheMaxFileBytes = 256 * 1024 ** 2,
  sliceSize = 4 * 1024 * 1024,
  sliceLookaheadBytes = 16 * 1024 * 1024,
  sliceFillConcurrency = 4,
  prefetchConcurrency = sliceFillConcurrency,
  mediaBrowserCacheSeconds = 300,
  createSignedChunk,
  routeRequest,
  resolveSession = async () => null,
  sessionNamespace = defaultSessionNamespace,
  namespaceFor = defaultNamespaceFor,
  adapterFor = () => ({ name: 'unknown' }),
  onImageWarmup,
  logger = { info() {}, warn() {}, error() {} },
  onMetric = () => {},
  knownSizeTtlMs = 24 * 60 * 60_000,
  knownSizeCap = 10_000,
  now = () => Date.now(),
} = {}) {
  const knownVideoSizes = new Map();
  const videoPrefetchInflight = new Map();
  const videoPrefetchStates = new Map();
  const PREFETCH_STATES_CAP = 1000;
  const KNOWN_SIZE_CAP = knownSizeCap;
  function rememberVideoSize(target, size) {
    const timestamp = now();
    const existing = knownVideoSizes.get(target);
    if (existing) {
      existing.size = size;
      existing.at = timestamp;
      return;
    }
    knownVideoSizes.set(target, { size, at: timestamp });
    if (knownVideoSizes.size > KNOWN_SIZE_CAP) {
      knownVideoSizes.delete(knownVideoSizes.keys().next().value);
    }
  }
  function knownVideoSize(target) {
    const entry = knownVideoSizes.get(target);
    if (!entry) return undefined;
    if (now() - entry.at > knownSizeTtlMs) {
      knownVideoSizes.delete(target);
      return undefined;
    }
    return entry.size;
  }

  async function readBinaryLimited(response, limit) {
    if (Buffer.isBuffer(response.body)) {
      if (response.body.length > limit) throw new Error('upstream media response too large');
      return response.body;
    }
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body ?? []) {
      size += chunk.length;
      if (size > limit) throw new Error('upstream media response too large');
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }

  function cacheStateLog(url, kind, state) {
    try {
      logger.info('gateway_cache', { host: new URL(url).hostname, kind, state });
    } catch {
      // Cache diagnostics must never affect the response.
    }
  }

  async function load({ target, kind = 'media', namespace = 'public', range, maxBytes, request }) {
    const requestOptions = { ...request, range, circuit: false };
    const foreground = request?.priority === 'foreground';
    if (!cache || range) {
      return { response: await fetchExternal(target, requestOptions), cacheState: 'BYPASS' };
    }
    const result = await cache.getOrLoad(target, kind, async () => {
      const remote = await fetchExternal(target, requestOptions);
      const contentType = remote.headers.get('content-type') || '';
      const contentLength = nonNegativeInteger(remote.headers.get('content-length'), null);
      const cacheable = remote.ok
        && (contentType.toLowerCase().startsWith('image/') || contentType.toLowerCase().startsWith('video/'))
        && contentLength !== null
        && contentLength <= maxBytes;
      if (!cacheable) {
        return { passthrough: remote, cacheable: false };
      }
      if (foreground) {
        const cacheCopy = remote.clone();
        return {
          passthrough: remote,
          status: remote.status,
          headers: responseHeaders(remote),
          cacheable: true,
          cacheBody: async () => ({
            status: remote.status,
            headers: responseHeaders(remote),
            body: await readBinaryLimited(cacheCopy, maxBytes),
            cacheable: true,
          }),
        };
      }
      return {
        status: remote.status,
        headers: responseHeaders(remote),
        body: await readBinaryLimited(remote, maxBytes),
        cacheable: true,
      };
    }, { namespace, bypassInflight: foreground, deferStore: foreground });
    cacheStateLog(target, kind, result.state);
    return {
      response: result.passthrough || responseFromCachedDocument(result),
      cacheState: result.state,
    };
  }

  async function readRange({ target, namespace = 'public', range }) {
    if (!cache) return null;
    const ranged = await cache.readRange(target, 'media', { namespace });
    if (!ranged) return null;
    const parsed = parseByteRange(range, ranged.size);
    if (!parsed) return null;
    if (parsed.unsatisfiable) {
      return new Response(null, {
        status: 416,
        headers: {
          'content-range': `bytes */${ranged.size}`,
          'content-type': ranged.entry.headers['content-type'] || 'application/octet-stream',
        },
      });
    }
    const stream = ranged.createStream(parsed.start, parsed.end);
    if (!stream) return null;
    const headers = {
      'content-type': ranged.entry.headers['content-type'] || 'application/octet-stream',
      'content-length': String(parsed.end - parsed.start + 1),
      'content-range': `bytes ${parsed.start}-${parsed.end}/${ranged.size}`,
      'accept-ranges': 'bytes',
    };
    for (const name of ['etag', 'last-modified']) {
      const value = ranged.entry.headers[name];
      if (value) headers[name] = value;
    }
    return new Response(Readable.toWeb(stream), { status: 206, headers });
  }

  async function readCached(target, kind = 'media', namespace = 'public', { bypassInflight = false } = {}) {
    if (!cache) return null;
    const miss = new Error('gateway cache miss');
    miss.code = 'GATEWAY_CACHE_MISS';
    try {
      const result = await cache.getOrLoad(target, kind, async () => { throw miss; }, {
        allowStale: kind !== 'eh-image',
        namespace,
        bypassInflight,
        ignoreFresh: bypassInflight,
      });
      return responseFromCachedDocument(result);
    } catch (error) {
      if (error?.code !== 'GATEWAY_CACHE_MISS') throw error;
      return null;
    }
  }

  async function cacheMedia(target, namespace, response, { bypassInflight = false } = {}) {
    if (!cache) return response;
    const contentType = response.headers.get('content-type') || '';
    const contentLength = nonNegativeInteger(response.headers.get('content-length'), null);
    const mediaType = contentType.toLowerCase();
    const mediaBytes = mediaType.startsWith('video/') ? videoCacheMaxFileBytes : mediaCacheMaxFileBytes;
    const cacheable = response.ok
      && (mediaType.startsWith('image/') || mediaType.startsWith('video/'))
      && contentLength !== null
      && contentLength <= mediaBytes;
    if (!cacheable) return response;
    if (bypassInflight) {
      const cacheCopy = response.clone();
      const result = await cache.getOrLoad(target, 'media', async () => ({
        passthrough: response,
        status: response.status,
        headers: responseHeaders(response),
        cacheable: true,
        cacheBody: async () => ({
          status: response.status,
          headers: responseHeaders(response),
          body: await readBinaryLimited(cacheCopy, mediaBytes),
          cacheable: true,
        }),
      }), {
        namespace,
        bypassInflight: true,
        ignoreFresh: true,
        deferStore: true,
      });
      cacheStateLog(target, 'media', result.state);
      return result.passthrough || responseFromCachedDocument(result);
    }
    const body = await readBinaryLimited(response, mediaBytes);
    const result = await cache.getOrLoad(target, 'media', async () => ({
      status: response.status,
      headers: responseHeaders(response),
      body,
      cacheable: true,
    }), { namespace, bypassInflight });
    cacheStateLog(target, 'media', result.state);
    return responseFromCachedDocument(result);
  }

  async function mediaVariant(source, target, width, namespace) {
    const original = source.response;
    if (!original?.ok || !original.body) return source;
    if (!(original.headers.get('content-type') || '').toLowerCase().startsWith('image/')) return source;

    let variant;
    let sourceBytes = 0;
    const startedAt = Date.now();
    try {
      const body = await readBinaryLimited(original.clone(), imageVariantMaxSourceBytes);
      sourceBytes = body.length;
      variant = await variantLimiter(() => makeImageVariant({
        body,
        contentType: original.headers.get('content-type') || '',
        width,
      }));
    } catch {
      onMetric('image_variant_fallback', {
        source: source.adapter?.name || 'unknown',
        width,
        reason: 'transform-failed',
        durationMs: Date.now() - startedAt,
      });
      return source;
    }
    if (!variant?.usedVariant || !Buffer.isBuffer(variant.body)) {
      onMetric('image_variant_fallback', {
        source: source.adapter?.name || 'unknown',
        width,
        reason: 'not-smaller',
        durationMs: Date.now() - startedAt,
      });
      return source;
    }
    onMetric('image_variant_generated', {
      source: source.adapter?.name || 'unknown',
      width,
      sourceBytes,
      variantBytes: variant.body.length,
      durationMs: Date.now() - startedAt,
    });

    const headers = responseHeaders(original);
    headers['content-type'] = variant.contentType;
    headers['content-length'] = String(variant.body.length);
    const cacheUrl = imageVariantCacheUrl(target, width);
    if (!cache) {
      return {
        ...source,
        response: new Response(variant.body, { status: original.status, statusText: original.statusText, headers }),
      };
    }

    const result = await cache.getOrLoad(cacheUrl, 'media-variant', async () => ({
      status: original.status,
      headers,
      body: variant.body,
      cacheable: true,
    }), { namespace });
    cacheStateLog(target, 'media-variant', result.state);
    return { ...source, response: responseFromCachedDocument(result) };
  }

  function maybeWarmupImageVariants(target, namespace, response, variantWidth) {
    if (variantWidth !== undefined || typeof onImageWarmup !== 'function') return;
    if (!response?.ok) return;
    const contentType = response.headers.get('content-type') || '';
    if (!contentType.toLowerCase().startsWith('image/')) return;
    queueMicrotask(() => {
      onImageWarmup(target, namespace).catch(() => {
        // Background variant warmup must never affect the served response.
      });
    });
  }

  function sliceKey(target, start) {
    return `${String(target)}#slice=${start}`;
  }

  async function fetchSliceIntoCache(target, resolvedUrl, namespace, part, { priority }) {
    if (!cache) return { status: 'failed' };
    const key = sliceKey(target, part.start);
    const existing = await cache.readRange(key, 'media', { namespace });
    if (existing && existing.size === part.end - part.start + 1) return { status: 'cached' };
    try {
      await cache.getOrLoad(key, 'media', async () => {
        const response = await fetchExternal(resolvedUrl, {
          range: `bytes=${part.start}-${part.end}`,
          circuit: false,
          priority,
        });
        if (!response?.ok) throw new Error(`slice ${part.start} fetch failed`);
        const body = await readBinaryLimited(response, sliceSize + 64 * 1024);
        if (body.length !== part.end - part.start + 1) {
          throw new Error(`slice ${part.start} short body`);
        }
        return {
          status: response.status,
          headers: responseHeaders(response),
          body,
          cacheable: true,
        };
      }, { namespace });
      return { status: 'stored' };
    } catch {
      return { status: 'failed' };
    }
  }

  async function readSliceRange(target, namespace, range, size) {
    if (!cache) return null;
    const parsed = parseByteRange(range, size);
    if (!parsed) return null;
    if (parsed.unsatisfiable) {
      return new Response(null, {
        status: 416,
        headers: {
          'content-range': `bytes */${size}`,
          'content-type': 'application/octet-stream',
        },
      });
    }
    const plan = sliceRanges(parsed.start, parsed.end, size, {
      sliceSize,
      lookahead: Math.max(1, parsed.end - parsed.start + 1),
    });
    const slices = [];
    for (const part of plan.ranges) {
      const ranged = await cache.readRange(sliceKey(target, part.start), 'media', { namespace });
      if (!ranged || ranged.size !== part.end - part.start + 1) return null;
      slices.push({ ranged, part });
    }
    if (!slices.length) return null;
    const headers = {
      'content-type': slices[0].ranged.entry.headers['content-type'] || 'application/octet-stream',
      'content-length': String(parsed.end - parsed.start + 1),
      'content-range': `bytes ${parsed.start}-${parsed.end}/${size}`,
      'accept-ranges': 'bytes',
    };
    for (const name of ['etag', 'last-modified']) {
      const value = slices[0].ranged.entry.headers[name];
      if (value) headers[name] = value;
    }
    async function* bytes() {
      for (let index = 0; index < slices.length; index += 1) {
        const { ranged, part } = slices[index];
        const from = index === 0 ? parsed.start - part.start : 0;
        const to = index === slices.length - 1 ? parsed.end - part.start : part.end - part.start;
        const stream = ranged.createStream(from, to);
        if (!stream) throw new Error('slice stream unavailable');
        for await (const chunk of stream) yield chunk;
      }
    }
    return new Response(Readable.toWeb(Readable.from(bytes())), { status: 206, headers });
  }

  async function fillVideoSlices(target, resolvedUrl, size, namespace, parsed, maxSliceBytes = videoCacheMaxFileBytes, options = {}) {
    if (!cache) return;
    const { shouldStop } = options;
    const plan = sliceRanges(parsed.start, parsed.end, size, { sliceSize, lookahead: sliceLookaheadBytes });
    if (!plan.ranges.length || plan.ranges[0].start >= maxSliceBytes) return;
    const missing = [];
    for (const part of plan.ranges) {
      if (part.start >= maxSliceBytes) break;
      if (shouldStop?.()) return;
      const existing = await cache.readRange(sliceKey(target, part.start), 'media', { namespace });
      if (!existing || existing.size !== part.end - part.start + 1) missing.push(part);
    }
    if (!missing.length) return;
    let next = 0;
    async function worker() {
      while (next < missing.length) {
        if (shouldStop?.()) return;
        const part = missing[next];
        next += 1;
        try {
          await fetchSliceIntoCache(target, resolvedUrl, namespace, part, { priority: 'background' });
        } catch {
          // Slice fill failures are background noise; the upstream path still works.
        }
      }
    }
    const workers = [];
    for (let index = 0; index < Math.min(sliceFillConcurrency, missing.length); index += 1) {
      workers.push(worker());
    }
    await Promise.all(workers);
  }

  async function prefetchVideoFile(target, { size, shouldStop } = {}) {
    if (!cache || !isVideoTarget(target)) return 0;
    const inflight = videoPrefetchInflight.get(target);
    if (inflight) return inflight;
    const state = { status: 'running', fetched: 0, failed: 0, total: null, startedAt: now(), completedAt: null };
    videoPrefetchStates.set(target, state);
    if (videoPrefetchStates.size > PREFETCH_STATES_CAP) {
      videoPrefetchStates.delete(videoPrefetchStates.keys().next().value);
    }
    const promise = (async () => {
      try {
        const resolved = await resolveMediaUrl(target);
        if (!resolved?.url) return 0;
        let fileSize = Number.isSafeInteger(size) && size > 0 ? size : knownVideoSize(target);
        if (!(Number.isSafeInteger(fileSize) && fileSize > 0)) {
          const probe = await fetchExternal(resolved.url, {
            range: 'bytes=0-0',
            circuit: false,
            priority: 'background',
          });
          const probeRange = (probe.headers.get('content-range') || '').match(/\/(\d+)\s*$/);
          const probedSize = probeRange ? Number(probeRange[1]) : null;
          await probe.body?.cancel();
          if (!(Number.isSafeInteger(probedSize) && probedSize > 0)) return 0;
          fileSize = probedSize;
        }
        rememberVideoSize(target, fileSize);
        const plan = sliceRanges(0, fileSize - 1, fileSize, { sliceSize, lookahead: fileSize });
        if (!plan.ranges.length) return 0;
        state.total = plan.ranges.length;
        let next = 0;
        async function worker() {
          while (next < plan.ranges.length) {
            if (shouldStop?.()) return;
            const part = plan.ranges[next];
            next += 1;
            if (part.start >= videoCacheMaxFileBytes) continue;
            const existing = await cache.readRange(sliceKey(target, part.start), 'media', { namespace: 'public' });
            if (existing && existing.size === part.end - part.start + 1) continue;
            try {
              const result = await fetchSliceIntoCache(target, resolved.url, 'public', part, { priority: 'background' });
              if (result.status === 'cached') continue;
              if (result.status === 'stored') state.fetched += 1;
              else state.failed += 1;
            } catch {
              // Background prefetch failures must never surface.
              state.failed += 1;
            }
          }
        }
        const workers = [];
        for (let index = 0; index < Math.min(prefetchConcurrency, plan.ranges.length); index += 1) {
          workers.push(worker());
        }
        await Promise.all(workers);
        if (state.failed > 0) {
          logger.warn('media_prefetch_partial', { target, fetched: state.fetched, failed: state.failed, total: plan.ranges.length });
        }
        if (state.fetched > 0) onMetric('media_prefetch_slices', { count: state.fetched, total: plan.ranges.length });
        return state.fetched;
      } finally {
        state.status = 'done';
        state.completedAt = now();
        videoPrefetchInflight.delete(target);
      }
    })();
    videoPrefetchInflight.set(target, promise);
    return promise;
  }

  function prefetchStatus(target) {
    const state = videoPrefetchStates.get(target);
    if (!state) return null;
    return {
      status: state.status,
      fetchedSlices: state.fetched,
      totalSlices: state.total,
      failedSlices: state.failed,
      startedAt: state.startedAt,
      completedAt: state.completedAt,
    };
  }

  async function assembleSliceRange(target, resolvedUrl, namespace, parsed, size) {
    if (!cache) return null;
    const plan = sliceRanges(parsed.start, parsed.end, size, {
      sliceSize,
      lookahead: Math.max(1, parsed.end - parsed.start + 1),
    });
    if (plan.ranges.length < 2 || plan.ranges.some((part) => part.start >= videoCacheMaxFileBytes)) return null;
    const parts = [];
    for (const part of plan.ranges) {
      const existing = await cache.readRange(sliceKey(target, part.start), 'media', { namespace });
      const ranged = existing && existing.size === part.end - part.start + 1 ? existing : null;
      const item = { part, ranged, error: null, ready: null, settle: null };
      if (!ranged) item.ready = new Promise((resolve) => { item.settle = resolve; });
      parts.push(item);
    }
    let nextMissing = 0;
    async function worker() {
      while (nextMissing < parts.length) {
        const item = parts[nextMissing];
        nextMissing += 1;
        if (item.ranged) continue;
        try {
          const result = await fetchSliceIntoCache(target, resolvedUrl, namespace, item.part, { priority: 'foreground' });
          if (result.status === 'failed') throw new Error(`slice ${item.part.start} fetch failed`);
          const stored = await cache.readRange(sliceKey(target, item.part.start), 'media', { namespace });
          if (!stored || stored.size !== item.part.end - item.part.start + 1) {
            throw new Error(`slice ${item.part.start} not stored`);
          }
          item.ranged = stored;
        } catch (error) {
          item.error = error;
        } finally {
          item.settle?.();
        }
      }
    }
    const missingCount = parts.filter((item) => !item.ranged).length;
    if (missingCount) {
      for (let index = 0; index < clamp(sliceFillConcurrency, 1, missingCount); index += 1) {
        void worker();
      }
    }
    // Resolve every missing slice before committing to a 206 with a fixed
    // content-length: a mid-stream failure would otherwise truncate a body the
    // client already trusts. On any failure, fall back to the single-range
    // fetch path instead of emitting a corrupt range response.
    await Promise.all(parts.filter((item) => !item.ranged).map((item) => item.ready));
    if (parts.some((item) => !item.ranged)) return null;
    async function* bytes() {
      for (let index = 0; index < parts.length; index += 1) {
        const item = parts[index];
        if (!item.ranged) {
          await item.ready;
          if (item.error) throw item.error;
        }
        const from = index === 0 ? parsed.start - item.part.start : 0;
        const to = index === parts.length - 1 ? parsed.end - item.part.start : item.part.end - item.part.start;
        const stream = item.ranged.createStream(from, to);
        if (!stream) throw new Error('slice stream unavailable');
        for await (const chunk of stream) yield chunk;
      }
    }
    const headers = {
      'content-type': parts[0].ranged.entry.headers['content-type'] || 'video/mp4',
      'content-length': String(parsed.end - parsed.start + 1),
      'content-range': `bytes ${parsed.start}-${parsed.end}/${size}`,
      'accept-ranges': 'bytes',
    };
    for (const name of ['etag', 'last-modified']) {
      const value = parts[0].ranged.entry.headers[name];
      if (value) headers[name] = value;
    }
    onMetric('media_range_assembled', { count: parts.length });
    return new Response(Readable.toWeb(Readable.from(bytes())), { status: 206, headers });
  }

  async function serveIwaraVideo(target, requestOptions, routeMetadata) {
    if (requestOptions.range) {
      const ranged = await readRange({ target, namespace: 'public', range: requestOptions.range });
      if (ranged) return { adapter: { name: 'iwara' }, egressScope: 'public', response: ranged };
      const rawRange = String(requestOptions.range || '').match(/^bytes=(\d+)-(\d+)$/);
      const rawLength = rawRange ? Number(rawRange[2]) - Number(rawRange[1]) + 1 : 0;
      let knownSize = knownVideoSize(target);
      if (!(Number.isSafeInteger(knownSize) && knownSize > 0) && rawLength >= sliceSize) {
        const resolvedForProbe = await resolveMediaUrl(target);
        if (resolvedForProbe?.url) {
          const probe = await fetchExternal(resolvedForProbe.url, {
            range: 'bytes=0-0',
            circuit: false,
            priority: 'background',
          });
          const probeRange = (probe.headers.get('content-range') || '').match(/\/(\d+)\s*$/);
          const probedSize = probeRange ? Number(probeRange[1]) : null;
          await probe.body?.cancel();
          if (Number.isSafeInteger(probedSize) && probedSize > 0) {
            knownSize = probedSize;
            rememberVideoSize(target, probedSize);
          }
        }
      }
      if (Number.isSafeInteger(knownSize) && knownSize > 0) {
        const sliced = await readSliceRange(target, 'public', requestOptions.range, knownSize);
        if (sliced) return { adapter: { name: 'iwara' }, egressScope: 'public', response: sliced };
        const parsed = parseByteRange(requestOptions.range, knownSize);
        if (parsed && !parsed.unsatisfiable) {
          const resolved = await resolveMediaUrl(target);
          if (resolved?.url) {
            const assembled = await assembleSliceRange(target, resolved.url, 'public', parsed, knownSize);
            if (assembled) return { adapter: { name: 'iwara' }, egressScope: 'public', response: assembled };
            fillVideoSlices(target, resolved.url, knownSize, 'public', parsed).catch(() => {
              // Background slice fill must never affect the served response.
            });
          }
        }
      }
      const resolved = await resolveMediaUrl(target);
      if (!resolved?.url) return { adapter: { name: 'iwara' }, egressScope: 'public', response: unavailableResponse() };
      const remote = await fetchExternal(resolved.url, { ...requestOptions, circuit: false, priority: 'foreground' });
      if (cache && remote.ok) {
        const contentRange = remote.headers.get('content-range') || '';
        const match = contentRange.match(/\/(\d+)\s*$/);
        const size = match ? Number(match[1]) : null;
        if (Number.isSafeInteger(size) && size > 0) {
          rememberVideoSize(target, size);
          const parsed = parseByteRange(requestOptions.range, size);
          if (parsed && !parsed.unsatisfiable) {
            // First play-through of a cacheable video: fill the covering slices
            // (plus a lookahead window) in the background with parallel range
            // requests so every later seek is served from the gateway cache
            // instead of repeating upstream range fetches.
            fillVideoSlices(target, resolved.url, size, 'public', parsed).catch(() => {
              // Background slice fill must never affect the served response.
            });
          }
        }
      }
      return { adapter: { name: 'iwara' }, egressScope: 'public', response: remote };
    }
    const cached = await readCached(target, 'media', 'public', { bypassInflight: true });
    if (cached) return { adapter: { name: 'iwara' }, egressScope: 'public', response: cached };
    const resolved = await resolveMediaUrl(target);
    if (!resolved?.url) return { adapter: { name: 'iwara' }, egressScope: 'public', response: unavailableResponse() };
    const remote = await fetchExternal(resolved.url, { ...requestOptions, circuit: false, priority: 'foreground' });
    if (!remote.ok) return { adapter: { name: 'iwara' }, egressScope: 'public', response: remote };
    const source = {
      adapter: { name: 'iwara' },
      egressScope: 'public',
      response: await cacheMedia(target, 'public', remote, { bypassInflight: true }),
    };
    return source;
  }

  async function serve(target, requestOptions = {}, routeMetadata = {}, variantWidth) {
    if (isVideoTarget(target)) return serveIwaraVideo(target, requestOptions, routeMetadata);
    const adapter = routeMetadata.adapter || adapterFor(target);
    const bypassInflight = requestOptions?.priority === 'foreground';
    const requestedScope = routeMetadata.egressScope === 'session'
      ? 'session'
      : (routeMetadata.egressScope === 'sticky' ? 'sticky' : 'public');
    if (requestedScope === 'session') {
      const session = routeMetadata.session || await resolveSession(adapter);
      if (!session) return { adapter, unavailable: true, egressScope: 'session' };
      const namespace = namespaceFor('session', session);
      if (requestOptions.range) {
        const ranged = await readRange({ target, namespace, range: requestOptions.range });
        if (ranged) return { adapter, egressScope: 'session', session, response: ranged };
        return routeRequest(target, requestOptions, routeMetadata);
      }
      if (variantWidth && cache) {
        const cachedVariant = await readCached(imageVariantCacheUrl(target, variantWidth), 'media-variant', namespace, { bypassInflight });
        if (cachedVariant) {
          onMetric('image_variant_hit', { source: adapter.name, width: variantWidth });
          return { adapter, egressScope: 'session', session, response: cachedVariant };
        }
      }
      const cached = await readCached(target, 'media', namespace, { bypassInflight });
      if (cached) {
        const source = { adapter, egressScope: 'session', session, response: cached };
        if (variantWidth) return mediaVariant(source, target, variantWidth, namespace);
        maybeWarmupImageVariants(target, namespace, cached, variantWidth);
        return source;
      }
      const routed = await routeRequest(target, requestOptions, routeMetadata);
      const source = { ...routed, response: await cacheMedia(target, namespace, routed.response, { bypassInflight }) };
      if (variantWidth) return mediaVariant(source, target, variantWidth, namespace);
      maybeWarmupImageVariants(target, namespace, source.response, variantWidth);
      return source;
    }

    if (requestOptions.range) {
      const ranged = await readRange({ target, namespace: 'public', range: requestOptions.range });
      if (ranged) return { adapter, egressScope: requestedScope, response: ranged };
      return routeRequest(target, requestOptions, routeMetadata);
    }
    if (variantWidth && cache) {
      const cachedVariant = await readCached(imageVariantCacheUrl(target, variantWidth), 'media-variant', 'public', { bypassInflight });
      if (cachedVariant) {
        onMetric('image_variant_hit', { source: adapter.name, width: variantWidth });
        return { adapter, egressScope: 'public', response: cachedVariant };
      }
    }
    const publicCached = await readCached(target, 'media', 'public', { bypassInflight });
    if (publicCached) {
      const source = { adapter, egressScope: 'public', response: publicCached };
      if (variantWidth) return mediaVariant(source, target, variantWidth, 'public');
      maybeWarmupImageVariants(target, 'public', publicCached, variantWidth);
      return source;
    }
    const routed = await routeRequest(target, requestOptions, routeMetadata);
    if (routed.unavailable) return routed;
    const namespace = namespaceFor(routed.egressScope, routed.session);
    const source = { ...routed, response: await cacheMedia(target, namespace, routed.response, { bypassInflight }) };
    if (variantWidth) return mediaVariant(source, target, variantWidth, namespace);
    maybeWarmupImageVariants(target, namespace, source.response, variantWidth);
    return source;
  }

  async function probeSize(target, { namespace = 'public' } = {}) {
    if (cache) {
      const ranged = await cache.readRange(target, 'media', { namespace });
      if (ranged) return ranged.size;
    }
    try {
      const probeUrl = isVideoTarget(target)
        ? (await resolveMediaUrl(target))?.url
        : target;
      if (!probeUrl) return null;
      const probe = await fetchExternal(probeUrl, {
        range: 'bytes=0-0',
        circuit: false,
        priority: 'background',
      });
      const contentRange = probe.headers.get('content-range') || '';
      const match = contentRange.match(/\/(\d+)\s*$/);
      if (!match) return null;
      const size = Number(match[1]);
      if (Number.isSafeInteger(size) && size > 0) rememberVideoSize(target, size);
      return size;
    } catch {
      return null;
    }
  }

  function chunkManifest({ target, size, chunks, secret, baseUrl, metadata = {} }) {
    const urls = [];
    for (let index = 0; index < chunks.count; index += 1) {
      const start = index * chunks.size;
      const end = Math.min(size - 1, start + chunks.size - 1);
      const token = createSignedChunk({
        url: target,
        start,
        end,
        secret,
        metadata: { ...metadata },
      });
      urls.push(`${String(baseUrl).replace(/\/$/, '')}/_gateway/chunk/${token}`);
    }
    return { size, chunkSize: chunks.size, count: chunks.count, urls };
  }

  return {
    load,
    readCached,
    readRange,
    cacheMedia,
    mediaVariant,
    serve,
    probeSize,
    chunkManifest,
    imageVariantCacheUrl,
    fillVideoSlices,
    prefetchVideoFile,
    prefetchStatus,
    sliceKey,
    rememberVideoSize,
    knownVideoSize,
  };
}

function unavailableResponse() {
  return new Response('video unavailable\n', {
    status: 502,
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  });
}
