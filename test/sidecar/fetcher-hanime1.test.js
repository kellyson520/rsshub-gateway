import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createHanimeFetcher,
  parseHanimeVideos,
  renderHanimeFeed,
} from '../../sidecar/fetcher-hanime1/fetcher.js';

const SAMPLE_HTML = `
<html>
<body>
  <div class="video-list">
    <a href="https://hanime1.me/watch?v=1001" class="video-link">
      <img src="https://vdownload.hembed.com/image/thumbnail/1001.jpg" alt="Demo Video 1" />
      <div class="home-rows-videos-title">Demon Slayer Hentai Ep 1</div>
    </a>
    <a href="https://hanime1.me/watch?v=1002" class="video-link">
      <img src="https://vdownload.hembed.com/image/thumbnail/1002.jpg" alt="Demo Video 2" />
      <div class="home-rows-videos-title">Re:Zero Hentai Ep 2</div>
    </a>
  </div>
</body>
</html>
`;

test('parseHanimeVideos correctly extracts watch links, titles, and posters', () => {
  const videos = parseHanimeVideos(SAMPLE_HTML);
  assert.equal(videos.length, 2);
  assert.equal(videos[0].id, '1001');
  assert.equal(videos[0].title, 'Demon Slayer Hentai Ep 1');
  assert.equal(videos[0].link, 'https://hanime1.me/watch?v=1001');
  assert.equal(videos[0].poster, 'https://vdownload.hembed.com/image/thumbnail/1001.jpg');

  assert.equal(videos[1].id, '1002');
  assert.equal(videos[1].title, 'Re:Zero Hentai Ep 2');
});

test('renderHanimeFeed creates valid RSS 2.0 XML with enclosures', () => {
  const videos = parseHanimeVideos(SAMPLE_HTML);
  const xml = renderHanimeFeed({
    title: 'Hanime1 - 最新里番',
    description: 'Hanime1.me 最新里番发布',
    selfUrl: '/hanime1/latest',
    videos,
  });

  assert.ok(xml.includes('<rss version="2.0"'));
  assert.ok(xml.includes('<title>Hanime1 - 最新里番</title>'));
  assert.ok(xml.includes('<title>Demon Slayer Hentai Ep 1</title>'));
  assert.ok(xml.includes('<enclosure url="https://vdownload.hembed.com/image/thumbnail/1001.jpg" type="image/jpeg"/>'));
});

test('createHanimeFetcher handles /hanime1/latest route successfully', async () => {
  const fetchHtml = async (url) => {
    assert.equal(url, 'https://hanime1.me');
    return {
      status: 200,
      text: async () => SAMPLE_HTML,
    };
  };

  const fetcher = createHanimeFetcher({ fetchHtml });
  const result = await fetcher.handleFetch({ routeId: '/hanime1/latest' });
  assert.ok(result.rssXml.includes('Demon Slayer Hentai Ep 1'));
  assert.equal(result.mediaUrls.length, 2);
  assert.equal(result.cacheHint.ttl, 1800);
});

test('createHanimeFetcher handles genre and search routes', async () => {
  const fetchHtml = async (url) => {
    assert.ok(url.includes('genre=3d') || url.includes('query=miku'));
    return {
      status: 200,
      text: async () => SAMPLE_HTML,
    };
  };

  const fetcher = createHanimeFetcher({ fetchHtml });
  const genreRes = await fetcher.handleFetch({
    routeId: '/hanime1/genre/:genre',
    params: { genre: '3d' },
  });
  assert.ok(genreRes.rssXml.includes('分类: 3d'));

  const searchRes = await fetcher.handleFetch({
    routeId: '/hanime1/search/:keyword',
    params: { keyword: 'miku' },
  });
  assert.ok(searchRes.rssXml.includes('搜索: miku'));
});
