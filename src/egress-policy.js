import { dedupe, isHostOrSubdomain, matchesHost, parseHostList, safeHost } from './http-utils.js';

const DEFAULT_PUBLIC_HOSTS = Object.freeze([
  'e-hentai.org',
  'ehgt.org',
  'hath.network',
  'nhentai.net',
  'hitomi.la',
  'pururin.io',
  'pururin.com',
  'hanime.tv',
  'hentai.tv',
  'hentai-foundry.com',
  '8muses.com',
  'rule34.xxx',
  'gelbooru.com',
  'donmai.us',
  'sankakucomplex.com',
  'hiyobi.me',
  'pornhub.com',
  'phncdn.com',
  'xvideos.com',
  'xv-cdn.com',
  'missav.com',
  'missav.ai',
  'missav.ws',
  'fourhoi.com',
  'javdb.com',
  'jdbstatic.com',
  'javbus.com',
  'javbus.one',
  'jpgcdn.com',
  'mgstage.com',
  'jable.tv',
  'dmm.co.jp',
  'ggjav.com',
  'ggjav.tv',
  'airav.wiki',
  'airav.io',
  'netflav.com',
  '1024cdn.sx',
  '1025cdn.sx',
  '1026cdn.sx',
  '2024cdn.sx',
  '91porn.com',
  'cdn77.org',
  'playno1.com',
  'onlyfans.com',
  'blogspot.com',
  'bitfan.id',
  '141jav.com',
]);

const DEFAULT_PUBLIC_REQUEST_HOSTS = Object.freeze([
  ...DEFAULT_PUBLIC_HOSTS,
  'iwara.tv',
  't.me',
  'telesco.pe',
  'x.com',
  'twitter.com',
  'twimg.com',
  'instagram.com',
  'cdninstagram.com',
  'fbcdn.net',
  'danbooru.donmai.us',
  'pixiv.net',
  'pximg.net',
]);

export {
  DEFAULT_PUBLIC_HOSTS,
  DEFAULT_PUBLIC_REQUEST_HOSTS,
  hostnameFor,
  isHostOrSubdomain,
};

export const EGRESS_POLICIES = Object.freeze({
  PUBLIC: 'public',
  STICKY: 'sticky',
});

function hostnameFor(value) {
  return safeHost(value, '');
}

export function isPublicEgressTarget(value) {
  const hostname = hostnameFor(value);
  return Boolean(hostname) && matchesHost(hostname, PUBLIC_HOSTS);
}

export function isPublicRequestTarget(value) {
  const hostname = hostnameFor(value);
  return Boolean(hostname) && matchesHost(hostname, PUBLIC_REQUEST_HOSTS);
}

export function egressPolicyForUrl(value) {
  return isPublicEgressTarget(value) ? EGRESS_POLICIES.PUBLIC : EGRESS_POLICIES.STICKY;
}

export function egressPolicyForRequest(value, { scope = 'auto' } = {}) {
  if (scope === 'session' || scope === 'sticky') return EGRESS_POLICIES.STICKY;
  if (scope === 'public' && isPublicRequestTarget(value)) return EGRESS_POLICIES.PUBLIC;
  return egressPolicyForUrl(value);
}

export { parseHostList };

const PUBLIC_HOSTS = Object.freeze(dedupe([
  ...DEFAULT_PUBLIC_HOSTS,
  ...parseHostList(process.env.EGRESS_PUBLIC_HOSTS),
]));

const PUBLIC_REQUEST_HOSTS = Object.freeze(dedupe([
  ...DEFAULT_PUBLIC_REQUEST_HOSTS,
  ...parseHostList(process.env.EGRESS_PUBLIC_REQUEST_HOSTS),
  ...parseHostList(process.env.EGRESS_PUBLIC_HOSTS),
]));

export { PUBLIC_HOSTS, PUBLIC_REQUEST_HOSTS };
