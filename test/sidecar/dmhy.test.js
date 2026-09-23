import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseDmhyTopics,
  renderDmhyFeed,
  createDmhyFetcher,
} from '../../sidecar/fetcher-dmhy/fetcher.js';

const SAMPLE_DMHY_HTML = `
<!DOCTYPE html>
<html>
<body>
<table id="topic_list" class="tablesorter">
  <thead><tr><th>發佈時間</th><th>分類</th><th>標題</th><th>下載</th><th>大小</th><th>種子</th><th>下載</th><th>完成</th></tr></thead>
  <tbody>
    <tr>
      <td class="text-center" style="width: 98px;">2024/03/10 15:30</td>
      <td class="text-center"><a href="/topics/list/sort_id/2"><font color="#0080ff">季度全集</font></a></td>
      <td class="title">
        <span class="tag"><a href="/topics/list/sort_id/2">季度全集</a></span>
        <a href="/topics/view/660001_Frieren_01_28.html" target="_blank">【喵萌奶茶屋】★01月新番★[葬送的芙莉莲 / Sousou no Frieren][01-28][720p/1080p][BDRip][简繁外挂]</a>
      </td>
      <td class="text-center">
        <a class="download-arrow arrow-magnet" href="magnet:?xt=urn:btih:1111222233334444555566667777888899990000&dn=Frieren" title="磁力下載"></a>
      </td>
      <td class="text-center">18.5GB</td>
      <td class="text-center"><span class="btl_1">250</span></td>
      <td class="text-center"><span class="btl_2">30</span></td>
      <td class="text-center">3420</td>
    </tr>
    <tr>
      <td class="text-center" style="width: 98px;">2024/03/10 16:15</td>
      <td class="text-center"><a href="/topics/list/sort_id/31"><font color="#228b22">日語動畫</font></a></td>
      <td class="title">
        <a href="/topics/view/660002_Dungeon_11.html" target="_blank">[爱恋&漫猫字幕组][迷宫饭][Dungeon Meshi][11][1080p][MP4][简中]</a>
      </td>
      <td class="text-center">
        <a class="download-arrow arrow-magnet" href="magnet:?xt=urn:btih:aaaabbbbccccddddeeeeffff0000111122223333&dn=Dungeon" title="磁力下載"></a>
      </td>
      <td class="text-center">650MB</td>
      <td class="text-center"><span class="btl_1">180</span></td>
      <td class="text-center"><span class="btl_2">10</span></td>
      <td class="text-center">1500</td>
    </tr>
  </tbody>
</table>
</body>
</html>
`;

test('parseDmhyTopics extracts id, title, link, magnet, size, category, and seeders', () => {
  const topics = parseDmhyTopics(SAMPLE_DMHY_HTML);
  assert.equal(topics.length, 2);

  assert.equal(topics[0].id, '660001');
  assert.equal(topics[0].title, '【喵萌奶茶屋】★01月新番★[葬送的芙莉莲 / Sousou no Frieren][01-28][720p/1080p][BDRip][简繁外挂]');
  assert.equal(topics[0].link, 'https://share.dmhy.org/topics/view/660001_Frieren_01_28.html');
  assert.equal(topics[0].magnet, 'magnet:?xt=urn:btih:1111222233334444555566667777888899990000&dn=Frieren');
  assert.equal(topics[0].size, '18.5GB');
  assert.equal(topics[0].category, '季度全集');
  assert.equal(topics[0].seeders, 250);

  assert.equal(topics[1].id, '660002');
  assert.equal(topics[1].category, '日語動畫');
  assert.equal(topics[1].size, '650MB');
});

test('renderDmhyFeed outputs valid RSS 2.0 with magnet link', () => {
  const topics = parseDmhyTopics(SAMPLE_DMHY_HTML);
  const xml = renderDmhyFeed({
    title: '动漫花园 - 最新发布',
    description: '动漫花园 DMHY 最新动画 BT 发布列表',
    selfUrl: 'https://127.0.0.1:1300/dmhy/latest',
    topics,
  });

  assert.match(xml, /<rss version="2.0"/);
  assert.match(xml, /<title>动漫花园 - 最新发布<\/title>/);
  assert.match(xml, /magnet:\?xt=urn:btih:1111222233334444555566667777888899990000/);
  assert.match(xml, /18\.5GB/);
});

test('createDmhyFetcher handles /latest, /sort_id, and /search routes', async () => {
  const fetchMock = async (url) => {
    assert.ok(url.includes('dmhy.org'));
    return {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
      text: async () => SAMPLE_DMHY_HTML,
    };
  };

  const fetcher = createDmhyFetcher({ fetchHtml: fetchMock });

  const resLatest = await fetcher.handleFetch({ routeId: '/dmhy/latest' });
  assert.ok(resLatest.rssXml);
  assert.match(resLatest.rssXml, /<rss version="2.0"/);

  const resCategory = await fetcher.handleFetch({ routeId: '/dmhy/topics/2', params: { sort_id: '2' } });
  assert.match(resCategory.rssXml, /季度全集/);

  const resSearch = await fetcher.handleFetch({ routeId: '/dmhy/search/Frieren', params: { keyword: 'Frieren' } });
  assert.match(resSearch.rssXml, /Frieren/);
});
