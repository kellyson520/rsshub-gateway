import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createAcgRipFetcher,
  parseAcgRipPosts,
  renderAcgRipFeed,
} from '../../sidecar/fetcher-acgrip/fetcher.js';

const SAMPLE_HTML = `
<html>
<body>
  <table>
    <tr>
      <td class="date hidden-xs hidden-sm">
        <div><a href="/user/1470">悠哈璃羽字幕社</a></div>
        <div><time datetime="1790080582">21 分钟</time></div>
      </td>
      <td class="title">
        <span class="label label-team"><a href="/team/134">悠哈璃羽</a></span>
        <span class="title">
          <a href="/t/363809">【悠哈璃羽字幕社】[碧蓝航线 微速前进 S2][12][1080p]</a>
        </span>
      </td>
      <td class="action"><a href="/t/363809.torrent"><i class="fa fa-download"></i></a></td>
      <td class="size">156.6 MB</td>
    </tr>
  </table>
</body>
</html>
`;

test('parseAcgRipPosts extracts title, torrentUrl, size, team, and uploader', () => {
  const posts = parseAcgRipPosts(SAMPLE_HTML);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].id, '363809');
  assert.equal(posts[0].title, '【悠哈璃羽字幕社】[碧蓝航线 微速前进 S2][12][1080p]');
  assert.equal(posts[0].torrentUrl, 'https://acg.rip/t/363809.torrent');
  assert.equal(posts[0].size, '156.6 MB');
  assert.equal(posts[0].uploader, '悠哈璃羽字幕社');
  assert.equal(posts[0].team, '悠哈璃羽');
});

test('renderAcgRipFeed outputs valid RSS 2.0 XML with torrent enclosure', () => {
  const posts = parseAcgRipPosts(SAMPLE_HTML);
  const xml = renderAcgRipFeed({
    title: 'ACG.RIP - 最新番组发布',
    description: 'ACG.RIP feed',
    selfUrl: '/acgrip/latest',
    posts,
  });

  assert.ok(xml.includes('<title>【悠哈璃羽字幕社】[碧蓝航线 微速前进 S2][12][1080p]</title>'));
  assert.ok(xml.includes('<enclosure url="https://acg.rip/t/363809.torrent" type="application/x-bittorrent"/>'));
});

test('createAcgRipFetcher handles latest route', async () => {
  const fetchHtml = async (url) => {
    assert.equal(url, 'https://acg.rip/');
    return {
      status: 200,
      text: async () => SAMPLE_HTML,
    };
  };

  const fetcher = createAcgRipFetcher({ fetchHtml });
  const res = await fetcher.handleFetch({ routeId: '/acgrip/latest' });
  assert.ok(res.rssXml.includes('碧蓝航线'));
  assert.equal(res.cacheHint.ttl, 900);
});
