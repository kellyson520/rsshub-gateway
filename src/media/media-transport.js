import { Readable } from 'node:stream';

const CACHE_RESPONSE_HEADERS = ['content-type', 'content-length', 'etag', 'last-modified', 'cache-control'];
const IMAGE_VARIANT_CACHE_VERSION = 'v1';
const SLICE_ALIGN = 64 * 1024;

export function sliceRanges(start, end, size, {
  sliceSize = 4 * 1024 * 1024,
  lookahead = 16 * 1024 * 1024,
} = {}) {
  const slice = Math.max(SLICE_ALIGN, Math.ceil(sliceSize / SLICE_ALIGN) * SLICE_ALIGN);
  const from = Math.max(0, Number(start) || 0);
  const to = Math.min(size - 1, Number(end) ?? size - 1);
  if (from > to || !Number.isSafeInteger(size) || size <= 0) return { slice, ranges: [] };
  const firstIndex = Math.floor(from / slice);
  const prefetchEnd = Math.min(size - 1, Math.max(to, firstIndex * slice + lookahead - 1));
  const lastIndex = Math.floor(prefetchEnd / slice);
  const ranges = [];
  for (let index = firstIndex; index <= lastIndex; index += 1) {
    ranges.push({ start: index * slice, end: Math.min(size - 1, index * slice + slice - 1), index });
  }
  return { slice, ranges };
}

export function responseHeaders(response) {
  const headers = {};
  for (const name of CACHE_RESPONSE_HEADERS) {
    const value = response.headers.get(name);
    if (value) headers[name] = value;
  }
  return headers;
}

export function responseFromCachedDocument(result) {
  return new Response(result.body, { status: result.status, headers: result.headers });
}

export function imageVariantCacheUrl(target, width) {
  const cacheUrl = new URL(target);
  cacheUrl.hash = `rsshub-gateway-${IMAGE_VARIANT_CACHE_VERSION}-w${width}`;
  return cacheUrl.toString();
}

export function parseByteRange(value, size) {
  const match = String(value || '').trim().match(/^bytes=(\d*)-(\d*)$/);
  if (!match) return null;
  const [, startText, endText] = match;
  if (startText === '' && endText === '') return null;
  if (startText === '') {
    const suffix = Number.parseInt(endText, 10);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return { unsatisfiable: true };
    const start = Math.max(0, size - suffix);
    return start >= size ? { unsatisfiable: true } : { start, end: size - 1 };
  }
  const start = Number.parseInt(startText, 10);
  if (!Number.isSafeInteger(start) || start < 0 || start >= size) return { unsatisfiable: true };
  const end = endText === '' ? size - 1 : Math.min(Number.parseInt(endText, 10), size - 1);
  if (end < start) return { unsatisfiable: true };
  return { start, end };
}

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
  mediaBrowserCacheSeconds = 300,
  createSignedChunk,
  routeRequest,
  resolveSession = async () => null,
  sessionNamespace = (session) => (session?.fingerprint ? `session:${session.fingerprint}` : 'session'),
  namespaceFor = (scope, session) => (scope === 'session' ? sessionNamespace(session) : scope),
  adapterFor = () => ({ name: 'unknown' }),
  onImageWarmup,
  logger = { info() {}, warn() {}, error() {} },
  onMetric = () => {},
  knownSizeTtlMs = 24 * 60 * 60_000,
  knownSizeCap = 10_000,
  now = () => Date.now(),
} = {}) {
  const knownVideoSizes = new Map();
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
      const contentLength = Number.parseInt(remote.headers.get('content-length') || '', 10);
      const cacheable = remote.ok
        && (contentType.toLowerCase().startsWith('image/') || contentType.toLowerCase().startsWith('video/'))
        && Number.isSafeInteger(contentLength)
        && contentLength >= 0
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
    const contentLength = Number.parseInt(response.headers.get('content-length') || '', 10);
    const mediaType = contentType.toLowerCase();
    const mediaBytes = mediaType.startsWith('video/') ? videoCacheMaxFileBytes : mediaCacheMaxFileBytes;
    const cacheable = response.ok
      && (mediaType.startsWith('image/') || mediaType.startsWith('video/'))
      && Number.isSafeInteger(contentLength)
      && contentLength >= 0
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

  async function storeVideoSlice(target, namespace, range, response) {
    if (!cache || !response?.ok) return false;
    const body = await readBinaryLimited(response, sliceSize + 64 * 1024);
    await cache.getOrLoad(sliceKey(target, range.start), 'media', async () => ({
      status: response.status,
      headers: responseHeaders(response),
      body,
      cacheable: true,
    }), { namespace });
    return true;
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
          const response = await fetchExternal(resolvedUrl, {
            range: `bytes=${part.start}-${part.end}`,
            circuit: false,
            priority: 'background',
          });
          await storeVideoSlice(target, namespace, part, response);
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
          const response = await fetchExternal(resolvedUrl, {
            range: `bytes=${item.part.start}-${item.part.end}`,
            circuit: false,
            priority: 'foreground',
          });
          if (!response?.ok) throw new Error(`slice ${item.part.start} fetch failed`);
          await storeVideoSlice(target, namespace, item.part, response);
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
      for (let index = 0; index < Math.min(Math.max(1, sliceFillConcurrency), missingCount); index += 1) {
        void worker();
      }
    }
    const firstMissing = parts.find((item) => !item.ranged);
    if (firstMissing) {
      await firstMissing.ready;
      if (firstMissing.error) return null;
    }
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
      return match ? Number(match[1]) : null;
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
