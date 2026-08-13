import test from 'node:test';
import assert from 'node:assert/strict';
import { createEhFetcher, HttpError } from '../sidecar/fetcher-eh/fetcher.js';

const RANKING_HTML = `<table class="gltc"><tbody>
  <tr>
    <td><p>1</p></td>
    <td class="glname"><a href="https://e-hentai.org/g/123/abc/">Gallery Title</a></td>
    <td class="glthumb"><img src="https://ehgt.org/thumb.jpg"/></td>
    <td class="gt" title=":Misc"></td>
  </tr>
</tbody></table>`;

function htmlResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, text: async () => body };
}

test('eh fetcher renders a ranking feed for the default day period', async () => {
  const requested = [];
  const fetcher = createEhFetcher({
    fetchHtml: async (url) => {
      requested.push(String(url));
      return htmlResponse(RANKING_HTML);
    },
  });
  const result = await fetcher.handleFetch({ routeId: '/ehviewer/ranking/:period?', params: {}, cacheTtl: 300 });
  assert.equal(requested[0], 'https://e-hentai.org/toplist.php?tl=15');
  assert.ok(result.rssXml.includes('<rss version="2.0"'));
  assert.ok(result.rssXml.includes('EhViewer 昨日热度'));
  assert.ok(result.rssXml.includes('Gallery Title'));
  assert.ok(result.rssXml.includes('https://e-hentai.org/g/123/abc/'));
  assert.ok(result.mediaUrls.includes('https://ehgt.org/thumb.jpg'));
  assert.equal(result.cacheHint.ttl, 300);
});

test('eh fetcher maps month, year and all periods to their toplist queries', async () => {
  const requested = [];
  const fetcher = createEhFetcher({
    fetchHtml: async (url) => {
      requested.push(String(url));
      return htmlResponse(RANKING_HTML);
    },
  });
  await fetcher.handleFetch({ routeId: '/ehviewer/ranking/:period?', params: { period: 'month' } });
  await fetcher.handleFetch({ routeId: '/ehviewer/ranking/:period?', params: { period: 'year' } });
  await fetcher.handleFetch({ routeId: '/ehviewer/ranking/:period?', params: { period: 'all' } });
  assert.deepEqual(requested, [
    'https://e-hentai.org/toplist.php?tl=13',
    'https://e-hentai.org/toplist.php?tl=12',
    'https://e-hentai.org/toplist.php?tl=11',
  ]);
});

test('eh fetcher rejects unknown periods and routeIds', async () => {
  const fetcher = createEhFetcher({ fetchHtml: async () => htmlResponse(RANKING_HTML) });
  await assert.rejects(
    () => fetcher.handleFetch({ routeId: '/ehviewer/ranking/:period?', params: { period: 'unknown' } }),
    (error) => error instanceof HttpError && error.status === 400,
  );
  await assert.rejects(
    () => fetcher.handleFetch({ routeId: '/bogus/:id', params: { id: '1' } }),
    (error) => error instanceof HttpError && error.status === 400,
  );
});

test('eh fetcher wraps upstream failures as 502', async () => {
  const fetcher = createEhFetcher({
    fetchHtml: async () => { throw new Error('network down'); },
  });
  await assert.rejects(
    () => fetcher.handleFetch({ routeId: '/ehviewer/ranking/:period?', params: {} }),
    (error) => error instanceof HttpError && error.status === 502,
  );
});

test('eh fetcher rejects non-ok upstream responses as 502', async () => {
  const fetcher = createEhFetcher({
    fetchHtml: async () => htmlResponse('forbidden', 403),
  });
  await assert.rejects(
    () => fetcher.handleFetch({ routeId: '/ehviewer/ranking/:period?', params: {} }),
    (error) => error instanceof HttpError && error.status === 502,
  );
});
