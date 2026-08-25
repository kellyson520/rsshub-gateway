import { ProxyAgent } from 'undici';

const DEFAULT_CONTROLLER_URL = process.env.EGRESS_CONTROLLER_URL || 'http://127.0.0.1:9090';
const DEFAULT_LISTENER_BASE_URL = process.env.EGRESS_PROXY_BASE_URL || 'http://127.0.0.1';
const DEFAULT_LANE_COUNT = 12;
const DEFAULT_SESSION_LANE_COUNT = 12;
const DEFAULT_SESSION_LISTENER_BASE_PORT = 7921;
const DEFAULT_PROBE_TIMEOUT_MS = 5_000;
const DEFAULT_PROBE_CACHE_MS = 5 * 60_000;
const PUBLIC_GROUP = 'PUBLIC';
const GROUP_TYPES = new Set(['Selector', 'URLTest', 'Fallback', 'LoadBalance', 'Relay', 'Compatible', 'URLTest']);
const RESERVED_NAMES = new Set(['DIRECT', 'REJECT', 'GLOBAL', 'PASS']);

function isSubscriptionMetadataName(name) {
  const value = String(name || '').trim().toLowerCase();
  return value.includes('剩余流量')
    || value.includes('距离下次重置')
    || value.includes('套餐到期')
    || value.includes('官网地址')
    || value.includes('更新订阅')
    || value.includes('update subscription')
    || value.includes('remaining traffic')
    || value.includes('subscription expires')
    || value.includes('reset remaining');
}

function boundedPositiveInteger(value, fallback, maximum) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, maximum);
}

function toUrlList(value) {
  if (!value) return [];
  const list = Array.isArray(value) ? value : [value];
  return list.map(String).filter(Boolean);
}

function normalizeProbeTargets(value, legacyProbeUrl) {
  if (value && typeof value === 'object') {
    return {
      public: toUrlList(value.public),
      sticky: toUrlList(value.sticky),
      hosts: value.hosts && typeof value.hosts === 'object' ? value.hosts : {},
    };
  }
  if (!legacyProbeUrl) {
    return { public: [], sticky: [], hosts: {} };
  }
  return {
    public: toUrlList(legacyProbeUrl),
    sticky: [],
    hosts: {},
  };
}

function laneId(index) {
  return `lane-${String(index + 1).padStart(2, '0')}`;
}

function laneGroup(index) {
  return `EGRESS_LANE_${String(index + 1).padStart(2, '0')}`;
}

function sessionLaneId(index) {
  return `session-lane-${String(index + 1).padStart(2, '0')}`;
}

function sessionLaneGroup(index) {
  return `SESSION_LANE_${String(index + 1).padStart(2, '0')}`;
}

function listenerUrl(baseUrl, index, basePort = 7901) {
  const target = new URL(baseUrl);
  target.port = String(basePort + index);
  return target.toString().replace(/\/$/, '');
}

function safeEvent(onEvent, event) {
  try {
    onEvent?.(event);
  } catch {
    // Diagnostics must never affect egress refresh.
  }
}

export function createMihomoEgressAdapter({
  controllerUrl = DEFAULT_CONTROLLER_URL,
  listenerBaseUrl = DEFAULT_LISTENER_BASE_URL,
  laneCount = DEFAULT_LANE_COUNT,
  sessionLaneCount = DEFAULT_SESSION_LANE_COUNT,
  sessionListenerBasePort = DEFAULT_SESSION_LISTENER_BASE_PORT,
  fetchImpl = fetch,
  probeUrl,
  probeTargets,
  probeFetchImpl = fetch,
  probeTimeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
  probeCacheMs = DEFAULT_PROBE_CACHE_MS,
  now = () => Date.now(),
  onEvent,
} = {}) {
  const controller = String(controllerUrl).replace(/\/$/, '');
  const lanesLimit = Math.max(1, Number.parseInt(laneCount, 10) || DEFAULT_LANE_COUNT);
  const sessionLanesLimit = Math.max(1, Number.parseInt(sessionLaneCount, 10) || DEFAULT_SESSION_LANE_COUNT);
  const sessionPort = boundedPositiveInteger(sessionListenerBasePort, DEFAULT_SESSION_LISTENER_BASE_PORT, 65_535);
  const sourceProbeUrl = String(probeUrl || '').trim();
  const sourceProbeTargets = normalizeProbeTargets(probeTargets, sourceProbeUrl);
  const PROBE_SCOPES = ['public', 'sticky'].filter((scope) => (sourceProbeTargets[scope] || []).length);
  const REQUIRED_PROBE_SCOPE = PROBE_SCOPES.includes('public') ? 'public' : PROBE_SCOPES[0];
  const sourceProbeTimeoutMs = boundedPositiveInteger(probeTimeoutMs, DEFAULT_PROBE_TIMEOUT_MS, 30_000);
  const sourceProbeCacheMs = boundedPositiveInteger(probeCacheMs, DEFAULT_PROBE_CACHE_MS, 60 * 60_000);
  let lastLanes = [];
  let degraded = false;
  const probeResults = new Map();
  // node -> first-banned timestamp; entries become retriable after the probe
  // cache window so a transient block cannot permanently consume session nodes.
  const unhealthySessionNodes = new Map();
  const sessionSlots = Array.from({ length: sessionLanesLimit }, (_, index) => ({
    id: sessionLaneId(index),
    group: sessionLaneGroup(index),
    proxyUrl: listenerUrl(listenerBaseUrl, index, sessionPort),
    proxyName: undefined,
    dispatcher: undefined,
    unhealthy: false,
  }));

  async function request(path, options) {
    const response = await fetchImpl(`${controller}${path}`, {
      ...options,
      headers: { ...(options?.body ? { 'content-type': 'application/json' } : {}), ...options?.headers },
    });
    if (!response.ok) throw new Error(`mihomo controller returned ${response.status}`);
    if (response.status === 204) return {};
    return response.json();
  }

  function healthyNodes(payload, providersPayload, { includeGenericFailures = false } = {}) {
    const proxies = payload?.proxies || {};
    const publicGroup = proxies[PUBLIC_GROUP];
    const names = Array.isArray(publicGroup?.all) ? publicGroup.all : [];
    const providerDetails = new Map();
    for (const provider of Object.values(providersPayload?.providers || {})) {
      for (const detail of provider?.proxies || []) {
        if (detail?.name) providerDetails.set(detail.name, detail);
      }
    }
    return names.filter((name) => {
      const detail = proxies[name] || providerDetails.get(name);
      return Boolean(detail)
        && !RESERVED_NAMES.has(name)
        && !isSubscriptionMetadataName(name)
        && !String(name).startsWith('EGRESS_LANE_')
        && !String(name).startsWith('SESSION_LANE_')
        && !GROUP_TYPES.has(detail.type)
        && (includeGenericFailures || detail.alive !== false);
    });
  }

  async function probeTarget(target, dispatcher, method, laneId) {
    const response = await probeFetchImpl(target, {
      method,
      dispatcher,
      redirect: 'manual',
      headers: { 'x-probe-lane': laneId },
      signal: AbortSignal.timeout(sourceProbeTimeoutMs),
    });
    const ok = response.status >= 200 && response.status < 400;
    await response.body?.cancel();
    return ok;
  }

  async function probeLane(lane, scope) {
    const targets = sourceProbeTargets[scope] || [];
    if (!targets.length) return true;
    const cacheKey = `${lane.proxyName}:${scope}`;
    const cached = probeResults.get(cacheKey);
    if (cached && now() - cached.at < sourceProbeCacheMs) return cached.ok;
    let ok = false;
    for (const target of targets) {
      let targetOk = false;
      try {
        targetOk = await probeTarget(target, lane.dispatcher, 'HEAD', lane.id);
      } catch {
        targetOk = false;
      }
      if (!targetOk) {
        // Some sites reject HEAD probes (403 bot guard, 405/501 method policy)
        // while serving GET traffic; retry once with GET and discard the body.
        try {
          targetOk = await probeTarget(target, lane.dispatcher, 'GET', lane.id);
        } catch {
          targetOk = false;
        }
      }
      if (targetOk) {
        ok = true;
        break;
      }
    }
    probeResults.set(cacheKey, { at: now(), ok });
    return ok;
  }

  async function bindAndProbe(node, index) {
    const group = laneGroup(index);
    await request(`/proxies/${encodeURIComponent(group)}`, {
      method: 'PUT',
      body: JSON.stringify({ name: node }),
    });
    const lane = {
      id: laneId(index),
      proxyName: node,
      proxyUrl: listenerUrl(listenerBaseUrl, index),
      dispatcher: new ProxyAgent(listenerUrl(listenerBaseUrl, index)),
      healthyScopes: new Set(),
    };
    for (const scope of PROBE_SCOPES) {
      if (await probeLane(lane, scope)) lane.healthyScopes.add(scope);
    }
    if (PROBE_SCOPES.length && !lane.healthyScopes.has(REQUIRED_PROBE_SCOPE)) {
      await lane.dispatcher.close().catch(() => {});
      return { lane: undefined, index };
    }
    return { lane, index };
  }

  async function proxyCandidates() {
    const payload = await request('/proxies');
    const publicNames = payload?.proxies?.[PUBLIC_GROUP]?.all || [];
    const needsProviderDetails = publicNames.some((name) => !payload?.proxies?.[name]);
    const providersPayload = needsProviderDetails ? await request('/providers/proxies') : undefined;
    const primaryNodes = healthyNodes(payload, providersPayload);
    const fallbackNodes = sourceProbeUrl
      ? healthyNodes(payload, providersPayload, { includeGenericFailures: true })
        .filter((node) => !primaryNodes.includes(node))
        .slice(0, Math.max(lanesLimit, sessionLanesLimit))
      : [];
    return [...primaryNodes, ...fallbackNodes];
  }

  async function verifyGroups() {
    try {
      const payload = await request('/proxies');
      const names = new Set(Object.keys(payload?.proxies || {}));
      const missing = [];
      for (let index = 0; index < lanesLimit; index += 1) {
        if (!names.has(laneGroup(index))) missing.push(laneGroup(index));
      }
      for (let index = 0; index < sessionLanesLimit; index += 1) {
        if (!names.has(sessionLaneGroup(index))) missing.push(sessionLaneGroup(index));
      }
      return { ready: missing.length === 0, missing };
    } catch (error) {
      return { ready: false, missing: [], error: error?.message || 'mihomo controller unavailable' };
    }
  }

  async function refreshPublicLanes() {
    try {
      const nodes = await proxyCandidates();
      const nextLanes = [];
      let cursor = 0;
      let freeIndexes = Array.from({ length: lanesLimit }, (_, index) => index);
      while (cursor < nodes.length && freeIndexes.length) {
        const batchNodes = nodes.slice(cursor, cursor + freeIndexes.length);
        const batchIndexes = freeIndexes.splice(0, batchNodes.length);
        cursor += batchNodes.length;
        const results = await Promise.all(batchNodes.map((node, offset) => bindAndProbe(node, batchIndexes[offset])));
        for (const result of results) {
          if (result.lane) nextLanes.push(result.lane);
          else freeIndexes.push(result.index);
        }
      }
      nextLanes.sort((left, right) => Number.parseInt(left.id.slice(5), 10) - Number.parseInt(right.id.slice(5), 10));
      if (PROBE_SCOPES.length && !nextLanes.length && lastLanes.length) {
        degraded = true;
        safeEvent(onEvent, { state: 'degraded', lanes: lastLanes.length, code: 'EGRESS_SOURCE_PROBE_FAILED' });
        return lastLanes;
      }
      // Retire dispatchers that the new snapshot no longer references; undici
      // close() waits for in-flight requests, so active leases are unaffected.
      const retained = new Set(nextLanes.map((lane) => lane.dispatcher));
      for (const lane of lastLanes) {
        if (!retained.has(lane.dispatcher)) {
          void lane.dispatcher?.close?.().catch(() => {});
        }
      }
      lastLanes = nextLanes;
      degraded = nextLanes.length === 0;
      safeEvent(onEvent, { state: degraded ? 'empty' : 'refresh', lanes: nextLanes.length });
      return lastLanes;
    } catch (error) {
      degraded = true;
      safeEvent(onEvent, { state: 'degraded', lanes: lastLanes.length, code: error.code || 'MIHOMO_CONTROLLER_ERROR' });
      return lastLanes;
    }
  }

  function sessionSnapshot(slot) {
    if (!slot.proxyName || !slot.dispatcher || slot.unhealthy) return undefined;
    return {
      id: slot.id,
      proxyName: slot.proxyName,
      proxyUrl: slot.proxyUrl,
      dispatcher: slot.dispatcher,
      healthyScopes: slot.healthyScopes ? [...slot.healthyScopes] : undefined,
    };
  }

  function sessionLanes() {
    return sessionSlots.map(sessionSnapshot).filter(Boolean);
  }

  function sessionSlotFor(laneId) {
    return sessionSlots.find((slot) => slot.id === String(laneId || '').trim());
  }

  async function assignSessionLane(laneId, node) {
    const slot = sessionSlotFor(laneId);
    const proxyName = String(node || '').trim();
    if (!slot) throw new Error(`unknown session lane: ${laneId}`);
    if (!proxyName) throw new Error('session lane proxy is required');
    if (slot.proxyName === proxyName && slot.dispatcher && !slot.unhealthy) return sessionSnapshot(slot);
    await request(`/proxies/${encodeURIComponent(slot.group)}`, {
      method: 'PUT',
      body: JSON.stringify({ name: proxyName }),
    });
    await slot.dispatcher?.close().catch(() => {});
    const dispatcher = new ProxyAgent(slot.proxyUrl);
    const healthy = await probeLane({ id: slot.id, proxyName, dispatcher }, 'sticky');
    if (!healthy) {
      await dispatcher.close().catch(() => {});
      slot.proxyName = undefined;
      slot.dispatcher = undefined;
      slot.healthyScopes = undefined;
      return undefined;
    }
    slot.proxyName = proxyName;
    slot.dispatcher = dispatcher;
    slot.unhealthy = false;
    slot.healthyScopes = new Set(['sticky']);
    unhealthySessionNodes.delete(proxyName);
    return sessionSnapshot(slot);
  }

  async function refreshSessionLanes() {
    try {
      const nodes = await proxyCandidates();
      const occupied = new Set(sessionSlots
        .filter((slot) => slot.proxyName && !slot.unhealthy)
        .map((slot) => slot.proxyName));
      for (const slot of sessionSlots) {
        if (slot.proxyName && !slot.unhealthy) continue;
        const node = nodes.find((candidate) => {
          if (occupied.has(candidate)) return false;
          const bannedAt = unhealthySessionNodes.get(candidate);
          if (bannedAt === undefined) return true;
          return now() - bannedAt >= sourceProbeCacheMs;
        });
        if (!node) continue;
        const assigned = await assignSessionLane(slot.id, node);
        if (assigned) occupied.add(node);
      }
      safeEvent(onEvent, { state: 'session-refresh', lanes: sessionLanes().length });
      return sessionLanes();
    } catch (error) {
      safeEvent(onEvent, { state: 'session-degraded', lanes: sessionLanes().length, code: error.code || 'MIHOMO_CONTROLLER_ERROR' });
      return sessionLanes();
    }
  }

  async function markSessionLaneUnhealthy(laneId) {
    const slot = sessionSlotFor(laneId);
    if (!slot) return false;
    if (slot.proxyName) unhealthySessionNodes.set(slot.proxyName, now());
    slot.unhealthy = true;
    slot.healthyScopes = undefined;
    await slot.dispatcher?.close().catch(() => {});
    slot.proxyName = undefined;
    slot.dispatcher = undefined;
    safeEvent(onEvent, { state: 'session-unhealthy', lane: slot.id });
    return true;
  }

  async function releaseSessionLane(laneId) {
    const slot = sessionSlotFor(laneId);
    if (!slot) return false;
    await slot.dispatcher?.close().catch(() => {});
    slot.proxyName = undefined;
    slot.dispatcher = undefined;
    slot.unhealthy = false;
    slot.healthyScopes = undefined;
    return true;
  }

  return {
    refresh: refreshPublicLanes,
    refreshPublicLanes,
    refreshSessionLanes,
    verifyGroups,
    sessionLanes,
    assignSessionLane,
    releaseSessionLane,
    markSessionLaneUnhealthy,
    lanes: () => lastLanes,
    ready: () => Promise.resolve(lastLanes),
    stats: () => ({ degraded, lanes: lastLanes.length, sessionLanes: sessionLanes().length }),
  };
}
