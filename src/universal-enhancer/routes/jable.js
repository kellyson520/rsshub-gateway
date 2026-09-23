import { jableTarget, parseVideoList, renderJableFeed } from '../../../sidecar/fetcher-jable/fetcher.js';

export const routes = [
  {
    path: '/jable/new-release/:page?',
    name: 'Jable 新作上市',
    example: '/jable/new-release',
    parameters: { page: '页码' },
    cacheTtl: 900,
    handler: async (ctx) => {
      const target = jableTarget('/jable/new-release/:page?', ctx.params);
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
      const rssXml = renderJableFeed({
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
