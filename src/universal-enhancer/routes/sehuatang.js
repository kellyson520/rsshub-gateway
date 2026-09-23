import { sehuatangTarget, parseList, renderFeed as renderSehuatangFeed } from '../../../sidecar/fetcher-sehuatang/fetcher.js';

export const routes = [
  {
    path: '/sehuatang/:subforumid?',
    name: '98堂 色花堂 论坛帖子',
    example: '/sehuatang/103',
    parameters: {
      subforumid: '版块 ID 或简拼 (gcyc:2, yzwmyc:36, yzymyc:37, gqzwzm:103 等)',
    },
    cacheTtl: 3600,
    handler: async (ctx) => {
      const target = sehuatangTarget('/sehuatang/:subforumid?', ctx.params);
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
      const rssXml = renderSehuatangFeed({
        title: target.title,
        siteUrl: target.siteUrl,
        items,
      });
      const mediaUrls = items.map((i) => i.cover).filter(Boolean);
      return { rssXml, mediaUrls, cacheHint: { ttl: 3600 } };
    },
  },
];

export default routes;
