# syntax=docker/dockerfile:1

# ---- build ----
FROM node:20-alpine AS build
WORKDIR /app
# No `*` glob — a missing lockfile must fail the build, not silently proceed.
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
# `npm run build` also copies src/db/schema.sql and src/db/migrations into dist/.
RUN npm run build

# ---- runtime ----
FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

# tini: Node as PID 1 doesn't reap zombies or forward signals cleanly.
RUN apk add --no-cache tini

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Copy the built output with `node`-user ownership so the process can read it
# without running as root.
COPY --from=build --chown=node:node /app/dist ./dist

USER node

# Liveness probe: /health is a no-DB check that the process is up. (/ready
# also exists but does a DB round-trip and reports 503 on indexer lag — a
# readiness concern for an orchestrator, not a container-health signal, and
# it would never go healthy for an API-only container with no worker.)
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -q -O /dev/null "http://127.0.0.1:${PORT:-4000}/health" || exit 1

# Populated at build time: `--build-arg SOURCE_COMMIT=$(git rev-parse HEAD)`
# `--build-arg BUILD_DATE=$(date -u +%Y-%m-%dT%H:%M:%SZ)`
ARG SOURCE_COMMIT=unknown
ARG BUILD_DATE=unknown
LABEL org.opencontainers.image.source="https://github.com/ourdao/ourdao-backend" \
      org.opencontainers.image.revision="${SOURCE_COMMIT}" \
      org.opencontainers.image.created="${BUILD_DATE}"

ENTRYPOINT ["/sbin/tini", "--"]
# Default: the API. Run the indexer from the same image with:
#   docker run --env-file .env <image> node dist/worker.js
CMD ["node", "dist/index.js"]
