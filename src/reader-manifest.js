export const DEFAULT_FIRST_DETAIL_BUDGET_MS = 1_200;

export function createInitialReaderManifest({ imageUrls = [], maxPages = imageUrls.length } = {}) {
  const unique = [...new Set(imageUrls)].slice(0, Math.max(Number(maxPages) || 0, 0));
  return {
    pages: unique.map((mediaTarget, index) => ({
      pageNumber: index + 1,
      detailTarget: mediaTarget,
      mediaTarget,
      state: 'deferred',
    })),
    totalPages: unique.length,
    complete: false,
  };
}

export function mergeResolvedPage(manifest, page) {
  const pages = manifest.pages.map((candidate) => {
    if (candidate.pageNumber !== page.pageNumber || candidate.detailTarget !== page.detailTarget) return candidate;
    return { ...candidate, mediaTarget: page.mediaTarget, state: 'resolved' };
  });
  return { ...manifest, pages };
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
