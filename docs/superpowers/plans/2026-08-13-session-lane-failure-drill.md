# 会话 lane 故障演练

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用端到端自动化演练证明会话 lane 封禁后的完整恢复链：blocked 状态触发 site tracker → `markSessionLaneUnhealthy` + 亲和记录迁移 → 下一次请求自动切到备用 lane 并成功。

**Architecture:** 现有机制已分段覆盖（mihomo-egress 槽位替换、session-affinity 迁移、recordSessionFailure 触发），但缺少把三段串起来的集成测试。演练测试使用真实 `sessionAffinity`（临时文件）+ 双 lane 假 egressAdapter + 假 `fetchExternal`（首个使用的 lane 返回 403，备用 lane 返回 200），走真实 `resolveSessionTransport` 链路。

- [x] Step 1: `test/server.test.js` 新增演练用例：请求 1-2 经 lane A 均 403（阈值 2 触发）→ 断言 `markSessionLaneUnhealthy(laneA)` 与亲和迁移；请求 3 自动走 lane B 返回 200
- [x] Step 2: 全量测试 289/289（root + 非 root 双验证）
- [x] Step 3: 生产冒烟：`/_gateway/infra` 会话 lane 健康、session 请求正常；记录手动演练步骤（mihomo 控制器指向坏节点 → 观察替换）

## 结果
- 端到端演练测试通过：两次 403（阈值 2）→ `markSessionLaneUnhealthy` + 亲和迁移 → 第三次请求自动切备用 lane 返回 200
- 生产冒烟（真实 iwara 会话 lane）：12 个会话 lane 健康；`/ _gateway/item` session token 请求 6 次全 200；亲和记录稳定在 `session-lane-01`；间歇性 403（2 次/60s 窗口内）未误触发轮换（阈值 3，符合设计）
- 未能强制真实上游连续 403（iwara 恢复放行），确定性演练由 CI 测试覆盖；生产手动演练步骤：将 `SESSION_LANE_XX` selector 指向被封节点 → 连续 3 次 403 → 观察 `session_lane_site_blocked` 日志 + 亲和迁移 + 槽位替换
