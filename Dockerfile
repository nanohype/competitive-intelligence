# Base image pinned by digest, not by tag. `node:24-alpine` is a moving tag —
# it repoints on every 24.x patch and every Alpine rebuild, so two builds of
# the same commit can differ. The GitHub Actions in this repo are already
# SHA-pinned; this is the same discipline for the one input that was not.
# This is the multi-arch index digest (linux/amd64, arm64, s390x), NOT a
# single-platform manifest — pinning the latter builds on one architecture
# and fails on the others. Renovate maintains it as a `digest` update.
FROM node:24-alpine@sha256:d32cdf619f63fe0471182d08996dd516c6275bb5fd31ae06e55a570bd9e1ad43 AS builder
WORKDIR /app

# Install and build the TypeScript app.
COPY package.json package-lock.json ./
RUN npm ci
# Both configs: tsconfig.build.json sets the emit options and rootDir, and
# extends tsconfig.json for everything else, so neither builds without the other.
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

FROM node:24-alpine@sha256:d32cdf619f63fe0471182d08996dd516c6275bb5fd31ae06e55a570bd9e1ad43 AS runner
WORKDIR /app
ENV NODE_ENV=production

RUN addgroup -g 1001 -S app && adduser -u 1001 -S app -G app

# Production deps only.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Compiled output + the starter crawl-source catalog. The app reads
# `sources.json` (src/index.ts, src/cli.ts), so ship the example as that path;
# mount a curated sources.json over it per-env to monitor a real source list.
COPY --from=builder /app/dist ./dist
COPY sources.example.json ./sources.json

USER app

# Health port — the app serves /health + /readyz here (config.port, env PORT).
EXPOSE 3000

# OTel auto-instrumentation: the --require hook loads the SDK + instrumentations
# before user code, so http/fetch/aws-sdk/pg are traced automatically. The OTLP
# target is the cluster's Grafana Alloy collector at
# alloy.monitoring.svc.cluster.local:4318 (set via
# OTEL_EXPORTER_OTLP_ENDPOINT in the chart).
ENV NODE_OPTIONS="--require @opentelemetry/auto-instrumentations-node/register"

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "dist/index.js"]
