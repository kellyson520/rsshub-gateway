import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createDlsiteFetcher,
  parseDlsiteWorks,
  renderDlsiteFeed,
} from '../../sidecar/fetcher-dlsite/fetcher.js';

const SAMPLE_HTML = `
<html>
<body>
  <div class="ranking_work">
    <dt class="work_name">
      <a href="https://www.dlsite.com/maniax/work/=/product_id/RJ328940.html">Cultivator Demo</a>
    </dt>
    <dd class="maker_name">
      <a href="https://www.dlsite.com/maniax/circle/profile/=/maker_id/RG12248.html">Panjandrum Circle</a>
    </dd>
    <img src="//img.dlsite.jp/modpub/images2/work/doujin/RJ329000/RJ328940_img_main.jpg" />
  </div>
  <div class="ranking_work">
    <dt class="work_name">
      <a href="https://www.dlsite.com/maniax/work/=/product_id/RJ01681172.html">Astreia Adventure</a>
    </dt>
    <dd class="maker_name">
      <a href="https://www.dlsite.com/maniax/circle/profile/=/maker_id/RG99999.html">Game Maker Z</a>
    </dd>
    <img src="//img.dlsite.jp/modpub/images2/work/doujin/RJ01682000/RJ01681172_img_main.jpg" />
  </div>
</body>
</html>
`;

test('parseDlsiteWorks extracts RJ id, title, maker, and poster', () => {
  const works = parseDlsiteWorks(SAMPLE_HTML);
  assert.equal(works.length, 2);
  assert.equal(works[0].id, 'RJ328940');
  assert.equal(works[0].title, 'Cultivator Demo');
  assert.equal(works[0].maker, 'Panjandrum Circle');
  assert.equal(works[0].poster, 'https://img.dlsite.jp/modpub/images2/work/doujin/RJ329000/RJ328940_img_main.jpg');

  assert.equal(works[1].id, 'RJ01681172');
  assert.equal(works[1].title, 'Astreia Adventure');
  assert.equal(works[1].maker, 'Game Maker Z');
});

test('renderDlsiteFeed formats rich RSS feed', () => {
  const works = parseDlsiteWorks(SAMPLE_HTML);
  const xml = renderDlsiteFeed({
    title: 'DLsite maniax 日榜',
    description: 'DLsite ranking',
    selfUrl: '/dlsite/ranking/maniax/day',
    works,
  });

  assert.ok(xml.includes('<title>[RJ328940] Cultivator Demo - Panjandrum Circle</title>'));
  assert.ok(xml.includes('<enclosure url="https://img.dlsite.jp/modpub/images2/work/doujin/RJ329000/RJ328940_img_main.jpg" type="image/jpeg"/>'));
});

test('createDlsiteFetcher handles ranking route properly', async () => {
  const fetchHtml = async (url) => {
    assert.ok(url.includes('/maniax/ranking/day'));
    return {
      status: 200,
      text: async () => SAMPLE_HTML,
    };
  };

  const fetcher = createDlsiteFetcher({ fetchHtml });
  const result = await fetcher.handleFetch({
    routeId: '/dlsite/ranking/:type?/:period?',
    params: { type: 'maniax', period: 'day' },
  });

  assert.ok(result.rssXml.includes('Cultivator Demo'));
  assert.equal(result.mediaUrls.length, 2);
});
