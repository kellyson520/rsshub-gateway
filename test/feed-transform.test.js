import test from 'node:test';
import assert from 'node:assert/strict';
import { transformFeed } from '../src/feed-transform.js';
import { verifySignedTarget } from '../src/signed-target.js';

const fixture = `<?xml version="1.0"?><rss version="2.0"><channel>
  <title>Iwara Ranking</title>
  <link>https://www.iwara.tv/videos</link>
  <atom:link xmlns:atom="http://www.w3.org/2005/Atom" href="http://gateway.example.test/iwara/ranking/video/date/ecchi" />
  <item>
    <title>Demo</title>
    <description><![CDATA[<p>Text</p><img src="https://i.iwara.tv/image/demo.jpg"><video poster="https://i.iwara.tv/image/poster.jpg"><source src="https://cdn.iwara.tv/video/demo.mp4"></video>]]></description>
    <link>https://www.iwara.tv/video/abc/demo</link>
  </item>
</channel></rss>`;

const options = {
  baseUrl: 'https://gateway.example.test',
  selfUrl: 'https://gateway.example.test/iwara/ranking/video/date/ecchi',
  secret: 'secret',
  now: 1000,
};

test('rewrites RSS item links and embedded Iwara media to signed gateway routes', () => {
  const output = transformFeed(fixture, options);
  assert.match(output, /https:\/\/gateway\.example\.test\/_gateway\/item\//);
  assert.match(output, /https:\/\/gateway\.example\.test\/_gateway\/media\//);
  assert.match(output, /href="https:\/\/gateway\.example\.test\/iwara\/ranking\/video\/date\/ecchi"/);
  assert.doesNotMatch(output, /https:\/\/cdn\.iwara\.tv\/video\/demo\.mp4/);
});

test('rewrites entity-encoded RSS description media', () => {
  const escaped = `<?xml version="1.0"?><rss><channel><item><link>https://www.iwara.tv/video/abc</link><description>&lt;img src="https://i.iwara.tv/image/demo.jpg"&gt;</description></item></channel></rss>`;
  const output = transformFeed(escaped, options);
  assert.match(output, /_gateway\/media/);
  assert.doesNotMatch(output, /https:\/\/i\.iwara\.tv\/image\/demo\.jpg/);
});

test('rewrites lazy-load and srcset media attributes', () => {
  const lazy = `<?xml version="1.0"?><rss><channel><item><link>https://www.iwara.tv/video/abc</link><description><![CDATA[
    <img src="https://i.iwara.tv/image/placeholder.jpg" data-original="https://i.iwara.tv/image/demo.jpg" data-src="https://i.iwara.tv/image/demo2.jpg">
    <img srcset="https://i.iwara.tv/image/demo3.jpg 480w, https://i.iwara.tv/image/demo4.jpg 960w">
  ]]></description></item></channel></rss>`;
  const output = transformFeed(lazy, options);
  assert.match(output, /data-original="https:\/\/gateway\.example\.test\/_gateway\/media\//);
  assert.match(output, /data-src="https:\/\/gateway\.example\.test\/_gateway\/media\//);
  assert.match(output, /srcset="https:\/\/gateway\.example\.test\/_gateway\/media\/[^"]+ 480w, https:\/\/gateway\.example\.test\/_gateway\/media\/[^"]+ 960w"/);
  assert.doesNotMatch(output, /i\.iwara\.tv\/image\/demo\.jpg|i\.iwara\.tv\/image\/demo2\.jpg|i\.iwara\.tv\/image\/demo3\.jpg|i\.iwara\.tv\/image\/demo4\.jpg/);
});

test('rewrites V2EX item links to the gateway reader', () => {
  const v2ex = `<?xml version="1.0"?><rss><channel><item><title>V2EX topic</title><link>https://v2ex.com/t/123456</link></item></channel></rss>`;
  const output = transformFeed(v2ex, options);

  assert.match(output, /https:\/\/gateway\.example\.test\/_gateway\/item\//);
  assert.doesNotMatch(output, /https:\/\/v2ex\.com\/t\/123456/);
});

test('uses a stable gateway URL for the same media during one cache day', () => {
  const first = transformFeed(fixture, { ...options, now: 1_000 });
  const later = transformFeed(fixture, { ...options, now: 86_399 });
  const mediaUrl = /https:\/\/gateway\.example\.test\/_gateway\/media\/[^"<]+/;

  assert.equal(first.match(mediaUrl)?.[0], later.match(mediaUrl)?.[0]);
});

test('rewrites Telegram post links and Telesco media to the gateway', () => {
  const telegram = `<?xml version="1.0"?><rss><channel><image><url>https://cdn5.telesco.pe/file/logo.jpg</url><link>https://t.me/s/baipiaotg</link></image><item><link>https://t.me/baipiaotg/67333</link><guid isPermaLink="false">https://t.me/baipiaotg/67333</guid><description>&lt;img src="https://cdn5.telesco.pe/file/demo.jpg"&gt;</description></item></channel></rss>`;
  const output = transformFeed(telegram, options);

  assert.match(output, /https:\/\/gateway\.example\.test\/_gateway\/item\//);
  assert.match(output, /https:\/\/gateway\.example\.test\/_gateway\/media\//);
  assert.doesNotMatch(output, /https:\/\/t\.me\/baipiaotg\/67333/);
  assert.doesNotMatch(output, /https:\/\/t\.me\/s\/baipiaotg/);
  assert.doesNotMatch(output, /https:\/\/cdn5\.telesco\.pe\/file\/demo\.jpg/);
  assert.doesNotMatch(output, /https:\/\/cdn5\.telesco\.pe\/file\/logo\.jpg/);
});

test('normalizes numeric text entities while retaining XML escaping', () => {
  const telegram = `<?xml version="1.0"?><rss><channel><item><title>&#x4f60;&#x597d;</title><link>https://t.me/baipiaotg/67333</link><description>&lt;p&gt;&#x4f60;&#x597d; &amp; &#x4e16;&#x754c;&lt;/p&gt;</description></item></channel></rss>`;
  const output = transformFeed(telegram, options);

  assert.match(output, /<title>你好<\/title>/);
  assert.match(output, /你好 &amp; 世界/);
  assert.doesNotMatch(output, /&#x4f60;/i);
});

test('carries public route metadata into transformed feed links', () => {
  const output = transformFeed(fixture, {
    ...options,
    signedTargetMetadata: { egressScope: 'public', source: 'iwara' },
  });
  const token = output.match(/_gateway\/media\/([^"<]+)/)?.[1];
  assert.ok(token);
  const data = verifySignedTarget(token, 'secret', 1001);
  assert.equal(data.egressScope, 'public');
  assert.equal(data.source, 'iwara');
});

test('decodes entity content exactly once without collapsing literal entities', () => {
  const cdata = `<?xml version="1.0"?><rss><channel><item><link>https://www.iwara.tv/video/abc</link><description><![CDATA[<p>Fish &amp; Chips</p>]]></description></item></channel></rss>`;
  const cdataOut = transformFeed(cdata, options);
  assert.match(cdataOut, /Fish &amp; Chips/);
  assert.doesNotMatch(cdataOut, /Fish & Chips/);

  // Escaped (non-CDATA) descriptions get exactly one decode: the literal
  // "&amp;amp;" must not collapse to a raw ampersand in the output.
  const escaped = `<?xml version="1.0"?><rss><channel><item><link>https://www.iwara.tv/video/abc</link><description>&lt;p&gt;Fish &amp;amp; Chips&lt;/p&gt;</description></item></channel></rss>`;
  const escapedOut = transformFeed(escaped, options);
  assert.match(escapedOut, /Fish &amp; Chips/);
  assert.doesNotMatch(escapedOut, /Fish & Chips/);
});

test('rewrites RSS enclosure and media attachment URLs to signed media routes', () => {
  const feed = `<?xml version="1.0"?><rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/"><channel><item>
    <title>Video</title>
    <link>https://www.iwara.tv/video/abc</link>
    <enclosure url="https://cdn.iwara.tv/video/demo.mp4" type="video/mp4" length="12345"/>
    <media:content url="https://cdn.iwara.tv/video/demo.mp4" type="video/mp4" cover="https://i.iwara.tv/image/poster.jpg"/>
    <media:thumbnail url="https://i.iwara.tv/image/thumb.jpg"/>
  </item></channel></rss>`;
  const output = transformFeed(feed, options);
  const mediaUrls = [...output.matchAll(/_gateway\/media\/([^"<]+)/g)].map((match) => verifySignedTarget(match[1], 'secret', 1001).url);
  assert.ok(mediaUrls.includes('https://cdn.iwara.tv/video/demo.mp4'));
  assert.ok(mediaUrls.includes('https://i.iwara.tv/image/poster.jpg'));
  assert.ok(mediaUrls.includes('https://i.iwara.tv/image/thumb.jpg'));
  assert.doesNotMatch(output, /https:\/\/cdn\.iwara\.tv\/video\/demo\.mp4/);
});

test('rewrites Atom enclosure links and preserves disallowed attachment hosts', () => {
  const atom = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><entry>
    <title>Post</title>
    <link href="https://x.com/user/status/1"/>
    <link rel="enclosure" href="https://video.twimg.com/ext_tw_video/1.mp4" type="video/mp4"/>
  </entry></feed>`;
  const output = transformFeed(atom, options);
  assert.match(output, /rel="enclosure" href="https:\/\/gateway\.example\.test\/_gateway\/media\//);
  assert.doesNotMatch(output, /https:\/\/video\.twimg\.com\/ext_tw_video\/1\.mp4/);

  const external = `<?xml version="1.0"?><rss><channel><item><link>https://x.com/user/status/1</link><enclosure url="https://example.com/outside.mp4" type="video/mp4"/></item></channel></rss>`;
  const unchanged = transformFeed(external, options);
  assert.match(unchanged, /enclosure url="https:\/\/example\.com\/outside\.mp4"/);
});
