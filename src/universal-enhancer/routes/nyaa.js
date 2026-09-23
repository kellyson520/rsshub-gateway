import { parseNyaaTorrents, renderNyaaFeed } from '../../../sidecar/fetcher-nyaa/fetcher.js';

const SITE_BASE = 'https://nyaa.si';

export const routes = [
  {
    path: '/nyaa/recent',
    name: 'Nyaa 最新发布',
    example: '/nyaa/recent',
    cacheTtl: 900,
    handler: async (ctx) => {
      const res = await ctx.fetch(`${SITE_BASE}/`, {
        headers: {
          'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        },
      });
      const html = await res.text();
      const torrents = parseNyaaTorrents(html);
      const rssXml = renderNyaaFeed({
        title: 'Nyaa - 最新发布',
        description: 'Nyaa.si 最新动漫 BT 资源列表',
        selfUrl: '/nyaa/recent',
        torrents,
      });
      return { rssXml, mediaUrls: [], cacheHint: { ttl: 900 } };
    },
  },
  {
    path: '/nyaa/search/:query',
    name: 'Nyaa 检索',
    example: '/nyaa/search/Bocchi',
    parameters: { query: '搜索词' },
    cacheTtl: 900,
    handler: async (ctx) => {
      const query = ctx.params.query;
      const targetUrl = `${SITE_BASE}/?f=0&c=0_0&q=${encodeURIComponent(query)}`;
      const res = await ctx.fetch(targetUrl, {
        headers: {
          'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        },
      });
      const html = await res.text();
      const torrents = parseNyaaTorrents(html);
      const rssXml = renderNyaaFeed({
        title: `Nyaa - 检索: ${query}`,
        description: `Nyaa.si 关键词 "${query}" 的检索结果`,
        selfUrl: `/nyaa/search/${encodeURIComponent(query)}`,
        torrents,
      });
      return { rssXml, mediaUrls: [], cacheHint: { ttl: 900 } };
    },
  },
];

export default routes;
