import { javdbTarget, parseVideoList, renderJavdbFeed } from '../../../sidecar/fetcher-javdb/fetcher.js';

export const routes = [
  {
    path: '/javdb/home/:category?/:sort?/:filter?',
    name: 'JavDB 主页最新影片',
    example: '/javdb/home',
    parameters: {
      category: '分类 (censored, uncensored, western)',
      sort: '排序 (magnet-update, release-date, score, views)',
      filter: '过滤 (downloadable, subbed, hd)',
    },
    cacheTtl: 900,
    handler: async (ctx) => {
      const target = javdbTarget('/javdb/home/:category?/:sort?/:filter?', ctx.params, ctx.query);
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
      const rssXml = renderJavdbFeed({
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
