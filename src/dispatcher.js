import { readFileSync } from 'node:fs';
import YAML from 'yaml';
import {
  buildSidecarFetchPayload,
  compilePattern,
  cookiesObject,
  createDispatcher as baseCreateDispatcher,
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

export function createDispatcher(options = {}) {
  return baseCreateDispatcher({
    readFileImpl: readFileSync,
    parseYaml: YAML.parse,
    ...options,
  });
}
