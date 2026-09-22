export const DEFAULT_DIRECT_PROBE_TARGETS = Object.freeze([
  'https://cloudflare.com/cdn-cgi/trace',
  'https://api.github.com/zen',
  'https://www.google.com/generate_204',
]);

export function isTestEnvironment() {
  return process.env.NODE_ENV === 'test'
    || process.env.npm_lifecycle_event === 'test'
    || process.argv.some((a) => a.includes('test'));
}

export function createDirectLinkProber({
  fetchImpl = (isTestEnvironment() ? null : fetch),
  targets = DEFAULT_DIRECT_PROBE_TARGETS,
  timeoutMs = 3500,
  threshold = 0.5,
  cacheMs = 120_000,
  logger = { info() {}, warn() {}, error() {} },
  now = () => Date.now(),
} = {}) {
  let lastProbeTime = 0;
  let cachedResult = null;
  let inFlightProbe = null;

  async function probeSingle(target) {
    if (!fetchImpl) {
      return { target, ok: false, simulated: true, durationMs: 0 };
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const start = now();
    try {
      const response = await fetchImpl(target, {
        signal: controller.signal,
        headers: {
          'user-agent': 'rsshub-gateway-direct-probe/1.0',
        },
      });
      const durationMs = now() - start;
      const ok = response.ok || response.status === 204 || (response.status >= 200 && response.status < 400);
      return { target, ok, status: response.status, durationMs };
    } catch (error) {
      return { target, ok: false, error: error.message, durationMs: now() - start };
    } finally {
      clearTimeout(timer);
    }
  }

  async function doProbe() {
    const probeTargets = Array.isArray(targets) && targets.length ? targets : DEFAULT_DIRECT_PROBE_TARGETS;
    const details = await Promise.all(probeTargets.map((t) => probeSingle(t)));
    const successCount = details.filter((d) => d.ok).length;
    const failCount = details.length - successCount;
    const successRatio = details.length ? (successCount / details.length) : 0;
    const canDirectLink = successRatio >= threshold;

    const result = {
      canDirectLink,
      successCount,
      failCount,
      total: details.length,
      successRatio,
      timestamp: now(),
      details,
    };

    lastProbeTime = now();
    cachedResult = result;

    logger.info('direct_link_probed', {
      canDirectLink,
      successCount,
      total: details.length,
    });

    return result;
  }

  async function probe({ force = false } = {}) {
    if (!force && cachedResult && (now() - lastProbeTime < cacheMs)) {
      return cachedResult;
    }
    if (inFlightProbe) {
      return inFlightProbe;
    }
    inFlightProbe = doProbe().finally(() => {
      inFlightProbe = null;
    });
    return inFlightProbe;
  }

  function canDirectLink() {
    return cachedResult ? cachedResult.canDirectLink : false;
  }

  function status() {
    return cachedResult || { canDirectLink: false, pending: true };
  }

  return {
    probe,
    canDirectLink,
    status,
  };
}
