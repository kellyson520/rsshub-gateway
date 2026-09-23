import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseBilibiliVideos,
  renderBilibiliFeed,
  createBilibiliFetcher,
  formatCount,
} from '../../sidecar/fetcher-bilibili/fetcher.js';

const SAMPLE_BILIBILI_DATA = {
  code: 0,
  message: '0',
  ttl: 1,
  data: {
    note: '综合热门',
    list: [
      {
        aid: 117308542555694,
        bvid: 'BV1BqhB6nEdN',
        title: '《原神》角色预告-「沃雅妮莎：此夜共沦」',
        pic: 'http://i0.hdslb.com/bfs/archive/dff4badd37bdf86481a648c9d3a8dd818af10c69.jpg',
        desc: '向高天祈祷，再向远海寄托愁思。',
        pubdate: 1790049600,
        duration: 712,
        owner: {
          mid: 401742377,
          name: '原神',
          face: 'https://i2.hdslb.com/bfs/face/e63bacc8.jpg',
        },
        stat: {
          view: 1521245,
          danmaku: 14852,
          reply: 10231,
          favorite: 38584,
          coin: 84419,
          share: 19648,
          like: 193267,
        },
      },
      {
        aid: 117312904500987,
        bvid: 'BV2CqhB6nXYZ',
        title: '专业保镖到底在做什么？',
        pic: 'https://i0.hdslb.com/bfs/archive/6646bc36.jpg',
        desc: '在各类作品中，保镖似乎总是训练有素。',
        pubdate: 1790067600,
        duration: 785,
        owner: {
          mid: 946974,
          name: '影视飓风',
          face: 'https://i0.hdslb.com/bfs/face/hurricane.jpg',
        },
        stat: {
          view: 2850000,
          danmaku: 26000,
          like: 250000,
        },
      },
    ],
  },
};

test('formatCount formats numeric metrics into readable strings', () => {
  assert.equal(formatCount(0), '0');
  assert.equal(formatCount(850), '850');
  assert.equal(formatCount(1521245), '152.1万');
  assert.equal(formatCount(120000000), '1.2亿');
});

test('parseBilibiliVideos parses video details, stats, author, and secure covers', () => {
  const videos = parseBilibiliVideos(SAMPLE_BILIBILI_DATA);
  assert.equal(videos.length, 2);

  const v1 = videos[0];
  assert.equal(v1.bvid, 'BV1BqhB6nEdN');
  assert.equal(v1.title, '《原神》角色预告-「沃雅妮莎：此夜共沦」');
  assert.equal(v1.author, '原神');
  assert.equal(v1.authorMid, 401742377);
  assert.equal(v1.url, 'https://www.bilibili.com/video/BV1BqhB6nEdN');
  assert.equal(v1.cover, 'https://i0.hdslb.com/bfs/archive/dff4badd37bdf86481a648c9d3a8dd818af10c69.jpg');
  assert.equal(v1.views, 1521245);
  assert.equal(v1.danmaku, 14852);
  assert.equal(v1.likes, 193267);

  const v2 = videos[1];
  assert.equal(v2.bvid, 'BV2CqhB6nXYZ');
  assert.equal(v2.author, '影视飓风');
});

test('renderBilibiliFeed generates RSS 2.0 with cover enclosure, stats, and links', () => {
  const videos = parseBilibiliVideos(SAMPLE_BILIBILI_DATA);
  const xml = renderBilibiliFeed({
    title: '哔哩哔哩全站日榜',
    description: 'Bilibili 全站排行榜热门视频',
    selfUrl: '/bilibili/ranking',
    videos,
    isRanking: true,
  });

  assert.match(xml, /<rss version="2.0"/);
  assert.match(xml, /<title>哔哩哔哩全站日榜<\/title>/);
  assert.match(xml, /【#1】《原神》角色预告-「沃雅妮莎：此夜共沦」/);
  assert.match(xml, /<enclosure url="https:\/\/i0\.hdslb\.com\/bfs\/archive\/dff4badd37bdf86481a648c9d3a8dd818af10c69\.jpg" type="image\/jpeg"\/>/);
  assert.match(xml, /UP主:.*?原神/);
  assert.match(xml, /播放量:.*?152\.1万/);
  assert.match(xml, /弹幕:.*?1\.5万/);
  assert.match(xml, /https:\/\/www\.bilibili\.com\/video\/BV1BqhB6nEdN/);
});

test('createBilibiliFetcher handles ranking and popular routes', async () => {
  let requestedUrl = '';
  const fetchMock = async (url) => {
    requestedUrl = url;
    return {
      status: 200,
      headers: { 'content-type': 'application/json' },
      json: async () => SAMPLE_BILIBILI_DATA,
    };
  };

  const fetcher = createBilibiliFetcher({ fetchExternal: fetchMock });

  const resRanking = await fetcher.handleFetch({ routeId: '/bilibili/ranking' });
  assert.ok(requestedUrl.includes('ranking/v2'));
  assert.ok(resRanking.rssXml);
  assert.equal(resRanking.mediaUrls.length, 2);
  assert.match(resRanking.rssXml, /全站排行榜/);

  const resPopular = await fetcher.handleFetch({ routeId: '/bilibili/popular' });
  assert.ok(requestedUrl.includes('web-interface/popular'));
  assert.ok(resPopular.rssXml);
  assert.equal(resPopular.mediaUrls.length, 2);
  assert.match(resPopular.rssXml, /热门视频/);
});
