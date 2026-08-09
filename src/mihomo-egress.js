import { ProxyAgent } from 'undici';

const DEFAULT_CONTROLLER_URL = process.env.EGRESS_CONTROLLER_URL || 'http://127.0.0.1:9090';
const DEFAULT_LISTENER_BASE_URL = process.env.EGRESS_PROXY_BASE_URL || 'http://127.0.0.1';
const DEFAULT_LANE_COUNT = 12;
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

function laneId(index) {
  return `lane-${String(index + 1).padStart(2, '0')}`;
}

function laneGroup(index) {
  return `EGRESS_LANE_${String(index + 1).padStart(2, '0')}`;
}

function listenerUrl(baseUrl, index) {
  const target = new URL(baseUrl);
  target.port = String(7901 + index);
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
  fetchImpl = fetch,
  probeUrl,
  probeFetchImpl = fetch,
  probeTimeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
  probeCacheMs = DEFAULT_PROBE_CACHE_MS,
  now = () => Date.now(),
  onEvent,
} = {}) {
  const controller = String(controllerUrl).replace(/\/$/, '');
  const lanesLimit = Math.max(1, Number.parseInt(laneCount, 10) || DEFAULT_LANE_COUNT);
  const sourceProbeUrl = String(probeUrl || '').trim();
  const sourceProbeTimeoutMs = boundedPositiveInteger(probeTimeoutMs, DEFAULT_PROBE_TIMEOUT_MS, 30_000);
  const sourceProbeCacheMs = boundedPositiveInteger(probeCacheMs, DEFAULT_PROBE_CACHE_MS, 60 * 60_000);
  let lastLanes = [];
  let degraded = false;
  const probeResults = new Map();

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
        && !GROUP_TYPES.has(detail.type)
        && (includeGenericFailures || detail.alive !== false);
    });
  }

  async function probeLane(lane) {
    if (!sourceProbeUrl) return true;
    const cached = probeResults.get(lane.proxyName);
    if (cached && now() - cached.at < sourceProbeCacheMs) return cached.ok;
    let ok = false;
    try {
      const response = await probeFetchImpl(sourceProbeUrl, {
        method: 'HEAD',
        dispatcher: lane.dispatcher,
        redirect: 'manual',
        signal: AbortSignal.timeout(sourceProbeTimeoutMs),
      });
      ok = response.status >= 200 && response.status < 400;
      await response.body?.cancel();
    } catch {
      ok = false;
    }
    probeResults.set(lane.proxyName, { at: now(), ok });
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
    };
    if (await probeLane(lane)) return { lane, index };
    await lane.dispatcher.close().catch(() => {});
    return { lane: undefined, index };
  }

  async function refresh() {
    try {
      const payload = await request('/proxies');
      const publicNames = payload?.proxies?.[PUBLIC_GROUP]?.all || [];
      const needsProviderDetails = publicNames.some((name) => !payload?.proxies?.[name]);
      const providersPayload = needsProviderDetails ? await request('/providers/proxies') : undefined;
      const primaryNodes = healthyNodes(payload, providersPayload);
      const fallbackNodes = sourceProbeUrl
        ? healthyNodes(payload, providersPayload, { includeGenericFailures: true })
          .filter((node) => !primaryNodes.includes(node))
          .slice(0, lanesLimit)
        : [];
      const nodes = [...primaryNodes, ...fallbackNodes];
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
      if (sourceProbeUrl && !nextLanes.length && lastLanes.length) {
        degraded = true;
        safeEvent(onEvent, { state: 'degraded', lanes: lastLanes.length, code: 'EGRESS_SOURCE_PROBE_FAILED' });
        return lastLanes;
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

  return {
    refresh,
    lanes: () => lastLanes,
    ready: () => Promise.resolve(lastLanes),
    stats: () => ({ degraded, lanes: lastLanes.length }),
  };
}
