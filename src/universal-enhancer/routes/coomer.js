import { coomerTarget, renderCoomerFeed } from '../../../sidecar/fetcher-coomer/fetcher.js';

export const routes = [
  {
    path: '/coomer/:source?/:id?',
    name: 'Coomer 创作者动态',
    example: '/coomer/posts',
    parameters: {
      source: '平台来源 (posts, onlyfans, fansly, patreon 等，缺省 posts)',
      id: '创作者 ID',
    },
    cacheTtl: 900,
    handler: async (ctx) => {
      const target = coomerTarget('/coomer/:source?/:id?', ctx.params, ctx.query);
      const data = await ctx.fetchJson(target.apiUrl, {
        headers: { Accept: 'application/json' },
      });
      const items = Array.isArray(data) ? data : (data?.posts || []);
      const rssXml = renderCoomerFeed({
        title: target.title,
        siteUrl: target.siteUrl,
        items,
      });
      return { rssXml, mediaUrls: [], cacheHint: { ttl: 900 } };
    },
  },
];

export default routes;
