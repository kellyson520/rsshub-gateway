import { compilePattern, matchSegments } from '../dispatcher.js';
import { createEnhancerContext } from './context.js';

export function createRouteRegistry({
  fetchClient,
  browserRenderClient,
  browserFetchClient,
  logger = console,
} = {}) {
  const routes = [];
  const routeMap = new Map();

  function register(routeDef) {
    if (!routeDef || typeof routeDef !== 'object') return false;

    // 支持数组批量注册
    if (Array.isArray(routeDef)) {
      let allOk = true;
      for (const item of routeDef) {
        if (!register(item)) allOk = false;
      }
      return allOk;
    }

    // 支持 RSSHub 风格解包: { route: { path, handler, ... } }
    const actual = routeDef.route && typeof routeDef.route === 'object' ? routeDef.route : routeDef;

    // 兼容 path 与 routeId
    const routeId = String(actual.routeId || actual.path || '').trim();
    if (!routeId) return false;

    if (typeof actual.handler !== 'function') {
      throw new TypeError(`Route ${routeId} must have a handler function`);
    }

    let pattern;
    try {
      pattern = compilePattern(routeId);
    } catch (err) {
      logger?.warn?.(`[universal-enhancer] Invalid route pattern: ${routeId}`, err);
      return false;
    }

    const compiled = {
      routeId,
      path: routeId,
      name: actual.name || routeId,
      maintainers: actual.maintainers || [],
      example: actual.example || routeId,
      parameters: actual.parameters || {},
      cacheTtl: actual.cacheTtl || 900,
      pattern,
      handler: actual.handler,
    };

    if (routeMap.has(routeId)) {
      const idx = routes.findIndex((r) => r.routeId === routeId);
      if (idx !== -1) routes.splice(idx, 1);
    }

    routes.push(compiled);
    routeMap.set(routeId, compiled);
    return true;
  }

  function hasRoute(routeId) {
    return routeMap.has(routeId);
  }

  function match(pathname) {
    const segments = String(pathname || '').split('/').filter(Boolean);
    for (const route of routes) {
      const params = matchSegments(route.pattern, segments);
      if (params !== null) {
        return { route, params };
      }
    }
    return null;
  }

  function listRoutes() {
    return routes.map((r) => ({
      routeId: r.routeId,
      path: r.path,
      name: r.name,
      example: r.example,
      parameters: r.parameters,
      cacheTtl: r.cacheTtl,
      maintainers: r.maintainers,
    }));
  }

  async function execute(requestPath, { cookies = '', egressLane = 'public', requestId } = {}) {
    const url = new URL(requestPath || '/', 'http://gateway.internal');
    const matched = match(url.pathname);
    if (!matched) return null;

    const query = Object.fromEntries(url.searchParams.entries());
    const ctx = createEnhancerContext({
      routeId: matched.route.routeId,
      params: matched.params,
      query,
      cookies,
      cacheTtl: matched.route.cacheTtl,
      fetchClient,
      browserRenderClient,
      browserFetchClient,
      logger,
      requestId,
    });

    try {
      const result = await matched.route.handler(ctx);
      if (!result || typeof result.rssXml !== 'string') {
        throw new Error(`Handler for ${matched.route.routeId} did not return valid rssXml`);
      }
      return result;
    } catch (error) {
      logger?.error?.(`[universal-enhancer] Route ${matched.route.routeId} error:`, error);
      throw error;
    }
  }

  return {
    register,
    hasRoute,
    match,
    listRoutes,
    execute,
    get routes() {
      return [...routes];
    },
  };
}
