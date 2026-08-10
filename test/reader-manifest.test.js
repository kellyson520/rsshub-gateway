import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_FIRST_DETAIL_BUDGET_MS,
  createInitialReaderManifest,
  mergeResolvedPage,
  withForegroundDeadline,
} from '../src/reader-manifest.js';

test('deduplicates initial detail targets while preserving source order', () => {
  const manifest = createInitialReaderManifest({
    imageUrls: [
      'https://e-hentai.org/s/one/gallery-1',
      'https://e-hentai.org/s/two/gallery-2',
      'https://e-hentai.org/s/one/gallery-1',
    ],
    maxPages: 10,
  });

  assert.deepEqual(manifest.pages.map((page) => [page.pageNumber, page.mediaTarget, page.state]), [
    [1, 'https://e-hentai.org/s/one/gallery-1', 'deferred'],
    [2, 'https://e-hentai.org/s/two/gallery-2', 'deferred'],
  ]);
  assert.equal(manifest.complete, false);
});

test('replaces only the matching deferred page with its resolved media target', () => {
  const manifest = createInitialReaderManifest({
    imageUrls: [
      'https://e-hentai.org/s/one/gallery-1',
      'https://e-hentai.org/s/two/gallery-2',
    ],
    maxPages: 10,
  });
  const merged = mergeResolvedPage(manifest, {
    pageNumber: 1,
    detailTarget: 'https://e-hentai.org/s/one/gallery-1',
    mediaTarget: 'https://page.example.hath.network/h/one.webp',
  });

  assert.deepEqual(merged.pages[0], {
    pageNumber: 1,
    detailTarget: 'https://e-hentai.org/s/one/gallery-1',
    mediaTarget: 'https://page.example.hath.network/h/one.webp',
    state: 'resolved',
  });
  assert.equal(merged.pages[1].mediaTarget, 'https://e-hentai.org/s/two/gallery-2');
});

test('returns the completed value before the foreground budget and marks timeout otherwise', async () => {
  assert.equal(DEFAULT_FIRST_DETAIL_BUDGET_MS, 1_200);
  const fast = await withForegroundDeadline(Promise.resolve('ready'), 20);
  assert.deepEqual(fast, { value: 'ready', timedOut: false });

  const slow = await withForegroundDeadline(new Promise(() => {}), 1);
  assert.deepEqual(slow, { value: undefined, timedOut: true });
});
