import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CATEGORIES,
  createLinuxdoFetcher,
  linuxdoTarget,
  renderLinuxdoFeed,
  resolveCategory,
} from '../../sidecar/fetcher-linuxdo/fetcher.js';

test('resolveCategory correctly resolves slugs and numeric IDs', () => {
  assert.equal(resolveCategory('develop').name, '开发调优');
  assert.equal(resolveCategory('4').slug, 'develop');
  assert.equal(resolveCategory('resource').name, '资源荟萃');
  assert.equal(resolveCategory('14').slug, 'resource');
  assert.equal(resolveCategory('news').id, 34);
  assert.equal(resolveCategory('welfare').id, 36);
  assert.equal(resolveCategory('gossip').name, '搞七捻三');
});

test('linuxdoTarget resolves latest, hot, top and category routes', () => {
  const latest = linuxdoTarget('/linuxdo/latest');
  assert.equal(latest.apiUrl, 'https://linux.do/latest.json');
  assert.equal(latest.title, 'LINUX DO - 最新话题');

  const hot = linuxdoTarget('/linuxdo/hot');
  assert.equal(hot.apiUrl, 'https://linux.do/hot.json');
  assert.equal(hot.title, 'LINUX DO - 热门话题');

  const top = linuxdoTarget('/linuxdo/top/:period?', { period: 'weekly' });
  assert.equal(top.apiUrl, 'https://linux.do/top.json?period=weekly');

  const devCat = linuxdoTarget('/linuxdo/category/:category/:period?', { category: 'develop' });
  assert.equal(devCat.apiUrl, 'https://linux.do/c/develop/4.json');
  assert.equal(devCat.title, 'LINUX DO - 开发调优');

  const newsCat = linuxdoTarget('/linuxdo/c/:category/:period?', { category: 'news' });
  assert.equal(newsCat.apiUrl, 'https://linux.do/c/news/34.json');
  assert.equal(newsCat.title, 'LINUX DO - 前沿快讯');
});

test('renderLinuxdoFeed creates rich RSS XML string compatible with Flareapp / Follow', () => {
  const xml = renderLinuxdoFeed({
    title: 'LINUX DO - 开发调优',
    siteUrl: 'https://linux.do/c/develop/4',
    description: '开发调优板块',
    items: [{
      title: '测试技术讨论',
      url: 'https://linux.do/t/topic/12345',
      author: 'neo',
      categoryName: '开发调优',
      postsCount: 25,
      views: 1200,
      likeCount: 45,
      excerpt: '这是一篇关于 Node.js 与代理优化的深度分享。',
      tags: ['nodejs', 'proxy'],
      imageUrl: 'https://linux.do/uploads/default/image.png',
      pubDate: '2026-08-25T10:00:00.000Z',
    }],
  });

  assert.ok(xml.includes('xmlns:content="http://purl.org/rss/1.0/modules/content/"'));
  assert.ok(xml.includes('xmlns:media="http://search.yahoo.com/mrss/"'));
  assert.ok(xml.includes('<title>LINUX DO - 开发调优</title>'));
  assert.ok(xml.includes('<title>测试技术讨论</title>'));
  assert.ok(xml.includes('<category>开发调优</category>'));
  assert.ok(xml.includes('<dc:creator>neo</dc:creator>'));
  assert.ok(xml.includes('<enclosure url="https://linux.do/uploads/default/image.png"'));
  assert.ok(xml.includes('<media:content url="https://linux.do/uploads/default/image.png"'));
  assert.ok(xml.includes('<content:encoded>'));
  assert.ok(xml.includes('🏷️ 分类:'));
  assert.ok(xml.includes('💬 25 回复'));
  assert.ok(xml.includes('#nodejs'));
});

test('createLinuxdoFetcher handles category fetch properly', async () => {
  const mockFetchJson = async (url) => ({
    ok: true,
    status: 200,
    json: async () => ({
      users: [{ id: 1, username: 'neo' }],
      topic_list: {
        topics: [{
          id: 100,
          title: 'Hello Category',
          slug: 'hello-category',
          posts_count: 5,
          views: 88,
          like_count: 10,
          excerpt: 'Category test content',
          category_id: 4,
          created_at: '2026-08-25T10:00:00.000Z',
          posters: [{ user_id: 1 }],
        }],
      },
    }),
  });

  const fetcher = createLinuxdoFetcher({ fetchJson: mockFetchJson });
  const result = await fetcher.handleFetch({
    routeId: '/linuxdo/category/:category/:period?',
    params: { category: 'develop' },
  });

  assert.ok(result.rssXml);
  assert.ok(result.rssXml.includes('Hello Category'));
  assert.ok(result.rssXml.includes('开发调优'));
  assert.equal(result.cacheHint.ttl, 300);
});

test('createLinuxdoFetcher handles top route and unknown category fallback', async () => {
  let requestedUrl = '';
  const mockFetchJson = async (url) => {
    requestedUrl = url;
    return {
      ok: true,
      status: 200,
      json: async () => ({
        users: [{ id: 2, username: 'tester' }],
        topic_list: {
          topics: [{
            id: 200,
            title: 'Top Weekly Discussion',
            slug: 'top-weekly',
            posts_count: 50,
            views: 9999,
            like_count: 120,
            excerpt: 'Weekly popular topic',
            category_id: 9999,
            created_at: '2026-08-25T11:00:00.000Z',
            posters: [{ user_id: 2 }],
          }],
        },
      }),
    };
  };

  const fetcher = createLinuxdoFetcher({ fetchJson: mockFetchJson });
  const resultTop = await fetcher.handleFetch({
    routeId: '/linuxdo/top/:period?',
    params: { period: 'monthly' },
  });

  assert.ok(requestedUrl.includes('period=monthly'));
  assert.ok(resultTop.rssXml.includes('Top Weekly Discussion'));
  assert.ok(resultTop.rssXml.includes('LINUX DO - 精华话题 (monthly)'));
});

test('createLinuxdoFetcher maps upstream errors properly', async () => {
  const mockFetchError = async () => ({
    ok: false,
    status: 502,
    statusText: 'Bad Gateway',
    json: async () => ({}),
  });

  const fetcher = createLinuxdoFetcher({ fetchJson: mockFetchError });
  await assert.rejects(
    () => fetcher.handleFetch({ routeId: '/linuxdo/latest', params: {} }),
    (err) => err.status === 502 || err.message.includes('502'),
  );
});

test('resolveCategory defaults unknown numeric or slug to generic label', () => {
  const resolved = resolveCategory('unknown-section');
  assert.equal(resolved.slug, 'unknown-section');
  assert.equal(resolved.name, 'unknown-section');
});

test('renderLinuxdoReaderPage generates elegant dark/light theme reading view with sanitized HTML', async () => {
  const { renderLinuxdoReaderPage } = await import('../../src/adapters/linuxdo.js');
  const html = renderLinuxdoReaderPage({
    topic: {
      id: 12345,
      title: 'Linux.do 深度调优实战',
      slug: 'deep-dive',
      views: 3200,
      posts_count: 5,
      like_count: 88,
      post_stream: {
        posts: [
          {
            id: 1,
            name: '始皇',
            username: 'neo',
            avatar_template: '/user_avatar/linux.do/neo/{size}/123.png',
            created_at: '2026-08-25T12:00:00.000Z',
            cooked: '<p>欢迎讨论优化 <script>alert("xss")</script><img src="https://linux.do/img/arch.png"></p>',
          },
          {
            id: 2,
            name: '版主',
            username: 'mod',
            created_at: '2026-08-25T12:30:00.000Z',
            cooked: '<p>顶贴支持！</p>',
          },
        ],
      },
    },
    baseUrl: 'https://gateway.example.test',
    secret: 'test-secret',
  });

  assert.ok(html.includes('Linux.do 深度调优实战'));
  assert.ok(html.includes('始皇'));
  assert.ok(html.includes('@neo'));
  assert.ok(html.includes('3200 浏览'));
  assert.ok(html.includes('顶贴支持！'));
  assert.ok(html.includes('_gateway/media/'));
  assert.doesNotMatch(html, /<script/);
});
