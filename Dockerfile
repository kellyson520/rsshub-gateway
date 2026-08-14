FROM metacubex/mihomo:Alpha AS mihomo
FROM node:24-alpine

COPY --from=mihomo /mihomo /usr/local/bin/mihomo

WORKDIR /app
RUN apk add --no-cache \
      --repository https://mirrors.aliyun.com/alpine/v3.24/main \
      --repository https://mirrors.aliyun.com/alpine/v3.24/community \
      python3 py3-pip \
    && pip3 install --no-cache-dir -i https://mirrors.aliyun.com/pypi/simple/ \
      --break-system-packages curl_cffi==0.16.0 \
    && rm -rf /root/.cache/pip \
    && mkdir -p /app/config /etc/ssl/extra-ca
# Let's Encrypt 2026 新层级（ISRG Root YE）中间证书：ggjav CDN 等站点只下发叶子证书，
# Node/undici 严格校验需要补全链路（curl_cffi 的 verify=False 不受影响）。
COPY config/certs/le-ggjav-chain.pem /etc/ssl/extra-ca/le-ggjav-chain.pem
ENV NODE_EXTRA_CA_CERTS=/etc/ssl/extra-ca/le-ggjav-chain.pem
COPY package*.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY sidecar ./sidecar
COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod 755 /entrypoint.sh

EXPOSE 1300 1301
ENTRYPOINT ["/entrypoint.sh"]
