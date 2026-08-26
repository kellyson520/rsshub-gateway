import test from 'node:test';
import assert from 'node:assert/strict';
import { firstImagePageUrl, galleryPageUrls, imagePageUrls, parseRankingHtml, rankingTarget, renderRankingFeed } from '../src/adapters/ehviewer.js';

test('maps ranking periods to E-Hentai toplist targets', () => {
  assert.equal(rankingTarget('day'), 'https://e-hentai.org/toplist.php?tl=15');
  assert.equal(rankingTarget('month'), 'https://e-hentai.org/toplist.php?tl=13');
  assert.equal(rankingTarget('year'), 'https://e-hentai.org/toplist.php?tl=12');
  assert.equal(rankingTarget('all'), 'https://e-hentai.org/toplist.php?tl=11');
  assert.throws(() => rankingTarget('unknown'), /period/i);
});

test('parses live gallery row fields into an inline-readable RSS entry', () => {
  const parsed = parseRankingHtml(`
    <table class="itg gltc"><tbody><tr class="gtr">
      <td><p>#1</p><p>123,456</p></td>
      <td class="gl2c"><div class="glthumb"><div><img data-src="https://ehgt.org/thumb.jpg" title="A &amp; B"></div></div></td>
      <td class="gl3c glname"><a href="https://e-hentai.org/g/123/abc/"><div class="glink">A &amp; B</div><div><div class="gt" title="language:chinese">chinese</div><div class="gt" title="female:big breasts">f:big breasts</div></div></a></td>
      <td class="gl4c glhide"><div><a>artist</a></div><div>24 pages</div></td>
      <td><div id="posted_123">2026-08-08 12:00</div></td>
    </tr></tbody></table>
  `, { period: 'day' });
  const item = parsed.items[0];
  const xml = renderRankingFeed(parsed);

  assert.equal(item.title, 'A & B');
  assert.equal(item.rank, '#1');
  assert.equal(item.pageCount, '24 pages');
  assert.equal(item.date, 'Sat, 08 Aug 2026 12:00:00 GMT');
  assert.match(xml, /<rss/);
  assert.match(xml, /A &amp; B/);
  assert.match(xml, /https:\/\/e-hentai\.org\/g\/123\/abc\//);
  assert.match(xml, /https:\/\/ehgt\.org\/thumb\.jpg/);
  assert.match(xml, /xmlns:content="http:\/\/purl\.org\/rss\/1\.0\/modules\/content\/"/);
  assert.match(xml, /<content:encoded><!\[CDATA\[/);
  assert.match(xml, /排名：#1/);
  assert.match(xml, /发布时间：Sat, 08 Aug 2026 12:00:00 GMT/);
  assert.doesNotMatch(xml, /chinesef:big breasts/);
  assert.doesNotMatch(xml, /<script|onerror=/i);
});

test('extracts the first valid E-Hentai image page from a gallery', () => {
  const page = firstImagePageUrl(`
    <div id="gdt">
      <a href="https://evil.example/s/bad/1">bad</a>
      <a href="https://e-hentai.org/s/first/123-1">first</a>
      <a href="https://e-hentai.org/s/second/123-2">second</a>
    </div>
  `, 'https://e-hentai.org/g/123/gallery/');

  assert.equal(page, 'https://e-hentai.org/s/first/123-1');
});

test('extracts the first image page from nested gallery tiles', () => {
  const page = firstImagePageUrl(`
    <div id="gdt">
      <div class="gdtm"><div><a href="https://e-hentai.org/s/first/123-1">first</a></div></div>
      <div class="gdtm"><div><a href="https://e-hentai.org/s/second/123-2">second</a></div></div>
    </div>
  `, 'https://e-hentai.org/g/123/gallery/');

  assert.equal(page, 'https://e-hentai.org/s/first/123-1');
});

test('returns no page for a gallery without a valid E-Hentai image link', () => {
  assert.equal(firstImagePageUrl('<div id="gdt"><a href="/g/123/other/">gallery</a></div>', 'https://e-hentai.org/g/123/gallery/'), '');
});

test('collects E-Hentai gallery pages and ordered unique image pages', () => {
  const html = `<div class="gtb"><a href="/g/123/abc/?p=1">2</a><a href="/g/123/abc/?p=2">3</a></div>
    <div id="gdt"><a href="/s/first/123-1">1</a><a href="/s/second/123-2">2</a><a href="/s/first/123-1">duplicate</a></div>`;

  assert.deepEqual(galleryPageUrls(html, 'https://e-hentai.org/g/123/abc/'), [
    'https://e-hentai.org/g/123/abc/',
    'https://e-hentai.org/g/123/abc/?p=1',
    'https://e-hentai.org/g/123/abc/?p=2',
  ]);
  assert.deepEqual(imagePageUrls(html, 'https://e-hentai.org/g/123/abc/?p=1'), [
    'https://e-hentai.org/s/first/123-1',
    'https://e-hentai.org/s/second/123-2',
  ]);
});

test('exports RANKING_PERIODS, MAX_ITEMS, escapeXml and cdata helpers', async () => {
  const {
    RANKING_PERIODS,
    MAX_ITEMS,
    EH_GALLERY_PATH,
    EH_IMAGE_PATH,
    escapeXml,
    cdata,
  } = await import('../src/adapters/ehviewer.js');

  assert.equal(typeof RANKING_PERIODS, 'object');
  assert.equal(RANKING_PERIODS.day.query, '15');
  assert.equal(MAX_ITEMS, 50);
  assert.ok(EH_GALLERY_PATH instanceof RegExp);
  assert.ok(EH_IMAGE_PATH instanceof RegExp);
  assert.equal(escapeXml('<foo & bar>'), '&lt;foo &amp; bar&gt;');
  assert.equal(cdata('content'), '<![CDATA[content]]>');
});
