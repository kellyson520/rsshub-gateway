FROM metacubex/mihomo:Alpha AS mihomo
FROM node:24-alpine

COPY --from=mihomo /mihomo /usr/local/bin/mihomo

WORKDIR /app
RUN mkdir -p /app/config
COPY package*.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod 755 /entrypoint.sh

EXPOSE 1300
ENTRYPOINT ["/entrypoint.sh"]
