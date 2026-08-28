import { ProxyAgent } from 'undici';
import {
  boundedInteger,
  boundedPositiveInteger,
  createMihomoEgressAdapter as baseCreateMihomoEgressAdapter,
  DEFAULT_EGRESS_CONTROLLER_URL,
  DEFAULT_EGRESS_LANE_COUNT,
  DEFAULT_EGRESS_LISTENER_BASE_URL,
  DEFAULT_EGRESS_PROBE_CACHE_MS,
  DEFAULT_EGRESS_PROBE_TIMEOUT_MS,
  DEFAULT_EGRESS_SESSION_LANE_COUNT,
  DEFAULT_EGRESS_SESSION_LISTENER_BASE_PORT,
  EGRESS_GROUP_TYPES as GROUP_TYPES,
  EGRESS_PUBLIC_GROUP as PUBLIC_GROUP,
  EGRESS_RESERVED_NAMES as RESERVED_NAMES,
  isSubscriptionMetadataName,
  laneGroup,
  laneId,
  listenerUrl,
  normalizeProbeTargets,
  positiveInteger,
  safeEvent,
  sessionLaneGroup,
  sessionLaneId,
  toUrlList,
} from './http-utils.js';

export const DEFAULT_CONTROLLER_URL = process.env.EGRESS_CONTROLLER_URL || DEFAULT_EGRESS_CONTROLLER_URL;
export const DEFAULT_LISTENER_BASE_URL = process.env.EGRESS_PROXY_BASE_URL || DEFAULT_EGRESS_LISTENER_BASE_URL;
export const DEFAULT_LANE_COUNT = DEFAULT_EGRESS_LANE_COUNT;
export const DEFAULT_SESSION_LANE_COUNT = DEFAULT_EGRESS_SESSION_LANE_COUNT;
export const DEFAULT_SESSION_LISTENER_BASE_PORT = DEFAULT_EGRESS_SESSION_LISTENER_BASE_PORT;
export const DEFAULT_PROBE_TIMEOUT_MS = DEFAULT_EGRESS_PROBE_TIMEOUT_MS;
export const DEFAULT_PROBE_CACHE_MS = DEFAULT_EGRESS_PROBE_CACHE_MS;

export {
  isSubscriptionMetadataName,
  normalizeProbeTargets,
  laneId,
  laneGroup,
  sessionLaneId,
  sessionLaneGroup,
  listenerUrl,
  boundedPositiveInteger,
  toUrlList,
  safeEvent,
  PUBLIC_GROUP,
  GROUP_TYPES,
  RESERVED_NAMES,
};

export function createMihomoEgressAdapter(options = {}) {
  return baseCreateMihomoEgressAdapter({
    ProxyAgentImpl: ProxyAgent,
    ...options,
  });
}
