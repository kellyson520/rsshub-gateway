import { readFileSync } from 'node:fs';
import YAML from 'yaml';
import {
  buildSidecarFetchPayload,
  compilePattern,
  cookiesObject,
  DEFAULT_ROUTES_FILE as BASE_DEFAULT_ROUTES_FILE,
  DEFAULT_SIDECAR_TIMEOUT_MS,
  matchRouteList,
  matchSegments,
  normalizeRoute,
  registerRouteEntries,
  resolveRedirect,
  sidecarUrl,
  unregisterRouteEntries,
} from './http-utils.js';

const DEFAULT_ROUTES_FILE = process.env.GATEWAY_ROUTES_FILE || BASE_DEFAULT_ROUTES_FILE;

export {
  compilePattern,
  normalizeRoute,
  matchSegments,
  matchRouteList,
  registerRouteEntries,
  unregisterRouteEntries,
  buildSidecarFetchPayload,
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
    return registerRouteEntries(runtimeRoutes, entries);
  }

  function unregisterRoutes(routeIds) {
    return unregisterRouteEntries(runtimeRoutes, routeIds);
  }

  function match(pathname) {
    return matchRouteList([...routes, ...runtimeRoutes], pathname);
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
        body: JSON.stringify(buildSidecarFetchPayload(route, params, { egressLane, cookies, cacheTtl })),
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
