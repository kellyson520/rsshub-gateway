import { parseDlsiteWorks, renderDlsiteFeed, TYPE_NAMES, PERIOD_NAMES } from '../../../sidecar/fetcher-dlsite/fetcher.js';

const SITE_BASE = 'https://www.dlsite.com';

export const routes = [
  {
    path: '/dlsite/ranking/:type?/:period?',
    name: 'DLsite 销量榜单',
    example: '/dlsite/ranking/maniax/day',
    parameters: {
      type: '类型 (maniax, comic, voice, game, books, pro 等，缺省 maniax)',
      period: '周期 (day, week, month 等，缺省 day)',
    },
    cacheTtl: 1800,
    handler: async (ctx) => {
      const type = ctx.params.type || 'maniax';
      const period = ctx.params.period || 'day';
      const targetUrl = `${SITE_BASE}/${encodeURIComponent(type)}/ranking/${encodeURIComponent(period)}`;
      const title = `DLsite ${TYPE_NAMES[type] || type} ${PERIOD_NAMES[period] || period}`;
      const description = `DLsite 官方排行榜 (${TYPE_NAMES[type] || type} / ${PERIOD_NAMES[period] || period})`;

      const res = await ctx.fetch(targetUrl, {
        headers: {
          'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'accept-language': 'zh-CN,zh;q=0.9,ja;q=0.8',
        },
      });
      const html = await res.text();
      const works = parseDlsiteWorks(html);
      const rssXml = renderDlsiteFeed({
        title,
        description,
        selfUrl: `/dlsite/ranking/${type}/${period}`,
        works,
      });
      const mediaUrls = works.map((w) => w.poster).filter(Boolean);
      return { rssXml, mediaUrls, cacheHint: { ttl: 1800 } };
    },
  },
];

export default routes;
