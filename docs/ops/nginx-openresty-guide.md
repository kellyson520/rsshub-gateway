# Nginx & OpenResty 配置与反向代理部署实战指南

本指南提供 `rsshub-gateway` 在生产环境下的标准 Nginx 与 OpenResty 接入范例、性能调优配置、WebSocket/流式传输支持与高可用代理配置。

---

## 一、Nginx 生产标准反向代理配置

```nginx
# /etc/nginx/conf.d/rsshub_gateway.conf

upstream rsshub_gateway_backend {
    server 127.0.0.1:81 max_fails=3 fail_timeout=10s;
    keepalive 64;
    keepalive_requests 10000;
    keepalive_timeout 60s;
}

server {
    listen 80;
    listen [::]:80;
    server_name rss.example.com;

    # 强制全站 HTTPS（按需启用）
    # return 301 https://$host$request_uri;

    # 日志格式
    access_log /var/log/nginx/rsshub_gateway.access.log combined buffer=64k flush=5s;
    error_log /var/log/nginx/rsshub_gateway.error.log warn;

    # 全局客户端体积与超时
    client_max_body_size 50M;
    client_body_timeout 30s;
    send_timeout 60s;

    # Gzip 静态协商（网关已具备 Brotli/Gzip，此处补充基础压缩）
    gzip on;
    gzip_vary on;
    gzip_proxied any;
    gzip_comp_level 5;
    gzip_types text/plain text/css application/json application/javascript application/xml application/rss+xml image/svg+xml;

    # 1. 核心网关与媒体传输代理
    location / {
        proxy_pass http://rsshub_gateway_backend;
        proxy_http_version 1.1;

        # 头部透传
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Connection "";

        # 视频 Range 切片与断点续传支持
        proxy_set_header Range $http_range;
        proxy_set_header If-Range $http_if_range;

        # 禁用 proxy_buffering 以获得毫秒级 TTFB 与流式直出
        proxy_buffering off;
        proxy_request_buffering off;

        # 超时设置
        proxy_connect_timeout 10s;
        proxy_read_timeout 120s;
        proxy_send_timeout 120s;
    }

    # 2. 网关内部运维与健康检查路径（限制内网访问）
    location ~ ^/_gateway/(stats|metrics|circuits|cache/clear|maintenance) {
        # 仅允许受信任的内网运维 IP
        allow 127.0.0.1;
        allow 10.0.0.0/8;
        allow 172.16.0.0/12;
        allow 192.168.0.0/16;
        deny all;

        proxy_pass http://rsshub_gateway_backend;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header Connection "";
    }
}
```

---

## 二、OpenResty (Lua) 动态鉴权与边缘限流配置

若借助 OpenResty 实现边缘鉴权、动态限流与灰度流量切分：

```nginx
# /usr/local/openresty/nginx/conf/rsshub_gateway_openresty.conf

lua_shared_dict gateway_rate_limit 10m;
lua_shared_dict gateway_cache_locks 1m;

server {
    listen 80;
    server_name rss-edge.example.com;

    location / {
        access_by_lua_block {
            local limit_conn = require "resty.limit.conn"
            -- 边缘基础 IP 限流：单 IP 最大 30 并发
            local lim, err = limit_conn.new("gateway_rate_limit", 30, 10, 0.5)
            if not lim then
                ngx.log(ngx.ERR, "failed to instantiate a resty.limit.conn object: ", err)
                return ngx.exit(500)
            end

            local key = ngx.var.binary_remote_addr
            local delay, err = lim:incoming(key, true)
            if not delay then
                if err == "rejected" then
                    ngx.header["Retry-After"] = 5
                    return ngx.exit(429)
                end
                ngx.log(ngx.ERR, "failed to limit req: ", err)
                return ngx.exit(500)
            end

            if lim:is_committed() then
                local ctx = ngx.ctx
                ctx.limit_conn = lim
                ctx.limit_key = key
            end

            if delay >= 0.001 then
                ngx.sleep(delay)
            end
        }

        proxy_pass http://127.0.0.1:81;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header Connection "";

        log_by_lua_block {
            local ctx = ngx.ctx
            local lim = ctx.limit_conn
            if lim then
                local latency = tonumber(ngx.var.request_time)
                local key = ctx.limit_key
                assert(key)
                local conn, err = lim:leaving(key, latency)
                if not conn then
                    ngx.log(ngx.ERR, "failed to record connection leaving: ", err)
                end
            end
        }
    }
}
```
