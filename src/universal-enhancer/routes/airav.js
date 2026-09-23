import { airavTarget, parseVideoList, renderAiravFeed } from '../../../sidecar/fetcher-airav/fetcher.js';

export const routes = [
  {
    path: '/airav/home',
    name: 'AIrav 最新發行',
    example: '/airav/home',
    cacheTtl: 900,
    handler: async (ctx) => {
      const target = airavTarget('/airav/home');
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
      const rssXml = renderAiravFeed({
        title: target.title,
        siteUrl: target.url,
        items,
      });
      const mediaUrls = items.map((i) => i.cover).filter(Boolean);
      return { rssXml, mediaUrls, cacheHint: { ttl: 900 } };
    },
  },
];

export default routes;
