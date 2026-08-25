# RSSHub Gateway 生产运维与架构全景总览 (Ops Index)

本文档汇集了 `rsshub-gateway` 生产部署、监控告警、多代理后端扩展与故障排查的核心文档矩阵与架构指南。

---

## 一、生产运维文档矩阵

| 文档指南 | 核心内容 | 链接路径 |
|---------|---------|---------|
| **Nginx / OpenResty 接入指南** | 生产反向代理配置、`proxy_buffering off` 优化、Lua 限流与 Range 直通 | [`nginx-openresty-guide.md`](./nginx-openresty-guide.md) |
| **故障排查与自愈手册 (Troubleshooting)** | Chromium 僵尸进程清理、Cloudflare 403 质询、代理池通道降级恢复、切片损坏排查 | [`troubleshooting-guide.md`](./troubleshooting-guide.md) |
| **监控指标与告警规范** | Prometheus 抓取配置、PromQL 核心告警规则（熔断/离线/高延迟）、Alertmanager 集成 | [`monitoring-alerting-guide.md`](./monitoring-alerting-guide.md) |
| **缓存运维与管理指南** | 分级缓存 TTL 矩阵、LRU 驱逐策略、`/_gateway/stats` 监控、冷重置与数据自愈 | [`cache-operations-guide.md`](./cache-operations-guide.md) |
| **Sidecar 扩展脚手架规范** | Fetcher-API 微服务接口契约、Node.js 与 Python FastAPI 脚手架模板、自定义路由集成 | [`sidecar-scaffold-guide.md`](./sidecar-scaffold-guide.md) |

---

## 二、核心架构体系概览

```
                ┌────────────────────────────────────────────────────────┐
                │             Client / Follow / Flareapp / Feed          │
                └───────────────────────────┬────────────────────────────┘
                                            │
                                            ▼
                ┌────────────────────────────────────────────────────────┐
                │          Nginx / OpenResty (SSL / Stream Buffer)       │
                └───────────────────────────┬────────────────────────────┘
                                            │
                                            ▼
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│                                 RSSHub Gateway Core                                     │
│                                                                                         │
│  ┌───────────────────────┐   ┌───────────────────────┐   ┌───────────────────────────┐  │
│  │   Route Dispatcher    │   │ Unified ResponseCache │   │ Resumable Range Transport │  │
│  │ (18+ Routes & Adapters│   │ (LRU + STALE Fallback)│   │  (64KiB Slices + Dedup)   │  │
│  └───────────┬───────────┘   └───────────┬───────────┘   └─────────────┬─────────────┘  │
│              │                           │                             │                │
│              ▼                           ▼                             ▼                │
│  ┌───────────────────────────────────────────────────────────────────────────────────┐  │
│  │                  Adaptive Egress Pool (24 Lanes Mihomo Proxies)                   │  │
│  │          - 12 Public Lanes (7901-7912)     - 12 Session Lanes (7921-7932)         │  │
│  └───────────────────────────────────────┬───────────────────────────────────────────┘  │
└──────────────────────────────────────────┼──────────────────────────────────────────────┘
                                           │
             ┌─────────────────────────────┴─────────────────────────────┐
             ▼                                                           ▼
┌─────────────────────────┐                                 ┌─────────────────────────┐
│     Upstream Feeds      │                                 │ Sidecar Content Engines │
│ (Iwara/X/Pixiv/TG/Eh..) │                                 │ (Python/Node Fetcher)   │
└─────────────────────────┘                                 └─────────────────────────┘
```

---

## 三、快速管理命令摘要

- **网关健康状态探针**：`curl -s http://127.0.0.1:81/healthz` 与 `curl -s http://127.0.0.1:81/readyz`
- **Prometheus 监控数据**：`curl -s http://127.0.0.1:81/_gateway/metrics`
- **网关综合统计 (JSON)**：`curl -s http://127.0.0.1:81/_gateway/stats`
- **Chromium 僵尸进程一键清理**：`pkill -f 'chromium|chrome'`
