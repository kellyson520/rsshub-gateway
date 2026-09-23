import { kemonoTarget, parsePost, renderKemonoFeed } from '../../../sidecar/fetcher-kemono/fetcher.js';

export const routes = [
  {
    path: '/kemono/:source?/:id?/:type?',
    name: 'Kemono 创作者与近期帖子',
    example: '/kemono/posts',
    parameters: {
      source: '平台来源 (posts, patreon, fanbox, gumroad, discord 等，缺省 posts)',
      id: '创作者 ID',
      type: '类型 (announcements, fancards 或空)',
    },
    cacheTtl: 900,
    handler: async (ctx) => {
      const target = kemonoTarget('/kemono/:source?/:id?/:type?', ctx.params, ctx.query);
      const data = await ctx.fetchJson(target.apiUrl, {
        headers: { Accept: 'application/json' },
      });
      const rawPosts = Array.isArray(data) ? data : (data?.posts || []);
      const items = rawPosts.map((p) => parsePost(p, target.source, target.id));
      const rssXml = renderKemonoFeed({
        title: target.title,
        siteUrl: target.siteUrl,
        items,
        source: target.source,
      });
      return { rssXml, mediaUrls: [], cacheHint: { ttl: 900 } };
    },
  },
];

export default routes;
