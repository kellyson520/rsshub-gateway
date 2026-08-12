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
    && mkdir -p /app/config
COPY package*.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod 755 /entrypoint.sh

EXPOSE 1300 1301
ENTRYPOINT ["/entrypoint.sh"]
