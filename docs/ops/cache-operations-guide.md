# RSSHub Gateway 缓存运维与接口管理规范

本文档详述 `rsshub-gateway` 的统一分级缓存运维机制、缓存清理接口（Cache Invalidation）、存储结构布局与生产维护指令。

---

## 一、缓存层级与 TTL 策略

网关采用基于本地文件系统的持久化分级缓存，元数据保存在 `$GATEWAY_CACHE_DIR/index.json` 中：

| 缓存类别 (`kind`) | 默认 TTL | 驱逐优先级 (`priority`) | 适用内容 |
|------------------|---------|-----------------------|---------|
| `rss` | 300 秒 (5分钟) | 0 (最高驱逐权重，最先淘汰) | RSS/Atom XML 订阅流 |
| `eh-image` | 300 秒 (5分钟) | 1 | E-Hentai 页面元数据 |
| `html` | 3 天 (259200秒) | 1 | 阅读器 HTML 页面 |
| `media` | 7 天 (604800秒) | 2 | 原始图片、视频切片 |
| `media-variant` | 7 天 (604800秒) | 3 (最低驱逐权重，优先保留) | 降采样/压缩后的 WebP 图像变体 |

---

## 二、缓存统计与监控接口

### 1. 查看缓存状态
```bash
curl -s http://127.0.0.1:81/_gateway/stats | jq .cache
```
**输出示例**：
```json
{
  "entries": 1420,
  "bytes": 524288000,
  "byteLimit": 5368709120,
  "counters": {
    "hits": 18230,
    "misses": 1540,
    "staleHits": 85,
    "bytesStored": 530000000,
    "rangeReads": 4200,
    "rangeBytes": 104857600
  },
  "inflight": 0,
  "storeInflight": 0,
  "activeLoads": 0,
  "root": "/var/cache/rsshub-gateway"
}
```

---

## 三、生产缓存运维管理指令

### 1. 安全平滑清理过期条目 (无需重启)
网关在每次启动与读取时会自动进行惰性淘汰与 LRU 释放。若需手动触发空间回收：
```bash
# 检查缓存目录物理磁盘占用
du -sh /var/cache/rsshub-gateway/

# 查看 index.json 条目总数
jq '. | length' /var/cache/rsshub-gateway/index.json
```

### 2. 紧急全量清空缓存 (冷重置)
若遇到脏数据或磁盘紧急爆满，可执行以下命令安全重置缓存（网关会自动重建索引）：
```bash
# 停止或暂停写入后清理
rm -rf /var/cache/rsshub-gateway/*
# 网关将在下一次请求到来时自动初始化新的空索引
```
