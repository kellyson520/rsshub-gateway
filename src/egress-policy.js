const PUBLIC_HOSTS = Object.freeze([
  'e-hentai.org',
  'ehgt.org',
  'hath.network',
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

export function egressPolicyForUrl(value) {
  return isPublicEgressTarget(value) ? EGRESS_POLICIES.PUBLIC : EGRESS_POLICIES.STICKY;
}

export { PUBLIC_HOSTS };
