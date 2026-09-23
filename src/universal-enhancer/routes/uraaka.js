import { uraakaTarget, parseList, renderFeed as renderUraakaFeed } from '../../../sidecar/fetcher-uraaka/fetcher.js';

export const routes = [
  {
    path: '/uraaka/home',
    name: '裏垢女子写真合集',
    example: '/uraaka/home',
    cacheTtl: 3600,
    handler: async (ctx) => {
      const target = uraakaTarget('/uraaka/home');
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

      const items = parseList(html);
      const rssXml = renderUraakaFeed({
        title: target.title,
        siteUrl: target.url,
        items,
      });
      const mediaUrls = items.map((i) => i.cover).filter(Boolean);
      return { rssXml, mediaUrls, cacheHint: { ttl: 3600 } };
    },
  },
];

export default routes;
