import { parseNodeSeekPosts, renderNodeSeekFeed } from '../../../sidecar/fetcher-nodeseek/fetcher.js';

const SITE_BASE = 'https://www.nodeseek.com';

export const routes = [
  {
    path: '/nodeseek/:category?',
    name: 'NodeSeek 社区讨论',
    example: '/nodeseek/latest',
    parameters: { category: '分类或排序 (latest, tech, deal 等，缺省 latest)' },
    cacheTtl: 300,
    handler: async (ctx) => {
      const category = ctx.params.category || ctx.query.category || 'latest';
      let targetUrl = `${SITE_BASE}/`;
      let title = 'NodeSeek - 最新讨论';
      let description = 'NodeSeek 极客社区最新讨论与主机情报';

      if (category === 'latest') {
        targetUrl = `${SITE_BASE}/`;
      } else {
        targetUrl = `${SITE_BASE}/?category=${encodeURIComponent(category)}`;
        title = `NodeSeek - ${category}`;
      }

      let html = '';
      try {
        const rendered = await ctx.fetchRendered(targetUrl);
        html = rendered?.html || '';
      } catch {
        const res = await ctx.fetch(targetUrl, {
          headers: {
            'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          },
        });
        html = await res.text();
      }

      const posts = parseNodeSeekPosts(html);
      const rssXml = renderNodeSeekFeed({
        title,
        description,
        selfUrl: `/nodeseek/${category}`,
        posts,
      });
      const mediaUrls = posts.map((p) => p.avatar).filter(Boolean);
      return { rssXml, mediaUrls, cacheHint: { ttl: 300 } };
    },
  },
];

export default routes;
