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

test('universal media engine: sniffs audio podcasts, Twitch and Instagram', () => {
  const twitch = sniffUniversalVideo('https://clips.twitch.tv/FrailTamePeanutCurseLit-abc123');
  assert.ok(twitch);
  assert.equal(twitch.platform, 'Twitch Clip');
  assert.ok(twitch.src.includes('clips.twitch.tv/embed'));

  const instagram = sniffUniversalVideo('https://www.instagram.com/reel/C123456789/');
  assert.ok(instagram);
  assert.equal(instagram.platform, 'Instagram');
  assert.ok(instagram.src.includes('instagram.com/p/C123456789/embed'));

  const audioHtml = `<p>本期音频节目录音：<a href="https://podcast.example.com/episodes/42.mp3">下载试听</a></p>`;
  const audio = sniffUniversalVideo('https://podcast.example.com/episodes/42', audioHtml);
  assert.ok(audio);
  assert.equal(audio.type, 'audio');
  assert.equal(audio.src, 'https://podcast.example.com/episodes/42.mp3');

  const renderedAudio = renderUniversalPlayerComponent({
    video: audio,
    title: '第42期：深度技术专访',
  });
  assert.ok(renderedAudio.includes('universal-audio-player'));
  assert.ok(renderedAudio.includes('第42期：深度技术专访'));
  assert.ok(renderedAudio.includes('https://podcast.example.com/episodes/42.mp3'));
});

test('RSS reader compatibility: strictly preserves CDATA and generates reader-compatible media cards and namespaces', async () => {
  const { transformFeed } = await import('../src/feed-transform.js');

  const rawXml = `<?xml version="1.0" encoding="utf-8"?>
  <rss version="2.0">
    <channel>
      <title>Feed for Readers</title>
      <link>https://example.com</link>
      <item>
        <title>视频教程分享</title>
        <link>https://www.youtube.com/watch?v=9bZkp7q19f0</link>
        <description><![CDATA[<p>这是视频正文说明，各大阅读器应正常渲染 HTML 而非转义字符。</p>]]></description>
      </item>
    </channel>
  </rss>`;

  const output = transformFeed(rawXml, {
    baseUrl: 'https://gateway.example.com',
    secret: 'test-secret',
    signedTargetMetadata: { egressScope: 'public' },
  });

  // 1. 验证 CDATA 存在且未被转义为 &lt;p&gt;
  assert.ok(output.includes('<![CDATA['), 'Output must contain CDATA wrapper');
  assert.ok(!output.includes('&lt;p&gt;这是视频正文说明'), 'HTML tags must not be escaped as literal text');

  // 2. 验证阅读器 WebView 兼容卡片与备用播放链接
  assert.ok(output.includes('rss-media-card'), 'Must contain reader-compatible card');
  assert.ok(output.includes('在 YouTube 播放'), 'Must contain fallback player link');

  // 3. 验证命名空间声明已自动补充
  assert.ok(output.includes('xmlns:content="http://purl.org/rss/1.0/modules/content/"'));
  assert.ok(output.includes('xmlns:media="http://search.yahoo.com/mrss/"'));
});

test('RSS reader compatibility: HTML5 video and audio native controls with posters and enclosures', async () => {
  const { transformFeed } = await import('../src/feed-transform.js');

  const rawXml = `<?xml version="1.0" encoding="utf-8"?>
  <rss version="2.0">
    <channel>
      <title>Native Media Feed</title>
      <link>https://example.com</link>
      <item>
        <title>原生视频演示</title>
        <link>https://example.com/videos/demo</link>
        <description><![CDATA[<p>精彩视频回顾：<video src="https://media.example.com/clip.mp4" poster="https://media.example.com/poster.jpg"></video></p>]]></description>
      </item>
      <item>
        <title>科技播客第100期</title>
        <link>https://example.com/podcast/100</link>
        <description><![CDATA[<p>本期音频：<audio src="https://media.example.com/ep100.mp3"></audio><img src="https://media.example.com/ep100-cover.jpg"/></p>]]></description>
      </item>
    </channel>
  </rss>`;

  const output = transformFeed(rawXml, {
    baseUrl: 'https://gateway.example.com',
    secret: 'test-secret',
  });

  // 1. 原生 video controls 与 poster 校验
  assert.match(output, /<video[^>]*controls/);
  assert.match(output, /<video[^>]*src="[^"]+"/);
  assert.match(output, /poster="[^"]+"/);
  assert.match(output, /<enclosure url="[^"]+" type="video\/mp4" length="0"\/>/);
  assert.match(output, /<media:content url="[^"]+" type="video\/mp4" medium="video"\/>/);
  assert.match(output, /<media:thumbnail url="[^"]+"/);

  // 2. 原生 audio controls 与封面校验
  assert.match(output, /<audio[^>]*controls/);
  assert.match(output, /<audio[^>]*src="[^"]+"/);
  assert.match(output, /<enclosure url="[^"]+" type="audio\/mpeg" length="0"\/>/);
  assert.match(output, /<media:content url="[^"]+" type="audio\/mpeg" medium="audio"\/>/);

  // 3. content:encoded 合成与 CDATA 保全校验
  assert.ok(output.includes('<content:encoded><![CDATA['), 'Must synthesize content:encoded with CDATA');
  assert.ok(!output.includes('&lt;video'), 'Video tags must not be escaped as literal text');
  assert.ok(!output.includes('&lt;audio'), 'Audio tags must not be escaped as literal text');
});

test('RSS reader compatibility: Atom entry support with enclosures and MRSS', async () => {
  const { transformFeed } = await import('../src/feed-transform.js');

  const atomXml = `<?xml version="1.0" encoding="utf-8"?>
  <feed xmlns="http://www.w3.org/2005/Atom">
    <title>Atom Media Feed</title>
    <entry>
      <title>Bilibili 视频分享</title>
      <link rel="alternate" href="https://www.bilibili.com/video/BV1xx411c7mD" />
      <summary>B站热门视频</summary>
      <content type="html"><![CDATA[<p>这是 B 站精彩内容，请欣赏。<img src="https://i0.hdslb.com/bfs/archive/cover.jpg" /></p>]]></content>
    </entry>
    <entry>
      <title>Atom 原生 MP4 视频</title>
      <link rel="alternate" href="https://example.com/atom/post/1" />
      <summary>Atom 视频正文</summary>
      <content type="html"><![CDATA[<p>在线看：<video src="https://media.example.com/atom.mp4" poster="https://media.example.com/atom-poster.jpg"></video></p>]]></content>
    </entry>
  </feed>`;

  const output = transformFeed(atomXml, {
    baseUrl: 'https://gateway.example.com',
    secret: 'test-secret',
  });

  // 1. 根 feed 具备 media 与 content 命名空间
  assert.ok(output.includes('xmlns:media="http://search.yahoo.com/mrss/"'));
  assert.ok(output.includes('xmlns:content="http://purl.org/rss/1.0/modules/content/"'));

  // 2. Bilibili entry 具备沙盒阅读器兜底卡片与直达播放链接
  assert.ok(output.includes('player.bilibili.com/player.html'));
  assert.ok(output.includes('在 Bilibili 播放'));
  assert.match(output, /<media:thumbnail url="[^"]+"/);

  // 3. Atom 原生视频 entry 具备 <link rel="enclosure"> 与 <media:content>
  assert.match(output, /<link rel="enclosure" type="video\/mp4" href="[^"]+"/);
  assert.match(output, /<media:content url="[^"]+" type="video\/mp4" medium="video"\/>/);

  // 4. CDATA 保持未转义
  assert.ok(output.includes('<![CDATA['), 'Atom content must be wrapped in CDATA');
  assert.ok(!output.includes('&lt;p&gt;这是 B 站精彩内容'), 'Atom content must not be escaped');
});
