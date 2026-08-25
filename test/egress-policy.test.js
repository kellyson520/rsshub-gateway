import test from 'node:test';
import assert from 'node:assert/strict';
import {
  EGRESS_POLICIES,
  egressPolicyForRequest,
  egressPolicyForUrl,
  isPublicEgressTarget,
  parseHostList,
} from '../src/egress-policy.js';

test('routes public E-Hentai and H@H targets through the public egress', () => {
  const targets = [
    'https://e-hentai.org/toplist.php?tl=15',
    'https://e-hentai.org/g/123/abcdef/',
    'https://ehgt.org/w/01/002/thumbnail.webp',
    'https://hath.network/h/01/002/image.webp',
    'https://e-hentai.org/s/abcdef/123/001-001',
  ];

  for (const target of targets) {
    assert.equal(egressPolicyForUrl(target), EGRESS_POLICIES.PUBLIC, target);
    assert.equal(isPublicEgressTarget(target), true, target);
  }
});

test('routes ExHentai and authenticated-source domains through the sticky egress', () => {
  const targets = [
    'https://exhentai.org/g/123/abcdef/',
    'https://x.com/example/status/1',
    'https://pbs.twimg.com/media/example.jpg',
    'https://instagram.com/p/example/',
    'https://scontent.cdninstagram.com/example.jpg',
    'https://iwara.tv/video/example',
    'https://t.me/s/baipiaotg',
    'https://telesco.pe/baipiaotg/1',
  ];

  for (const target of targets) {
    assert.equal(egressPolicyForUrl(target), EGRESS_POLICIES.STICKY, target);
    assert.equal(isPublicEgressTarget(target), false, target);
  }
});

test('defaults malformed and unknown targets to the sticky egress', () => {
  for (const target of ['https://example.com/page', 'not-a-url', '', null]) {
    assert.equal(egressPolicyForUrl(target), EGRESS_POLICIES.STICKY, String(target));
    assert.equal(isPublicEgressTarget(target), false, String(target));
  }
});

test('matches complete host labels instead of lookalike domains', () => {
  assert.equal(egressPolicyForUrl('https://not-e-hentai.org/page'), EGRESS_POLICIES.STICKY);
  assert.equal(egressPolicyForUrl('https://examplehath.network/h/1.webp'), EGRESS_POLICIES.STICKY);
});

test('routes explicitly public reader sources through the shared pool', () => {
  for (const target of [
    'https://iwara.tv/video/1',
    'https://x.com/example/status/1',
    'https://instagram.com/p/example/',
    'https://t.me/s/channel',
  ]) {
    assert.equal(egressPolicyForRequest(target, { scope: 'public' }), EGRESS_POLICIES.PUBLIC, target);
  }
});

test('keeps session and unknown requests on a stable route', () => {
  assert.equal(egressPolicyForRequest('https://x.com/example/status/1', { scope: 'session' }), EGRESS_POLICIES.STICKY);
  assert.equal(egressPolicyForRequest('https://exhentai.org/g/1/a/', { scope: 'public' }), EGRESS_POLICIES.STICKY);
  assert.equal(egressPolicyForRequest('https://example.com/page', { scope: 'public' }), EGRESS_POLICIES.STICKY);
});

test('routes adult galleries, boorus, and video CDNs through the public egress', () => {
  const targets = [
    'https://nhentai.net/g/123/',
    'https://i.nhentai.net/galleries/123/1.jpg',
    'https://hitomi.la/galleries/123.html',
    'https://pornhub.com/view_video.php?viewkey=1',
    'https://ci.phncdn.com/videos/1.mp4',
    'https://xvideos.com/video1',
    'https://x1.xv-cdn.com/videos/1.mp4',
    'https://missav.com/watch/1',
    'https://javdb.com/v/1',
    'https://www.jpgcdn.com/1.jpg',
    'https://cdn.donmai.us/original/1/2.jpg',
    'https://rule34.xxx/index.php',
  ];
  for (const target of targets) {
    assert.equal(egressPolicyForUrl(target), EGRESS_POLICIES.PUBLIC, target);
    assert.equal(isPublicEgressTarget(target), true, target);
  }
  assert.equal(egressPolicyForRequest('https://nhentai.net/g/123/', { scope: 'public' }), EGRESS_POLICIES.PUBLIC);
  assert.equal(egressPolicyForRequest('https://danbooru.donmai.us/posts/1', { scope: 'public' }), EGRESS_POLICIES.PUBLIC);
});

test('parses env host lists as JSON or comma separated', () => {
  assert.deepEqual(parseHostList('a.com, b.com'), ['a.com', 'b.com']);
  assert.deepEqual(parseHostList(JSON.stringify(['c.com', 'd.com'])), ['c.com', 'd.com']);
  assert.deepEqual(parseHostList(''), []);
});

test('merges env host overrides into public lists and includes pixiv defaults', async () => {
  process.env.EGRESS_PUBLIC_HOSTS = 'example.com';
  process.env.EGRESS_PUBLIC_REQUEST_HOSTS = JSON.stringify(['cdn.example.com']);
  const fresh = await import(`../src/egress-policy.js?env=${Date.now()}`);
  try {
    assert.equal(fresh.isPublicEgressTarget('https://example.com/a'), true);
    assert.equal(fresh.isPublicRequestTarget('https://cdn.example.com/a'), true);
    assert.equal(fresh.isPublicRequestTarget('https://www.pixiv.net/artworks/1'), true);
    assert.equal(fresh.isPublicEgressTarget('https://www.pixiv.net/artworks/1'), false);
  } finally {
    delete process.env.EGRESS_PUBLIC_HOSTS;
    delete process.env.EGRESS_PUBLIC_REQUEST_HOSTS;
  }
});

test('parseHostList handles invalid JSON fallback seamlessly', () => {
  assert.deepEqual(parseHostList('{ bad json }'), ['{ bad json }']);
  assert.deepEqual(parseHostList(null), []);
  assert.deepEqual(parseHostList(undefined), []);
});
