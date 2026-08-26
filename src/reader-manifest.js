import { dedupe, withDeadline } from './http-utils.js';

export const DEFAULT_PAGE_STATE_DEFERRED = 'deferred';
export const DEFAULT_PAGE_STATE_RESOLVED = 'resolved';

export const DEFAULT_FIRST_DETAIL_BUDGET_MS = 1_200;

export function createInitialReaderManifest({ imageUrls = [], maxPages = imageUrls.length } = {}) {
  const unique = dedupe(imageUrls).slice(0, Math.max(Number(maxPages) || 0, 0));
  return {
    pages: unique.map((mediaTarget, index) => ({
      pageNumber: index + 1,
      detailTarget: mediaTarget,
      mediaTarget,
      state: DEFAULT_PAGE_STATE_DEFERRED,
    })),
    totalPages: unique.length,
    complete: false,
  };
}

export function mergeResolvedPage(manifest, page) {
  const pages = manifest.pages.map((candidate) => {
    if (candidate.pageNumber !== page.pageNumber || candidate.detailTarget !== page.detailTarget) return candidate;
    return { ...candidate, mediaTarget: page.mediaTarget, state: DEFAULT_PAGE_STATE_RESOLVED };
  });
  return { ...manifest, pages };
}

export function isManifestComplete(manifest) {
  if (!manifest || !Array.isArray(manifest.pages) || manifest.pages.length === 0) return false;
  return manifest.pages.every((page) => page.state === DEFAULT_PAGE_STATE_RESOLVED);
}

export const withForegroundDeadline = withDeadline;
export { withDeadline };
