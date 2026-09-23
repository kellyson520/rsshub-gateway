import { skebTarget, renderFeed as renderSkebFeed } from '../../../sidecar/fetcher-skeb/fetcher.js';

export const routes = [
  {
    path: '/skeb/:category',
    name: 'Skeb 插画与作品',
    example: '/skeb/art',
    parameters: {
      category: '分类 (art, illust, voice, novel, video, music, comic, popular 等)',
    },
    cacheTtl: 3600,
    handler: async (ctx) => {
      const target = skebTarget('/skeb/:category', ctx.params);
      const data = await ctx.fetchJson(target.apiUrl, {
        headers: { Accept: 'application/json' },
      });
      const items = Array.isArray(data) ? data : (data?.works || []);
      const rssXml = renderSkebFeed({
        title: target.title,
        siteUrl: target.siteUrl,
        items,
        categoryName: target.categoryName,
      });
      return { rssXml, mediaUrls: [], cacheHint: { ttl: 3600 } };
    },
  },
];

export default routes;
