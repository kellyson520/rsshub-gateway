# 响应驱动会话出口设计

## 目标

将多出口能力沉淀为网关的共享传输底座。公开的 E-Hentai、Iwara、Telegram、X 和 Instagram 请求通过公共出口池加速；站点明确要求认证时，网关才启用对应来源的凭据，并把同一 Cookie 或 Token 固定到一个长期不变的 session lane。适配器不创建代理、不选择节点，也不保存出口状态。

## 路由模型

每个外部请求有三种不可互换的路由范围：

- `public`：不附加 Cookie、Token 或 Authorization，使用 `EGRESS_LANE_01..12` 公共池。E-Hentai、Iwara、Telegram、X、Instagram 及各自公开媒体域属于候选公开来源。
- `session`：只有上游认证挑战确认需要会话、且本地存在该来源凭据时使用。凭据只会在此范围内附加，请求经固定 session lane 发出。
- `sticky`：ExHentai、未知来源和不适合匿名多出口的请求继续使用现有固定出口。

HTTP `429`、`5xx`、连接失败与超时是容量或上游故障，不会转换为 session 请求；它们保留公共池的重试、退避和熔断策略。

## 响应认证升级

网关对候选公开来源先执行匿名 `public` 请求。以下响应才被视为认证挑战：

- `401`；
- 指向登录路由的 `3xx`；
- 认证型 `403`；
- `200` HTML 中由适配器识别的登录页或登录壳。

适配器提供 `isAuthenticationChallenge(response)`，X 与 Instagram 复用已有登录壳识别，Iwara 增加对应的登录页识别；Telegram 没有本地会话凭据时不升级。认证挑战发生后，若该来源没有配置凭据，网关返回现有的安全受限页。若存在凭据，网关以 `session` 范围重试一次；这次重试成功后，详情及其签出的媒体 URL 都携带受保护的 session 路由标记。

## Session Lane

会话键为 `HMAC-SHA256(gatewaySecret, source + normalizedCredentials)`。原始 Cookie、Token、指纹和代理节点名称不会进入日志、HTML、RSS 或 Git。

Mihomo 增加仅容器本地可见的 `SESSION_LANE_01..12` listener。首次升级到 `session` 时，`SessionAffinityRegistry` 以会话键的一致性哈希选择一个健康 session lane，并持久化 `{ credentialFingerprint, laneId, proxyIdentityHash, assignedAt, lastUsedAt }`。同一会话后续的详情、重试、媒体和重启后的请求都解析为同一个 lane。

公共池刷新不会重绑 session lane。只有当前代理节点明确失效时，注册表才迁移该会话到另一个健康 session lane，并写入脱敏的迁移事件。`401`、登录页和普通站点 `403` 不触发出口迁移，以避免会话在认证失败时任意换 IP。

每条 session lane 使用与公共 lane 相同的受控并发下限和租约释放机制。不同凭据可以落在同一 lane，但一个凭据不会在健康状态下改变出口。

## 传输与缓存边界

`upstream` 成为唯一的出口调用点：它接收 `egressScope` 和 `source` 上下文，选择公共池、会话池或固定 dispatcher，并在响应体结束、取消或异常时释放租约。来源 Header 分为匿名 Header 与 session Header；默认不自动发送来源凭据。

签名目标扩展可选路由元数据 `egressScope`，该元数据由现有 HMAC 保护，不包含任何凭据。旧 URL 不带此字段，保持匿名公开或现有 sticky 默认行为。

缓存必须按范围隔离：公开内容继续按规范化上游 URL 共用缓存；session 内容使用 `source + credentialFingerprint + normalizedUrl` 的私有逻辑键。私有响应、媒体和失败回退不会被匿名请求命中。缓存目录及会话映射保持 Git 忽略和权限受限。

## 组件边界

- `egress-policy`：维护候选公开域和 `public` / `session` / `sticky` 的纯规则，不读 Cookie 或 Mihomo。
- `session-affinity`：生成凭据指纹、持久化映射、选择稳定 session lane 与记录迁移。
- `mihomo-egress`：分别刷新公共 lane 与健康检测；仅在首次分配或真实失效时绑定 session lane。
- `upstream`：根据请求范围附加匿名或 session Header，租用正确 dispatcher，并执行一次认证升级重试。
- 站点适配器：只声明匹配域、匿名/会话 Header 和认证挑战识别。
- `server` 与 `signed-target`：把会话路由意图安全传给详情和媒体请求，并为公开/会话内容选择隔离缓存键。

## 验收

- 无凭据的 Iwara、Telegram、X、Instagram 详情与媒体请求租用公共 lane；带凭据但未遇到认证挑战时仍不发送凭据。
- `401`、登录重定向与适配器识别的登录 HTML 恰好触发一次 session 重试；`429`、`5xx` 和超时绝不触发 session 重试。
- 同一来源凭据跨详情、媒体和进程重启解析到同一 session lane；真实节点失效才允许迁移。
- Session 凭据、会话缓存与公开缓存互相不可命中；日志、签名 URL 和统计不包含原始凭据或节点名称。
- E-Hentai 公开画廊继续按页分片到公共出口，ExHentai 继续固定出口；全部单元测试、Mihomo 配置校验与网关就绪检查通过。
