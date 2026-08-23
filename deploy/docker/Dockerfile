# syntax=docker/dockerfile:1.7
FROM node:22.23.2-bookworm-slim@sha256:d649c27dae7ba0137b3cef5dd75baa422c08dc3d9e3fc0c23dfb172dc3cc6436 AS toolchain

ENV NEXT_TELEMETRY_DISABLED=1
ENV TURBO_TELEMETRY_DISABLED=1
# Install the exact package-manager version through npm's integrity-checked
# registry path instead of relying on a mutable Corepack download.
RUN npm install --global pnpm@11.18.0 && pnpm --version
WORKDIR /app

FROM toolchain AS build
ARG NEXT_PUBLIC_API_BASE_URL=http://127.0.0.1:13100/v1
ENV NEXT_PUBLIC_API_BASE_URL=${NEXT_PUBLIC_API_BASE_URL}
COPY . .
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm config set store-dir /pnpm/store && pnpm install --frozen-lockfile
RUN pnpm build

# The first staging image intentionally keeps the frozen workspace install so
# pnpm workspace symlinks and native modules are byte-for-byte identical to the
# verified build. A later registry optimization may prune layers without
# changing this runtime contract.
FROM toolchain AS runtime
ENV NODE_ENV=production
COPY --from=build --chown=node:node /app /app
USER node

FROM runtime AS api
EXPOSE 3100
HEALTHCHECK --interval=10s --timeout=5s --start-period=20s --retries=12 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3100/v1/health/live').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
CMD ["node", "apps/api/dist/main.js"]

FROM runtime AS worker
CMD ["node", "apps/worker/dist/main.js"]

FROM runtime AS web
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=5s --start-period=20s --retries=12 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
CMD ["node", "apps/web/node_modules/next/dist/bin/next", "start", "apps/web", "-p", "3000"]

FROM runtime AS migrate
CMD ["node", "packages/db/dist/cli/migrate.js", "up"]
