import { DEFAULT_CACHE_ROOT } from './options.js';
import {
  chooseLane,
  createSessionAffinity,
  DEFAULT_SESSION_AFFINITY_MAX_AGE_MS as DEFAULT_MAX_AGE_MS,
  DEFAULT_SESSION_AFFINITY_VERSION as VERSION,
  fingerprintFor,
  isValidAffinityRecord as validRecord,
  normalizedCredentials,
  normalizedLaneIds,
  proxyIdentityHash,
} from './http-utils.js';

export {
  VERSION,
  DEFAULT_MAX_AGE_MS,
  DEFAULT_CACHE_ROOT,
  fingerprintFor,
  normalizedLaneIds,
  normalizedCredentials,
  chooseLane,
  proxyIdentityHash,
  validRecord,
  createSessionAffinity,
};
