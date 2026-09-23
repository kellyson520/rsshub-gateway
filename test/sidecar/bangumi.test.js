import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseBangumiCalendar,
  renderBangumiCalendarFeed,
  createBangumiFetcher,
} from '../../sidecar/fetcher-bangumi/fetcher.js';

const SAMPLE_BANGUMI_CALENDAR = [
  {
    weekday: { en: 'Sun', cn: '星期日', ja: '日曜', id: 7 },
    items: [
      {
        id: 400001,
        url: 'http://bgm.tv/subject/400001',
        type: 2,
        name: '葬送のフリーレン',
        name_cn: '葬送的芙莉莲',
        summary: '千年精灵的旅程',
        air_date: '2023-09-29',
        rating: { total: 15400, score: 8.9 },
        rank: 2,
        images: {
          large: 'https://lain.bgm.tv/pic/cover/l/40/00/400001_large.jpg',
          common: 'https://lain.bgm.tv/pic/cover/c/40/00/400001_common.jpg',
        },
      },
    ],
  },
  {
    weekday: { en: 'Mon', cn: '星期一', ja: '月曜', id: 1 },
    items: [
      {
        id: 400002,
        url: 'http://bgm.tv/subject/400002',
        type: 2,
        name: 'ダンジョン飯',
        name_cn: '迷宫饭',
        summary: '品尝魔物的迷宫探索',
        air_date: '2024-01-04',
        rating: { total: 9800, score: 8.4 },
        rank: 25,
        images: {
          large: 'https://lain.bgm.tv/pic/cover/l/40/00/400002_large.jpg',
        },
      },
    ],
  },
];

test('parseBangumiCalendar filters by weekday and extracts subject details', () => {
  const sundayItems = parseBangumiCalendar(SAMPLE_BANGUMI_CALENDAR, 7);
  assert.equal(sundayItems.length, 1);
  assert.equal(sundayItems[0].id, 400001);
  assert.equal(sundayItems[0].title, '葬送的芙莉莲');
  assert.equal(sundayItems[0].score, 8.9);
  assert.equal(sundayItems[0].cover, 'https://lain.bgm.tv/pic/cover/l/40/00/400001_large.jpg');

  const allItems = parseBangumiCalendar(SAMPLE_BANGUMI_CALENDAR, 'all');
  assert.equal(allItems.length, 2);
});

test('renderBangumiCalendarFeed outputs valid RSS 2.0 with image enclosure', () => {
  const items = parseBangumiCalendar(SAMPLE_BANGUMI_CALENDAR, 7);
  const xml = renderBangumiCalendarFeed({
    title: 'Bangumi 番组计划 - 星期日每日放送',
    description: '今日放送动画列表',
    selfUrl: 'https://127.0.0.1:1300/bangumi/calendar/today',
    items,
  });

  assert.match(xml, /<rss version="2.0"/);
  assert.match(xml, /<title>Bangumi 番组计划 - 星期日每日放送<\/title>/);
  assert.match(xml, /<title>【评分 8\.9】葬送的芙莉莲<\/title>/);
  assert.match(xml, /<enclosure url="https:\/\/lain\.bgm\.tv\/pic\/cover\/l\/40\/00\/400001_large\.jpg" type="image\/jpeg"\/>/);
});

test('createBangumiFetcher handles /today, /week, and specific weekday routes', async () => {
  const fetchMock = async (url) => {
    assert.ok(url.includes('api.bgm.tv/calendar'));
    return {
      status: 200,
      headers: { 'content-type': 'application/json' },
      json: async () => SAMPLE_BANGUMI_CALENDAR,
    };
  };

  const fetcher = createBangumiFetcher({ fetchExternal: fetchMock, now: () => new Date('2024-03-10T12:00:00Z') });

  const resToday = await fetcher.handleFetch({ routeId: '/bangumi/calendar/today' });
  assert.ok(resToday.rssXml);
  assert.match(resToday.rssXml, /<rss version="2.0"/);
  assert.match(resToday.rssXml, /星期日/);

  const resWeek = await fetcher.handleFetch({ routeId: '/bangumi/calendar/week' });
  assert.match(resWeek.rssXml, /迷宫饭/);
});
