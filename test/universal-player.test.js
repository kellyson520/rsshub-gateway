import test from 'node:test';
import assert from 'node:assert/strict';
import {
  sniffUniversalVideo,
  renderUniversalPlayerComponent,
} from '../src/universal-player/engine.js';
import { renderGenericReaderPage } from '../src/http-utils.js';

test('universal video engine: sniffs YouTube URL', () => {
  const result = sniffUniversalVideo('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  assert.ok(result);
  assert.equal(result.type, 'iframe');
  assert.ok(result.src.includes('youtube-nocookie.com/embed/dQw4w9WgXcQ'));

  const shortResult = sniffUniversalVideo('https://youtu.be/dQw4w9WgXcQ');
  assert.ok(shortResult);
  assert.equal(shortResult.type, 'iframe');
});

test('universal video engine: sniffs Bilibili and Vimeo URLs', () => {
  const bili = sniffUniversalVideo('https://www.bilibili.com/video/BV1xx411c7mD');
  assert.ok(bili);
  assert.equal(bili.type, 'iframe');
  assert.ok(bili.src.includes('BV1xx411c7mD'));

  const vimeo = sniffUniversalVideo('https://vimeo.com/76979871');
  assert.ok(vimeo);
  assert.equal(vimeo.type, 'iframe');
  assert.ok(vimeo.src.includes('player.vimeo.com/video/76979871'));
});

test('universal video engine: sniffs HTML5 video tag and HLS .m3u8 stream from arbitrary page', () => {
  const htmlWithVideo = `
    <!doctype html>
    <html>
      <head><title>Some Arbitrary Video Blog</title></head>
      <body>
        <h1>My Trip Video</h1>
        <video src="https://media.example.com/videos/trip.mp4" poster="https://media.example.com/trip.jpg"></video>
      </body>
    </html>
  `;
  const result1 = sniffUniversalVideo('https://myblog.com/post/1', htmlWithVideo);
  assert.ok(result1);
  assert.equal(result1.type, 'video');
  assert.equal(result1.src, 'https://media.example.com/videos/trip.mp4');

  const htmlWithHls = `
    <html>
      <head><title>Live Streaming News</title></head>
      <body>
        <script>
          var playerConfig = { streamUrl: "https://stream.news.com/live/index.m3u8" };
        </script>
      </body>
    </html>
  `;
  const result2 = sniffUniversalVideo('https://news.com/live', htmlWithHls);
  assert.ok(result2);
  assert.equal(result2.type, 'hls');
  assert.equal(result2.src, 'https://stream.news.com/live/index.m3u8');
});

test('universal video engine: renders universal player component', () => {
  const component = renderUniversalPlayerComponent({
    video: { type: 'iframe', src: 'https://www.youtube-nocookie.com/embed/123' },
    title: 'Test YouTube Video',
  });
  assert.ok(component.includes('universal-cinema-container'));
  assert.ok(component.includes('youtube-nocookie.com/embed/123'));
  assert.ok(component.includes('Test YouTube Video'));
});

test('renderGenericReaderPage automatically injects universal player on any website with video', () => {
  const genericHtml = `
    <!doctype html>
    <html>
      <head><title>科技测评：最新无人机视频</title></head>
      <body>
        <p>这是正文内容介绍</p>
        <video src="https://tech.com/video.mp4" controls></video>
      </body>
    </html>
  `;
  const rendered = renderGenericReaderPage({
    url: 'https://tech.com/drone-review',
    html: genericHtml,
    baseUrl: 'https://gateway.example.com',
    secret: 'test-secret',
    signedTargetMetadata: { egressScope: 'public' },
  });

  assert.ok(rendered.includes('universal-cinema-container'));
  assert.ok(rendered.includes('universal-cinema-video'));
  assert.ok(rendered.includes('科技测评：最新无人机视频'));
  assert.ok(rendered.includes('这是正文内容介绍'));
});

test('upstream RSSHub feed enhancement: automatically injects video player and enclosure', async () => {
  const { transformFeed } = await import('../src/feed-transform.js');

  const upstreamRssHubXml = `<?xml version="1.0" encoding="utf-8"?>
  <rss version="2.0">
    <channel>
      <title>Upstream RSSHub Channel</title>
      <link>https://rsshub.app</link>
      <description>Sample upstream feed</description>
      <item>
        <title>最新科技视频演示</title>
        <link>https://www.youtube.com/watch?v=dQw4w9WgXcQ</link>
        <description><![CDATA[<p>欢迎观看本期评测视频</p>]]></description>
      </item>
      <item>
        <title>直链MP4播客分享</title>
        <link>https://example.com/podcast/1</link>
        <description><![CDATA[<p>音频与视频录像：<video src="https://example.com/media/ep1.mp4"></video></p>]]></description>
      </item>
    </channel>
  </rss>`;

  const enhanced = transformFeed(upstreamRssHubXml, {
    baseUrl: 'https://gateway.example.com',
    secret: 'test-secret',
    signedTargetMetadata: { egressScope: 'public' },
  });

  // 1. YouTube item: 自动注入响应式 iframe 播放器
  assert.ok(enhanced.includes('youtube-nocookie.com/embed/dQw4w9WgXcQ'));
  // 2. MP4 item: 自动补充 <enclosure type="video/mp4" ...>
  assert.ok(enhanced.includes('<enclosure url="https://example.com/media/ep1.mp4" type="video/mp4" length="0"/>') || enhanced.includes('type="video/mp4"'));
});
