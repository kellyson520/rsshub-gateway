export const DEFAULT_PAGE_STATE_DEFERRED = 'deferred';
export const DEFAULT_PAGE_STATE_RESOLVED = 'resolved';

export const DEFAULT_FIRST_DETAIL_BUDGET_MS = 1_200;

export function createInitialReaderManifest({ imageUrls = [], maxPages = imageUrls.length } = {}) {
  const unique = [...new Set(imageUrls)].slice(0, Math.max(Number(maxPages) || 0, 0));
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

export function withForegroundDeadline(promise, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      resolve({ value: undefined, timedOut: true });
    }, Math.max(Number(timeoutMs) || 0, 0));
    Promise.resolve(promise).then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ value, timedOut: false });
      },
      () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ value: undefined, timedOut: false });
      },
    );
  });
}
