import { parseHanimeVideos, renderHanimeFeed } from '../../../sidecar/fetcher-hanime1/fetcher.js';

const SITE_BASE = 'https://hanime1.me';

export const routes = [
  {
    path: '/hanime1/latest',
    name: 'Hanime1 最新里番动画',
    example: '/hanime1/latest',
    cacheTtl: 1800,
    handler: async (ctx) => {
      let html = '';
      try {
        const rendered = await ctx.fetchRendered(SITE_BASE);
        html = rendered?.html || '';
      } catch {
        const res = await ctx.fetch(SITE_BASE, {
          headers: {
            'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          },
        });
        html = await res.text();
      }

      const videos = parseHanimeVideos(html);
      const rssXml = renderHanimeFeed({
        title: 'Hanime1 - 最新动画',
        description: 'Hanime1.me 最新更新动画列表',
        selfUrl: '/hanime1/latest',
        videos,
      });
      const mediaUrls = videos.map((v) => v.poster).filter(Boolean);
      return { rssXml, mediaUrls, cacheHint: { ttl: 1800 } };
    },
  },
];

export default routes;
