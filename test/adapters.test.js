import test from 'node:test';
import assert from 'node:assert/strict';
import { adapterForUrl, resolveMode } from '../src/adapters/index.js';

test('uses an Iwara session header only when configured', () => {
  const adapter = adapterForUrl('https://www.iwara.tv/video/abc');
  assert.deepEqual(adapter.headers({}), {});
  assert.match(adapter.headers({ cookie: 'session=value' }).cookie, /session=value/);
});

test('builds X and Instagram headers from their source tokens', () => {
  assert.match(adapterForUrl('https://x.com/example/status/1').headers({ authToken: 'auth', ct0: 'csrf' }).cookie, /auth_token=auth/);
  assert.match(adapterForUrl('https://www.instagram.com/example/').headers({ cookie: 'sessionid=value' }).cookie, /sessionid=value/);
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
