import { parseMangaDexChapters, renderMangaDexFeed } from '../../../sidecar/fetcher-mangadex/fetcher.js';

export const routes = [
  {
    path: '/mangadex/latest',
    name: 'MangaDex 全球漫画更新',
    example: '/mangadex/latest',
    cacheTtl: 900,
    handler: async (ctx) => {
      const data = await ctx.fetchJson('https://api.mangadex.org/chapter?limit=30&order[readableAt]=desc&translatedLanguage[]=zh&translatedLanguage[]=zh-hk&translatedLanguage[]=en&includes[]=manga&includes[]=scanlation_group&contentRating[]=safe&contentRating[]=suggestive');
      const chapters = parseMangaDexChapters(data);
      const rssXml = renderMangaDexFeed({
        title: 'MangaDex - 最新更新',
        description: 'MangaDex 全球多语言漫画最新章节更新列表',
        selfUrl: '/mangadex/latest',
        chapters,
      });
      return { rssXml, mediaUrls: [], cacheHint: { ttl: 900 } };
    },
  },
];

export default routes;
