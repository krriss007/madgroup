# syntax=docker/dockerfile:1
#
# TradePilot — one image, both processes.
#
# The Fastify API listens on 127.0.0.1 inside the container and the Next.js
# terminal proxies /api and /ws to it, so a single exposed port (3000) serves
# the UI, the REST API and the WebSocket. There is no reason for a browser to
# ever address the API directly, which keeps the public surface to one port.
#
# Build:  docker build -f deploy/Dockerfile -t tradepilot .
# Run:    docker run --rm -p 3000:3000 \
#           -e SESSION_SECRET="$(openssl rand -hex 32)" \
#           -e BRIDGE_SECRET="$(openssl rand -hex 32)" \
#           tradepilot
#
# Persistence: without DATABASE_URL the API runs on its in-memory store and all
# data is lost on restart. For anything but a throwaway demo, set DATABASE_URL
# (see deploy/docker-compose.yml for app + PostgreSQL + automatic HTTPS).

FROM node:22-slim AS build
WORKDIR /app

ENV NEXT_TELEMETRY_DISABLED=1

# Install from the lockfile first so the dependency layer caches independently
# of source changes. --ignore-scripts skips the Prisma engine download, which is
# not needed at runtime (database/schema.sql is applied at boot by the store)
# and is unreachable from some locked-down build networks.
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY backend/package.json backend/
COPY frontend/package.json frontend/
COPY tests/package.json tests/
RUN npm ci --ignore-scripts --no-audit --no-fund

COPY . .
RUN npm run build


FROM node:22-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOST=0.0.0.0 \
    PORT=3000 \
    API_HOST=127.0.0.1 \
    API_PORT=8080

COPY --from=build /app /app

# Only the terminal is published; the API stays on the loopback interface.
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=45s --retries=3 \
  CMD node deploy/healthcheck.mjs

CMD ["node", "deploy/entrypoint.mjs"]
