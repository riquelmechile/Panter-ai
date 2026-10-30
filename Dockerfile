FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig*.json ./
COPY src ./src
COPY scripts ./scripts
COPY vendor ./vendor
RUN npm run build

FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN apk add --no-cache git && npm ci --omit=dev --no-audit --no-fund \
    && mkdir -p /data && chown -R node:node /data && chmod 0700 /data
COPY --from=build /app/dist ./dist
COPY --from=build /app/vendor ./vendor
ENV PANTER_PORT=8080 PANTER_BIND_HOST=0.0.0.0 PANTER_DATA_DIR=/data
EXPOSE 8080
VOLUME ["/data"]
USER node
CMD ["node", "dist/server.js"]
