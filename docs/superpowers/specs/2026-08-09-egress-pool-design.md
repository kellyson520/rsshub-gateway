# 网关多出口智能出口池设计

## 目标

把 Mihomo 订阅中的代理节点抽象为网关底层出口池。公共站点请求按代理节点分配到固定本地 listener，每个健康出口至少支持 3 路并发，并根据成功率、429、5xx 和超时自动调整；固定登录请求继续复用单一 `STICKY` 出口。E-Hentai 预热和未来 X、Instagram、Iwara、Telegram 模块都通过同一个出口池，不再各自实现代理逻辑。

## 架构边界

- 领域/应用层 `src/egress-pool.js`：管理出口车道、租约、每车道并发目标、退避和公平调度；不依赖 Mihomo、HTTP 或 Docker。
- 基础设施层 `src/mihomo-egress.js`：调用 Mihomo Controller 查询 `PUBLIC` 组的健康节点，把节点绑定到 `EGRESS_LANE_01..12` 策略组，并返回本地 listener 地址。
- 应用层 `src/upstream.js`：根据 `egress-policy` 选择 `public` 或 `sticky`；公共请求租用出口车道，响应完成或失败后归还租约；固定请求使用现有 7890 代理。
- 预热上下文 `src/media-prefetch.js`：保持重试、持久化和按源公平性，但全局容量由出口池提供；单个 H@H 节点的限制由出口车道承担。
- 基础设施配置：Mihomo 只监听容器本地 9090 Controller 和 7901-7912 固定 listener，不把 Controller 或代理 listener 暴露给宿主机。

## 出口模型

每个 `EGRESS_LANE_N` 是一个可独立租用的出口车道：

- Mihomo `select` 组通过 Controller 绑定一个实际订阅节点；listener 固定映射到该组。
- 车道启动并发目标为 3，健康连续成功后逐步提升，默认上限为 6。
- 429、408、425、5xx、超时会立即降低目标并进入短暂冷却；最低目标仍为 3，连续失败的车道由 Controller 健康状态移出。
- 池以最少活动数优先、轮询作为平局策略分配租约。
- 最多使用 12 个健康节点；全局预热任务上限为 48，避免订阅节点数量异常时无限放大请求。
- 健康节点少于 12 个时只启用实际可用车道；没有可用车道时公共请求短暂回退到 7890 的 `PUBLIC` 组并记录降级事件。

固定出口不进入公共池，避免 Cookie、Token 和出口 IP 不一致。未知目标继续默认走 `STICKY`。

## 失败与恢复

- 租约释放必须覆盖正常响应、响应体读取结束、取消、网络异常和重试分支。
- Controller 查询失败不影响已有车道；只有全部车道失效时才进入公共降级模式。
- 节点绑定只记录脱敏的 lane id、节点 hash、状态和 HTTP 状态码，不记录订阅 URL、Cookie、Token 或完整目标 URL。
- Mihomo 订阅刷新后，Controller 下一次刷新周期重新发现并分配节点；正在使用的租约不被中途打断。

## 验收标准

- 单元测试证明每个出口最低 3 路、成功自动升档、限流自动降档、租约最终释放和公平调度。
- Controller 适配器测试证明只选择健康订阅节点，并正确绑定 `EGRESS_LANE_N`。
- Upstream 测试证明 public 请求使用池中不同 listener，sticky 请求仍使用 7890，RSSHub 内网请求不经过池。
- Mihomo 配置测试通过，Controller/listener 只绑定 `127.0.0.1`。
- E-Hentai 143 页画廊继续达到 143/143、0 警告、首尾媒体 HTTP 200；运行日志无 `eh_media_prefetch failed`。
