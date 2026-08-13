# egress 池按延迟加权路由

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在保持「最少负载 + 自适应并发」的基础上，让 egress 池在负载持平时优先把请求路由到延迟更低的 lane，提升多出口整体吞吐。

**Architecture:** 每个 lane 维护成功请求时长的 EWMA（α=0.2，单样本钳制 10s，跨 `setLanes` 刷新保留）。`chooseLane` 中：存在未采样 lane 时保持轮询（探索阶段）；全部有样本后，在负载相同的候选里选 EWMA 最低的子集，子集内部仍轮询（相等延迟公平）。galleryShard 分片提示优先级不变。

- [x] Step 1: `test/egress-pool.test.js` 新增用例：tied 时优先低延迟 lane、stats 暴露 `samples`/`ewmaMs`、刷新后保留、极端时长钳制、EWMA 平滑（100→160）
- [x] Step 2: `src/egress-pool.js` 实现：`createState` 增 `ewmaMs/samples`、`makeLease` 记 `startedAt`、`release` 成功时更新 EWMA、`chooseLane` tied 分支按 EWMA 选子集、`stats` 暴露
- [x] Step 3: 全量测试（root + 非 root 双验证）
- [x] Step 4: 生产验证：`/_gateway/infra` egress lanes 出现 `ewmaMs`；提交推送 CI 绿

## 结果
- 生产验证：12 lanes 健康；`lane-01` 在 ranking 请求后 `ewmaMs: 1492, samples: 1`（其余 lane 处于探索阶段 samples 0，符合设计）
- 压力验证：全量测试 10 连跑无失败
