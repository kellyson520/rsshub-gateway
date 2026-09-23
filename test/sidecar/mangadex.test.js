import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseMangaDexChapters,
  renderMangaDexFeed,
  createMangaDexFetcher,
} from '../../sidecar/fetcher-mangadex/fetcher.js';

const SAMPLE_MANGADEX_RESPONSE = {
  result: 'ok',
  data: [
    {
      id: 'chapter-uuid-1',
      type: 'chapter',
      attributes: {
        volume: '12',
        chapter: '128',
        title: '旅の終わり',
        translatedLanguage: 'zh-hk',
        publishAt: '2024-03-10T12:00:00+00:00',
        pages: 18,
      },
      relationships: [
        {
          id: 'manga-uuid-1',
          type: 'manga',
          attributes: {
            title: {
              'zh-hk': '葬送的芙莉蓮',
              'en': "Frieren: Beyond Journey's End",
              'ja': '葬送のフリーレン',
            },
          },
        },
        {
          id: 'group-uuid-1',
          type: 'scanlation_group',
          attributes: {
            name: '民間漢化組',
          },
        },
      ],
    },
    {
      id: 'chapter-uuid-2',
      type: 'chapter',
      attributes: {
        volume: '4',
        chapter: '32',
        title: null,
        translatedLanguage: 'en',
        publishAt: '2024-03-10T13:30:00+00:00',
        pages: 24,
      },
      relationships: [
        {
          id: 'manga-uuid-2',
          type: 'manga',
          attributes: {
            title: {
              en: 'Delicious in Dungeon',
              ja: 'ダンジョン飯',
            },
          },
        },
      ],
    },
  ],
};

test('parseMangaDexChapters extracts chapter details, manga titles, and groups', () => {
  const chapters = parseMangaDexChapters(SAMPLE_MANGADEX_RESPONSE);
  assert.equal(chapters.length, 2);

  assert.equal(chapters[0].id, 'chapter-uuid-1');
  assert.equal(chapters[0].mangaTitle, '葬送的芙莉蓮');
  assert.equal(chapters[0].chapterNumber, '128');
  assert.equal(chapters[0].volume, '12');
  assert.equal(chapters[0].chapterTitle, '旅の終わり');
  assert.equal(chapters[0].language, 'zh-hk');
  assert.equal(chapters[0].group, '民間漢化組');
  assert.equal(chapters[0].link, 'https://mangadex.org/chapter/chapter-uuid-1');

  assert.equal(chapters[1].id, 'chapter-uuid-2');
  assert.equal(chapters[1].mangaTitle, 'Delicious in Dungeon');
  assert.equal(chapters[1].language, 'en');
});

test('renderMangaDexFeed outputs valid RSS 2.0 with chapter reader links', () => {
  const chapters = parseMangaDexChapters(SAMPLE_MANGADEX_RESPONSE);
  const xml = renderMangaDexFeed({
    title: 'MangaDex - 最新更新漫画',
    description: 'MangaDex 全球多语言漫画最新章节',
    selfUrl: 'https://127.0.0.1:1300/mangadex/latest',
    chapters,
  });

  assert.match(xml, /<rss version="2.0"/);
  assert.match(xml, /<title>MangaDex - 最新更新漫画<\/title>/);
  assert.match(xml, /葬送的芙莉蓮 - \[卷 12\] 第 128 话 旅の終わり/);
  assert.match(xml, /民間漢化組/);
  assert.match(xml, /https:\/\/mangadex\.org\/chapter\/chapter-uuid-1/);
});

test('createMangaDexFetcher handles /latest, /manga/:id, and language filtering', async () => {
  const fetchMock = async (url) => {
    assert.ok(url.includes('api.mangadex.org/chapter'));
    return {
      status: 200,
      headers: { 'content-type': 'application/json' },
      json: async () => SAMPLE_MANGADEX_RESPONSE,
    };
  };

  const fetcher = createMangaDexFetcher({ fetchExternal: fetchMock });

  const resLatest = await fetcher.handleFetch({ routeId: '/mangadex/latest' });
  assert.ok(resLatest.rssXml);
  assert.match(resLatest.rssXml, /<rss version="2.0"/);

  const resManga = await fetcher.handleFetch({ routeId: '/mangadex/manga/manga-uuid-1', params: { id: 'manga-uuid-1' } });
  assert.match(resManga.rssXml, /葬送的芙莉蓮/);
});
