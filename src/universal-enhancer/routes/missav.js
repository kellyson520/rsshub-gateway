import { missavTarget, parseVideoList, renderMissavFeed } from '../../../sidecar/fetcher-missav/fetcher.js';

export const routes = [
  {
    path: '/missav/new/:page?',
    name: 'MissAV 最近更新',
    example: '/missav/new',
    parameters: { page: '页码' },
    cacheTtl: 900,
    handler: async (ctx) => {
      const target = missavTarget('/missav/new/:page?', ctx.params);
      let html = '';
      try {
        const rendered = await ctx.fetchRendered(target.url);
        html = rendered?.html || '';
      } catch {
        const res = await ctx.fetch(target.url, {
          headers: {
            'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          },
        });
        html = await res.text();
      }

      const items = parseVideoList(html);
      const rssXml = renderMissavFeed({
        title: target.title,
        siteUrl: target.url,
        items,
      });
      const mediaUrls = items.map((i) => i.poster).filter(Boolean);
      return { rssXml, mediaUrls, cacheHint: { ttl: 900 } };
    },
  },
];

export default routes;
