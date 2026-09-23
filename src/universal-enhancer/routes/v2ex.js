import { parseV2exTopics, renderV2exFeed } from '../../../sidecar/fetcher-v2ex/fetcher.js';

const SITE_BASE = 'https://www.v2ex.com';

export const routes = [
  {
    path: '/v2ex/topics/:tab?',
    name: 'V2EX 讨论列表',
    example: '/v2ex/topics/latest',
    parameters: { tab: '分类标签 (latest, hot, tech, creative 等，缺省 tech)' },
    cacheTtl: 600,
    handler: async (ctx) => {
      const tab = ctx.params.tab || ctx.query.tab || 'tech';
      let targetUrl = `${SITE_BASE}/?tab=tech`;
      let title = 'V2EX - 最新讨论';
      let description = 'V2EX 极客与技术社区讨论';

      if (tab === 'latest') {
        targetUrl = `${SITE_BASE}/recent`;
        title = 'V2EX - 最新主题';
      } else if (tab === 'hot') {
        targetUrl = `${SITE_BASE}/?tab=hot`;
        title = 'V2EX - 今日热门';
      } else {
        targetUrl = `${SITE_BASE}/?tab=${encodeURIComponent(tab)}`;
        title = `V2EX - ${tab}`;
      }

      const res = await ctx.fetch(targetUrl, {
        headers: {
          'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        },
      });
      const html = await res.text();
      const topics = parseV2exTopics(html);
      const rssXml = renderV2exFeed({
        title,
        description,
        selfUrl: `/v2ex/topics/${tab}`,
        topics,
      });
      const mediaUrls = topics.map((t) => t.avatar).filter(Boolean);
      return { rssXml, mediaUrls, cacheHint: { ttl: 600 } };
    },
  },
  {
    path: '/v2ex/node/:node',
    name: 'V2EX 节点主题',
    example: '/v2ex/node/qna',
    parameters: { node: '节点名称 (如 qna, programmer)' },
    cacheTtl: 600,
    handler: async (ctx) => {
      const node = ctx.params.node;
      const targetUrl = `${SITE_BASE}/go/${encodeURIComponent(node)}`;
      const res = await ctx.fetch(targetUrl, {
        headers: {
          'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        },
      });
      const html = await res.text();
      const topics = parseV2exTopics(html);
      const rssXml = renderV2exFeed({
        title: `V2EX - 节点: ${node}`,
        description: `V2EX 节点 ${node} 最新主题列表`,
        selfUrl: `/v2ex/node/${node}`,
        topics,
      });
      const mediaUrls = topics.map((t) => t.avatar).filter(Boolean);
      return { rssXml, mediaUrls, cacheHint: { ttl: 600 } };
    },
  },
];

export default routes;
