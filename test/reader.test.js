import test from 'node:test';
import assert from 'node:assert/strict';
import { renderEhImageSequence, renderReaderPage, renderUnavailablePage } from '../src/reader.js';
import { verifySignedTarget } from '../src/signed-target.js';

test('rewrites lazy-loaded E-Hentai images to signed media URLs', () => {
  const output = renderReaderPage({
    url: 'https://e-hentai.org/g/123/abc/',
    html: '<html><body><img data-src="https://ehgt.org/full.jpg" alt="page"></body></html>',
    baseUrl: 'https://gateway.example.test',
    secret: 'secret',
  });

  assert.match(output, /_gateway\/media\//);
  assert.match(output, /img,video\{max-width:100%;height:auto\}/);
  assert.doesNotMatch(output, /data-src=/);
});

test('renders an E-Hentai gallery as a structured preview grid', () => {
  const output = renderReaderPage({
    url: 'https://e-hentai.org/g/123/abc/',
    html: `<html><head><title>Source gallery</title></head><body>
      <div id="nb">Front Page</div>
      <div class="gm">
        <div id="gd1"><div style="width:250px;height:361px;background:transparent url(https://cover.example.hath.network/h/cover.webp) 0 0 no-repeat"></div></div>
        <div id="gd2"><h1 id="gn">Gallery title</h1><h1 id="gj">Gallery subtitle</h1></div>
        <div id="gdn"><a href="https://e-hentai.org/uploader/example">Uploader</a></div>
        <div id="rating_label">Rating: 4.5</div><span id="rating_count">123 votes</span>
        <div id="gdd"><table><tr><td>Posted:</td><td>2026-08-08 12:00</td></tr><tr><td>Length:</td><td>2 pages</td></tr></table></div>
        <div id="taglist"><table><tr><td>language:</td><td><a href="https://e-hentai.org/tag/language:chinese">chinese</a></td></tr><tr><td>female:</td><td><a href="https://e-hentai.org/tag/female:test">test tag</a></td></tr></table></div>
      </div>
      <div class="gtb"><p class="gpc">Showing 1 - 2 of 2 images</p><a href="https://e-hentai.org/g/123/abc/?p=1">2</a></div>
      <div id="gdt" class="gt200"><a href="https://e-hentai.org/s/one/123-1"><div title="Page 1: one.jpg" style="width:200px;height:289px;background:transparent url(https://thumb.example.hath.network/h/sprite.webp) -0px 0 no-repeat"></div></a><a href="https://e-hentai.org/s/two/123-2"><div title="Page 2: two.jpg" style="width:200px;height:289px;background:transparent url(https://thumb.example.hath.network/h/sprite.webp) -200px 0 no-repeat"></div></a></div>
      <div class="dp">Source footer</div>
    </body></html>`,
    baseUrl: 'https://gateway.example.test',
    secret: 'secret',
  });

  assert.match(output, /class="[^"]*\beh-gallery\b[^"]*"/);
  assert.match(output, /<article class="reader eh-gallery">/);
  assert.match(output, /<figure class="eh-page">/);
  assert.doesNotMatch(output, /class="[^"]*eh-(gallery-header|meta|tags)[^"]*"/);
  assert.match(output, /class="eh-cover"/);
  assert.match(output, /class="eh-details"/);
  assert.match(output, /class="eh-labels"/);
  assert.match(output, /class="eh-grid"/);
  assert.match(output, /class="eh-thumb"/);
  assert.match(output, /<p class="eh-thumb-label">Page 1: one\.jpg<\/p>/);
  assert.match(output, /class="eh-cover"[\s\S]*?<img class="eh-cover-image"[^>]+src="https:\/\/gateway\.example\.test\/_gateway\/media\//);
  assert.match(output, /<img class="eh-thumb-image"[^>]+src="https:\/\/gateway\.example\.test\/_gateway\/media\//);
  assert.doesNotMatch(output, /background-image:url/);
  assert.match(output, /_gateway\/media\//);
  assert.match(output, /_gateway\/item\//);
  assert.match(output, /transform:translate\(-200px,0px\)/);
  assert.match(output, /Gallery title/);
  assert.match(output, /评分：4\.5 123 votes/);
  assert.match(output, /Showing 1 - 2 of 2 images/);
  assert.doesNotMatch(output, /Front Page|Source footer|example\.hath\.network/);
});

test('renders an E-Hentai image page with proxied image and navigation', () => {
  const output = renderReaderPage({
    url: 'https://e-hentai.org/s/one/123-1',
    html: `<html><head><title>Gallery title</title></head><body>
      <div id="i1"><h1>Gallery title</h1><div id="i2">1 / 2</div><a id="prev" href="https://e-hentai.org/s/one/123-1">Previous</a><a id="next" href="https://e-hentai.org/s/two/123-2">Next</a><div id="i3"><a href="https://e-hentai.org/s/two/123-2"><img id="img" src="https://page.example.hath.network/h/full.webp" alt="Page 1"></a></div></div>
    </body></html>`,
    baseUrl: 'https://gateway.example.test',
    secret: 'secret',
  });

  assert.match(output, /class="[^"]*\beh-image-page\b[^"]*"/);
  assert.match(output, /<div class="reader eh-image-page">/);
  assert.match(output, /<p class="eh-image-title">Gallery title · .*<\/p>/);
  assert.match(output, /图片阅读模式：可使用上一页和下一页连续阅读。/);
  assert.match(output, /<p class="eh-image-nav"[^>]*>.*上一页.*下一页.*<\/p>/s);
  assert.match(output, /<p class="eh-image-content"><img id="img"/);
  assert.match(output, /id="img"/);
  assert.match(output, /_gateway\/media\//);
  assert.match(output, /_gateway\/item\//);
  assert.doesNotMatch(output, /<article class="reader eh-image-page">/);
  assert.doesNotMatch(output, /<figure class="eh-image-frame">/);
  assert.doesNotMatch(output, /page\.example\.hath\.network/);
});

test('renders the current E-Hentai image DOM without relying on an img id', () => {
  const output = renderReaderPage({
    url: 'https://e-hentai.org/s/one/123-1',
    html: `<html><body>
      <div id="i1"><div class="sni"><h1>Gallery title</h1><div class="sn">
        <a href="https://e-hentai.org/s/one/123-1"><img src="https://ehgt.org/g/p.png"></a>
        <div><span>1</span> / <span>2</span></div>
        <a href="https://e-hentai.org/s/two/123-2"><img src="https://ehgt.org/g/n.png"></a>
      </div></div></div>
      <div><a href="https://node.hath.network:54200/h/full.webp"><img src="https://node.hath.network:54200/h/full.webp"></a></div>
    </body></html>`,
    baseUrl: 'https://gateway.example.test',
    secret: 'secret',
  });

  assert.match(output, /class="[^\"]*\beh-image-page\b[^\"]*"/);
  assert.match(output, /<div class="reader eh-image-page">/);
  assert.match(output, /<p class="eh-image-title">Gallery title · .*<\/p>/);
  assert.match(output, /图片阅读模式：可使用上一页和下一页连续阅读。/);
  assert.match(output, /<p class="eh-image-nav"[^>]*>.*上一页.*下一页.*<\/p>/s);
  assert.match(output, /<p class="eh-image-content"><img id="img"/);
  assert.match(output, /id="img"/);
  assert.match(output, /上一页/);
  assert.match(output, /下一页/);
  assert.match(output, /1 \/ 2/);
  assert.match(output, /_gateway\/media\//);
  assert.doesNotMatch(output, /<article class="reader eh-image-page">/);
  assert.doesNotMatch(output, /<figure class="eh-image-frame">/);
  assert.doesNotMatch(output, /node\.hath\.network/);
});

test('renders a safe unavailable page with a gateway-local source link', () => {
  const output = renderUnavailablePage({
    url: 'https://x.com/example/status/1',
    title: 'X 内容',
    message: 'X 内容暂时无法读取。<script>alert(1)</script>',
    baseUrl: 'https://gateway.example.test',
    secret: 'secret',
  });

  assert.match(output, /X 内容/);
  assert.match(output, /X 内容暂时无法读取。&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(output, /https:\/\/gateway\.example\.test\/_gateway\/item\//);
  assert.doesNotMatch(output, /<script>|<iframe|onerror=/i);
});

test('renders an ordered E-Hentai image sequence without navigation links', () => {
  const output = renderEhImageSequence({
    title: 'Gallery title',
    pages: [
      { pageNumber: 1, media: 'https://gateway.example.test/_gateway/media/one', alt: 'Page 1' },
      { pageNumber: 3, media: 'https://gateway.example.test/_gateway/media/three', alt: 'Page 3' },
    ],
    totalPages: 3,
    failures: [{ pageNumber: 2, reason: 'upstream unavailable' }],
  });

  assert.match(output, /<div class="reader eh-image-page">/);
  assert.match(output, /已加载 2 \/ 3 页/);
  assert.ok(output.indexOf('/_gateway/media/one') < output.indexOf('/_gateway/media/three'));
  assert.match(output, /<p class="eh-image-content"><img[^>]+src="https:\/\/gateway\.example\.test\/_gateway\/media\/one"/);
  assert.match(output, /<link rel="preload" as="image" href="https:\/\/gateway\.example\.test\/_gateway\/media\/one" fetchpriority="high"[^>]*>/);
  assert.match(output, /<img[^>]+src="https:\/\/gateway\.example\.test\/_gateway\/media\/one"[^>]+loading="eager"[^>]+fetchpriority="high"/);
  assert.doesNotMatch(output, /<a[^>]+>上一页|<a[^>]+>下一页/);
  assert.match(output, /第 2 页暂时无法读取/);
});

test('preloads only the configured E-Hentai first-screen images and leaves later images lazy', () => {
  const pages = Array.from({ length: 3 }, (_, index) => ({
    pageNumber: index + 1,
    media: `https://gateway.example.test/_gateway/media/${index + 1}`,
    alt: `Page ${index + 1}`,
  }));
  const output = renderEhImageSequence({ title: 'Gallery title', pages, preloadCount: 2 });

  assert.match(output, /<link rel="preload" as="image" href="https:\/\/gateway\.example\.test\/_gateway\/media\/1" fetchpriority="high"[^>]*>/);
  assert.match(output, /<link rel="preload" as="image" href="https:\/\/gateway\.example\.test\/_gateway\/media\/2" fetchpriority="high"[^>]*>/);
  assert.doesNotMatch(output, /<link rel="preload" as="image" href="https:\/\/gateway\.example\.test\/_gateway\/media\/3"/);
  assert.match(output, /<img[^>]+src="https:\/\/gateway\.example\.test\/_gateway\/media\/1"[^>]+loading="eager"[^>]+fetchpriority="high"/);
  assert.match(output, /<img[^>]+src="https:\/\/gateway\.example\.test\/_gateway\/media\/2"[^>]+loading="eager"[^>]+fetchpriority="high"/);
  assert.match(output, /<img[^>]+src="https:\/\/gateway\.example\.test\/_gateway\/media\/3"[^>]+loading="lazy"/);
});

test('uses derived media candidates and render containment for later gallery pages', () => {
  const pages = [
    { pageNumber: 1, media: 'https://gateway.example.test/_gateway/media/one', alt: 'Page 1' },
    { pageNumber: 2, media: 'https://gateway.example.test/_gateway/media/two', alt: 'Page 2' },
  ];
  const output = renderEhImageSequence({ title: 'Gallery title', pages, preloadCount: 1 });

  const firstImage = output.match(/<img[^>]+src="https:\/\/gateway\.example\.test\/_gateway\/media\/one"[^>]*>/)?.[0];
  assert.ok(firstImage);
  assert.doesNotMatch(firstImage, /srcset=/);
  assert.match(output, /<img[^>]+src="https:\/\/gateway\.example\.test\/_gateway\/media\/two"[^>]+srcset="[^"]+w=1280 1280w, [^"]+w=1920 1920w, [^"]+w=2560 2560w"[^>]+sizes="\(min-width:1120px\) 1120px, 100vw"/);
  assert.match(output, /<p class="eh-image-content eh-image-deferred"[^>]+content-visibility:auto[^>]+contain-intrinsic-size:1000px 1400px[^>]*><img[^>]+src="https:\/\/gateway\.example\.test\/_gateway\/media\/two"[^>]+loading="lazy"[^>]+decoding="async"/);
});

test('renders resolved and deferred media targets as Flare-safe continuous images', () => {
  const output = renderEhImageSequence({
    title: 'Gallery title',
    pages: [
      {
        pageNumber: 1,
        mediaTarget: 'https://page.example.hath.network/h/one.webp',
        alt: 'first',
      },
      {
        pageNumber: 2,
        mediaTarget: 'https://e-hentai.org/s/two/gallery-2',
        alt: 'second',
      },
    ],
    totalPages: 2,
    baseUrl: 'https://gateway.example.test',
    secret: 'secret',
  });
  const images = [...output.matchAll(/<img[^>]+src="([^"]+)"[^>]*>/g)].map((match) => match[1]);
  const targets = images.map((src) => verifySignedTarget(new URL(src).pathname.split('/').pop(), 'secret').url);

  assert.deepEqual(targets, [
    'https://page.example.hath.network/h/one.webp',
    'https://e-hentai.org/s/two/gallery-2',
  ]);
  assert.doesNotMatch(output, /<a[^>]*>\s*<img/i);
  assert.match(output, /<img[^>]+src="[^"]+"[^>]+loading="eager"[^>]+fetchpriority="high"/);
  assert.match(output, /<p class="eh-image-content eh-image-deferred"[^>]*>\s*<img[^>]+loading="lazy"/);
  assert.doesNotMatch(output, /src="https:\/\/page\.example\.hath\.network\//);
  assert.doesNotMatch(output, /src="https:\/\/e-hentai\.org\//);
});

test('carries session scope into generated reader media URLs without exposing its fingerprint', () => {
  const output = renderReaderPage({
    url: 'https://x.com/example/status/1',
    html: '<html><head><title>Post</title></head><body><img src="https://pbs.twimg.com/media/demo.jpg" alt="demo"></body></html>',
    baseUrl: 'https://gateway.example.test',
    secret: 'secret',
    signedTargetMetadata: { egressScope: 'session', source: 'x' },
  });
  const token = output.match(/_gateway\/media\/([^" ]+)/)?.[1];
  assert.ok(token);
  const data = verifySignedTarget(token, 'secret');
  assert.equal(data.egressScope, 'session');
  assert.equal(data.source, 'x');
  assert.doesNotMatch(output, /credentialFingerprint|abcdef123456/);
});

test('renders and sanitizes adult media reader pages cleanly', () => {
  const output = renderReaderPage({
    url: 'https://www.javbus.com/ABC-123',
    html: `<html><head><title>ABC-123 JavBus</title></head><body>
      <h1>ABC-123 女优主演</h1>
      <script>alert("malicious XSS");</script>
      <div class="movie">
        <img src="https://www.javbus.com/pics/cover/abc_b.jpg" alt="Cover">
        <p>Release: 2026-08-01</p>
        <a href="https://www.javbus.com/genre/hd">HD Category</a>
      </div>
    </body></html>`,
    baseUrl: 'https://gateway.example.test',
    secret: 'secret',
  });

  assert.match(output, /ABC-123/);
  assert.doesNotMatch(output, /<script/);
  assert.doesNotMatch(output, /alert\(/);
  assert.match(output, /_gateway\/media\//);
  assert.match(output, /_gateway\/item\//);
});

test('renderUnavailablePage generates clear error diagnostics page', () => {
  const output = renderUnavailablePage({
    url: 'https://e-hentai.org/g/123/abc/',
    message: 'Upstream connection timed out',
    baseUrl: 'https://gateway.example.test',
    secret: 'secret',
  });

  assert.match(output, /Upstream connection timed out/);
  assert.match(output, /https:\/\/gateway\.example\.test\/_gateway\/item\//);
  assert.match(output, /class="reader"/);
  assert.match(output, /原始来源/);
});

test('renderReaderPage safely handles malformed or empty html body', () => {
  const output = renderReaderPage({
    url: 'https://example.com/item/1',
    html: '',
    baseUrl: 'https://gateway.example.test',
    secret: 'secret',
  });
  assert.match(output, /class="reader"/);
});
