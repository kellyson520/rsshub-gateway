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
