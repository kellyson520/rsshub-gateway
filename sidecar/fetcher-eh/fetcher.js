import { HttpError } from '../../src/fetcher-server.js';

export { HttpError };
import {
  parseRankingHtml,
  rankingTarget,
  renderRankingFeed,
} from '../../src/adapters/ehviewer.js';

const SUPPORTED_ROUTE_IDS = new Set(['/ehviewer/ranking/:period?', '/ehviewer/ranking']);
const PERIODS = new Set(['day', 'month', 'year', 'all']);
const DEFAULT_CACHE_TTL = 300;

export function createEhFetcher({ fetchHtml } = {}) {
  async function handleFetch(body) {
    const routeId = String(body?.routeId || '');
    const params = body?.params || {};
    if (!SUPPORTED_ROUTE_IDS.has(routeId)) {
      throw new HttpError(400, `unsupported routeId: ${routeId}`);
    }
    const period = String(params.period || 'day').trim() || 'day';
    if (!PERIODS.has(period)) throw new HttpError(400, `unsupported period: ${period}`);
    let remote;
    try {
      remote = await fetchHtml(rankingTarget(period));
    } catch (error) {
      throw new HttpError(502, `e-hentai upstream failed: ${error.message}`);
    }
    if (!remote?.ok) throw new HttpError(502, `e-hentai returned ${remote?.status || 'unknown'}`);
    const html = await remote.text();
    const { items } = parseRankingHtml(html, { period });
    const rssXml = renderRankingFeed({ period, items });
    const mediaUrls = items.map((item) => item.thumbnail).filter(Boolean);
    const cacheTtl = Number.isInteger(body?.cacheTtl) && body.cacheTtl > 0 ? body.cacheTtl : DEFAULT_CACHE_TTL;
    return { rssXml, mediaUrls, cacheHint: { ttl: cacheTtl } };
  }

  return { handleFetch };
}
