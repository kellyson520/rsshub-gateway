import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createV2exFetcher,
  parseV2exTopics,
  renderV2exFeed,
} from '../../sidecar/fetcher-v2ex/fetcher.js';

const SAMPLE_HTML = `
<html>
<body>
  <div class="cell item">
    <table cellpadding="0" cellspacing="0" border="0" width="100%">
      <tr>
        <td width="48" valign="top" align="center">
          <a href="/member/devguy"><img src="https://cdn.v2ex.com/avatar/111.png" class="avatar" /></a>
        </td>
        <td width="auto" valign="middle">
          <span class="item_title"><a href="/t/99901#reply10">Node.js 22 LTS 性能大幅提升</a></span>
          <span class="topic_info">
            <a class="node" href="/go/nodejs">nodejs</a> &nbsp;•&nbsp; <strong><a href="/member/devguy">devguy</a></strong>
          </span>
        </td>
      </tr>
    </table>
  </div>
</body>
</html>
`;

test('parseV2exTopics correctly extracts topic title, id, author, avatar, and node', () => {
  const topics = parseV2exTopics(SAMPLE_HTML);
  assert.equal(topics.length, 1);
  assert.equal(topics[0].id, '99901');
  assert.equal(topics[0].title, 'Node.js 22 LTS 性能大幅提升');
  assert.equal(topics[0].author, 'devguy');
  assert.equal(topics[0].nodeName, 'nodejs');
  assert.equal(topics[0].link, 'https://www.v2ex.com/t/99901');
  assert.equal(topics[0].avatar, 'https://cdn.v2ex.com/avatar/111.png');
});

test('renderV2exFeed creates valid RSS 2.0 XML with category', () => {
  const topics = parseV2exTopics(SAMPLE_HTML);
  const xml = renderV2exFeed({
    title: 'V2EX - 技术讨论',
    description: 'V2EX feed',
    selfUrl: '/v2ex/topics/latest',
    topics,
  });

  assert.ok(xml.includes('<title>[nodejs] Node.js 22 LTS 性能大幅提升</title>'));
  assert.ok(xml.includes('<category>nodejs</category>'));
  assert.ok(xml.includes('<enclosure url="https://cdn.v2ex.com/avatar/111.png" type="image/png"/>'));
});

test('createV2exFetcher handles tab and hot routes', async () => {
  const fetchHtml = async (url) => {
    assert.ok(url.includes('tab=hot') || url.includes('tab=tech'));
    return {
      status: 200,
      text: async () => SAMPLE_HTML,
    };
  };

  const fetcher = createV2exFetcher({ fetchHtml });
  const hotRes = await fetcher.handleFetch({ routeId: '/v2ex/topics/hot' });
  assert.ok(hotRes.rssXml.includes('Node.js 22 LTS 性能大幅提升'));
  assert.equal(hotRes.mediaUrls.length, 1);
});
