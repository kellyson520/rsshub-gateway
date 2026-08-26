import test from 'node:test';
import assert from 'node:assert/strict';
import { adapterForUrl, resolveMode } from '../src/adapters/index.js';

test('uses an Iwara session header only when explicitly requested', () => {
  const adapter = adapterForUrl('https://www.iwara.tv/video/abc');
  assert.deepEqual(adapter.headers({}), {});
  assert.deepEqual(adapter.headers({ cookie: 'session=value' }), {});
  assert.match(adapter.headers({ cookie: 'session=value' }, { includeCredentials: true }).cookie, /session=value/);
});

test('builds X and Instagram headers only for session requests', () => {
  assert.match(adapterForUrl('https://x.com/example/status/1').headers({ authToken: 'auth', ct0: 'csrf' }, { includeCredentials: true }).cookie, /auth_token=auth/);
  assert.match(adapterForUrl('https://www.instagram.com/example/').headers({ cookie: 'sessionid=value' }, { includeCredentials: true }).cookie, /sessionid=value/);
});

test('uses public fallback mode without source credentials', () => {
  assert.equal(resolveMode('x', {}), 'public');
  assert.equal(resolveMode('instagram', {}), 'public');
  assert.equal(resolveMode('iwara', { cookie: 'session=value' }), 'authenticated');
});

test('uses the Telegram embed endpoint for public post details', () => {
  const adapter = adapterForUrl('https://t.me/baipiaotg/67336');

  assert.equal(adapter.readerTarget('https://t.me/baipiaotg/67336'), 'https://t.me/baipiaotg/67336?embed=1');
  assert.equal(adapter.readerTarget('https://t.me/s/baipiaotg'), 'https://t.me/s/baipiaotg');
  assert.equal(adapter.readerTarget('invalid-url'), 'invalid-url');
});

test('keeps canonical reader URLs and source-specific fallback messages', () => {
  const x = adapterForUrl('https://x.com/example/status/1');
  const instagram = adapterForUrl('https://www.instagram.com/example/');
  const iwara = adapterForUrl('https://www.iwara.tv/video/example');
  const pixiv = adapterForUrl('https://www.pixiv.net/artworks/123');

  assert.equal(x.readerTarget('https://x.com/example/status/1'), 'https://x.com/example/status/1');
  assert.match(x.unavailableMessage(), /X/);
  assert.match(instagram.unavailableMessage(), /Instagram/);
  assert.match(iwara.unavailableMessage(), /Iwara/);
  assert.match(pixiv.unavailableMessage(), /Pixiv/);
});

test('attaches the pixiv referer for image CDN media', () => {
  const adapter = adapterForUrl('https://i.pximg.net/img-master/img/2026/08/12/00/00/00/1_p0_master1200.jpg');
  assert.equal(adapter.name, 'pixiv');
  assert.equal(adapter.headers({}).referer, 'https://www.pixiv.net/');
  assert.equal(adapterForUrl('https://www.pixiv.net/artworks/123').headers({ referer: 'https://example.com/' }).referer, 'https://example.com/');
  assert.equal(adapter.headers({ cookie: 'session=value' }, { includeCredentials: true }).cookie, 'session=value');
});

test('selects the E-Hentai adapter for gallery and image hosts', () => {
  const adapter = adapterForUrl('https://e-hentai.org/g/123/abc/');

  assert.equal(adapter.name, 'ehviewer');
  assert.equal(adapter.readerTarget('https://e-hentai.org/g/123/abc/'), 'https://e-hentai.org/g/123/abc/');
  assert.equal(adapter.isGalleryUrl('https://e-hentai.org/g/123/abc/'), true);
  assert.equal(adapter.isGalleryUrl('https://e-hentai.org/s/first/123-1'), false);
});

test('exposes anonymous public headers and authentication challenge detection', () => {
  const cases = [
    ['https://iwara.tv/video/abc', { cookie: 'session=value' }, true],
    ['https://x.com/example/status/1', { authToken: 'auth', ct0: 'csrf' }, true],
    ['https://instagram.com/p/example/', { cookie: 'sessionid=value' }, true],
    ['https://t.me/example/1', {}, false],
  ];

  for (const [url, config, supportsSession] of cases) {
    const adapter = adapterForUrl(url);
    const anonymousHeaders = adapter.headers(config, { includeCredentials: false });
    assert.equal(adapter.publiclyReadable, true, adapter.name);
    assert.equal(typeof adapter.isAuthenticationChallenge, 'function', adapter.name);
    assert.equal(Object.keys(anonymousHeaders).some((name) => /^(cookie|authorization)$/i.test(name)), false, adapter.name);
    assert.equal(adapter.isAuthenticationChallenge({ status: 401, headers: new Headers(), body: '' }), supportsSession, adapter.name);
  }
});

test('recognizes login pages without treating service errors as authentication challenges', () => {
  const iwara = adapterForUrl('https://iwara.tv/video/abc');
  const x = adapterForUrl('https://x.com/example/status/1');
  const instagram = adapterForUrl('https://instagram.com/p/example/');

  assert.equal(iwara.isAuthenticationChallenge({ status: 200, headers: new Headers(), body: '<form action="/login"><input name="password"></form>' }), true);
  assert.equal(x.isAuthenticationChallenge({ status: 200, headers: new Headers(), body: '<form action="/i/flow/login"><input name="password"></form>' }), true);
  assert.equal(instagram.isAuthenticationChallenge({ status: 200, headers: new Headers(), body: '<form><input name="username"><input name="password"></form>' }), true);
  assert.equal(x.isAuthenticationChallenge({ status: 503, headers: new Headers(), body: 'unavailable' }), false);
});

test('routes major adult platforms to the adult-media adapter with proper default headers', () => {
  const domains = [
    'https://jable.tv/videos/abc/',
    'https://missav.live/cn/new',
    'https://www.javbus.com/ABC-123',
    'https://javdb.com/v/XYZ',
    'https://airav.io/video/1',
    'https://ggjav.tv/video/2',
    'https://www.wnacg.com/photos-index-aid-1.html',
    'https://chikubi.jp/post-1.html',
    'https://skeb.jp/@creator/works/1',
    'https://artist.fanbox.cc/posts/1',
    'https://kemono.cr/patreon/user/1/post/1',
    'https://coomer.st/onlyfans/user/1/post/1',
    'https://www.sehuatang.net/thread-1-1-1.html',
    'https://www.uraaka-joshi.com/user/1',
    'https://netflav.com/video?id=123',
    'https://91porn.com/view_video.php?viewkey=abc',
  ];

  for (const targetUrl of domains) {
    const adapter = adapterForUrl(targetUrl);
    assert.equal(adapter.name, 'adult-media', `adapter for ${targetUrl}`);
    assert.equal(adapter.readerTarget(targetUrl), targetUrl);
    const hdrs = adapter.headers();
    assert.ok(hdrs['User-Agent']);
    assert.ok(hdrs['Accept-Language']);
    assert.ok(adapter.unavailableMessage().includes('原始来源'));
    assert.equal(adapter.isAuthenticationChallenge({ status: 403 }), true);
    assert.equal(adapter.isAuthenticationChallenge({ status: 200, body: '<html>cf-challenge</html>' }), true);
    assert.equal(adapter.isAuthenticationChallenge({ status: 200, body: '<html>normal</html>' }), false);
  }
});

test('adapterForUrl handles malformed URLs, null, or empty string gracefully', () => {
  assert.equal(adapterForUrl('not a url').name, 'unknown');
  assert.equal(adapterForUrl('').name, 'unknown');
  assert.equal(adapterForUrl(null).name, 'unknown');
  assert.equal(adapterForUrl(undefined).name, 'unknown');
  assert.equal(adapterForUrl('https://unsupported.site.example/').name, 'unknown');
});

test('getSupportedSourceNames and isKnownSourceUrl provide direct ecosystem queries', async () => {
  const { getSupportedSourceNames, isKnownSourceUrl } = await import('../src/adapters/index.js');
  const sources = getSupportedSourceNames();
  assert.ok(Array.isArray(sources));
  assert.ok(sources.includes('iwara'));
  assert.ok(sources.includes('x'));
  assert.ok(sources.includes('pixiv'));
  assert.ok(sources.includes('adult-media'));

  assert.equal(isKnownSourceUrl('https://x.com/status/1'), true);
  assert.equal(isKnownSourceUrl('https://jable.tv/video/123'), true);
  assert.equal(isKnownSourceUrl('https://linux.do/t/topic/1'), true);
  assert.equal(isKnownSourceUrl('https://unknown-domain-999.xyz/test'), false);
  assert.equal(isKnownSourceUrl(null), false);
});

test('exports linuxdo adapter helpers and SITE_BASE constant', async () => {
  const {
    SITE_BASE,
    escapeHtml,
    rewriteCookedHtml,
    isLinuxdoTopicTarget,
    linuxdoTopicId,
  } = await import('../src/adapters/linuxdo.js');

  assert.equal(SITE_BASE, 'https://linux.do');
  assert.equal(escapeHtml('<script>alert("xss")</script>'), '&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;');

  assert.equal(isLinuxdoTopicTarget('https://linux.do/t/topic/12345'), true);
  assert.equal(isLinuxdoTopicTarget('https://linux.do/c/all'), false);
  assert.equal(linuxdoTopicId('https://linux.do/t/topic/12345'), '12345');

  const rewritten = rewriteCookedHtml('<p>Simple text</p>', { baseUrl: 'http://127.0.0.1:1300', secret: 'test-secret' });
  assert.ok(rewritten.includes('Simple text'));
});

test('exports adult-media adapter constants and domain array', async () => {
  const {
    ADULT_DOMAINS,
    DEFAULT_USER_AGENT,
    DEFAULT_ACCEPT_LANGUAGE,
  } = await import('../src/adapters/adult-media.js');

  assert.ok(Array.isArray(ADULT_DOMAINS));
  assert.ok(ADULT_DOMAINS.includes('jable.tv'));
  assert.ok(ADULT_DOMAINS.includes('javbus.com'));
  assert.ok(DEFAULT_USER_AGENT.includes('Mozilla'));
  assert.ok(DEFAULT_ACCEPT_LANGUAGE.includes('zh-CN'));
});
