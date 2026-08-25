# RSSHub Gateway 生产运维与故障排查手册

本文档总结 `rsshub-gateway` 服务在生产运行过程中的常见故障表现、排查链路、根因分析及应急处置操作。

---

## 一、排查工具箱与基础检查

```bash
# 1. 检查网关服务与端口存活状态
curl -I http://127.0.0.1:81/healthz

# 2. 获取网关核心性能指标与统计
curl -s http://127.0.0.1:81/_gateway/stats | jq .

# 3. 检查熔断器状态 (Circuit Breaker)
curl -s http://127.0.0.1:81/_gateway/circuits | jq .

# 4. 检查多通道代理池 (Mihomo Egress Lanes) 存活
curl -s http://127.0.0.1:81/_gateway/lanes | jq .
```

---

## 二、常见故障排查与自愈处置

### 1. Chrome / Chromium 僵尸进程泄漏排查与清理

**现象**：
- 渲染类 Adapter（如 Jable / MissAV / Fanbox 等）耗时升高或超时；
- `top` / `htop` 显示系统出现大量 `defunct` 或长驻内存不退出的 `chromium-browser` / `chrome` 进程。

**排查命令**：
```bash
# 查看所有 chrome 僵尸进程与父进程关系
ps -ef | grep -i chrome | grep defunct

# 查看 chrome 进程总数与内存消耗
ps aux | grep -iE 'chrome|chromium' | wc -l
```

**处置与根治方案**：
1. **应急清理**：
   ```bash
   # 批量终止悬挂超时的 Chrome 进程
   pkill -f 'chrome|chromium'
   ```
2. **架构级防泄漏机制**：
   - 确保 `browser-fetch.js` 与 `browser-render.js` 中的 `AbortSignal.timeout` 严格生效并在 `finally` 块中调用 `browser.close()`；
   - Docker 部署环境在启动容器时追加 `--init` 标志（如 `docker run --init ...`），由内置 init 进程自动回收僵尸进程。

---

### 2. 上游站点 WAF 拦截 (HTTP 403 / Cloudflare 质询)

**现象**：
- 请求 JavBus、JavDB、Kemono、Skeb 等站点时返回 403 页面或 Cloudflare 阻断。

**排查链路**：
1. 检查网关日志中是否记录 `browser_fetch_fallback` 或 `site_failure_recorded`；
2. 确认 `GATEWAY_BROWSER_FETCH_HOSTS` 环境变量中是否包含目标站点 Host；
3. 确认 Python `fetch-worker.py`（curl_cffi 指纹 Worker）是否正常运行在后台。

**处置方案**：
- 将目标站点加入 `GATEWAY_BROWSER_FETCH_HOSTS` 列表中走浏览器 TLS 指纹传输；
- 检查 Mihomo 出口代理节点质量，过滤被上游拉黑的 IP（`site-failure-tracker.js` 会自动降权并切换出口通道）。

---

### 3. 视频播放卡顿与 Range 分片加载慢

**现象**：
- Iwara / Adult Media 视频播放初始缓冲慢或拖动进度条卡顿。

**排查链路**：
1. 确认 Nginx 反向代理层是否关闭了 `proxy_buffering`（开启会导致缓冲整段数据才返回）；
2. 检查 `_gateway/stats` 中 `mediaCache` 命中率与 `video_slices` 填充速率；
3. 检查当前视频是否已触发 `lease-backfill` 后台预填。

**处置方案**：
- 确保反向代理开启了 `Range` 头部透传且未对大文件进行限速；
- 适当调整 `GATEWAY_MEDIA_PREFETCH_CONCURRENCY`（缺省为 2~4）以提升切片预热速度。

---

### 4. 磁盘缓存空间占满与 LRU 驱逐

**现象**：
- 磁盘使用率达到 100%，网关日志报错 `ENOSPC`。

**处置方案**：
- 网关采用 LRU 自动驱逐（`cache.js` 内部严格受 `maxBytes` 门限保护）；
- 运维可调用缓存清理接口主动回收空间：
  ```bash
  curl -X POST http://127.0.0.1:81/_gateway/cache/clear
  ```
