import { readFileSync } from 'node:fs';
import YAML from 'yaml';
import {
  compilePattern,
  cookiesObject,
  DEFAULT_ROUTES_FILE as BASE_DEFAULT_ROUTES_FILE,
  DEFAULT_SIDECAR_TIMEOUT_MS,
  matchSegments,
  normalizeRoute,
  resolveRedirect,
  sidecarUrl,
} from './http-utils.js';

const DEFAULT_ROUTES_FILE = process.env.GATEWAY_ROUTES_FILE || BASE_DEFAULT_ROUTES_FILE;

export {
  compilePattern,
  normalizeRoute,
  matchSegments,
  sidecarUrl,
  cookiesObject,
  resolveRedirect,
  DEFAULT_SIDECAR_TIMEOUT_MS,
};

export function createDispatcher({
  routesFile = DEFAULT_ROUTES_FILE,
  readFileImpl = readFileSync,
  parseYaml = YAML.parse,
  fetchImpl = fetch,
  logger = console,
  sidecarTimeoutMs = DEFAULT_SIDECAR_TIMEOUT_MS,
} = {}) {
  const routes = [];
  const runtimeRoutes = [];
  try {
    const source = readFileImpl(routesFile, 'utf8');
    const parsed = parseYaml(source);
    if (parsed && Array.isArray(parsed.routes)) {
      for (const raw of parsed.routes) {
        const route = normalizeRoute(raw);
        if (route) routes.push(route);
      }
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      logger.error?.(`dispatcher_routes_load_failed: ${error.message}`);
    }
  }

  function registerRoutes(entries) {
    let registered = 0;
    let rejected = 0;
    for (const raw of Array.isArray(entries) ? entries : []) {
      const route = normalizeRoute(raw);
      if (!route) {
        rejected += 1;
        continue;
      }
      runtimeRoutes.push(route);
      registered += 1;
    }
    return { registered, rejected };
  }

  function unregisterRoutes(routeIds) {
    const wanted = new Set(Array.isArray(routeIds) ? routeIds.map(String) : []);
    const before = runtimeRoutes.length;
    for (let index = runtimeRoutes.length - 1; index >= 0; index -= 1) {
      if (wanted.has(runtimeRoutes[index].routeId)) runtimeRoutes.splice(index, 1);
    }
    return { removed: before - runtimeRoutes.length };
  }

  function match(pathname) {
    const segments = String(pathname || '').split('/').filter(Boolean);
    for (const route of [...routes, ...runtimeRoutes]) {
      const params = matchSegments(route.pattern, segments);
      if (params !== null) return { route, params };
    }
    return null;
  }

  async function callSidecar(route, params, { egressLane, cookies, cacheTtl, requestId } = {}) {
    const baseUrl = sidecarUrl(route.backend);
    if (!baseUrl) throw new Error(`unsupported backend: ${route.backend}`);
    let response;
    try {
      response = await fetchImpl(`${baseUrl}/fetch`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(requestId ? { 'x-request-id': requestId } : {}),
        },
        body: JSON.stringify({
          routeId: route.routeId,
          params,
          egressLane,
          // Fetcher-API contract: cookies is an object; normalize the raw Cookie
          // header the gateway may hand over so sidecars always get {name: value}.
          cookies: cookiesObject(cookies),
          cacheTtl: cacheTtl ?? route.cacheTtl,
        }),
        signal: AbortSignal.timeout(sidecarTimeoutMs),
      });
    } catch (error) {
      throw new Error(`sidecar unavailable: ${error.message}`);
    }
    if (!response.ok) throw new Error(`sidecar returned ${response.status}`);
    let payload;
    try {
      payload = await response.json();
    } catch {
      throw new Error('sidecar response is not valid json');
    }
    if (!payload || typeof payload.rssXml !== 'string') {
      throw new Error('sidecar response missing rssXml');
    }
    return payload;
  }

  return { routes, runtimeRoutes, match, callSidecar, registerRoutes, unregisterRoutes };
}
