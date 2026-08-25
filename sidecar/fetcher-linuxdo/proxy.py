import http.server, socketserver, urllib.request, json, os
PORT = 8017

class ProxyHandler(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        if self.path == '/fetch':
            try:
                # 使用完整的浏览器 Header
                headers = {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
                    'Accept': 'application/json, text/javascript, */*; q=0.01',
                    'Referer': 'https://linux.do/',
                    'Accept-Language': 'zh-CN,zh;q=0.9',
                }
                proxy = urllib.request.ProxyHandler({'https': os.environ.get('http_proxy', 'http://127.0.0.1:7891')})
                opener = urllib.request.build_opener(proxy)
                req = urllib.request.Request('https://linux.do/latest.json', headers=headers)
                with opener.open(req, timeout=15) as response:
                    data = json.load(response)
                    items = [{'title': t['title'], 'url': f'https://linux.do/t/{t["slug"]}/{t["id"]}', 'pubDate': t['created_at']} for t in data['topic_list']['topics']]
                    rss = f'<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>Linux.do</title>{ "".join([f"<item><title>{i['title']}</title><link>{i['url']}</link></item>" for i in items]) }</channel></rss>'
                    self.send_response(200)
                    self.send_header('Content-Type', 'application/json')
                    self.end_headers()
                    self.wfile.write(json.dumps({'rssXml': rss, 'cacheHint': {'ttl': 300}}).encode())
            except Exception as e:
                self.send_response(502)
                self.end_headers()
                self.wfile.write(str(e).encode())

with socketserver.TCPServer(("", PORT), ProxyHandler) as httpd:
    httpd.serve_forever()
