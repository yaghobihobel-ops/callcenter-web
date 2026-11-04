FROM node:20-bookworm-slim AS dependencies
WORKDIR /build
# Use the headers shipped in the official Node image if the native SQLite
# connector must fall back from a prebuilt binary to a local compilation.
ENV npm_config_nodedir=/usr/local
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY backend/package.json backend/package-lock.json ./
# Keep the existing lockfile and compile the optional SQLite CRM connector.
RUN npm ci --omit=dev --no-audit --no-fund

FROM node:20-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY --from=dependencies /build/node_modules ./node_modules
COPY backend/ ./
RUN cp public/widget.js /opt/widget.js.template \
    && mkdir -p /var/lib/callcenter/recordings /run/callcenter-keys \
    && chown -R node:node /app /var/lib/callcenter
COPY docker/app-entrypoint.sh /usr/local/bin/app-entrypoint.sh
RUN chmod 755 /usr/local/bin/app-entrypoint.sh
USER node
EXPOSE 3006
ENTRYPOINT ["app-entrypoint.sh"]
CMD ["node", "runtime.js"]
