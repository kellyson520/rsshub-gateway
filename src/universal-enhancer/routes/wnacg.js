import { wnacgTarget, parseList, renderFeed as renderWnacgFeed } from '../../../sidecar/fetcher-wnacg/fetcher.js';

export const routes = [
  {
    path: '/wnacg/home/:cid?/:tag?',
    name: 'WNACG 绅士漫画',
    example: '/wnacg/home',
    parameters: {
      cid: '分类代号 (all, zh-doujin, doujin-cg, cosplay, tankobon 等)',
      tag: '标签关键词',
    },
    cacheTtl: 900,
    handler: async (ctx) => {
      const target = wnacgTarget('/wnacg/home/:cid?/:tag?', ctx.params);
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
      const rssXml = renderWnacgFeed({
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
