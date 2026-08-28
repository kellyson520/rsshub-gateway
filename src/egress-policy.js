import {
  dedupe,
  DEFAULT_PUBLIC_HOSTS,
  DEFAULT_PUBLIC_REQUEST_HOSTS,
  egressPolicyForRequest as baseEgressPolicyForRequest,
  egressPolicyForUrl as baseEgressPolicyForUrl,
  EGRESS_POLICIES,
  isHostOrSubdomain,
  isPublicEgressTarget as baseIsPublicEgressTarget,
  isPublicRequestTarget as baseIsPublicRequestTarget,
  parseHostList,
  safeHost,
} from './http-utils.js';

const PUBLIC_HOSTS = Object.freeze(dedupe([
  ...DEFAULT_PUBLIC_HOSTS,
  ...parseHostList(process.env.EGRESS_PUBLIC_HOSTS),
]));

const PUBLIC_REQUEST_HOSTS = Object.freeze(dedupe([
  ...DEFAULT_PUBLIC_REQUEST_HOSTS,
  ...parseHostList(process.env.EGRESS_PUBLIC_REQUEST_HOSTS),
  ...parseHostList(process.env.EGRESS_PUBLIC_HOSTS),
]));

function hostnameFor(value) {
  return safeHost(value, '');
}

export function isPublicEgressTarget(value) {
  return baseIsPublicEgressTarget(value, PUBLIC_HOSTS);
}

export function isPublicRequestTarget(value) {
  return baseIsPublicRequestTarget(value, PUBLIC_REQUEST_HOSTS);
}

export function egressPolicyForUrl(value) {
  return baseEgressPolicyForUrl(value, PUBLIC_HOSTS);
}

export function egressPolicyForRequest(value, { scope = 'auto' } = {}) {
  return baseEgressPolicyForRequest(value, { scope, publicHosts: PUBLIC_HOSTS, publicRequestHosts: PUBLIC_REQUEST_HOSTS });
}

export {
  DEFAULT_PUBLIC_HOSTS,
  DEFAULT_PUBLIC_REQUEST_HOSTS,
  EGRESS_POLICIES,
  hostnameFor,
  isHostOrSubdomain,
  parseHostList,
  PUBLIC_HOSTS,
  PUBLIC_REQUEST_HOSTS,
};
