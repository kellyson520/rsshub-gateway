# 网关多出口智能出口池 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建立可被所有站点模块复用的 Mihomo 多出口智能出口池，每个健康代理节点最低 3 路并发。

**Architecture:** Mihomo 提供本地 Controller 和固定 listener；`mihomo-egress` 负责节点发现与绑定；`egress-pool` 负责无副作用的租约和自适应并发；`upstream` 统一注入池化 dispatcher。E-Hentai 预热只消费统一 upstream，不保存站点专属出口逻辑。

**Tech Stack:** Node.js 24、node:test、Undici `ProxyAgent`、Mihomo Meta Controller API、Docker Compose。

---

### Task 1: 出口池领域模型

**Files:**
- Create: `src/egress-pool.js`
- Create: `test/egress-pool.test.js`

- [ ] **Step 1: 写失败测试**

测试 `createEgressPool({ lanes })`：两个 lane 各自初始容量为 3；前 6 个租约能立即取得，第 7 个必须等待释放；成功达到连续阈值后单 lane 容量从 3 升到 4；429 后降回不低于 3；异常释放也必须唤醒等待者。

- [ ] **Step 2: 运行红灯测试**

Run: `node --test test/egress-pool.test.js`

Expected: `ERR_MODULE_NOT_FOUND`，因为 `src/egress-pool.js` 尚不存在。

- [ ] **Step 3: 实现最小领域模型**

导出 `createEgressPool`。lane 输入为 `{ id, proxyName, proxyUrl, dispatcher }`；租约返回 `{ laneId, proxyName, dispatcher, release(result) }`。池维护每 lane 的 `active`、`targetConcurrency`、`successStreak`、`cooldownUntil`，使用最少活动数优先。`release` 对 2xx 增加成功 streak，对 408/425/429/5xx/超时降低目标，目标范围固定在 3..6。

- [ ] **Step 4: 运行领域测试**

Run: `node --test test/egress-pool.test.js`

Expected: all pool tests pass。

### Task 2: Mihomo Controller 适配器

**Files:**
- Create: `src/mihomo-egress.js`
- Create: `test/mihomo-egress.test.js`

- [ ] **Step 1: 写失败测试**

用 `fetchImpl` 返回 Clash API 形状的 `/proxies/PUBLIC` 数据，测试适配器过滤 `DIRECT`、组节点和 `alive:false` 节点；为最多 12 个健康节点调用 `PUT /proxies/EGRESS_LANE_N`，并返回 `http://127.0.0.1:790N` listener 映射。

- [ ] **Step 2: 运行红灯测试**

Run: `node --test test/mihomo-egress.test.js`

Expected: `ERR_MODULE_NOT_FOUND`。

- [ ] **Step 3: 实现 Controller 客户端**

导出 `createMihomoEgressAdapter({ controllerUrl, listenerBaseUrl, laneCount, fetchImpl })`，实现 `refresh()`、`lanes()` 和 `ready()`。Controller 请求只携带本地 API 地址；日志只输出 lane id 和节点 hash。Controller 不可用时保留上一轮 lane 快照。

- [ ] **Step 4: 运行适配器测试**

Run: `node --test test/mihomo-egress.test.js`

Expected: all adapter tests pass。

### Task 3: Upstream 租约接入

**Files:**
- Modify: `src/upstream.js`
- Modify: `test/upstream.test.js`

- [ ] **Step 1: 写失败测试**

注入一个包含两个 dispatcher 的假出口池；连续两次 E-Hentai 请求必须分别使用池中的 listener；X 请求使用默认 sticky dispatcher；RSSHub 请求不调用池。增加响应体读取结束后才释放租约的断言。

- [ ] **Step 2: 运行红灯测试**

Run: `node --test test/upstream.test.js`

Expected: 新增断言失败，因为当前 upstream 只有单一 `ProxyAgent`。

- [ ] **Step 3: 接入池化 dispatcher**

`createUpstreamClient` 接受可选 `egressPool`。public 请求按策略 `await egressPool.acquire({ host })`，每次 retry 重新租约；返回响应时包装 Web `ReadableStream`，在 body close/cancel/error 时调用 `release`。sticky 和 RSSHub 保持现有路径，池不可用时使用 7890 降级。

- [ ] **Step 4: 运行 upstream 测试**

Run: `node --test test/upstream.test.js`

Expected: all upstream tests pass。

### Task 4: 预热队列接入动态容量

**Files:**
- Modify: `src/media-prefetch.js`
- Modify: `src/server.js`
- Modify: `test/media-prefetch.test.js`
- Modify: `test/server.test.js`

- [ ] **Step 1: 写失败测试**

为预热队列注入 `minimumConcurrencyProvider`，当出口池有 4 个 lane 时，队列的有效最低并发为 12；单一 H@H 域名可以提交到池中，由池按出口车道限制实际请求；池退避不能把单 lane 目标降到 3 以下。

- [ ] **Step 2: 运行红灯测试**

Run: `node --test test/media-prefetch.test.js test/server.test.js`

Expected: 新增动态容量断言失败。

- [ ] **Step 3: 接入池容量而不复制代理逻辑**

预热队列增加 `minimumConcurrencyProvider` 和 `capacityProvider`；生产默认全局最大 48、每源队列上限 48，实际网络并发由 egress pool 的 lane 目标控制。保留持久化、退避、缓存和每次任务去重。

- [ ] **Step 4: 运行预热和服务器测试**

Run: `node --test test/media-prefetch.test.js test/server.test.js`

Expected: all targeted tests pass。

### Task 5: Mihomo 基础设施配置

**Files:**
- Modify: `/opt/1panel/apps/rsshub-gateway/config/mihomo/config.yaml`
- Modify: `/opt/1panel/apps/rsshub-gateway/docker-compose.yml`
- Modify: `/home/ubuntu/.config/rsshub-gateway/docker-compose.yml`

- [ ] **Step 1: 增加本地 Controller、12 个 lane group 和 listener**

加入 `external-controller: 127.0.0.1:9090`；为 `EGRESS_LANE_01..12` 增加 `select + use: subscription` 组；为每组增加 `mixed` listener，监听 `127.0.0.1:7901..7912`，并通过 `proxy: EGRESS_LANE_N` 固定出站。不会暴露新端口到宿主机。

- [ ] **Step 2: 配置校验**

Run: `sudo -n docker exec rsshub-gateway mihomo -t -d /root/.config/mihomo`

Expected: `configuration file ... test is successful`。

- [ ] **Step 3: 更新环境变量**

设置 `EGRESS_CONTROLLER_URL=http://127.0.0.1:9090`、`EGRESS_LANE_COUNT=12`、`EGRESS_MIN_CONCURRENCY_PER_LANE=3`、`EGRESS_MAX_CONCURRENCY_PER_LANE=6`、`EGRESS_MAX_TOTAL_CONCURRENCY=48`；E-Hentai 预热初始容量改为池的可用容量。

### Task 6: 服务器组装、部署和验收

**Files:**
- Modify: `src/server.js`
- Modify: `test/server.test.js`
- Modify: `README.md`

- [ ] **Step 1: 写失败测试**

测试 `createGatewayServer` 将同一个 `egressPool` 传给 upstream 和媒体预热；测试 readyz 在 Controller 暂时不可用时仍报告 RSSHub 状态，同时记录公共出口降级。

- [ ] **Step 2: 完成组装**

启动时创建 Mihomo 适配器和出口池，首次刷新后供 upstream 使用；后台每 60 秒刷新节点并重新绑定 lane，旧租约不被中断。README 记录所有站点模块只调用 `fetchExternal`，不直接创建代理。

- [ ] **Step 3: 全量测试和构建**

Run: `npm test && sudo -n docker compose config --quiet && sudo -n docker compose up -d --build gateway`

Expected: Node tests all pass and gateway container remains running。

- [ ] **Step 4: 线上验收**

检查 `/readyz`、Mihomo 配置、运行中的 lane 数量和无敏感日志；请求 143 页 E-Hentai 画廊，确认 `143/143`、143 media、0 warning、首尾媒体 200、无 prefetch failed。

- [ ] **Step 5: 提交**

```bash
git add src/egress-pool.js src/mihomo-egress.js src/upstream.js src/media-prefetch.js src/server.js test docs README.md docker-compose.yml
git commit -m "feat: add adaptive multi-egress pool foundation"
```
