import { compilePattern, matchSegments } from '../dispatcher.js';
import { createEnhancerContext } from './context.js';

export function createRouteRegistry({ fetchClient, browserRenderClient, logger = console } = {}) {
  const routes = [];
  const routeMap = new Map();

  function register(routeDef) {
    if (!routeDef || typeof routeDef !== 'object') return false;
    const routeId = String(routeDef.routeId || '').trim();
    if (!routeId) return false;
    if (typeof routeDef.handler !== 'function') {
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
      name: routeDef.name || routeId,
      cacheTtl: routeDef.cacheTtl || 900,
      pattern,
      handler: routeDef.handler,
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
    routes,
    register,
    hasRoute,
    match,
    execute,
  };
}
