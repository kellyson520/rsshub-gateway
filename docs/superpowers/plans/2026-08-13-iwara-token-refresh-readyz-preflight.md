# iwara 令牌刷新与 readyz 出口预检

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 补齐 iwara 凭证生命周期（refresh token → access token 刷新与缓存、会话请求使用 access token），并让 `/readyz` 预检 mihomo lane 组，防止 `SESSION_LANE_*` 部署缺口复发（上轮生产故障根因）。

**背景：** `iwaraToken()` 目前把 `sources.json` 里的 refresh token 直接当 Bearer 用（iwara API 部分端点接受，但非规范做法，且无刷新/轮换逻辑）。`/readyz` 只查 RSSHub 与熔断，mihomo 组缺失时一无所知（上轮 SESSION_LANE 缺口即如此）。

- [x] Step 1: `src/adapters/iwara.js` 新增 `refreshIwaraAccessToken(fetchJson, refreshToken)`——POST `api.iwara.tv/auth/refresh`，`{refreshToken}`，解析 `{token, refreshToken, expires}`（expires 兼容秒级 TTL 与 epoch ms），失败抛 typed error
- [x] Step 2: `src/server.js` `iwaraToken()` 改造：JWT `type=access_token` 直接使用；否则经 fetchd 兑换 access token（内存缓存+轮换 refresh token，成功按 expires 过期，失败回退原始 token 并 15 分钟重试）
- [x] Step 3: `resolveSessionTransport` 对 iwara 用解析后的 access token 作为请求头凭证（指纹仍基于配置凭证，保持亲和稳定）
- [x] Step 4: `src/mihomo-egress.js` 新增 `verifyGroups()`——控制器 `GET /proxies`，校验 `EGRESS_LANE_01..12` 与 `SESSION_LANE_01..12` 存在，返回 `{ready, missing}`
- [x] Step 5: `/readyz` 接入 egress 预检（存在 egressAdapter 时），`ready = rsshub && egress.ready`，payload 含 `egress:{ready,lanes,sessionLanes,missingGroups}`
- [x] Step 6: 测试：适配器刷新函数、server token 缓存/回退/会话凭证、verifyGroups、readyz 预检；全量 + 非 root 双验证
- [ ] Step 7: README 更新（iwara 令牌刷新、readyz 语义）；生产部署验证；推送 GitHub 且 CI 绿
