import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createWeiboFetcher,
  escapeXml,
  parseWeiboHotSearch,
  renderWeiboFeed,
} from '../../sidecar/fetcher-weibo/fetcher.js';

const SAMPLE_WEIBO_JSON = {
  ok: 1,
  data: {
    hotgov: {
      word: '筑牢强国建设民族复兴的坚实根基',
      name: '筑牢强国建设民族复兴的坚实根基',
      url: 'https://s.weibo.com/weibo?q=%23筑牢强国建设民族复兴的坚实根基%23',
      note: '置顶',
      is_gov: 1,
    },
    realtime: [
      {
        num: 1,
        word: '我国科学家在量子计算取得新突破',
        raw_hot: 2045610,
        label_name: '爆',
        icon_desc: '爆',
        category: '科技',
        subject_querys: '我国科学家在量子计算取得新突破',
      },
      {
        num: 2,
        word: '春日赏花踏青指南',
        raw_hot: 1054320,
        label_name: '热',
        icon_desc: '热',
        category: '旅游',
        subject_querys: '春日赏花踏青指南',
      },
      {
        num: 3,
        word: '第97届奥斯卡获奖名单揭晓',
        raw_hot: 892340,
        label_name: '新',
        icon_desc: '新',
        category: '电影',
        subject_querys: '第97届奥斯卡获奖名单揭晓',
      },
    ],
  },
};

const SAMPLE_WEIBO_HTML = `
<table class="list-table">
  <tbody>
    <tr>
      <td class="td-01 ranktop"></td>
      <td class="td-02">
        <a href="/weibo?q=%23开局之年看中国%23&Refer=top" target="_blank">开局之年看中国</a>
      </td>
      <td class="td-03"><i class="icon-txt icon-txt-top">置顶</i></td>
    </tr>
    <tr>
      <td class="td-01 ranktop">1</td>
      <td class="td-02">
        <a href="/weibo?q=%23人工智能发展新趋势%23&Refer=top" target="_blank">人工智能发展新趋势</a>
        <span>1890234</span>
      </td>
      <td class="td-03"><i class="icon-txt icon-txt-hot">热</i></td>
    </tr>
    <tr>
      <td class="td-01 ranktop">2</td>
      <td class="td-02">
        <a href="/weibo?q=%23深中通道最新进展%23&Refer=top" target="_blank">深中通道最新进展</a>
        <span>982314</span>
      </td>
      <td class="td-03"><i class="icon-txt icon-txt-new">新</i></td>
    </tr>
  </tbody>
</table>
`;

test('parseWeiboHotSearch extracts items from JSON including hotgov and realtime list', () => {
  const items = parseWeiboHotSearch(SAMPLE_WEIBO_JSON);
  assert.equal(items.length, 4);

  // Top item (hotgov)
  assert.equal(items[0].rank, '置顶');
  assert.equal(items[0].keyword, '筑牢强国建设民族复兴的坚实根基');
  assert.equal(items[0].tag, '置顶');
  assert.ok(items[0].link.includes('筑牢强国建设民族复兴的坚实根基'));

  // Rank 1
  assert.equal(items[1].rank, 1);
  assert.equal(items[1].keyword, '我国科学家在量子计算取得新突破');
  assert.equal(items[1].hotness, 2045610);
  assert.equal(items[1].tag, '爆');
  assert.equal(items[1].category, '科技');
  assert.ok(items[1].link.startsWith('https://s.weibo.com/weibo?q='));

  // Rank 2
  assert.equal(items[2].rank, 2);
  assert.equal(items[2].keyword, '春日赏花踏青指南');
  assert.equal(items[2].hotness, 1054320);
  assert.equal(items[2].tag, '热');

  // Rank 3
  assert.equal(items[3].rank, 3);
  assert.equal(items[3].keyword, '第97届奥斯卡获奖名单揭晓');
  assert.equal(items[3].hotness, 892340);
  assert.equal(items[3].tag, '新');
});

test('parseWeiboHotSearch parses HTML fallback table properly', () => {
  const items = parseWeiboHotSearch(SAMPLE_WEIBO_HTML);
  assert.equal(items.length, 3);

  assert.equal(items[0].rank, '置顶');
  assert.equal(items[0].keyword, '开局之年看中国');
  assert.equal(items[0].tag, '置顶');
  assert.equal(items[0].link, 'https://s.weibo.com/weibo?q=%23开局之年看中国%23&Refer=top');

  assert.equal(items[1].rank, 1);
  assert.equal(items[1].keyword, '人工智能发展新趋势');
  assert.equal(items[1].hotness, 1890234);
  assert.equal(items[1].tag, '热');
  assert.equal(items[1].link, 'https://s.weibo.com/weibo?q=%23人工智能发展新趋势%23&Refer=top');

  assert.equal(items[2].rank, 2);
  assert.equal(items[2].keyword, '深中通道最新进展');
  assert.equal(items[2].hotness, 982314);
  assert.equal(items[2].tag, '新');
});

test('renderWeiboFeed creates valid RSS 2.0 XML with rankings and search links', () => {
  const items = parseWeiboHotSearch(SAMPLE_WEIBO_JSON);
  const xml = renderWeiboFeed({
    title: '微博热搜榜',
    description: '实时微博热搜排行榜与要闻',
    selfUrl: '/weibo/search/hot',
    items,
  });

  assert.match(xml, /<rss version="2.0"/);
  assert.match(xml, /<title>微博热搜榜<\/title>/);
  assert.match(xml, /【置顶】筑牢强国建设民族复兴的坚实根基/);
  assert.match(xml, /【第 1 名】我国科学家在量子计算取得新突破 \[爆\]/);
  assert.match(xml, /热度指数:<\/strong>\s*2045610/);
  assert.match(xml, /https:\/\/s\.weibo\.com\/weibo\?q=/);
});

test('createWeiboFetcher handles /weibo/search/hot and /weibo/hot', async () => {
  const fetchMock = async (url) => {
    assert.ok(url.includes('weibo.com'));
    return {
      status: 200,
      json: async () => SAMPLE_WEIBO_JSON,
      text: async () => JSON.stringify(SAMPLE_WEIBO_JSON),
    };
  };

  const fetcher = createWeiboFetcher({ fetchExternal: fetchMock });

  const res1 = await fetcher.handleFetch({ routeId: '/weibo/search/hot' });
  assert.ok(res1.rssXml);
  assert.match(res1.rssXml, /我国科学家在量子计算取得新突破/);
  assert.equal(res1.cacheHint?.ttl, 300);
  assert.ok(Array.isArray(res1.mediaUrls));

  const res2 = await fetcher.handleFetch({ routeId: '/weibo/hot' });
  assert.ok(res2.rssXml);
  assert.match(res2.rssXml, /春日赏花踏青指南/);
});

test('createWeiboFetcher throws HttpError on upstream failure', async () => {
  const fetchFail = async () => ({
    status: 502,
    text: async () => 'Bad Gateway',
  });

  const fetcher = createWeiboFetcher({ fetchExternal: fetchFail });
  await assert.rejects(
    async () => fetcher.handleFetch({ routeId: '/weibo/search/hot' }),
    (err) => err.status === 502,
  );
});
