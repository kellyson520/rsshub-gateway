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
});

test('keeps canonical reader URLs and source-specific fallback messages', () => {
  const x = adapterForUrl('https://x.com/example/status/1');
  const instagram = adapterForUrl('https://www.instagram.com/example/');
  const iwara = adapterForUrl('https://www.iwara.tv/video/example');

  assert.equal(x.readerTarget('https://x.com/example/status/1'), 'https://x.com/example/status/1');
  assert.match(x.unavailableMessage(), /X/);
  assert.match(instagram.unavailableMessage(), /Instagram/);
  assert.match(iwara.unavailableMessage(), /Iwara/);
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
