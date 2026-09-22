const EXCLUDED_PREFIXES = Object.freeze([
  '/_gateway',
  '/healthz',
  '/favicon.ico',
  '/robots.txt',
  '/metrics',
  '/api',
]);

export function normalizeFeedPath(requestPath) {
  if (!requestPath || typeof requestPath !== 'string') return null;
  try {
    const parsed = new URL(requestPath, 'http://gateway.internal');
    const pathname = parsed.pathname.trim();
    if (!pathname || pathname === '/') return null;
    for (const prefix of EXCLUDED_PREFIXES) {
      if (pathname.startsWith(prefix)) return null;
    }
    // Ignore binary asset extensions
    if (/\.(png|jpe?g|gif|webp|ico|svg|css|js|mp4|webm|m3u8|ts)$/i.test(pathname)) {
      return null;
    }
    return pathname.replace(/\/+$/, '');
  } catch {
    return null;
  }
}

export function createDynamicRouteRegistry({
  maxRoutes = 500,
  maxWarmupPaths = 50,
  seedPaths = [],
  now = () => Date.now(),
  logger = { info() {}, warn() {}, error() {} },
} = {}) {
  const routes = new Map();

  function recordRoute(cleanPath, initialHits = 1) {
    const existing = routes.get(cleanPath);
    const timestamp = now();
    if (existing) {
      existing.hitCount += 1;
      existing.lastAccessedAt = timestamp;
      return { isNew: false, ...existing };
    }

    // Check capacity and prune lowest score route if needed
    if (routes.size >= maxRoutes) {
      pruneLowestPriority();
    }

    const entry = {
      path: cleanPath,
      hitCount: initialHits,
      firstSeenAt: timestamp,
      lastAccessedAt: timestamp,
    };
    routes.set(cleanPath, entry);
    logger.info('dynamic_route_registered', { path: cleanPath });
    return { isNew: true, ...entry };
  }

  function pruneLowestPriority() {
    let oldestKey = null;
    let lowestScore = Infinity;
    const current = now();

    for (const [key, entry] of routes.entries()) {
      // Score based on hit count and recency (half-life decay)
      const ageHours = Math.max(0, (current - entry.lastAccessedAt) / 3_600_000);
      const score = entry.hitCount / (1 + ageHours);
      if (score < lowestScore) {
        lowestScore = score;
        oldestKey = key;
      }
    }
    if (oldestKey) {
      routes.delete(oldestKey);
    }
  }

  // Seed initial paths
  for (const seed of seedPaths) {
    const clean = normalizeFeedPath(seed);
    if (clean) {
      recordRoute(clean, 1);
    }
  }

  function recordAccess(requestPath) {
    const clean = normalizeFeedPath(requestPath);
    if (!clean) return null;
    return recordRoute(clean);
  }

  function getWarmupPaths() {
    const current = now();
    const sorted = [...routes.values()]
      .map((entry) => {
        const ageHours = Math.max(0, (current - entry.lastAccessedAt) / 3_600_000);
        const score = entry.hitCount / (1 + ageHours);
        return { entry, score };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, maxWarmupPaths);

    return sorted.map((item) => item.entry.path);
  }

  function getAllRoutes() {
    return [...routes.values()];
  }

  return {
    recordAccess,
    getWarmupPaths,
    getAllRoutes,
  };
}
