import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseNyaaTorrents,
  renderNyaaFeed,
  createNyaaFetcher,
} from '../../sidecar/fetcher-nyaa/fetcher.js';

const SAMPLE_NYAA_HTML = `
<!DOCTYPE html>
<html>
<body>
<div class="table-responsive">
  <table class="table table-bordered table-hover table-striped torrent-list">
    <thead><tr><th>Category</th><th>Name</th><th>Link</th><th>Size</th><th>Date</th><th>Seeders</th><th>Leechers</th><th>Completed</th></tr></thead>
    <tbody>
      <tr class="default">
        <td><a href="/?c=1_2" title="Anime - English-translated"><img src="/static/img/icons/1_2.png" alt="Anime - English-translated"></a></td>
        <td colspan="2">
          <a href="/view/1800001" title="[SubsPlease] Frieren - Beyond Journey's End - 28 (1080p) [ABCD1234].mkv">[SubsPlease] Frieren - Beyond Journey's End - 28 (1080p) [ABCD1234].mkv</a>
        </td>
        <td class="text-center">
          <a href="/download/1800001.torrent"><i class="fa fa-download"></i></a>
          <a href="magnet:?xt=urn:btih:abcdef1234567890abcdef1234567890abcdef12&dn=Frieren"><i class="fa fa-magnet"></i></a>
        </td>
        <td class="text-center">1.4 GiB</td>
        <td class="text-center" data-timestamp="1710000000">2024-03-09 14:00</td>
        <td class="text-center">152</td>
        <td class="text-center">12</td>
        <td class="text-center">2430</td>
      </tr>
      <tr class="success">
        <td><a href="/?c=1_4" title="Anime - Raw"><img src="/static/img/icons/1_4.png" alt="Anime - Raw"></a></td>
        <td colspan="2">
          <a href="/view/1800002" title="[Erai-raws] Dungeon Meshi - 11 [1080p]">[Erai-raws] Dungeon Meshi - 11 [1080p]</a>
        </td>
        <td class="text-center">
          <a href="/download/1800002.torrent"><i class="fa fa-download"></i></a>
          <a href="magnet:?xt=urn:btih:0987654321fedcba0987654321fedcba09876543&dn=Dungeon"><i class="fa fa-magnet"></i></a>
        </td>
        <td class="text-center">950.2 MiB</td>
        <td class="text-center" data-timestamp="1710010000">2024-03-09 16:46</td>
        <td class="text-center">88</td>
        <td class="text-center">5</td>
        <td class="text-center">1200</td>
      </tr>
    </tbody>
  </table>
</div>
</body>
</html>
`;

test('parseNyaaTorrents extracts id, title, torrentUrl, magnet, size, category, and seeders', () => {
  const torrents = parseNyaaTorrents(SAMPLE_NYAA_HTML);
  assert.equal(torrents.length, 2);

  assert.equal(torrents[0].id, '1800001');
  assert.equal(torrents[0].title, "[SubsPlease] Frieren - Beyond Journey's End - 28 (1080p) [ABCD1234].mkv");
  assert.equal(torrents[0].link, 'https://nyaa.si/view/1800001');
  assert.equal(torrents[0].torrentUrl, 'https://nyaa.si/download/1800001.torrent');
  assert.ok(torrents[0].magnet.startsWith('magnet:?xt=urn:btih:'));
  assert.equal(torrents[0].size, '1.4 GiB');
  assert.equal(torrents[0].category, 'Anime - English-translated');
  assert.equal(torrents[0].seeders, 152);

  assert.equal(torrents[1].id, '1800002');
  assert.equal(torrents[1].category, 'Anime - Raw');
});

test('renderNyaaFeed produces valid RSS 2.0 with torrent enclosure and magnet links', () => {
  const torrents = parseNyaaTorrents(SAMPLE_NYAA_HTML);
  const xml = renderNyaaFeed({
    title: 'Nyaa - Recent Anime',
    description: 'Recent Anime torrents from Nyaa',
    selfUrl: 'https://127.0.0.1:1300/nyaa/recent',
    torrents,
  });

  assert.match(xml, /<rss version="2.0"/);
  assert.match(xml, /<title>Nyaa - Recent Anime<\/title>/);
  assert.match(xml, /<enclosure url="https:\/\/nyaa\.si\/download\/1800001\.torrent" type="application\/x-bittorrent"\/>/);
  assert.match(xml, /magnet:\?xt=urn:btih:/);
  assert.match(xml, /1\.4 GiB/);
});

test('createNyaaFetcher handles /recent, /user, and /search routes', async () => {
  const fetchMock = async (url) => {
    assert.ok(url.includes('nyaa.si'));
    return {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
      text: async () => SAMPLE_NYAA_HTML,
    };
  };

  const fetcher = createNyaaFetcher({ fetchHtml: fetchMock });

  const resRecent = await fetcher.handleFetch({ routeId: '/nyaa/recent' });
  assert.ok(resRecent.rssXml);
  assert.match(resRecent.rssXml, /<rss version="2.0"/);

  const resUser = await fetcher.handleFetch({ routeId: '/nyaa/user/SubsPlease', params: { username: 'SubsPlease' } });
  assert.match(resUser.rssXml, /SubsPlease/);

  const resSearch = await fetcher.handleFetch({ routeId: '/nyaa/search/Frieren', params: { query: 'Frieren' } });
  assert.match(resSearch.rssXml, /Frieren/);
});
