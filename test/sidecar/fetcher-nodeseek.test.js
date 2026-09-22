import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createNodeSeekFetcher,
  parseNodeSeekPosts,
  renderNodeSeekFeed,
} from '../../sidecar/fetcher-nodeseek/fetcher.js';

const SAMPLE_HTML = `
<html>
<body>
  <div class="post-item">
    <img src="/avatar/12345.png" alt="alice" />
    <div class="post-title">
      <a href="/post-10001-1">推荐几款便宜好用的香港 VPS</a>
    </div>
    <span class="info-author">
      <a href="/space/12345">alice</a>
    </span>
  </div>
  <div class="post-item">
    <img src="/avatar/67890.png" alt="bob" />
    <div class="post-title">
      <a href="/post-10002-1">Cloudflare 最新 CDN 规则分享</a>
    </div>
    <span class="info-author">
      <a href="/space/67890">bob</a>
    </span>
  </div>
</body>
</html>
`;

test('parseNodeSeekPosts correctly extracts posts, authors, and avatar links', () => {
  const posts = parseNodeSeekPosts(SAMPLE_HTML);
  assert.equal(posts.length, 2);
  assert.equal(posts[0].id, '10001');
  assert.equal(posts[0].title, '推荐几款便宜好用的香港 VPS');
  assert.equal(posts[0].author, 'alice');
  assert.equal(posts[0].link, 'https://www.nodeseek.com/post-10001-1');
  assert.equal(posts[0].avatar, 'https://www.nodeseek.com/avatar/12345.png');

  assert.equal(posts[1].id, '10002');
  assert.equal(posts[1].title, 'Cloudflare 最新 CDN 规则分享');
  assert.equal(posts[1].author, 'bob');
});

test('renderNodeSeekFeed generates valid RSS 2.0 XML with enclosures', () => {
  const posts = parseNodeSeekPosts(SAMPLE_HTML);
  const xml = renderNodeSeekFeed({
    title: 'NodeSeek 最新主题',
    description: 'NodeSeek 论坛',
    selfUrl: '/nodeseek/latest',
    posts,
  });

  assert.ok(xml.includes('<title>推荐几款便宜好用的香港 VPS</title>'));
  assert.ok(xml.includes('<author>alice</author>'));
  assert.ok(xml.includes('<enclosure url="https://www.nodeseek.com/avatar/12345.png" type="image/png"/>'));
});

test('createNodeSeekFetcher handles latest and category routes', async () => {
  const fetchRenderedHtml = async (url) => {
    assert.ok(url === 'https://www.nodeseek.com' || url.includes('/category/tech'));
    return {
      status: 200,
      html: SAMPLE_HTML,
    };
  };

  const fetcher = createNodeSeekFetcher({ fetchRenderedHtml });
  const res = await fetcher.handleFetch({ routeId: '/nodeseek/latest' });
  assert.ok(res.rssXml.includes('推荐几款便宜好用的香港 VPS'));
  assert.equal(res.mediaUrls.length, 2);

  const catRes = await fetcher.handleFetch({
    routeId: '/nodeseek/category/:category',
    params: { category: 'tech' },
  });
  assert.ok(catRes.rssXml.includes('板块: tech'));
});
