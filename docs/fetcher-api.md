# Fetcher-API 协议（Sidecar-Fetcher ↔ rsshub-gateway）

版本：v1（2026-08-13）｜状态：实现中，与 `src/dispatcher.js` 和 `sidecar/fetcher-*` 同步演进

Sidecar-Fetcher 是独立于网关基座的站点抓取进程，负责"向源站抓取数据、解析组装 RSS"。
媒体代理、缓存、指标、降级回退全部由网关基座完成。本协议是两者之间唯一的契约。

## 1 总体约定

- 传输：HTTP/1.1 + JSON（`content-type: application/json; charset=utf-8`）。
- 地址：网关通过 `gateway-routes.yaml` 中 `backend: "sidecar://host:port"` 注册，调用 `http://host:port/fetch`。
- 超时：网关侧默认 20s（`createDispatcher` 的 `sidecarTimeoutMs`），覆盖 sidecar 冷启动（browser-fetch 首次拉起约 10-15s）；sidecar 应尽快返回。
- 无鉴权（v1）：sidecar 仅在内网可达；如需保护，在 sidecar 前置反向代理上加认证。

## 2 端点

### 2.1 `POST /fetch` — 抓取并组装 RSS

请求体（网关 → sidecar）：

```json
{
  "routeId": "/iwara/users/:username/:kind?",
  "params": { "username": "example", "kind": "video" },
  "egressLane": "public",
  "cookies": {},
  "cacheTtl": 900
}
```

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `routeId` | string | 注册表中的路由模式，sidecar 据此校验是否支持 |
| `params` | object | 从请求路径提取的参数（`:name`/`:name?`/`*`） |
| `egressLane` | string | 建议出口域（`public`/`sticky`/`session`），sidecar 可忽略 |
| `cookies` | object | 客户端 Cookie（可选，透传） |
| `cacheTtl` | int | 网关建议的缓存 TTL（秒），sidecar 可用 `cacheHint.ttl` 覆盖 |

响应体（sidecar → 网关）：

```json
{
  "rssXml": "<?xml version=\"1.0\"...<rss>...</rss>",
  "mediaUrls": ["https://source.example/thumbnail-00.jpg"],
  "cacheHint": { "ttl": 900 }
}
```

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `rssXml` | string | 是 | 完整 RSS 2.0/Atom XML 字符串，链接使用源站原始 URL |
| `mediaUrls` | string[] | 否 | 源站原始媒体链接列表（缩略图/文件），供网关预判与统计 |
| `cacheHint.ttl` | int | 否 | 覆盖网关缓存 TTL（秒）；缺省用请求的 `cacheTtl` 或网关默认 |

网关收到后：按 `cacheHint.ttl` 缓存（kind `rss`），再经统一后处理（媒体链接重写为网关代理地址、指标、压缩）输出。

### 2.2 `GET /healthz` — 健康检查

```json
{ "ok": true, "transport": "worker" }
```

`ok: false` 或非 200 视为不健康。

## 3 错误约定

sidecar 应返回语义化 HTTP 状态码 + `{ "error": "human readable" }`：

| 状态码 | 含义 |
| --- | --- |
| 400 | 不支持的 `routeId` / 参数缺失或非法（如未知 ranking period） |
| 404 | 源站对象不存在（如 iwara 用户不存在） |
| 502 | 源站抓取失败 / sidecar 内部错误 |

网关侧处理：`fallback_upstream: true` 的路由在任意错误（网络不可达、超时、非 2xx、`rssXml` 缺失）时自动降级到上游 RSSHub；
未开启 fallback 的路由返回 502。sidecar 进程崩溃（连接拒绝）同样触发降级，不会影响网关与其他路由。

## 4 路由模式

`gateway-routes.yaml` 支持：

- `:name` — 匹配一个路径段并捕获为参数（URL 解码）。
- `:name?` — 可选尾段，缺省时不捕获。
- `*` — 匹配剩余全部路径（必须是最后一段）。
- 字面量段 — 精确匹配。
- 注册顺序优先：多条路由命中时取第一条。

网关基座不包含任何站点抓取路由（宪章约束）：未注册的路由一律透传上游 RSSHub。
`routes.yaml` 注册 `/ehviewer/ranking/:period?` 后由 fetcher-eh sidecar 服务该路径；
注册 `/iwara/users/:username/:kind?` 后由 fetcher-iwara sidecar 服务。

部署形态（均满足进程隔离）：
- **单容器疑难站点增强模式（推荐）**：sidecar 默认开启（`GATEWAY_SIDECAR_IWARA` /
  `GATEWAY_SIDECAR_EH`，默认 `true`，设 `false` 关闭），网关容器内以独立进程运行，路由 backend 写
  `sidecar://127.0.0.1:8000` / `sidecar://127.0.0.1:8001`（见 `docker-compose.enhanced.example.yml`）。
- 多容器模式：sidecar 独立容器，backend 写 compose 服务名。

## 5 参考实现

| Sidecar | 路由 | 源站 | 说明 |
| --- | --- | --- | --- |
| `sidecar/fetcher-iwara` | `/iwara/users/:username/:kind?` | api.iwara.tv | 用户视频/图片 feed；token 自动刷新；browser-fetch 过 Cloudflare |
| `sidecar/fetcher-eh` | `/ehviewer/ranking/:period?` | e-hentai.org | 排名 feed；`period` ∈ day/month/year/all |

两者共用 `src/fetcher-server.js`（HTTP 脚手架：`/fetch`、`/healthz`、错误映射）与
`src/browser-fetch.js`（curl_cffi 浏览器指纹 + Mihomo 出口）。

## 6 运行时路由注册（无需重启网关）

网关提供控制端点 `/_gateway/dispatcher/routes`，sidecar 可在启动时（或运行中）动态注册/注销路由，
路由表立即生效，无需重启网关。端点默认关闭：网关未配置 `DISPATCHER_REGISTRATION_TOKEN` 时返回 404
（生产默认不开启，零回归）。

| 方法 | 请求体 | 响应 |
| --- | --- | --- |
| `GET` | — | `{ routes: [...], total }`（配置文件 + 运行时路由列表） |
| `POST` | `{ "routes": [{ "routeId", "backend", "fallback_upstream", "cacheTtl" }] }` | `{ registered, rejected, total }` |
| `DELETE` | `{ "routeIds": ["/iwara/users/:username/:kind?"] }` | `{ removed, total }` |

鉴权：`Authorization: Bearer <DISPATCHER_REGISTRATION_TOKEN>`（常量时间比较）。
配置文件路由优先级高于运行时路由；运行时路由支持与配置文件相同的模式语法
（`:name`、`:name?`、`*`）与 `fallback_upstream` 语义。重复注册同一 `routeId` 会产生多条候选，
按注册顺序取第一条命中（`DELETE` 按 `routeId` 全部移除）。

### 启动时自动注册

两个参考 sidecar（`sidecar/fetcher-iwara`、`sidecar/fetcher-eh`）内置自动注册：设置以下环境变量后，
启动时自动 POST 注册自己的路由，收到 SIGTERM/SIGINT 时尽力注销：

| 环境变量 | 说明 |
| --- | --- |
| `DISPATCHER_REGISTRATION_URL` | 网关基地址，如 `http://gateway:1300`（自动追加 `/_gateway/dispatcher/routes`） |
| `DISPATCHER_REGISTRATION_TOKEN` | 与网关 `DISPATCHER_REGISTRATION_TOKEN` 一致 |
| `FETCHER_ADVERTISE_HOST` | 网关可达的 sidecar 主机名（compose 内为服务名，如 `fetcher-iwara`） |

注册失败会自动重试（默认 10 次、间隔 2s），最终失败仅记日志、不阻断 sidecar 启动；
sidecar 仍可被 `gateway-routes.yaml` 静态路由直接调用。

## 7 新增站点指引

1. 新建 `sidecar/fetcher-<name>/fetcher.js`：实现 `createXxxFetcher({ fetchJson/fetchHtml })` 与 `handleFetch(body)`，返回 `{ rssXml, mediaUrls, cacheHint }`，错误抛 `HttpError(status, message)`。
2. 新建 `sidecar/fetcher-<name>/server.js`：复用 `createFetcherServer` + `browser-fetch`，端口 `FETCHER_PORT`。
3. 在 `gateway-routes.yaml` 注册路由，`fallback_upstream: true` 保持可用性。
4. 在 `docker-compose` 疑难站点增强模板中增加服务（同镜像，`command: ["fetcher-<name>"]`）。
5. 优先向上游 RSSHub 提交路由改进；仅 CF 强校验等场景才开发 sidecar。
