import test from 'node:test';
import assert from 'node:assert/strict';
import { createMediaSignedTarget, createSignedTarget, isAllowedTarget, verifySignedTarget } from '../src/signed-target.js';

test('accepts an unexpired allowlisted target', () => {
  const token = createSignedTarget('https://www.iwara.tv/video/abc', 'secret', 3600, 1000);
  assert.equal(verifySignedTarget(token, 'secret', 1001).url, 'https://www.iwara.tv/video/abc');
});

test('rejects altered and expired targets', () => {
  const token = createSignedTarget('https://x.com/example/status/1', 'secret', 1, 1000);
  assert.throws(() => verifySignedTarget(`${token}x`, 'secret', 1001));
  assert.throws(() => verifySignedTarget(token, 'secret', 1002));
});

test('rejects unsupported and private targets', () => {
  assert.throws(() => createSignedTarget('http://example.com', 'secret'));
  assert.throws(() => createSignedTarget('https://127.0.0.1/private', 'secret'));
  assert.throws(() => createSignedTarget('https://example.com/private', 'secret'));
});

test('uses one signed media URL for each cache day', () => {
  const first = createMediaSignedTarget('https://i.iwara.tv/image/demo.jpg', 'secret', 1_000);
  const later = createMediaSignedTarget('https://i.iwara.tv/image/demo.jpg', 'secret', 86_399);
  const nextDay = createMediaSignedTarget('https://i.iwara.tv/image/demo.jpg', 'secret', 86_400);

  assert.equal(first, later);
  assert.notEqual(first, nextDay);
  assert.equal(verifySignedTarget(first, 'secret', 86_399).url, 'https://i.iwara.tv/image/demo.jpg');
});

test('accepts Telegram post and media hosts', () => {
  assert.equal(
    verifySignedTarget(createSignedTarget('https://t.me/baipiaotg/67333', 'secret'), 'secret').url,
    'https://t.me/baipiaotg/67333',
  );
  assert.equal(
    verifySignedTarget(createSignedTarget('https://cdn5.telesco.pe/file/demo.jpg', 'secret'), 'secret').url,
    'https://cdn5.telesco.pe/file/demo.jpg',
  );
});

test('allows E-Hentai gallery and image hosts but not unrelated hosts', () => {
  assert.equal(isAllowedTarget('https://e-hentai.org/g/123/abc/'), true);
  assert.equal(isAllowedTarget('https://ehgt.org/thumb.jpg'), true);
  assert.equal(isAllowedTarget('https://node.example.hath.network/h/image.webp'), true);
  assert.equal(isAllowedTarget('https://node.example.hath.network/om/image.webp'), true);
  assert.equal(isAllowedTarget('https://node.example.hath.network:54200/h/image.webp'), true);
  assert.equal(isAllowedTarget('https://node.example.hath.network:54200/om/image.webp'), true);
  assert.equal(isAllowedTarget('https://node.example.hath.network:1064/h/image.webp'), true);
  assert.equal(isAllowedTarget('https://node.example.hath.network:38428/h/image.webp'), true);
  assert.equal(isAllowedTarget('https://node.example.hath.network/c2/thumb.webp'), true);
  assert.equal(isAllowedTarget('https://node.example.hath.network:1/h/image.webp'), false);
  assert.equal(isAllowedTarget('https://node.example.hath.network:1023/h/image.webp'), false);
  assert.equal(isAllowedTarget('https://node.example.hath.network:54200/c2/thumb.webp'), false);
  assert.equal(isAllowedTarget('https://node.example.hath.network:54200/not-gallery/image.webp'), false);
  assert.equal(isAllowedTarget('https://images.example.invalid/full.jpg'), false);
});

test('protects scope metadata in signed targets and keeps legacy tokens compatible', () => {
  const token = createSignedTarget(
    'https://x.com/example/status/1',
    'secret',
    3600,
    1000,
    { egressScope: 'session', source: 'x' },
  );
  const data = verifySignedTarget(token, 'secret', 1001);
  assert.equal(data.egressScope, 'session');
  assert.equal(data.source, 'x');
  assert.equal(data.credentialFingerprint, undefined);

  const legacy = verifySignedTarget(createSignedTarget('https://x.com/example/status/1', 'secret', 3600, 1000), 'secret', 1001);
  assert.equal(legacy.egressScope, undefined);
  assert.throws(() => createSignedTarget('https://x.com/example/status/1', 'secret', 3600, 1000, { egressScope: 'private' }));
});

test('allows major adult source hosts and their media CDNs', () => {
  const allowed = [
    'https://nhentai.net/g/123/',
    'https://i.nhentai.net/galleries/123/1.jpg',
    'https://t.nhentai.net/galleries/123/cover.jpg',
    'https://hitomi.la/galleries/123.html',
    'https://tn.hitomi.la/reader/1/1.jpg',
    'https://pururin.io/gallery/1/1.jpg',
    'https://hanime.tv/videos/hentai/1',
    'https://hentai.tv/video/1',
    'https://pictures.hentai-foundry.com/x/1.jpg',
    'https://images.8muses.com/x/1.jpg',
    'https://rule34.xxx/index.php?page=post&s=view&id=1',
    'https://img3.gelbooru.com/images/1/2.jpg',
    'https://cdn.donmai.us/original/1/2.jpg',
    'https://s.sankakucomplex.com/data/1/2.jpg',
    'https://pornhub.com/view_video.php?viewkey=1',
    'https://ci.phncdn.com/videos/1.mp4',
    'https://xvideos.com/video1',
    'https://x1.xv-cdn.com/videos/1.mp4',
    'https://missav.com/watch/1',
    'https://javdb.com/v/1',
    'https://javbus.com/1',
    'https://www.jpgcdn.com/1.jpg',
  ];
  for (const target of allowed) {
    assert.equal(isAllowedTarget(target), true, target);
  }
  assert.equal(isAllowedTarget('https://example.com/outside.mp4'), false);
});
