# readyz lane 就绪语义与 egress 仪表

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复 readyz 在重启后 ~40s 内（lane 探测未完成、实际流量不可达）仍返回 200 的语义缺口；补齐 egress 仪表。

- [x] Step 1: `/readyz` 就绪条件改为 `groups ready && lanes > 0`（`egress.ready` 同步反映合并结果）；无 adapter 时保持原语义
- [x] Step 2: `/_gateway/metrics` 新增 `egress_session_lanes` 与 `egress_degraded`（0/1）仪表
- [x] Step 3: 测试：新增「组存在但 lane 未填充 → 503」用例，metrics 断言两个新仪表；285/285（root + 非 root）
- [x] Step 4: 生产验证：重启后 6s readyz 503（lanes 0），~40s 后 200（12+12 lanes）；仪表 `egress_lanes 12 / egress_session_lanes 12 / egress_degraded 0`；feed 200
