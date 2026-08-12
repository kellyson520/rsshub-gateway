# 多出口站点级自适应设计

## 目标

在多出口底座（12 条 Egress lane，每条绑定一个健康 Mihomo 节点）之上增加**站点级健康**：lane 的可用性不再由单一探测 URL 决定，而是按站点/策略作用域分别判定；请求失败（403/429/超时）反馈回调度层，连续失败的 lane 对特定站点摘除，会话亲和自动迁移。使“节点被某站点封禁但整体健康”的场景不再持续打坏该站点的流量，从根上降低 token 封禁与站点不可用。

## 现状与问题（已核实）

- `createMihomoEgressAdapter` 每 60s 刷新：取订阅中健康节点，把 `EGRESS_LANE_01..12` 通过控制器 API 绑定到不同节点，用**单一** `EGRESS_PROBE_URL`（当前为 `https://e-hentai.org/`）探测后建立 lane。
- `createEgressPool` 只按并发做调度：least-active 选择、408/425/429/5xx 退避、3→6 路爬坡；没有站点维度。
- `session-affinity` 有 `markLaneUnhealthy(laneId)` 迁移机制，但没有任何代码调用它（除测试外）。
- 请求路径（`upstream.js`）持有 `lease.laneId`/`lease.proxyName`，释放时只回传状态做并发退避，不反馈站点。
- 策略 host 列表（`egress-policy.js` 的 `PUBLIC_HOSTS`/`PUBLIC_REQUEST_HOSTS`）硬编码。

## 设计

### 1. 站点级探测（site-scoped probes）

`createMihomoEgressAdapter` 新增 `probeTargets` 选项，结构：

```js
{
  public: ['https://e-hentai.org/'],                    // 公共作用域代表站点
  sticky: ['https://www.iwara.tv/', 'https://x.com/'],  // 固定作用域代表站点
  hosts: { 'i.iwara.tv': 'https://www.iwara.tv/' },     // 可选：具体 host → 探测 URL 覆盖
}
```

- 默认值：`public: ['https://e-hentai.org/']`、`sticky: ['https://www.iwara.tv/', 'https://x.com/']`；`hosts` 默认为空。
- lane 健康按 `(proxyName, scope)` 维度缓存探测结果（复用现有 `probeResults`，key 改为 `${proxyName}:${scope}`，仍走 `probeCacheMs`）。
- `refreshPublicLanes`：lane 绑定节点后分别探测 public 与 sticky；snapshot 增加 `healthyScopes` 集合。`public` 探测失败 → 该 lane 完全不进入池；`sticky` 探测失败 → 仍进入池，但标记为 sticky 不可用。
- 会话 lane（`assignSessionLane`）同样在绑定后按 `probeTargets.sticky` 探测，失败则回滚（不占用 slot）。

### 2. 池的站点过滤与兜底

`createEgressPool` lane 状态增加：

```js
siteHealth: Map<host, { failures: number, until: number, blocked: boolean }>
```

- `chooseLane({ host, scope })`：
  1. 候选 = 并发可用 且 cooldown 结束 且 未对该 host 标记 blocked 的 lane；
  2. 若 `scope === 'public'`，额外要求 lane 的 `healthyScopes` 含 public；`sticky`/`session` 要求含 sticky；
  3. 无候选时**降级**：忽略站点 blocked 但保留并发/scope 条件再选一次，并 emit `{ state: 'site-degraded', host }`；
  4. 仍无则按现有 `EGRESS_POOL_EMPTY` 语义等待。
- `makeLease` 携带 `host`（acquire 时传入）；`release(result)` 的 `result` 支持 `{ status, host, error }`。
- `recordResult` 扩展：`status` 命中封禁集合（403、401、407、429）且带 `host` 时 → 该 lane 该 host 失败计数 +1，连续失败达到阈值（默认 3 次、窗口 60s）→ `siteHealth[host] = { blocked: true, until: now + cooldownMs }` 并 emit `{ state: 'site-blocked', laneId, host, status }`；成功响应清除该 host 计数。
- 新增 `stats()` 字段：per-lane `siteBlocked: [host...]`。

### 3. 请求失败反馈回路

- `upstream.js`：`lease.release({ status, host, error })` 补传 `host`（请求目标 hostname）；其余重试/熔断逻辑不变。
- `server.js` 的 egress `onEvent`：
  - `site-blocked` 且 lane 是会话 lane（id 以 `session-lane-` 开头）→ `mihomoEgress.markSessionLaneUnhealthy(laneId)` + `sessionAffinity.markLaneUnhealthy(laneId)`（现有迁移逻辑），记日志 `session_lane_site_blocked`；
  - `site-degraded` → 记 `egress_site_degraded` 日志（含 host）。
- session 请求的 lane 绑定仍在 `upstream.js` 的 session 分支（`sessionDispatcher`），反馈经 pool 事件链路完成；session 迁移后旧 dispatcher 由 `markSessionLaneUnhealthy` 关闭。

### 4. 策略配置化

- `egress-policy.js`：`PUBLIC_HOSTS`/`PUBLIC_REQUEST_HOSTS` 允许 env 覆盖并**合并**默认值：
  - `EGRESS_PUBLIC_HOSTS`、`EGRESS_PUBLIC_REQUEST_HOSTS`（逗号分隔或 JSON 数组）。
- 新增默认项：`pixiv.net`、`pximg.net` 加入 `PUBLIC_REQUEST_HOSTS`（页面/公开媒体走公共池；带凭证的图仍由 session 作用域接管）。

### 5. 可观测性

- `/_gateway/infra` 的 `egress` 增加：`probeTargets` 概览、每 lane `healthyScopes`、`siteBlocked` 列表、`degraded` 状态。
- 事件日志：`egress_site_probe`、`egress_site_blocked`、`egress_site_degraded`、`session_lane_site_blocked`。

## 配置项

| env | 默认 | 说明 |
| --- | --- | --- |
| `EGRESS_PROBE_TARGETS` | `{"public":["https://e-hentai.org/"],"sticky":["https://www.iwara.tv/","https://x.com/"],"hosts":{}}` | 站点级探测目标 JSON |
| `EGRESS_SITE_FAILURE_THRESHOLD` | `3` | 站点连续失败摘除阈值 |
| `EGRESS_SITE_FAILURE_WINDOW_MS` | `60000` | 站点失败统计窗口 |
| `EGRESS_PUBLIC_HOSTS` | 默认列表 | 公共作用域 host 覆盖（合并） |
| `EGRESS_PUBLIC_REQUEST_HOSTS` | 默认列表 | 公共请求作用域 host 覆盖（合并） |

## 验收

- 单元测试：站点探测缓存按 scope 隔离；池按站点 blocked 过滤并降级兜底；失败计数窗口与阈值触发 `site-blocked`；session lane 收到事件后迁移记录；策略 env 覆盖合并。
- 现有 231 测试全绿。
- 生产重建后 `/healthz` ok、`/_gateway/infra` 显示每 lane `healthyScopes` 与 `siteBlocked`。
- 用 iwara 会话请求观察：模拟 403 后对应 lane 摘除、会话迁移日志出现、请求仍 200。
