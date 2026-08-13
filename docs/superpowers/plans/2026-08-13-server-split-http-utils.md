# server.js 拆分（第一步：纯工具函数）实施记录

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 降低 `server.js`（1888 行单体）复杂度：先把无闭包依赖的纯 HTTP/缓存工具函数抽到独立模块，行为零变化。

**Architecture:** 新建 `src/http-utils.js`（读 secret/源配置、HTTP 写响应、缓存文档辅助、数值/探测目标解析、图片变体宽度、并发工具），`server.js` 改从该模块导入并删除本地定义；`DEFAULT_*` 配置常量保留在 `server.js`。

- [x] Step 1: 提取 `src/http-utils.js`（235 行，含 23 个导出函数）
- [x] Step 2: 新增 `test/http-utils.test.js`（9 个用例：boundedInteger、documentCacheKind、变体宽度、probeTargets、媒体文件名、读写限制、并发、writeJson）
- [x] Step 3: `server.js` 删除本地定义并导入（1888 → 1660 行）
- [x] Step 4: 修复提取误删的 `DEFAULT_*` 常量（egress/prefetch/media 共 21 个），全量 259/259 通过
- [x] Step 5: 生产同步与重建；`/healthz=ok`、12 lanes、feed 200

## 后续（C 项余下）

- [x] 路由处理器拆分：评估后以「路径分类指标（route_*）+ request-id + /_gateway/metrics」作为本轮观测增强（大路由闭包依赖面广，拆分留待后续）
- [x] request-id 与指标导出（Prometheus 文本格式，`/_gateway/metrics`，264/264 通过，生产验证）
