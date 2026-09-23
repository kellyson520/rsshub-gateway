import {
  parseRankingHtml,
  rankingTarget,
  renderRankingFeed,
} from '../../../src/adapters/ehviewer.js';

export const routes = [
  {
    path: '/ehviewer/ranking/:period?',
    name: 'E-Hentai 排行榜',
    example: '/ehviewer/ranking/day',
    parameters: {
      period: '统计周期 (day, month, year, all，缺省 day)',
    },
    cacheTtl: 300,
    handler: async (ctx) => {
      const period = ctx.params.period || 'day';
      const targetUrl = rankingTarget(period);
      const res = await ctx.fetch(targetUrl);
      const html = await res.text();
      const { items } = parseRankingHtml(html, { period });
      const rssXml = renderRankingFeed({ period, items });
      const mediaUrls = items.map((item) => item.thumbnail).filter(Boolean);
      return { rssXml, mediaUrls, cacheHint: { ttl: 300 } };
    },
  },
];

export default routes;
