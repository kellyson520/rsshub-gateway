# Sidecar 扩展脚手架与多代理后端开发指南

本文档指导开发者如何为 `rsshub-gateway` 快速开发、接入与扩展独立的 Fetcher Sidecar 微服务，以及如何配置和利用多代理后端（Multi-proxy Backend）实现流量分发与隔离。

---

## 一、Fetcher-API 契约规范

每个独立 Sidecar 都是一个轻量 HTTP 服务，监听指定端口并实现 `/fetch` 接口：

- **请求方式**：`POST /fetch`
- **请求头**：`Content-Type: application/json`，可选 `x-request-id`
- **请求体（JSON）**：
  ```json
  {
    "routeId": "/custom/feed/:param",
    "params": {
      "param": "target_value"
    },
    "egressLane": "http://127.0.0.1:7901",
    "cookies": {
      "session_id": "abc123xyz"
    },
    "cacheTtl": 900
  }
  ```
- **响应体（JSON）**：
  ```json
  {
    "rssXml": "<?xml version=\"1.0\" encoding=\"UTF-8\"?><rss version=\"2.0\">...</rss>",
    "cacheTtl": 900
  }
  ```

---

## 二、Node.js 原生 Sidecar 脚手架模板

创建 `sidecar-template.js`：

```javascript
import http from 'node:http';

const PORT = Number(process.env.SIDECAR_PORT || 8000);

const server = http.createServer(async (req, res) => {
  if (req.method === 'POST' && req.url === '/fetch') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', async () => {
      try {
        const payload = JSON.parse(body || '{}');
        const { routeId, params, egressLane } = payload;

        // 1. 业务抓取与解析逻辑（可利用 egressLane 指定通道外发）
        const title = `RSS Generated for ${params?.param || 'default'}`;
        const rssXml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>${title}</title>
    <link>https://example.com</link>
    <description>Sidecar generated feed</description>
    <item>
      <title>Sample Item 1</title>
      <link>https://example.com/item/1</link>
      <pubDate>${new Date().toUTCString()}</pubDate>
    </item>
  </channel>
</rss>`;

        // 2. 返回 Fetcher-API 结果
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ rssXml, cacheTtl: 900 }));
      } catch (err) {
        res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // 健康检查
  if (req.method === 'GET' && (req.url === '/healthz' || req.url === '/')) {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('OK\n');
    return;
  }

  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('Not Found\n');
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Sidecar microservice listening on http://0.0.0.0:${PORT}`);
});
```

---

## 三、Python FastAPI Sidecar 脚手架模板

创建 `sidecar_fastapi.py`：

```python
from fastapi import FastAPI, Request, HTTPException
from pydantic import BaseModel
from typing import Dict, Any, Optional
import uvicorn
import httpx

app = FastAPI(title="RSSHub Gateway Sidecar")

class FetchPayload(BaseModel):
    routeId: str
    params: Dict[str, Any]
    egressLane: Optional[str] = None
    cookies: Optional[Dict[str, str]] = None
    cacheTtl: Optional[int] = 900

@app.get("/healthz")
def healthz():
    return {"status": "ok"}

@app.post("/fetch")
async def fetch_route(payload: FetchPayload):
    # 使用 payload.egressLane 调度代理通道
    proxies = payload.egressLane if payload.egressLane else None
    
    # 模拟数据抓取
    item_param = payload.params.get("param", "default")
    rss_xml = f"""<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>FastAPI Sidecar for {item_param}</title>
    <link>https://example.com</link>
    <item>
      <title>Article 1</title>
      <link>https://example.com/1</link>
    </item>
  </channel>
</rss>"""

    return {"rssXml": rss_xml, "cacheTtl": payload.cacheTtl}

if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8000)
```

---

## 四、Gateway 路由配置文件 (`gateway-routes.yaml`) 注册

在网关的 `gateway-routes.yaml` 中配置路由分发：

```yaml
routes:
  # 1. 调度到 Node.js / Python Sidecar 微服务
  - routeId: "/custom/feed/:param"
    backend: "sidecar://127.0.0.1:8000"
    fallback_upstream: true
    cacheTtl: 900

  # 2. 调度到带通配符的子路由
  - routeId: "/ehviewer/ranking/*"
    backend: "sidecar://127.0.0.1:8001"
    fallback_upstream: false

  # 3. 永久重定向路由（301 HTTP Cacheable）
  - routeId: "/old/user/:id"
    backend: "redirect"
    redirectTo: "/new/users/:id"
```
