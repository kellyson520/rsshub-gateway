# RSSHub-Gateway 功能增强、服务稳定性、性能提速专项落地计划

本方案针对 RSSHub-Gateway 在 Docker 部署、New-API 联动、RSS 订阅高频使用场景下的功能扩展、稳定性加固及性能提速进行系统化设计与落地推进。

---

## 一、核心目标与指标要求

1. **功能完备度**：
   - 补齐反爬适配、自适应调度、媒体防盗链短时令牌与会话作废管理；
   - 支持 Feed 规则过滤（关键词/作者/广告黑名单）。
2. **服务稳定性 (SLA 99.9%)**：
   - 结构化 JSON 健康探针（健康率、代理存活、Sidecar 状态、队列深度）；
   - 自动自愈（代理通道轮换、进程崩溃降级、磁盘高水位 LRU 回收）；
   - 全链路 `Request-ID` 串联与安全沙箱。
3. **性能提速**：
   - RSS 响应 ≤ 300ms，出站前后台带宽调度（后台预取 ≤ 30% 抢占）；
   - Brotli 深度压缩、视频分片预加载与 Range 完美适配。

---

## 二、P0 核心刚需功能规划与架构设计

### 1. 自适应预取调度引擎 (`src/feed-prefetch.js`)
- **动态退避算法**：
  - 响应 HTTP 200：保持基础预取周期（默认 15 分钟）；
  - 响应 HTTP 429 / 5xx：触发指数退避（`interval * 2^retries`，上限 4 小时），避免持续冲击源站引发 IP 封禁；
  - 连续失败超过 3 次标记 `degraded` 并上报 metrics，等待冷却期后自动恢复。
- **管理接口支持**：
  - `POST /_gateway/prefetch/refresh`：强制对单 Feed 或全部 Feed 触发异步刷新；
  - `POST /_gateway/prefetch/toggle`：动态启用/暂停指定 Feed 的预取调度。

### 2. 媒体防盗链短时 Token 与会话安全 (`src/download-session.js` & `src/signed-target.js`)
- **短时临时 Token**：支持签发 5~10 分钟超短有效期令牌（`shortLived` 模式），适配阅读器前台临时播放与防盗链转存；
- **会话手动撤销 (`POST /_gateway/revoke-session`)**：支持按 `sessionId` 或 `targetUrl` 一键作废下载会话，即时阻断未授权的流式传输。

### 3. Feed 内容过滤规则引擎 (`src/feed-transform.js`)
- **关键词黑名单 (`keywordBlacklist`)**：在解析 RSS XML 条目时过滤包含敏感词或推广内容的条目；
- **作者屏蔽 (`authorBlacklist`)**：剔除特定噪音发布者；
- **广告模式过滤 (`adFilters`)**：自动清理包含推广特征标签的条目。

---

## 三、实施排期与分步执行

| 阶段 | 模块 | 核心落地项 | 验证标准 |
|------|------|-----------|---------|
| **Task 1** | 预取引擎 | 自适应退避算法、单 Feed 刷新/启停管理 | 单元测试 & 模拟 429 验证退避周期 |
| **Task 2** | 会话安全 | 短时 Token 签发、`/_gateway/revoke-session` 撤销接口 | 令牌时效测试与作废后 403 阻断断言 |
| **Task 3** | 内容过滤 | Feed 关键词/作者/广告黑名单过滤引擎 | RSS XML 转换前后条目过滤断言 |
| **Task 4** | 稳定性与性能 | 结构化健康检查、出站调度与全量回归测试 | 635+ 单元与集成测试 100% PASS |
