import test from 'node:test';
import assert from 'node:assert/strict';
import { renderStandardFeed } from '../src/universal-enhancer/feed-builder.js';
import { createEnhancerContext } from '../src/universal-enhancer/context.js';
import { createUniversalEnhancer, allModularRoutes } from '../src/universal-enhancer/index.js';
import { createDispatcher } from '../src/dispatcher.js';

test('renderStandardFeed creates valid RSS 2.0 with items and enclosures', () => {
  const xml = renderStandardFeed({
    title: '通用线路 - 热门资讯',
    link: 'https://example.com',
    description: '这是一个通用增强线路测试源',
    language: 'zh-cn',
    items: [
      {
        title: '测试条目 1',
        link: 'https://example.com/item/1',
        description: '<p>正文内容测试</p>',
        pubDate: new Date('2026-09-23T00:00:00Z'),
        author: '张三',
        category: '科技',
        enclosure: {
          url: 'https://example.com/cover.jpg',
          type: 'image/jpeg',
        },
      },
    ],
  });

  assert.match(xml, /<rss version="2.0"/);
  assert.match(xml, /<title>通用线路 - 热门资讯<\/title>/);
  assert.match(xml, /<title>测试条目 1<\/title>/);
  assert.match(xml, /<category>科技<\/category>/);
  assert.match(xml, /<enclosure url="https:\/\/example\.com\/cover\.jpg" type="image\/jpeg"\/>/);
  assert.match(xml, /<author>张三<\/author>/);
});

test('createEnhancerContext provides fetch, fetchJson, fetchHtml, fetchRendered, fetchImpersonate, parseDom, and render', async () => {
  const mockFetch = async (url) => {
    return {
      status: 200,
      ok: true,
      text: async () => '<html><body><div class="target">Hello Cheerio</div></body></html>',
      json: async () => ({ hello: 'world' }),
    };
  };

  const mockImpersonate = async (url) => {
    return {
      status: 200,
      ok: true,
      text: async () => 'impersonated content',
    };
  };

  const ctx = createEnhancerContext({
    routeId: '/test/:id',
    params: { id: '42' },
    query: { filter: 'hot' },
    fetchClient: { fetch: mockFetch },
    browserRenderClient: { fetchRenderedHtml: async () => ({ status: 200, html: '<html><body>Rendered</body></html>' }) },
    browserFetchClient: { fetch: mockImpersonate },
  });

  assert.equal(ctx.params.id, '42');
  assert.equal(ctx.query.filter, 'hot');

  const json = await ctx.fetchJson('https://api.example.com/data');
  assert.deepEqual(json, { hello: 'world' });

  const html = await ctx.fetchHtml('https://example.com/page');
  assert.match(html, /Hello Cheerio/);

  // 测试 DOM 解析器
  const $ = ctx.parseDom(html);
  assert.equal($('.target').text(), 'Hello Cheerio');

  const rendered = await ctx.fetchRendered('https://protected.example.com');
  assert.equal(rendered.html, '<html><body>Rendered</body></html>');

  const impersonated = await ctx.fetchImpersonate('https://cf.example.com');
  const impText = await impersonated.text();
  assert.equal(impText, 'impersonated content');

  const result = ctx.render({
    title: '上下文渲染测试',
    link: 'https://example.com',
    description: '测试描述',
    items: [{ title: '测试1', link: 'https://example.com/1' }],
  });

  assert.ok(result.rssXml);
  assert.match(result.rssXml, /<title>上下文渲染测试<\/title>/);
  assert.deepEqual(result.cacheHint, { ttl: 900 });
});

test('createUniversalEnhancer supports RSSHub route declaration style', async () => {
  const enhancer = createUniversalEnhancer();

  // RSSHub 规范风格
  enhancer.register({
    route: {
      path: '/rsshub-style/:user',
      name: 'RSSHub 风格声明测试',
      maintainers: ['kellyson'],
      example: '/rsshub-style/alice',
      parameters: { user: '用户名' },
      cacheTtl: 600,
      handler: async (ctx) => {
        return ctx.render({
          title: `用户 ${ctx.params.user} 动态`,
          link: `https://example.com/${ctx.params.user}`,
          items: [{ title: '动态 1', link: 'https://example.com/1' }],
        });
      },
    },
  });

  assert.ok(enhancer.hasRoute('/rsshub-style/:user'));
  const list = enhancer.listRoutes();
  const found = list.find((r) => r.path === '/rsshub-style/:user');
  assert.ok(found);
  assert.equal(found.name, 'RSSHub 风格声明测试');
  assert.deepEqual(found.maintainers, ['kellyson']);
  assert.equal(found.cacheTtl, 600);

  const res = await enhancer.execute('/rsshub-style/bob');
  assert.ok(res);
  assert.match(res.rssXml, /用户 bob 动态/);
});

test('createUniversalEnhancer registers, matches and executes routes in-process', async () => {
  const enhancer = createUniversalEnhancer();

  enhancer.register({
    routeId: '/echo/:msg',
    name: '回显测试路由',
    cacheTtl: 300,
    handler: async (ctx) => {
      return ctx.render({
        title: `回显: ${ctx.params.msg}`,
        link: 'https://example.com/echo',
        description: '回显内容',
        items: [
          {
            title: `信息: ${ctx.params.msg}`,
            link: `https://example.com/echo/${ctx.params.msg}`,
            description: `Query param test: ${ctx.query.tag || 'none'}`,
          },
        ],
      });
    },
  });

  assert.ok(enhancer.hasRoute('/echo/:msg'));
  const match = enhancer.match('/echo/hello');
  assert.ok(match);
  assert.equal(match.params.msg, 'hello');

  const executionResult = await enhancer.execute('/echo/world?tag=featured');
  assert.ok(executionResult);
  assert.match(executionResult.rssXml, /回显: world/);
  assert.match(executionResult.rssXml, /Query param test: featured/);
  assert.equal(executionResult.cacheHint.ttl, 300);
});

test('createUniversalEnhancer initializes modular routes from routes/ directory', () => {
  const enhancer = createUniversalEnhancer();
  assert.ok(allModularRoutes.length >= 9);

  assert.ok(enhancer.hasRoute('/epic/free'));
  assert.ok(enhancer.hasRoute('/bilibili/ranking'));
  assert.ok(enhancer.hasRoute('/weibo/search/hot'));
  assert.ok(enhancer.hasRoute('/zhihu/hot'));
  assert.ok(enhancer.hasRoute('/github/trending/:since?/:language?'));
  assert.ok(enhancer.hasRoute('/dmhy/latest'));
  assert.ok(enhancer.hasRoute('/bangumi/calendar/today'));
  assert.ok(enhancer.hasRoute('/steam/specials'));
  assert.ok(enhancer.hasRoute('/mangadex/latest'));
});

test('dispatcher transparently executes universal enhancer routes in-process', async () => {
  const enhancer = createUniversalEnhancer();
  enhancer.register({
    routeId: '/fast/topic/:id',
    handler: async (ctx) => {
      return ctx.render({
        title: `主题: ${ctx.params.id}`,
        items: [{ title: `Item ${ctx.params.id}`, link: `https://example.com/${ctx.params.id}` }],
      });
    },
  });

  const dispatcher = createDispatcher({
    routesFile: 'absent.yaml',
    universalEnhancer: enhancer,
  });

  const matched = dispatcher.match('/fast/topic/999');
  assert.ok(matched);
  assert.equal(matched.route.backend, 'universal://in-process');
  assert.equal(matched.params.id, '999');

  const result = await dispatcher.callSidecar(matched.route, matched.params);
  assert.ok(result);
  assert.match(result.rssXml, /<title>主题: 999<\/title>/);
});
