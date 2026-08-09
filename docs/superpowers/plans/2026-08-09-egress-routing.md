# 网关分流与 E-Hentai 12 路预热 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建立公共/固定出口领域策略，并把 E-Hentai 媒体预热上限提升到 12 路。

**Architecture:** `src/egress-policy.js` 是无副作用领域服务；`src/upstream.js` 将策略作为请求上下文和诊断边界；Mihomo 配置把 E-Hentai/H@H 映射到 `PUBLIC` 负载组，把登录站点和未知目标映射到 `STICKY` 组；`src/media-prefetch.js` 只负责公共 E-Hentai 图片的自适应并发。

**Tech Stack:** Node.js 24、node:test、Undici、Mihomo Meta、Docker Compose。

---

### Task 1: 领域策略测试与实现

**Files:**
- Create: `src/egress-policy.js`
- Create: `test/egress-policy.test.js`

- [ ] **Step 1: 写失败测试**

测试 `public` 规则覆盖 E-Hentai toplist/gallery/image、ehgt 和 hath；测试 `sticky` 覆盖 ExHentai、X、Instagram、Iwara、Telegram、未知 HTTPS 目标。

- [ ] **Step 2: 运行测试确认缺少模块而失败**

Run: `node --test test/egress-policy.test.js`

Expected: `ERR_MODULE_NOT_FOUND`。

- [ ] **Step 3: 实现纯领域函数**

导出 `EGRESS_POLICIES`、`egressPolicyForUrl(value)` 和 `isPublicEgressTarget(value)`。只读取 URL，不读取环境变量、不创建网络连接；默认策略为 `sticky`。

- [ ] **Step 4: 运行领域测试**

Run: `node --test test/egress-policy.test.js`

Expected: all policy tests pass。

### Task 2: 12 路预热与应用层策略接入

**Files:**
- Modify: `src/media-prefetch.js`
- Modify: `src/server.js`
- Modify: `src/upstream.js`
- Modify: `test/media-prefetch.test.js`
- Modify: `test/upstream.test.js`

- [ ] **Step 1: 先增加 12 路失败断言**

将调度器测试的 `maxConcurrency` 设置为 12，并断言成功任务的最大活动数不超过 12；增加 Upstream 请求的策略诊断回调断言，E-Hentai 图片为 `public`、X 为 `sticky`。

- [ ] **Step 2: 将调度器绝对上限从 6 扩展到 12**

保留自适应升降、每 origin 2 路、退避和持久化，仅将默认值改为初始 6、最低 3、最高 12。所有已有缓存与 Range 行为不变。

- [ ] **Step 3: 接入领域策略**

在 `createUpstreamClient` 中使用 `egressPolicyForUrl` 生成 `policy` 字段；调用方可通过 `onRequestPolicy` 观察 `{host, policy}`，日志不得包含完整 URL、Token 或 Cookie。网络请求继续由 Mihomo 基础设施执行。

- [ ] **Step 4: 运行完整 Node 测试**

Run: `npm test`

Expected: zero failures。

### Task 3: Mihomo 基础设施分流

**Files:**
- Modify: `/opt/1panel/apps/rsshub-gateway/config/mihomo/config.yaml`
- Modify: `/home/ubuntu/.config/rsshub-gateway/docker-compose.yml`

- [ ] **Step 1: 增加 `PUBLIC` 和 `STICKY` 组**

`PUBLIC` 使用 `load-balance` + `round-robin` + 60 秒健康检查；`STICKY` 使用 `url-test` + 60 秒健康检查。规则顺序为 E-Hentai/H@H 公共域、ExHentai/登录域固定、最后未知目标固定。

- [ ] **Step 2: 运行 Mihomo 配置检查**

Run: `sudo docker exec rsshub-gateway mihomo -t -d /root/.config/mihomo`

Expected: `configuration file ... test is successful`。

- [ ] **Step 3: 更新 Compose 参数**

设置 `EH_MEDIA_PREFETCH_CONCURRENCY=6`、`EH_MEDIA_PREFETCH_MIN_CONCURRENCY=3`、`EH_MEDIA_PREFETCH_MAX_CONCURRENCY=12`，每 origin 仍为 2。

### Task 4: 部署和验收

**Files:**
- Production image built from `/opt/1panel/apps/rsshub-gateway`

- [ ] **Step 1: 重建并检查 readiness**

Run: `sudo docker compose up -d --build gateway && curl --fail http://127.0.0.1:1300/readyz && sudo docker compose ps`

- [ ] **Step 2: 验证 E-Hentai 画廊**

用 fresh token 请求画廊，断言 HTTP 200、143/143、143 个图片节点、0 个警告；日志不得出现失败。

- [ ] **Step 3: 验证分流和预热**

检查 Mihomo 配置加载成功、预热日志到达 concurrency 12 或在限流时自动退避；验证首尾媒体 HTTP 200。

- [ ] **Step 4: 提交变更**

```bash
git add src/egress-policy.js src/media-prefetch.js src/server.js src/upstream.js test/egress-policy.test.js test/media-prefetch.test.js test/upstream.test.js docker-compose.yml
git commit -m "perf: split public and sticky gateway egress"
```
