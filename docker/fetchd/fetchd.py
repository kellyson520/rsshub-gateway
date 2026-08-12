#!/usr/bin/env python3
"""Browser-fingerprint fetch sidecar for rsshub-gateway.

Cloudflare-protected sources (for example api.iwara.tv) reject plain
Node/curl TLS fingerprints. This sidecar performs the request with a
Chrome-impersonating client (curl_cffi) and returns the response as JSON.
"""
import base64
import json
import os
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from curl_cffi import requests

PROXY = os.environ.get("FETCHD_PROXY", "http://127.0.0.1:7890")
IMPERSONATE = os.environ.get("FETCHD_IMPERSONATE", "chrome131")
PORT = int(os.environ.get("FETCHD_PORT", "7899"))
MAX_BODY = int(os.environ.get("FETCHD_MAX_BODY", str(4 * 1024 * 1024)))
MAX_TIMEOUT = 60.0


def respond(handler, status, payload):
    body = json.dumps(payload).encode("utf-8")
    handler.send_response(status)
    handler.send_header("content-type", "application/json; charset=utf-8")
    handler.send_header("content-length", str(len(body)))
    handler.end_headers()
    handler.wfile.write(body)


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *_):
        return

    def do_GET(self):
        if self.path == "/healthz":
            respond(self, 200, {"ok": True})
            return
        respond(self, 404, {"error": "not found"})

    def do_POST(self):
        if self.path != "/fetch":
            respond(self, 404, {"error": "not found"})
            return
        try:
            length = int(self.headers.get("content-length") or 0)
            if length <= 0 or length > 1024 * 1024:
                respond(self, 400, {"error": "invalid request body"})
                return
            payload = json.loads(self.rfile.read(length) or b"{}")
        except Exception as exc:  # noqa: BLE001
            respond(self, 400, {"error": f"invalid json: {exc}"})
            return

        url = payload.get("url")
        if not isinstance(url, str) or not url.startswith("https://"):
            respond(self, 400, {"error": "url must be an https url"})
            return
        method = str(payload.get("method") or "GET").upper()
        headers = payload.get("headers") or {}
        if not isinstance(headers, dict):
            respond(self, 400, {"error": "headers must be an object"})
            return
        body = payload.get("body")
        if body is not None and not isinstance(body, str):
            respond(self, 400, {"error": "body must be a string"})
            return
        try:
            timeout = min(float(payload.get("timeout") or 30), MAX_TIMEOUT)
        except (TypeError, ValueError):
            respond(self, 400, {"error": "invalid timeout"})
            return

        try:
            response = requests.request(
                method,
                url,
                impersonate=IMPERSONATE,
                headers=headers,
                data=body.encode("utf-8") if body is not None else None,
                proxies={"http": PROXY, "https": PROXY},
                timeout=timeout,
                allow_redirects=False,
                verify=False,
            )
        except Exception as exc:  # noqa: BLE001
            respond(self, 502, {"error": f"fetch failed: {exc}"})
            return

        content = response.content or b""
        if len(content) > MAX_BODY:
            respond(self, 413, {"error": "response body too large"})
            return
        response_headers = {key: value for key, value in response.headers.items()}
        respond(self, 200, {
            "status": response.status_code,
            "headers": response_headers,
            "body": base64.b64encode(content).decode("ascii"),
        })


def main():
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    server.daemon_threads = True
    print(f"fetchd listening on 0.0.0.0:{PORT} proxy={PROXY} impersonate={IMPERSONATE}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
