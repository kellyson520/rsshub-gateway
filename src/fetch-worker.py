#!/usr/bin/env python3
"""Browser-fingerprint fetch worker for rsshub-gateway.

Cloudflare-protected sources (for example api.iwara.tv, linux.do) reject plain
Node/curl TLS fingerprints. This worker performs requests with a
Chrome-impersonating client (curl_cffi) and returns results as JSON.

Protocol (default, stdio): line-delimited JSON-RPC. Each request line:
  {"id": 1, "url": "...", "method": "GET", "headers": {...}, "body": "...",
   "timeout": 30, "impersonate": "chrome131", "redirect": "manual|follow",
   "proxy": "http://..."}   # proxy optional, defaults to FETCHD_PROXY
Each response line:
  {"id": 1, "ok": true, "status": 200, "headers": {...},
   "body": "<base64>", "latencyMs": 123, "ip": "..."}
  {"id": 1, "ok": false, "error": "...", "code": "..."}

HTTP mode (--http PORT): same payloads over POST /fetch, GET /healthz.
"""
import argparse
import base64
import json
import os
import random
import socket
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from curl_cffi import requests

DEFAULT_PROXY = os.environ.get("FETCHD_PROXY", "http://127.0.0.1:7890")
DEFAULT_IMPERSONATE = os.environ.get("FETCHD_IMPERSONATE", "chrome131")
DEFAULT_MAX_BODY = int(os.environ.get("FETCHD_MAX_BODY", str(4 * 1024 * 1024)))
MAX_TIMEOUT = 60.0
SUPPORTED_IMPERSONATIONS = [
    "chrome", "chrome99", "chrome100", "chrome101", "chrome104", "chrome107",
    "chrome110", "chrome116", "chrome119", "chrome120", "chrome123",
    "chrome124", "chrome131", "edge101", "firefox133", "safari17_0",
    "safari17_2_ios",
]

# 所有的 Mihomo 出口代理通道
ALL_PROXY_LANES = [
    "http://127.0.0.1:7901",
    "http://127.0.0.1:7908",
    "http://127.0.0.1:7903",
    "http://127.0.0.1:7890",
    "http://127.0.0.1:7902",
    "http://127.0.0.1:7904",
    "http://127.0.0.1:7905",
    "http://127.0.0.1:7906",
    "http://127.0.0.1:7907",
    "http://127.0.0.1:7909",
    "http://127.0.0.1:7910",
    "http://127.0.0.1:7911",
    "http://127.0.0.1:7912",
]


def execute_request_with_proxy(method, url, impersonate, headers, body_bytes, proxy, timeout, redirect):
    return requests.request(
        method,
        url,
        impersonate=impersonate,
        headers=headers,
        data=body_bytes,
        proxies={"http": proxy, "https": proxy},
        timeout=timeout,
        allow_redirects=(redirect == "follow"),
        verify=False,
    )


def run_request(payload):
    """Execute one fetch and return the response dict (always JSON-serializable)."""
    url = payload.get("url")
    if not isinstance(url, str) or not url.startswith("https://"):
        return {"ok": False, "code": "invalid_url", "error": "url must be an https url"}
    method = str(payload.get("method") or "GET").upper()
    headers = payload.get("headers") or {}
    if not isinstance(headers, dict):
        return {"ok": False, "code": "invalid_headers", "error": "headers must be an object"}
    body = payload.get("body")
    if body is not None and not isinstance(body, str):
        return {"ok": False, "code": "invalid_body", "error": "body must be a string"}
    try:
        timeout = min(float(payload.get("timeout") or 30), MAX_TIMEOUT)
    except (TypeError, ValueError):
        return {"ok": False, "code": "invalid_timeout", "error": "invalid timeout"}
    impersonate = str(payload.get("impersonate") or DEFAULT_IMPERSONATE)
    if impersonate not in SUPPORTED_IMPERSONATIONS:
        return {"ok": False, "code": "unsupported_impersonation",
                "error": f"unsupported impersonation: {impersonate}"}
    redirect = str(payload.get("redirect") or "follow").lower()
    if redirect not in ("manual", "follow"):
        return {"ok": False, "code": "invalid_redirect", "error": "redirect must be manual or follow"}
    primary_proxy = payload.get("proxy") or DEFAULT_PROXY
    if not isinstance(primary_proxy, str):
        return {"ok": False, "code": "invalid_proxy", "error": "proxy must be a string"}
    try:
        max_body = int(payload.get("maxBody") or DEFAULT_MAX_BODY)
    except (TypeError, ValueError):
        max_body = DEFAULT_MAX_BODY

    body_bytes = body.encode("utf-8") if body is not None else None
    started = time.monotonic()

    # 动态负载均衡与打散重试，避免单个出口节点触发频控
    other_lanes = [p for p in ALL_PROXY_LANES if p != primary_proxy]
    random.shuffle(other_lanes)
    proxy_candidates = [primary_proxy] + other_lanes
    last_error = None
    last_candidate_response = None
    final_response = None
    per_proxy_timeout = min(timeout, 3.5)

    for proxy in proxy_candidates:
        try:
            res = execute_request_with_proxy(
                method, url, impersonate, headers, body_bytes, proxy, per_proxy_timeout, redirect
            )
            # 2xx / 3xx / 404 等业务正常响应直接采纳
            if res.status_code not in (429, 403, 502, 503, 504):
                final_response = res
                break
            last_candidate_response = res
        except Exception as exc:  # noqa: BLE001
            last_error = exc
            continue

    response = final_response or last_candidate_response
    if response is None:
        return {
            "ok": False,
            "code": "fetch_failed",
            "error": f"fetch failed across proxies: {last_error}",
            "latencyMs": int((time.monotonic() - started) * 1000),
        }

    content = response.content or b""
    if len(content) > max_body:
        return {
            "ok": False,
            "code": "body_too_large",
            "error": f"response body too large ({len(content)} > {max_body})",
            "status": response.status_code,
            "latencyMs": int((time.monotonic() - started) * 1000),
        }
    try:
        peer_ip = response.request_headers.get("x-requested-ip") or ""
    except Exception:  # noqa: BLE001
        peer_ip = ""
    return {
        "ok": True,
        "status": response.status_code,
        "headers": {key: value for key, value in response.headers.items()},
        "body": base64.b64encode(content).decode("ascii"),
        "latencyMs": int((time.monotonic() - started) * 1000),
        "ip": peer_ip,
    }


class JsonRpcWorker:
    def __init__(self, output):
        self.output = output

    def handle_line(self, line):
        try:
            payload = json.loads(line)
        except Exception:  # noqa: BLE001
            self.write({"ok": False, "code": "invalid_json", "error": "invalid request line"})
            return
        request_id = payload.get("id")
        result = run_request(payload)
        result["id"] = request_id
        self.write(result)

    def write(self, payload):
        self.output.write(json.dumps(payload, separators=(",", ":")) + "\n")
        self.output.flush()

    def serve_stdio(self):
        for line in sys.stdin:
            line = line.strip()
            if not line:
                continue
            self.handle_line(line)
        # EOF means the parent exited; drain the output then quit.
        self.output.flush()


class HttpHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    worker = None

    def log_message(self, *_):
        return

    def do_GET(self):
        if self.path == "/healthz":
            self._respond(200, {"ok": True, "impersonate": DEFAULT_IMPERSONATE,
                                "proxy": DEFAULT_PROXY})
            return
        self._respond(404, {"error": "not found"})

    def do_POST(self):
        if self.path != "/fetch":
            self._respond(404, {"error": "not found"})
            return
        try:
            length = int(self.headers.get("content-length") or 0)
            if length <= 0 or length > 1024 * 1024:
                self._respond(400, {"error": "invalid request body"})
                return
            payload = json.loads(self.rfile.read(length) or b"{}")
        except Exception as exc:  # noqa: BLE001
            self._respond(400, {"error": f"invalid json: {exc}"})
            return
        result = run_request(payload)
        self._respond(200, result)

    def _respond(self, status, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--http", type=int, default=0, help="serve HTTP on this port instead of stdio")
    args = parser.parse_args()
    if args.http:
        server = ThreadingHTTPServer(("0.0.0.0", args.http), HttpHandler)
        HttpHandler.worker = JsonRpcWorker(sys.stdout)
        print(f"fetch worker listening on 0.0.0.0:{args.http} "
              f"impersonate={DEFAULT_IMPERSONATE} proxy={DEFAULT_PROXY}", flush=True)
        server.serve_forever()
    else:
        worker = JsonRpcWorker(sys.stdout)
        worker.serve_stdio()


if __name__ == "__main__":
    main()
