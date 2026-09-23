import { parseSteamFeatured, renderSteamFeed } from '../../../sidecar/fetcher-steam/fetcher.js';

export const routes = [
  {
    path: '/steam/specials',
    name: 'Steam 特惠折扣游戏',
    example: '/steam/specials',
    cacheTtl: 1800,
    handler: async (ctx) => {
      const data = await ctx.fetchJson('https://store.steampowered.com/api/featuredcategories/?l=schinese&cc=cn');
      const apps = parseSteamFeatured(data, 'specials');
      const rssXml = renderSteamFeed({
        title: 'Steam 特惠折扣游戏',
        description: 'Steam 商店当前精选特惠与折扣游戏',
        selfUrl: '/steam/specials',
        games: apps,
      });
      const mediaUrls = apps.map((a) => a.headerImage).filter(Boolean);
      return { rssXml, mediaUrls, cacheHint: { ttl: 1800 } };
    },
  },
];

export default routes;
