import { parseAcgRipPosts, renderAcgRipFeed } from '../../../sidecar/fetcher-acgrip/fetcher.js';

const SITE_BASE = 'https://acg.rip';

export const routes = [
  {
    path: '/acgrip/latest',
    name: 'ACG.RIP 最新动漫发布',
    example: '/acgrip/latest',
    cacheTtl: 900,
    handler: async (ctx) => {
      const res = await ctx.fetch(`${SITE_BASE}/`, {
        headers: {
          'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        },
      });
      const html = await res.text();
      const posts = parseAcgRipPosts(html);
      const rssXml = renderAcgRipFeed({
        title: 'ACG.RIP - 最新发布',
        description: 'ACG.RIP 最新动画与漫画 BT 种子发布列表',
        selfUrl: '/acgrip/latest',
        posts,
      });
      return { rssXml, mediaUrls: [], cacheHint: { ttl: 900 } };
    },
  },
  {
    path: '/acgrip/search/:keyword',
    name: 'ACG.RIP 搜索',
    example: '/acgrip/search/1080p',
    parameters: { keyword: '检索关键词' },
    cacheTtl: 900,
    handler: async (ctx) => {
      const keyword = ctx.params.keyword;
      const targetUrl = `${SITE_BASE}/?term=${encodeURIComponent(keyword)}`;
      const res = await ctx.fetch(targetUrl, {
        headers: {
          'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        },
      });
      const html = await res.text();
      const posts = parseAcgRipPosts(html);
      const rssXml = renderAcgRipFeed({
        title: `ACG.RIP - 搜索: ${keyword}`,
        description: `ACG.RIP 关键词 "${keyword}" 的检索结果`,
        selfUrl: `/acgrip/search/${encodeURIComponent(keyword)}`,
        posts,
      });
      return { rssXml, mediaUrls: [], cacheHint: { ttl: 900 } };
    },
  },
];

export default routes;
