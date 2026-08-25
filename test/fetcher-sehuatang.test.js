import test from 'node:test';
import assert from 'node:assert/strict';
import { createSehuatangFetcher, HttpError, sehuatangTarget, parseList, renderFeed } from '../sidecar/fetcher-sehuatang/fetcher.js';

const HTML_DATA = `
<html>
<body>
<table id="threadlisttableid">
  <tbody id="normalthread_123456">
    <tr>
      <td class="icn"></td>
      <th class="new">
        <a href="thread-123456-1-1.html" class="xst">[中文字幕] SSIS-999 示例影片发布</a>
      </th>
      <td class="by">
        <cite><a href="space-uid-100.html">发布老哥</a></cite>
        <em><span>2024-06-01</span></em>
      </td>
      <td class="num">
        <a href="thread-123456-1-1.html" class="xi2">18</a>
        <em>1520</em>
      </td>
    </tr>
  </tbody>
  <tbody id="normalthread_123457">
    <tr>
      <td class="icn"></td>
      <th class="new">
        <a href="thread-123457-1-1.html" class="xst">[中文字幕] MIDV-888 第二部影片</a>
      </th>
      <td class="by">
        <cite><a href="space-uid-101.html">字幕达人</a></cite>
        <em><span>2024-06-02</span></em>
      </td>
      <td class="num">
        <a href="thread-123457-1-1.html" class="xi2">32</a>
        <em>2480</em>
      </td>
    </tr>
  </tbody>
</table>
</body>
</html>
`;

function mockHtmlResponse(html, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => html,
  };
}

// ===== sehuatangTarget 测试 =====

test('sehuatangTarget: maps subforum aliases', () => {
  const t1 = sehuatangTarget('/sehuatang/:subforumid?', { subforumid: 'gqzwzm' });
  assert.equal(t1.fid, '103');
  assert.ok(t1.title.includes('高清中文字幕'));

  const t2 = sehuatangTarget('/sehuatang/:subforumid?', { subforumid: '103' });
  assert.equal(t2.fid, '103');

  const t3 = sehuatangTarget('/sehuatang/:subforumid?', {});
  assert.equal(t3.fid, '103');
});

test('sehuatangTarget: rejects unsupported routeId', () => {
  assert.throws(
    () => sehuatangTarget('/other/route', {}),
    (e) => e instanceof HttpError && e.status === 400,
  );
});

// ===== parseList & renderFeed 测试 =====

test('parseList: extracts threads accurately', () => {
  const items = parseList(HTML_DATA);
  assert.equal(items.length, 2);
  assert.ok(items[0].title.includes('SSIS-999'));
  assert.equal(items[0].guid, 'sehuatang:thread:123456');
  assert.ok(items[0].url.includes('thread-123456-1-1.html'));
  assert.ok(items[0].description.includes('发布老哥'));
});

test('renderFeed: generates valid RSS feed', () => {
  const items = parseList(HTML_DATA);
  const xml = renderFeed({
    title: '98堂 色花堂 - 高清中文字幕',
    siteUrl: 'https://www.sehuatang.net/forum.php?mod=forumdisplay&fid=103',
    items,
  });
  assert.ok(xml.includes('<rss version="2.0"'));
  assert.ok(xml.includes('98堂 色花堂 - 高清中文字幕'));
  assert.ok(xml.includes('SSIS-999'));
  assert.ok(xml.includes('sehuatang:thread:123456'));
});

// ===== createSehuatangFetcher 集成测试 =====

test('fetcher: returns rssXml, mediaUrls and cacheHint', async () => {
  const fetcher = createSehuatangFetcher({
    fetchHtml: async () => mockHtmlResponse(HTML_DATA),
  });
  const result = await fetcher.handleFetch({
    routeId: '/sehuatang/:subforumid?',
    params: { subforumid: '103' },
  });
  assert.ok(result.rssXml.includes('<rss version="2.0"'));
  assert.ok(result.rssXml.includes('SSIS-999'));
  assert.ok(result.rssXml.includes('MIDV-888'));
  assert.equal(result.cacheHint.ttl, 3600);
});

test('fetcher: handles empty forum thread list gracefully with short TTL', async () => {
  const fetcher = createSehuatangFetcher({
    fetchHtml: async () => mockHtmlResponse('<html><body><div>No threads</div></body></html>'),
  });
  const result = await fetcher.handleFetch({
    routeId: '/sehuatang/:subforumid?',
    params: { subforumid: '103' },
  });
  assert.ok(result.rssXml.includes('<rss version="2.0"'));
  assert.equal(result.cacheHint.ttl, 120);
});

test('fetcher: maps upstream network failure to 502', async () => {
  const failing = createSehuatangFetcher({
    fetchHtml: async () => { throw new Error('Network timeout'); },
  });
  await assert.rejects(
    () => failing.handleFetch({ routeId: '/sehuatang/:subforumid?', params: { subforumid: '103' } }),
    (e) => e instanceof HttpError && e.status === 502,
  );
});
