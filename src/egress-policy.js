const PUBLIC_HOSTS = Object.freeze([
  'e-hentai.org',
  'ehgt.org',
  'hath.network',
]);

const PUBLIC_REQUEST_HOSTS = Object.freeze([
  ...PUBLIC_HOSTS,
  'iwara.tv',
  't.me',
  'telesco.pe',
  'x.com',
  'twitter.com',
  'twimg.com',
  'instagram.com',
  'cdninstagram.com',
  'fbcdn.net',
]);

export const EGRESS_POLICIES = Object.freeze({
  PUBLIC: 'public',
  STICKY: 'sticky',
});

function hostnameFor(value) {
  try {
    return (value instanceof URL ? value : new URL(String(value))).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function isHostOrSubdomain(hostname, base) {
  return hostname === base || hostname.endsWith(`.${base}`);
}

export function isPublicEgressTarget(value) {
  const hostname = hostnameFor(value);
  return Boolean(hostname) && PUBLIC_HOSTS.some((base) => isHostOrSubdomain(hostname, base));
}

export function isPublicRequestTarget(value) {
  const hostname = hostnameFor(value);
  return Boolean(hostname) && PUBLIC_REQUEST_HOSTS.some((base) => isHostOrSubdomain(hostname, base));
}

export function egressPolicyForUrl(value) {
  return isPublicEgressTarget(value) ? EGRESS_POLICIES.PUBLIC : EGRESS_POLICIES.STICKY;
}

export function egressPolicyForRequest(value, { scope = 'auto' } = {}) {
  if (scope === 'session' || scope === 'sticky') return EGRESS_POLICIES.STICKY;
  if (scope === 'public' && isPublicRequestTarget(value)) return EGRESS_POLICIES.PUBLIC;
  return egressPolicyForUrl(value);
}

export { PUBLIC_HOSTS, PUBLIC_REQUEST_HOSTS };
