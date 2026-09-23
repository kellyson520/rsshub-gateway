import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createZhihuFetcher,
  escapeXml,
  parseZhihuHot,
  renderZhihuFeed,
} from '../../sidecar/fetcher-zhihu/fetcher.js';

const SAMPLE_ZHIHU_JSON = {
  data: [
    {
      type: 'hot_list_feed',
      id: '101',
      target: {
        id: 700000001,
        title: '如何看待 2026 年人工智能技术的最新突破？',
        type: 'question',
        answer_count: 852,
        comment_count: 120,
        excerpt: '近期多家实验室发布了新一代大模型与多模态架构...',
      },
      detail_text: '4800 万热度',
      children: [
        {
          type: 'answer',
          thumbnail: 'https://picx.zhimg.com/v2-ai-thumb.jpg',
        },
      ],
    },
    {
      type: 'hot_list_feed',
      id: '102',
      target: {
        id: 700000002,
        title: '有哪些小众但体验惊艳的开源工具？',
        type: 'question',
        answer_count: 320,
        comment_count: 45,
        excerpt: '整理了一些在日常开发和生活中极大提升效率的开源项目...',
      },
      detail_text: '2300 万热度',
      children: [
        {
          type: 'answer',
          thumbnail: 'https://picx.zhimg.com/v2-tools-thumb.png',
        },
      ],
    },
    {
      type: 'hot_list_feed',
      id: '103',
      target: {
        id: 700000003,
        title: '如何评价今年的某某科技新品发布会？',
        type: 'question',
        answer_count: 156,
        excerpt: '发布会带来了多款新芯片和操作系统更新...',
      },
      detail_text: '1200 万热度',
      children: [],
    },
  ],
};

const SAMPLE_ZHIHU_HTML = `
<div class="HotList-list">
  <section class="HotItem">
    <div class="HotItem-rank">1</div>
    <div class="HotItem-content">
      <a href="https://www.zhihu.com/question/800000001" class="HotItem-link">
        <h2 class="HotItem-title">太空探索领域有哪些令人振奋的新计划？</h2>
      </a>
      <p class="HotItem-excerpt">商业航天与深空探测正在迎来密集发射期...</p>
      <div class="HotItem-metrics">3500 万热度 &bull; 620 个回答</div>
    </div>
    <img src="https://picx.zhimg.com/v2-space.jpg" class="HotItem-img"/>
  </section>
  <section class="HotItem">
    <div class="HotItem-rank">2</div>
    <div class="HotItem-content">
      <a href="/question/800000002" class="HotItem-link">
        <h2 class="HotItem-title">程序员如何构建持续终身学习的知识体系？</h2>
      </a>
      <div class="HotItem-metrics">1800 万热度</div>
    </div>
  </section>
</div>
`;

test('parseZhihuHot extracts rankings, titles, hotness, answers, thumbnails, and links from JSON', () => {
  const items = parseZhihuHot(SAMPLE_ZHIHU_JSON);
  assert.equal(items.length, 3);

  // Item 1
  assert.equal(items[0].rank, 1);
  assert.equal(items[0].title, '如何看待 2026 年人工智能技术的最新突破？');
  assert.equal(items[0].hotness, '4800 万热度');
  assert.equal(items[0].answerCount, 852);
  assert.equal(items[0].thumbnail, 'https://picx.zhimg.com/v2-ai-thumb.jpg');
  assert.equal(items[0].link, 'https://www.zhihu.com/question/700000001');

  // Item 2
  assert.equal(items[1].rank, 2);
  assert.equal(items[1].title, '有哪些小众但体验惊艳的开源工具？');
  assert.equal(items[1].hotness, '2300 万热度');
  assert.equal(items[1].answerCount, 320);
  assert.equal(items[1].thumbnail, 'https://picx.zhimg.com/v2-tools-thumb.png');
  assert.equal(items[1].link, 'https://www.zhihu.com/question/700000002');

  // Item 3 (no thumbnail)
  assert.equal(items[2].rank, 3);
  assert.equal(items[2].title, '如何评价今年的某某科技新品发布会？');
  assert.equal(items[2].hotness, '1200 万热度');
  assert.equal(items[2].answerCount, 156);
  assert.equal(items[2].thumbnail, '');
  assert.equal(items[2].link, 'https://www.zhihu.com/question/700000003');
});

test('parseZhihuHot parses HTML fallback properly', () => {
  const items = parseZhihuHot(SAMPLE_ZHIHU_HTML);
  assert.equal(items.length, 2);

  assert.equal(items[0].rank, 1);
  assert.equal(items[0].title, '太空探索领域有哪些令人振奋的新计划？');
  assert.equal(items[0].hotness, '3500 万热度');
  assert.equal(items[0].thumbnail, 'https://picx.zhimg.com/v2-space.jpg');
  assert.equal(items[0].link, 'https://www.zhihu.com/question/800000001');

  assert.equal(items[1].rank, 2);
  assert.equal(items[1].title, '程序员如何构建持续终身学习的知识体系？');
  assert.equal(items[1].hotness, '1800 万热度');
  assert.equal(items[1].link, 'https://www.zhihu.com/question/800000002');
});

test('renderZhihuFeed creates valid RSS 2.0 with enclosures and rich descriptions', () => {
  const items = parseZhihuHot(SAMPLE_ZHIHU_JSON);
  const xml = renderZhihuFeed({
    title: '知乎全站热榜',
    description: '知乎全站实时热榜',
    selfUrl: '/zhihu/hot',
    items,
  });

  assert.match(xml, /<rss version="2.0"/);
  assert.match(xml, /<title>知乎全站热榜<\/title>/);
  assert.match(xml, /【第 1 名】如何看待 2026 年人工智能技术的最新突破？/);
  assert.match(xml, /<enclosure url="https:\/\/picx\.zhimg\.com\/v2-ai-thumb\.jpg" type="image\/jpeg"\/>/);
  assert.match(xml, /热度值:<\/strong>\s*4800 万热度/);
  assert.match(xml, /回答数:<\/strong>\s*852/);
  assert.match(xml, /https:\/\/www\.zhihu\.com\/question\/700000001/);
});

test('createZhihuFetcher handles /zhihu/hot and /zhihu/hotlist with mediaUrls', async () => {
  const fetchMock = async (url) => {
    assert.ok(url.includes('zhihu.com'));
    return {
      status: 200,
      json: async () => SAMPLE_ZHIHU_JSON,
      text: async () => JSON.stringify(SAMPLE_ZHIHU_JSON),
    };
  };

  const fetcher = createZhihuFetcher({ fetchExternal: fetchMock });

  const res1 = await fetcher.handleFetch({ routeId: '/zhihu/hot' });
  assert.ok(res1.rssXml);
  assert.match(res1.rssXml, /人工智能技术的最新突破/);
  assert.equal(res1.cacheHint?.ttl, 300);
  assert.equal(res1.mediaUrls.length, 2);
  assert.ok(res1.mediaUrls.includes('https://picx.zhimg.com/v2-ai-thumb.jpg'));
  assert.ok(res1.mediaUrls.includes('https://picx.zhimg.com/v2-tools-thumb.png'));

  const res2 = await fetcher.handleFetch({ routeId: '/zhihu/hotlist' });
  assert.ok(res2.rssXml);
  assert.match(res2.rssXml, /开源工具/);
});

test('createZhihuFetcher throws HttpError on upstream failure', async () => {
  const fetchFail = async () => ({
    status: 502,
    text: async () => 'Upstream Error',
  });

  const fetcher = createZhihuFetcher({ fetchExternal: fetchFail });
  await assert.rejects(
    async () => fetcher.handleFetch({ routeId: '/zhihu/hot' }),
    (err) => err.status === 502,
  );
});
