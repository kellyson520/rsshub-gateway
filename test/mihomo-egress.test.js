import test from 'node:test';
import assert from 'node:assert/strict';
import { createMihomoEgressAdapter } from '../src/mihomo-egress.js';

function response(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

test('discovers healthy public proxy nodes and binds them to fixed listeners', async () => {
  const requests = [];
  const adapter = createMihomoEgressAdapter({
    controllerUrl: 'http://127.0.0.1:9090',
    listenerBaseUrl: 'http://127.0.0.1',
    laneCount: 3,
    fetchImpl: async (url, options = {}) => {
      requests.push({ url: String(url), options });
      if (options.method === 'PUT') return response({});
      return response({
        proxies: {
          PUBLIC: { type: 'LoadBalance', all: ['node-a', 'DIRECT', 'node-b', 'node-dead', 'EGRESS_LANE_01'] },
          'node-a': { type: 'Shadowsocks', alive: true },
          'node-b': { type: 'Vmess', alive: true },
          'node-dead': { type: 'Shadowsocks', alive: false },
          DIRECT: { type: 'Direct', alive: true },
          EGRESS_LANE_01: { type: 'Selector', alive: true },
        },
      });
    },
  });

  const lanes = await adapter.refresh();

  assert.deepEqual(lanes.map((lane) => ({ id: lane.id, proxyName: lane.proxyName, proxyUrl: lane.proxyUrl })), [
    { id: 'lane-01', proxyName: 'node-a', proxyUrl: 'http://127.0.0.1:7901' },
    { id: 'lane-02', proxyName: 'node-b', proxyUrl: 'http://127.0.0.1:7902' },
  ]);
  assert.deepEqual(requests.filter((request) => request.options.method === 'PUT').map((request) => ({
    url: request.url,
    body: JSON.parse(request.options.body),
  })), [
    { url: 'http://127.0.0.1:9090/proxies/EGRESS_LANE_01', body: { name: 'node-a' } },
    { url: 'http://127.0.0.1:9090/proxies/EGRESS_LANE_02', body: { name: 'node-b' } },
  ]);
});

test('retains the last usable lane snapshot when Controller refresh fails', async () => {
  let calls = 0;
  const adapter = createMihomoEgressAdapter({
    controllerUrl: 'http://127.0.0.1:9090',
    laneCount: 1,
    fetchImpl: async (_url, options = {}) => {
      if (options.method === 'PUT') return response({});
      calls += 1;
      if (calls > 1) throw new Error('controller unavailable');
      return response({ proxies: {
        PUBLIC: { type: 'LoadBalance', all: ['node-a'] },
        'node-a': { type: 'Shadowsocks', alive: true },
      } });
    },
  });

  const first = await adapter.refresh();
  const second = await adapter.refresh();

  assert.equal(second, first);
  assert.equal(adapter.stats().degraded, true);
  assert.equal(adapter.stats().lanes, 1);
});

test('accepts Mihomo lane binding responses with no content', async () => {
  const adapter = createMihomoEgressAdapter({
    controllerUrl: 'http://127.0.0.1:9090',
    laneCount: 1,
    fetchImpl: async (_url, options = {}) => {
      if (options.method === 'PUT') return new Response(null, { status: 204 });
      return response({ proxies: {
        PUBLIC: { type: 'LoadBalance', all: ['node-a'] },
        'node-a': { type: 'Shadowsocks', alive: true },
      } });
    },
  });

  const lanes = await adapter.refresh();

  assert.equal(lanes.length, 1);
  assert.equal(adapter.stats().degraded, false);
});

test('discovers provider nodes when the proxy group omits inline node details', async () => {
  const adapter = createMihomoEgressAdapter({
    controllerUrl: 'http://127.0.0.1:9090',
    laneCount: 1,
    fetchImpl: async (url, options = {}) => {
      if (options.method === 'PUT') return new Response(null, { status: 204 });
      if (String(url).endsWith('/providers/proxies')) {
        return response({ providers: {
          subscription: { proxies: [
            { name: 'node-a', type: 'Hysteria2', alive: true },
            { name: 'node-dead', type: 'Vless', alive: false },
          ] },
        } });
      }
      return response({ proxies: {
        PUBLIC: { type: 'LoadBalance', all: ['node-a', 'node-dead'] },
      } });
    },
  });

  const lanes = await adapter.refresh();

  assert.deepEqual(lanes.map((lane) => lane.proxyName), ['node-a']);
  assert.equal(adapter.stats().degraded, false);
});

test('skips subscription metadata entries that are reported as healthy proxies', async () => {
  const requests = [];
  const adapter = createMihomoEgressAdapter({
    controllerUrl: 'http://127.0.0.1:9090',
    laneCount: 2,
    fetchImpl: async (url, options = {}) => {
      requests.push({ url: String(url), options });
      if (options.method === 'PUT') return new Response(null, { status: 204 });
      if (String(url).endsWith('/providers/proxies')) {
        return response({ providers: { subscription: { proxies: [
          { name: '剩余流量：491.66 GB', type: 'Hysteria2', alive: true },
          { name: '---连不上的时候请更新订阅---', type: 'Hysteria2', alive: true },
          { name: 'node-a', type: 'Hysteria2', alive: true },
          { name: 'node-b', type: 'Vless', alive: true },
        ] } } });
      }
      return response({ proxies: { PUBLIC: { type: 'LoadBalance', all: ['剩余流量：491.66 GB', '---连不上的时候请更新订阅---', 'node-a', 'node-b'] } } });
    },
  });

  const lanes = await adapter.refresh();

  assert.deepEqual(lanes.map((lane) => lane.proxyName), ['node-a', 'node-b']);
  assert.equal(requests.filter((request) => request.options.method === 'PUT').length, 2);
});

test('replaces a lane that fails the E-Hentai source probe', async () => {
  const bindings = [];
  let probes = 0;
  const adapter = createMihomoEgressAdapter({
    controllerUrl: 'http://127.0.0.1:9090',
    laneCount: 2,
    probeUrl: 'https://e-hentai.org/',
    probeFetchImpl: async () => {
      probes += 1;
      return new Response(null, { status: probes === 1 ? 451 : 200 });
    },
    fetchImpl: async (url, options = {}) => {
      if (options.method === 'PUT') {
        bindings.push({ url: String(url), name: JSON.parse(options.body).name });
        return new Response(null, { status: 204 });
      }
      return response({ proxies: {
        PUBLIC: { type: 'LoadBalance', all: ['node-blocked', 'node-a', 'node-b'] },
        'node-blocked': { type: 'Hysteria2', alive: true },
        'node-a': { type: 'Hysteria2', alive: true },
        'node-b': { type: 'Vless', alive: true },
      } });
    },
  });

  const lanes = await adapter.refresh();

  assert.deepEqual(lanes.map((lane) => lane.proxyName).sort(), ['node-a', 'node-b']);
  assert.deepEqual(bindings.map((binding) => binding.name), ['node-blocked', 'node-a', 'node-b']);
  assert.equal(probes, 3);
});

test('uses source-probe-healthy fallback nodes when generic health is unavailable', async () => {
  const adapter = createMihomoEgressAdapter({
    controllerUrl: 'http://127.0.0.1:9090',
    laneCount: 2,
    probeUrl: 'https://e-hentai.org/',
    probeFetchImpl: async () => new Response(null, { status: 200 }),
    fetchImpl: async (_url, options = {}) => {
      if (options.method === 'PUT') return new Response(null, { status: 204 });
      return response({ proxies: {
        PUBLIC: { type: 'LoadBalance', all: ['node-primary', 'node-fallback'] },
        'node-primary': { type: 'Hysteria2', alive: true },
        'node-fallback': { type: 'Vless', alive: false },
      } });
    },
  });

  const lanes = await adapter.refresh();

  assert.deepEqual(lanes.map((lane) => lane.proxyName), ['node-primary', 'node-fallback']);
});

test('probes candidate lanes concurrently within each available batch', async () => {
  let active = 0;
  let maxActive = 0;
  const adapter = createMihomoEgressAdapter({
    controllerUrl: 'http://127.0.0.1:9090',
    laneCount: 2,
    probeUrl: 'https://e-hentai.org/',
    probeFetchImpl: async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active -= 1;
      return new Response(null, { status: 200 });
    },
    fetchImpl: async (_url, options = {}) => {
      if (options.method === 'PUT') return new Response(null, { status: 204 });
      return response({ proxies: {
        PUBLIC: { type: 'LoadBalance', all: ['node-a', 'node-b'] },
        'node-a': { type: 'Hysteria2', alive: true },
        'node-b': { type: 'Vless', alive: true },
      } });
    },
  });

  await adapter.refresh();

  assert.equal(maxActive, 2);
});

test('keeps dedicated session lanes across public refreshes', async () => {
  const requests = [];
  const adapter = createMihomoEgressAdapter({
    controllerUrl: 'http://127.0.0.1:9090',
    listenerBaseUrl: 'http://127.0.0.1',
    laneCount: 2,
    sessionLaneCount: 2,
    sessionListenerBasePort: 7921,
    fetchImpl: async (url, options = {}) => {
      requests.push({ url: String(url), options });
      if (options.method === 'PUT') return new Response(null, { status: 204 });
      return response({ proxies: {
        PUBLIC: { type: 'LoadBalance', all: ['node-a', 'node-b', 'node-c'] },
        'node-a': { type: 'Hysteria2', alive: true },
        'node-b': { type: 'Vless', alive: true },
        'node-c': { type: 'Shadowsocks', alive: true },
      } });
    },
  });

  const sessions = await adapter.refreshSessionLanes();
  assert.deepEqual(sessions.map((lane) => ({ id: lane.id, proxyName: lane.proxyName, proxyUrl: lane.proxyUrl })), [
    { id: 'session-lane-01', proxyName: 'node-a', proxyUrl: 'http://127.0.0.1:7921' },
    { id: 'session-lane-02', proxyName: 'node-b', proxyUrl: 'http://127.0.0.1:7922' },
  ]);

  const sessionBindings = () => requests.filter((request) => request.options.method === 'PUT' && /SESSION_LANE_/.test(request.url));
  assert.deepEqual(sessionBindings().map((request) => ({ url: request.url, body: JSON.parse(request.options.body) })), [
    { url: 'http://127.0.0.1:9090/proxies/SESSION_LANE_01', body: { name: 'node-a' } },
    { url: 'http://127.0.0.1:9090/proxies/SESSION_LANE_02', body: { name: 'node-b' } },
  ]);

  await adapter.refreshPublicLanes();
  await adapter.refreshSessionLanes();
  assert.equal(sessionBindings().length, 2);
});

test('replaces a session lane only after it is marked unhealthy', async () => {
  const requests = [];
  const adapter = createMihomoEgressAdapter({
    controllerUrl: 'http://127.0.0.1:9090',
    sessionLaneCount: 2,
    sessionListenerBasePort: 7921,
    fetchImpl: async (url, options = {}) => {
      requests.push({ url: String(url), options });
      if (options.method === 'PUT') return new Response(null, { status: 204 });
      return response({ proxies: {
        PUBLIC: { type: 'LoadBalance', all: ['node-a', 'node-b', 'node-c'] },
        'node-a': { type: 'Hysteria2', alive: true },
        'node-b': { type: 'Vless', alive: true },
        'node-c': { type: 'Shadowsocks', alive: true },
      } });
    },
  });

  const first = await adapter.refreshSessionLanes();
  await adapter.refreshSessionLanes();
  assert.equal(requests.filter((request) => request.options.method === 'PUT').length, 2);

  await adapter.markSessionLaneUnhealthy(first[0].id);
  const second = await adapter.refreshSessionLanes();
  assert.notEqual(second.find((lane) => lane.id === first[0].id).proxyName, first[0].proxyName);
  assert.equal(requests.filter((request) => request.options.method === 'PUT').length, 3);
});
