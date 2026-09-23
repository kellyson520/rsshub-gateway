import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseEpicFreeGames,
  renderEpicFeed,
  createEpicFetcher,
  formatEpicDate,
} from '../../sidecar/fetcher-epic/fetcher.js';

const SAMPLE_EPIC_DATA = {
  data: {
    Catalog: {
      searchStore: {
        elements: [
          {
            title: '心灵警探 (Mindcop)',
            id: 'mindcop-id-123',
            namespace: 'mindcop-ns',
            description: '一款非线性侦探推理冒险解谜游戏。',
            effectiveDate: '2026-09-17T15:00:00.000Z',
            offerMappings: [
              {
                pageSlug: 'mindcop-78e6c1',
                pageType: 'productHome',
              },
            ],
            keyImages: [
              {
                type: 'OfferImageWide',
                url: 'https://cdn1.epicgames.com/offer/mindcop/wide.jpg',
              },
              {
                type: 'Thumbnail',
                url: 'https://cdn1.epicgames.com/offer/mindcop/thumb.jpg',
              },
            ],
            price: {
              totalPrice: {
                discountPrice: 0,
                originalPrice: 6000,
                currencyCode: 'CNY',
                fmtPrice: {
                  originalPrice: '¥60.00',
                  discountPrice: '0',
                },
              },
            },
            promotions: {
              promotionalOffers: [
                {
                  promotionalOffers: [
                    {
                      startDate: '2026-09-17T15:00:00.000Z',
                      endDate: '2026-09-24T15:00:00.000Z',
                      discountSetting: {
                        discountType: 'PERCENTAGE',
                        discountPercentage: 0,
                      },
                    },
                  ],
                },
              ],
              upcomingPromotionalOffers: [],
            },
          },
          {
            title: 'Astrea Six Sided Oracles',
            id: 'astrea-id-456',
            namespace: 'astrea-ns',
            description: '骰子构筑 Rogue-like 策略游戏。',
            effectiveDate: '2026-09-24T15:00:00.000Z',
            productSlug: 'astrea-six-sided-oracles',
            keyImages: [
              {
                type: 'featuredMedia',
                url: 'https://cdn1.epicgames.com/offer/astrea/featured.jpg',
              },
            ],
            price: {
              totalPrice: {
                discountPrice: 7800,
                originalPrice: 7800,
                currencyCode: 'CNY',
                fmtPrice: {
                  originalPrice: '¥78.00',
                  discountPrice: '¥78.00',
                },
              },
            },
            promotions: {
              promotionalOffers: [],
              upcomingPromotionalOffers: [
                {
                  promotionalOffers: [
                    {
                      startDate: '2026-09-24T15:00:00.000Z',
                      endDate: '2026-10-01T15:00:00.000Z',
                      discountSetting: {
                        discountType: 'PERCENTAGE',
                        discountPercentage: 0,
                      },
                    },
                  ],
                },
              ],
            },
          },
          {
            title: 'Regular Paid Game',
            id: 'paid-789',
            price: {
              totalPrice: {
                discountPrice: 19900,
                originalPrice: 19900,
                currencyCode: 'CNY',
              },
            },
            promotions: null,
          },
        ],
      },
    },
  },
};

test('formatEpicDate converts ISO strings to readable dates', () => {
  const formatted = formatEpicDate('2026-09-17T15:00:00.000Z');
  assert.ok(formatted.includes('2026-09-17'));
});

test('parseEpicFreeGames extracts active and upcoming free promotions', () => {
  const allGames = parseEpicFreeGames(SAMPLE_EPIC_DATA, 'all');
  assert.equal(allGames.length, 2);

  const activeGame = allGames.find((g) => g.status === 'active');
  assert.ok(activeGame);
  assert.equal(activeGame.title, '心灵警探 (Mindcop)');
  assert.equal(activeGame.originalPrice, '¥60.00');
  assert.equal(activeGame.finalPrice, '免费');
  assert.equal(activeGame.coverImage, 'https://cdn1.epicgames.com/offer/mindcop/wide.jpg');
  assert.equal(activeGame.url, 'https://store.epicgames.com/zh-CN/p/mindcop-78e6c1');
  assert.equal(activeGame.startDate, '2026-09-17T15:00:00.000Z');
  assert.equal(activeGame.endDate, '2026-09-24T15:00:00.000Z');

  const upcomingGame = allGames.find((g) => g.status === 'upcoming');
  assert.ok(upcomingGame);
  assert.equal(upcomingGame.title, 'Astrea Six Sided Oracles');
  assert.equal(upcomingGame.originalPrice, '¥78.00');
  assert.equal(upcomingGame.finalPrice, '免费');
  assert.equal(upcomingGame.coverImage, 'https://cdn1.epicgames.com/offer/astrea/featured.jpg');
  assert.equal(upcomingGame.url, 'https://store.epicgames.com/zh-CN/p/astrea-six-sided-oracles');
  assert.equal(upcomingGame.startDate, '2026-09-24T15:00:00.000Z');
  assert.equal(upcomingGame.endDate, '2026-10-01T15:00:00.000Z');

  // Filter test
  const onlyActive = parseEpicFreeGames(SAMPLE_EPIC_DATA, 'active');
  assert.equal(onlyActive.length, 1);
  assert.equal(onlyActive[0].id, 'mindcop-id-123');

  const onlyUpcoming = parseEpicFreeGames(SAMPLE_EPIC_DATA, 'upcoming');
  assert.equal(onlyUpcoming.length, 1);
  assert.equal(onlyUpcoming[0].id, 'astrea-id-456');
});

test('renderEpicFeed outputs valid RSS 2.0 with cover enclosure, prices, and promotion dates', () => {
  const games = parseEpicFreeGames(SAMPLE_EPIC_DATA, 'all');
  const xml = renderEpicFeed({
    title: 'Epic Games 每周限免游戏',
    description: 'Epic 游戏商城每周限时免费喜加一游戏',
    selfUrl: '/epic/free',
    games,
  });

  assert.match(xml, /<rss version="2.0"/);
  assert.match(xml, /<title>Epic Games 每周限免游戏<\/title>/);
  assert.match(xml, /【限免中】心灵警探 \(Mindcop\)/);
  assert.match(xml, /【即将限免】Astrea Six Sided Oracles/);
  assert.match(xml, /<enclosure url="https:\/\/cdn1\.epicgames\.com\/offer\/mindcop\/wide\.jpg" type="image\/jpeg"\/>/);
  assert.match(xml, /原价:.*?¥60\.00/);
  assert.match(xml, /现价:.*?免费/);
  assert.match(xml, /限免时间:/);
});

test('createEpicFetcher handles /epic/free, /epic/active, and /epic/upcoming routes', async () => {
  const fetchMock = async (url) => {
    assert.ok(url.includes('freeGamesPromotions'));
    return {
      status: 200,
      headers: { 'content-type': 'application/json' },
      json: async () => SAMPLE_EPIC_DATA,
    };
  };

  const fetcher = createEpicFetcher({ fetchExternal: fetchMock });

  const resAll = await fetcher.handleFetch({ routeId: '/epic/free' });
  assert.ok(resAll.rssXml);
  assert.equal(resAll.mediaUrls.length, 2);
  assert.match(resAll.rssXml, /心灵警探/);
  assert.match(resAll.rssXml, /Astrea/);

  const resActive = await fetcher.handleFetch({ routeId: '/epic/active' });
  assert.ok(resActive.rssXml);
  assert.equal(resActive.mediaUrls.length, 1);
  assert.match(resActive.rssXml, /心灵警探/);

  const resUpcoming = await fetcher.handleFetch({ routeId: '/epic/upcoming' });
  assert.ok(resUpcoming.rssXml);
  assert.equal(resUpcoming.mediaUrls.length, 1);
  assert.match(resUpcoming.rssXml, /Astrea/);
});
