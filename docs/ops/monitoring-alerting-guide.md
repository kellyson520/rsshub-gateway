# RSSHub Gateway 监控指标与生产告警规范

本文档详述 `rsshub-gateway` 暴露的运维监控指标接口（Prometheus / OpenMetrics 兼容、JSON 统计接口）、核心告警规则阈值以及对接 Alertmanager / Grafana 的最佳配置。

---

## 一、监控数据源接口

网关默认在管理端口暴露以下可观测性端点：

| 端点路径 | 格式 | 说明 | 适用场景 |
|---------|------|------|---------|
| `GET /_gateway/metrics` | Prometheus 文本格式 | 全量计数器、时延直方图、仪表盘指标 | Prometheus / VictoriaMetrics 抓取 |
| `GET /_gateway/stats` | JSON 格式 | 当前缓存状态、下载会话、预取队列统计 | 快速调试、内网看板、自定义脚本 |
| `GET /_gateway/circuits` | JSON 格式 | 各上游 Host 熔断器状态 (CLOSED/OPEN/HALF_OPEN) | 熔断监控与自动告警 |
| `GET /_gateway/lanes` | JSON 格式 | Mihomo 多通道代理池 (Public/Session) 存活状态 | 出口节点质量监控 |
| `GET /healthz` | Plain Text | 网关基础存活探针 (Liveness) | K8s / 负载均衡器心跳 |
| `GET /readyz` | JSON 格式 | 就绪探针 (Readiness，含代理通道就绪率) | 流量分发就绪校验 |

---

## 二、Prometheus 抓取配置示例

```yaml
# prometheus.yml
scrape_configs:
  - job_name: 'rsshub-gateway'
    scrape_interval: 15s
    scrape_timeout: 10s
    metrics_path: '/_gateway/metrics'
    static_configs:
      - targets: ['127.0.0.1:81']
        labels:
          instance: 'rsshub-gateway-prod'
          env: 'production'
```

---

## 三、核心 Prometheus 告警规则 (PromQL Alerting Rules)

```yaml
groups:
  - name: rsshub_gateway_alerts
    rules:
      # 1. 网关服务离线
      - alert: GatewayDown
        expr: up{job="rsshub-gateway"} == 0
        for: 1m
        labels:
          severity: critical
        annotations:
          summary: "RSSHub Gateway 实例已离线"
          description: "实例 {{ $labels.instance }} 在过去 1 分钟内未能被 Prometheus 抓取。"

      # 2. 熔断器触发告警
      - alert: CircuitBreakerTripped
        expr: gateway_circuit_state{state="open"} > 0
        for: 2m
        labels:
          severity: warning
        annotations:
          summary: "上游站点熔断器触发"
          description: "目标主机 {{ $labels.host }} 出现持续故障，熔断器已开启 (OPEN)。"

      # 3. 代理池可用通道不足
      - alert: EgressLanesDegraded
        expr: gateway_egress_lanes_active < 4
        for: 3m
        labels:
          severity: critical
        annotations:
          summary: "Mihomo 出口代理通道不足"
          description: "当前活跃代理通道数量仅剩 {{ $value }} 条（标准为 24 条），可能影响海外站点抓取。"

      # 4. 高错误率告警
      - alert: HighHttp5xxRate
        expr: sum(rate(gateway_requests_total{status=~"5.."}[5m])) / sum(rate(gateway_requests_total[5m])) > 0.05
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "HTTP 5xx 错误率超过 5%"
          description: "过去 5 分钟内网关 5xx 错误占比达到 {{ $value | humanizePercentage }}。"

      # 5. 缓存占用与 LRU 频繁驱逐
      - alert: CacheSpaceNearFull
        expr: gateway_cache_bytes / gateway_cache_max_bytes > 0.90
        for: 10m
        labels:
          severity: info
        annotations:
          summary: "磁盘缓存占用超过 90%"
          description: "网关磁盘缓存使用量达到 {{ $value | humanizePercentage }}，将触发 LRU 淘汰。"
```
