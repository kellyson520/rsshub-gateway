import test from 'node:test';
import assert from 'node:assert/strict';
import * as cheerio from 'cheerio';
import {
  upgradeImageUrl,
  detectMediaEnclosure,
  cleanTrackingUrls,
  removeTrackingPixels,
  sanitizeInlineStyles,
  calculateReadingStats,
  extractHashtags,
  declutterHtml,
  applyAdaptivePipeline,
} from '../src/adaptive-pipeline/index.js';
import { transformFeed } from '../src/feed-transform.js';

test('adaptive pipeline: media upgrader upgrades CDN thumbnails to original quality', () => {
  // Twitter / X
  assert.equal(
    upgradeImageUrl('https://pbs.twimg.com/media/abc?format=jpg&name=small'),
    'https://pbs.twimg.com/media/abc?format=jpg&name=orig'
  );

  // Bilibili
  assert.equal(
    upgradeImageUrl('https://i0.hdslb.com/bfs/archive/abc.jpg@300w_200h_1c.webp'),
    'https://i0.hdslb.com/bfs/archive/abc.jpg'
  );

  // Weibo
  assert.equal(
    upgradeImageUrl('https://wx1.sinaimg.cn/thumb150/abc.jpg'),
    'https://wx1.sinaimg.cn/large/abc.jpg'
  );

  // Zhihu
  assert.equal(
    upgradeImageUrl('https://pic1.zhimg.com/v2-abc_b.jpg'),
    'https://pic1.zhimg.com/v2-abc_r.jpg'
  );

  // YouTube
  assert.equal(
    upgradeImageUrl('https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg'),
    'https://i.ytimg.com/vi/dQw4w9WgXcQ/maxresdefault.jpg'
  );
});

test('adaptive pipeline: detects audio/video and synthesizes enclosure tag', () => {
  const xml = `<item><title>Podcast Episode</title><description><![CDATA[<p>Listen here: <audio src="https://example.com/audio.mp3"/></p>]]></description></item>`;
  const $ = cheerio.load(xml, { xmlMode: true });
  applyAdaptivePipeline($);
  const enclosure = $('enclosure');
  assert.equal(enclosure.length, 1);
  assert.equal(enclosure.attr('url'), 'https://example.com/audio.mp3');
  assert.equal(enclosure.attr('type'), 'audio/mp3');
});

test('adaptive pipeline: cleans tracking parameters and 1x1 tracking pixels', () => {
  const dirtyHtml = '<p>Check out <a href="https://example.com/news?utm_source=rss&utm_medium=feed&id=123">Article</a></p><img src="https://pixel.wp.com/g.gif?v=1" width="1" height="1"/>';
  const cleaned = cleanTrackingUrls(removeTrackingPixels(dirtyHtml));
  assert.ok(!cleaned.includes('utm_source'));
  assert.ok(cleaned.includes('id=123'));
  assert.ok(!cleaned.includes('pixel.wp.com'));
});

test('adaptive pipeline: sanitizes inline styles for dark mode and mobile adaptability', () => {
  const rawHtml = '<div style="background-color: #ffffff; color: #000000; font-family: SimSun; width: 900px;"><p>Hello World</p><img src="https://example.com/pic.jpg"/></div>';
  const sanitized = sanitizeInlineStyles(rawHtml);
  assert.ok(!sanitized.includes('background-color'));
  assert.ok(!sanitized.includes('color: #000000'));
  assert.ok(!sanitized.includes('width: 900px'));
  assert.ok(sanitized.includes('max-width: 100%'));
});

test('adaptive pipeline: extracts hashtags and estimates reading time', () => {
  const content = '这是一篇关于深度学习与人工智能的精彩文章。#人工智能 #深度学习 今日重大突破！' + '测试文本'.repeat(80);
  const tags = extractHashtags(content);
  assert.ok(tags.includes('人工智能'));
  assert.ok(tags.includes('深度学习'));

  const stats = calculateReadingStats(content);
  assert.ok(stats.totalUnits > 300);
  assert.equal(stats.minutes >= 1, true);
});

test('adaptive pipeline: declutters common spam footer lines', () => {
  const dirty = '<p>正文内容</p><p>扫描下方二维码关注公众号</p><p>The post Title appeared first on Site.</p>';
  const decluttered = declutterHtml(dirty);
  assert.equal(decluttered, '<p>正文内容</p>');
});

test('adaptive pipeline: transformFeed end-to-end enhances arbitrary upstream XML without templates', () => {
  const upstreamFeed = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Upstream Feed</title>
    <link>https://example.com</link>
    <item>
      <title>新闻报道 #科技</title>
      <link>https://example.com/post/1</link>
      <description><![CDATA[<div style="background:#fff; color:#000;"><p>关注新科技：<a href="https://example.com/item?utm_source=rss">链接</a></p><img src="https://pbs.twimg.com/media/test?format=jpg&name=small"/><video src="https://example.com/clip.mp4"></video></div>]]></description>
    </item>
  </channel>
</rss>`;

  const output = transformFeed(upstreamFeed, {
    baseUrl: 'https://gateway.example.com',
    secret: 'test-secret',
  });

  // 1. Twitter 图片被升格为 name=orig 且带防盗链签名 (&name=orig 被签名存放在 media token 中)
  assert.ok(output.includes('Jm5hbWU9b3Jp') || output.includes('name=orig'));
  // 2. UTM 参数被清除
  assert.ok(!output.includes('utm_source=rss'));
  // 3. 视频被自动补齐为 enclosure
  assert.ok(output.includes('<enclosure url="https://example.com/clip.mp4" type="video/mp4"'));
  // 4. #科技 自动补齐为 <category>科技</category>
  assert.ok(output.includes('<category>科技</category>'));
  // 5. 自动应用现代流式自适应排版
  assert.ok(output.includes('max-width: 100%'));
});
