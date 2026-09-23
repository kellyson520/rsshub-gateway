import { parseBilibiliVideos, renderBilibiliFeed } from '../../../sidecar/fetcher-bilibili/fetcher.js';

export const routes = [
  {
    path: '/bilibili/ranking',
    name: 'Bilibili 全站日榜',
    example: '/bilibili/ranking',
    cacheTtl: 900,
    handler: async (ctx) => {
      const url = 'https://api.bilibili.com/x/web-interface/ranking/v2?rid=0&type=all';
      const data = await ctx.fetchJson(url, {
        headers: { referer: 'https://www.bilibili.com/' },
      });
      const list = data?.data?.list || [];
      const videos = parseBilibiliVideos(list);
      const rssXml = renderBilibiliFeed(videos, 'B站全站日榜 - 综合热门', 'https://www.bilibili.com/v/popular/rank/all');
      const mediaUrls = videos.map((v) => v.pic).filter(Boolean);
      return { rssXml, mediaUrls, cacheHint: { ttl: 900 } };
    },
  },
  {
    path: '/bilibili/popular',
    name: 'Bilibili 综合热门',
    example: '/bilibili/popular',
    cacheTtl: 900,
    handler: async (ctx) => {
      const url = 'https://api.bilibili.com/x/web-interface/popular?ps=20&pn=1';
      const data = await ctx.fetchJson(url, {
        headers: { referer: 'https://www.bilibili.com/' },
      });
      const list = data?.data?.list || [];
      const videos = parseBilibiliVideos(list);
      const rssXml = renderBilibiliFeed(videos, 'B站全站热门视频', 'https://www.bilibili.com/v/popular');
      const mediaUrls = videos.map((v) => v.pic).filter(Boolean);
      return { rssXml, mediaUrls, cacheHint: { ttl: 900 } };
    },
  },
];

export default routes;
