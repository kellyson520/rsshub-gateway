import { readFileSync } from 'node:fs';
import YAML from 'yaml';

const DEFAULT_ROUTES_FILE = process.env.GATEWAY_ROUTES_FILE || 'gateway-routes.yaml';
const DEFAULT_SIDECAR_TIMEOUT_MS = 20_000;

function compilePattern(routeId) {
  const segments = String(routeId).split('/').filter(Boolean);
  const pattern = [];
  let star = false;
  for (const segment of segments) {
    if (segment === '*') {
      star = true;
      pattern.push({ type: 'star' });
    } else if (segment.startsWith(':')) {
      const name = segment.slice(1);
      if (name.endsWith('?')) {
        pattern.push({ type: 'optional', name: name.slice(0, -1) });
      } else {
        pattern.push({ type: 'param', name });
      }
    } else {
      pattern.push({ type: 'literal', value: segment });
    }
  }
  if (star && pattern[pattern.length - 1].type !== 'star') {
    throw new Error(`route "${routeId}": * must be the last segment`);
  }
  return pattern;
}

function normalizeRoute(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const routeId = String(raw.routeId || '').trim();
  const backend = String(raw.backend || '').trim();
  if (!routeId || !backend) return null;
  let pattern;
  try {
    pattern = compilePattern(routeId);
  } catch {
    return null;
  }
  const fallbackUpstream = raw.fallback_upstream === true || raw.fallbackUpstream === true;
  const cacheTtl = Number.isInteger(raw.cacheTtl) && raw.cacheTtl > 0 ? raw.cacheTtl : undefined;
  return { routeId, backend, fallbackUpstream, cacheTtl, pattern };
}

function matchSegments(pattern, segments) {
  const params = {};
  const starIndex = pattern.findIndex((part) => part.type === 'star');
  const required = pattern.filter((part) => part.type !== 'optional');
  const minLength = starIndex >= 0 ? starIndex : required.length;
  const maxLength = starIndex >= 0 ? Infinity : pattern.length;
  if (segments.length < minLength || segments.length > maxLength) return null;
  let segmentIndex = 0;
  for (let index = 0; index < pattern.length; index += 1) {
    const part = pattern[index];
    if (part.type === 'star') {
      return params;
    }
    if (segmentIndex >= segments.length) {
      if (part.type === 'optional') return params;
      return null;
    }
    const value = segments[segmentIndex];
    if (part.type === 'literal') {
      if (value !== part.value) return null;
    } else if (part.type === 'param' || part.type === 'optional') {
      params[part.name] = decodeURIComponent(value);
    }
    segmentIndex += 1;
  }
  return segmentIndex === segments.length ? params : null;
}

function sidecarUrl(backend) {
  if (typeof backend !== 'string' || !backend.startsWith('sidecar://')) return null;
  const hostPort = backend.slice('sidecar://'.length).replace(/\/$/, '');
  if (!hostPort) return null;
  return `http://${hostPort}`;
}

export function createDispatcher({
  routesFile = DEFAULT_ROUTES_FILE,
  readFileImpl = readFileSync,
  parseYaml = YAML.parse,
  fetchImpl = fetch,
  logger = console,
  sidecarTimeoutMs = DEFAULT_SIDECAR_TIMEOUT_MS,
} = {}) {
  const routes = [];
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

  function match(pathname) {
    const segments = String(pathname || '').split('/').filter(Boolean);
    for (const route of routes) {
      const params = matchSegments(route.pattern, segments);
      if (params !== null) return { route, params };
    }
    return null;
  }

  async function callSidecar(route, params, { egressLane, cookies, cacheTtl } = {}) {
    const baseUrl = sidecarUrl(route.backend);
    if (!baseUrl) throw new Error(`unsupported backend: ${route.backend}`);
    let response;
    try {
      response = await fetchImpl(`${baseUrl}/fetch`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          routeId: route.routeId,
          params,
          egressLane,
          cookies,
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

  return { routes, match, callSidecar };
}
