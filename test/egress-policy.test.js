import test from 'node:test';
import assert from 'node:assert/strict';
import {
  EGRESS_POLICIES,
  egressPolicyForRequest,
  egressPolicyForUrl,
  isPublicEgressTarget,
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
