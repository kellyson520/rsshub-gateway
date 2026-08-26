import { mapWithConcurrency } from './http-utils.js';

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
const MEDIA_CONCURRENCY = 8;
const DEFAULT_BENCHMARK_VARIANT_WIDTH = 1920;

export {
  LOCAL_HOSTS,
  MEDIA_CONCURRENCY,
  DEFAULT_BENCHMARK_VARIANT_WIDTH,
  localGatewayUrl,
  mediaUrls,
  mapWithConcurrency,
  numericContentLength,
  durationCheckpoint,
  variantUrl,
};

function localGatewayUrl(value) {
  let target;
  try {
    target = new URL(value);
  } catch {
    target = null;
  }
  if (!target || !['http:', 'https:'].includes(target.protocol) || !LOCAL_HOSTS.has(target.hostname)
    || target.username || target.password || !target.pathname.startsWith('/_gateway/item/')) {
    const error = new Error('a local gateway item URL is required');
    error.code = 'BENCHMARK_LOCAL_GATEWAY_REQUIRED';
    throw error;
  }
  return target;
}

function mediaUrls(html, baseUrl) {
  const urls = new Set();
  for (const match of String(html || '').matchAll(/<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi)) {
    try {
      const target = new URL(match[1], baseUrl);
      if (target.origin === baseUrl.origin && target.pathname.startsWith('/_gateway/media/')) urls.add(target.toString());
    } catch {
      // Ignore malformed or external markup.
    }
  }
  return [...urls];
}

function numericContentLength(response) {
  const value = Number.parseInt(response.headers.get('content-length') || '', 10);
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function durationCheckpoint(results, count) {
  if (!count) return 0;
  return Math.max(...results
    .map((result) => result.completedAt)
    .sort((left, right) => left - right)
    .slice(0, count));
}

function variantUrl(original, width = DEFAULT_BENCHMARK_VARIANT_WIDTH) {
  const target = new URL(original);
  target.searchParams.set('w', String(width));
  return target.toString();
}

export async function benchmarkGallery({ gatewayUrl, fetchImpl = fetch, now = () => Date.now() } = {}) {
  const itemUrl = localGatewayUrl(gatewayUrl);
  const startedAt = now();
  const itemResponse = await fetchImpl(itemUrl, { headers: { 'accept-encoding': 'identity' } });
  const html = await itemResponse.text();
  const htmlMs = Math.max(0, now() - startedAt);
  const originals = mediaUrls(html, itemUrl);

  const sourceSizes = await mapWithConcurrency(originals, MEDIA_CONCURRENCY, async (url) => {
    try {
      const response = await fetchImpl(url, { method: 'HEAD', headers: { 'accept-encoding': 'identity' } });
      return numericContentLength(response);
    } catch {
      return 0;
    }
  });
  const mediaStartedAt = now();
  const variants = await mapWithConcurrency(originals.map(variantUrl), MEDIA_CONCURRENCY, async (url) => {
    try {
      const response = await fetchImpl(url, { headers: { 'accept-encoding': 'identity' } });
      const body = Buffer.from(await response.arrayBuffer());
      return { status: response.status, bytes: body.length, completedAt: Math.max(0, now() - mediaStartedAt) };
    } catch {
      return { status: 0, bytes: 0, completedAt: Math.max(0, now() - mediaStartedAt) };
    }
  });
  const statusCounts = {};
  for (const result of variants) statusCounts[result.status] = (statusCounts[result.status] || 0) + 1;
  const originalBytes = sourceSizes.reduce((total, bytes) => total + bytes, 0);
  const variantBytes = variants.reduce((total, result) => total + result.bytes, 0);
  const variantSavedPercent = originalBytes > 0
    ? Number((((originalBytes - variantBytes) / originalBytes) * 100).toFixed(2))
    : 0;
  const firstScreenCount = Math.min(8, variants.length);
  const quarterCount = Math.ceil(variants.length / 4);

  return {
    htmlMs,
    firstScreenMs: durationCheckpoint(variants, firstScreenCount),
    quarterReadyMs: durationCheckpoint(variants, quarterCount),
    allReadyMs: durationCheckpoint(variants, variants.length),
    originalBytes,
    variantBytes,
    variantSavedPercent,
    statusCounts,
  };
}
