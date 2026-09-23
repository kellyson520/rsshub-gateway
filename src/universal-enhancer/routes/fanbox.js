import { fanboxTarget, renderFeed as renderFanboxFeed } from '../../../sidecar/fetcher-fanbox/fetcher.js';

export const routes = [
  {
    path: '/fanbox/:creator',
    name: 'pixivFANBOX 创作者主页',
    example: '/fanbox/official',
    parameters: {
      creator: '创作者 ID (例如 official)',
    },
    cacheTtl: 3600,
    handler: async (ctx) => {
      const target = fanboxTarget('/fanbox/:creator', ctx.params);
      const data = await ctx.fetchJson(target.apiUrl, {
        headers: {
          Origin: 'https://www.fanbox.cc',
          Referer: 'https://www.fanbox.cc/',
          Accept: 'application/json',
        },
      });
      const items = data?.body || [];
      const rssXml = renderFanboxFeed({
        title: target.title,
        siteUrl: target.siteUrl,
        items,
        creator: target.creator,
      });
      return { rssXml, mediaUrls: [], cacheHint: { ttl: 3600 } };
    },
  },
];

export default routes;
