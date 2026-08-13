# 出口探测加固与 CI（C 余项续）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复 sticky 出口探测的可靠性缺口，并补上仓库缺失的 CI。

**背景（生产实测）：** `/_gateway/infra` 显示 12 条公共 lane 的 `healthyScopes` 全部只有 `public`，`adapter.sessionLanes=0`；而 `config/sources.json` 已配置 `iwara.token`。根因在 `src/mihomo-egress.js` 的 `probeLane`：每个 scope 只探测 `targets[0]`（sticky 默认第一个是 `https://www.iwara.tv/`），且只发 HEAD；iwara/x 对 HEAD 常返回 403/405 → sticky 探测全挂 → 会话 lane 永远无法分配，会话级出口（带凭证的 iwara/x）实际不可用。

- [x] Step 1: `probeLane` 加固——多目标任一成功即通过；HEAD 遇 405/501/403 时 GET 兜底（2xx/3xx 算成功并立即取消 body）
- [x] Step 2: 更新 `test/mihomo-egress.test.js`（多目标任一通过、HEAD→GET 兜底、仍失败保持排除）
- [x] Step 3: 全量测试通过（264+ 基线）
- [x] Step 4: README 更新探测语义
- [x] Step 5: 新增 `.github/workflows/ci.yml`（node 24，npm ci + npm test）
- [ ] Step 6: 生产同步重建；验证 infra healthyScopes/sessionLanes 与 GitHub Actions 首次运行

**注：** `allowSessionRetry`（upstream.js）需要调用方先解析好 `sessionDispatcher/sessionCredentials` 才有效，而文档/媒体链路已走 `fetchGatewayTarget` 的认证挑战升级（server.js `authenticationChallenge`），故不强行全局接线。
