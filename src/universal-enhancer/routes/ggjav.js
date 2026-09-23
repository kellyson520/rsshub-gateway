import { ggjavTarget, parseVideoList, renderGgjavFeed } from '../../../sidecar/fetcher-ggjav/fetcher.js';

export const routes = [
  {
    path: '/ggjav/home/:page?',
    name: 'GGJAV 最新發布',
    example: '/ggjav/home',
    parameters: { page: '页码' },
    cacheTtl: 900,
    handler: async (ctx) => {
      const target = ggjavTarget('/ggjav/home/:page?', ctx.params, ctx.query);
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
      const rssXml = renderGgjavFeed({
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
