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

  const rejected = await withForegroundDeadline(Promise.reject(new Error('upstream rejected')), 20);
  assert.deepEqual(rejected, { value: undefined, timedOut: false });
});

test('createInitialReaderManifest handles empty and invalid inputs gracefully', () => {
  const empty = createInitialReaderManifest();
  assert.deepEqual(empty.pages, []);
  assert.equal(empty.totalPages, 0);
  assert.equal(empty.complete, false);

  const clamped = createInitialReaderManifest({
    imageUrls: ['https://a.com/1', 'https://a.com/2'],
    maxPages: 1,
  });
  assert.equal(clamped.pages.length, 1);
  assert.equal(clamped.totalPages, 1);
});

test('mergeResolvedPage returns unchanged manifest when pageNumber or detailTarget does not match', () => {
  const manifest = createInitialReaderManifest({
    imageUrls: ['https://e-hentai.org/s/one/gallery-1'],
    maxPages: 10,
  });
  const unmerged = mergeResolvedPage(manifest, {
    pageNumber: 99,
    detailTarget: 'https://e-hentai.org/s/unknown/gallery-99',
    mediaTarget: 'https://cdn.example.com/99.jpg',
  });
  assert.deepEqual(unmerged, manifest);
});

test('isManifestComplete checks whether all pages in manifest are resolved', async () => {
  const { isManifestComplete } = await import('../src/reader-manifest.js');
  const incomplete = createInitialReaderManifest({
    imageUrls: ['https://e-hentai.org/s/one/gallery-1', 'https://e-hentai.org/s/two/gallery-2'],
  });
  assert.equal(isManifestComplete(incomplete), false);

  const partial = mergeResolvedPage(incomplete, {
    pageNumber: 1,
    detailTarget: 'https://e-hentai.org/s/one/gallery-1',
    mediaTarget: 'https://cdn.example.com/1.jpg',
  });
  assert.equal(isManifestComplete(partial), false);

  const complete = mergeResolvedPage(partial, {
    pageNumber: 2,
    detailTarget: 'https://e-hentai.org/s/two/gallery-2',
    mediaTarget: 'https://cdn.example.com/2.jpg',
  });
  assert.equal(isManifestComplete(complete), true);

  // Edge cases
  assert.equal(isManifestComplete(null), false);
  assert.equal(isManifestComplete({}), false);
  assert.equal(isManifestComplete({ pages: [] }), false);
});

test('exports DEFAULT_PAGE_STATE_DEFERRED and DEFAULT_PAGE_STATE_RESOLVED constants', async () => {
  const {
    DEFAULT_PAGE_STATE_DEFERRED,
    DEFAULT_PAGE_STATE_RESOLVED,
  } = await import('../src/reader-manifest.js');

  assert.equal(DEFAULT_PAGE_STATE_DEFERRED, 'deferred');
  assert.equal(DEFAULT_PAGE_STATE_RESOLVED, 'resolved');
});
