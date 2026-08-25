# server.js 选项解析拆分

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `createGatewayServer` 内联的 49 个选项解析（env/默认值/边界钳制）抽到独立模块 `src/options.js`，server.js 从 1210 行降到 ~997 行，选项解析可单独测试。

**Architecture:** 新增 `resolveGatewayOptions(options = {}, env = process.env)`，返回全部标量选项（logger/secret/sourceConfig、egress/eh/media/lease 各组、egressBlockedStatuses Set、imageVariantLimiter）；`createGatewayServer` 顶部解构。行为零变化：`env` 默认指向 `process.env`，读取时机与原来一致（调用时）。

- [x] Step 1: 提取 DEFAULT_* 常量块、主选项块（348-448、468、528-621）、lease 选项块（1057-1065、1080-1106）到 `src/options.js`；server.js 改为顶部解构并清理不再使用的导入
- [x] Step 2: 新增 `test/options.test.js`（4 用例）：默认值、options>env>默认优先级、边界钳制/回退、egressBlockedStatuses 数组与字符串解析
- [x] Step 3: 全量测试 293/293（root + 非 root 双验证）
- [x] Step 4: 生产部署新构建，验证启动、readyz 200、feed 200；提交推送后 CI 绿
