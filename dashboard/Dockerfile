# @arix/dashboard — multi-stage production build (Next.js standalone output).
# No NEXT_PUBLIC_* needed: all data goes through the proxied /api (runtime),
# and middleware reads AUTH_JWT_SECRET / SERVER_API_URL at runtime.
#
# Build context is the REPO ROOT, not this directory — required to reach the
# root pnpm-lock.yaml/pnpm-workspace.yaml for a workspace-aware, frozen-
# lockfile install of just this package (previously this Dockerfile built
# from `./dashboard` alone with `--no-frozen-lockfile`, which could silently
# drift from the versions actually pinned in the root lockfile). See
# docker-compose.yml (`dashboard.build: {context: ., dockerfile:
# dashboard/Dockerfile}`) and the root .dockerignore (patterns there are
# relative to the repo root, not here) — mirrors server/Dockerfile's pattern.
#
# With the monorepo root visible in the build context, next.config.mjs's
# outputFileTracingRoot picks the repo root (it finds pnpm-workspace.yaml
# there) instead of falling back to `./dashboard` alone — which changes the
# standalone output layout: it nests one level deeper, under
# `.next/standalone/dashboard/`, with a shared/hoisted `node_modules` at
# `.next/standalone/node_modules`, instead of a flat `.next/standalone/`.
# The COPY paths and CMD below match that nested layout exactly (verified by
# running `pnpm --filter @arix/dashboard build` from the repo root and
# inspecting `dashboard/.next/standalone/`) — do not "flatten" these paths
# without re-verifying the actual build output first.

FROM node:24-slim AS builder
WORKDIR /app
RUN corepack enable

# Workspace manifests only, first — this layer only invalidates when a
# dependency actually changes, not on every source edit.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY dashboard/package.json ./dashboard/package.json
RUN pnpm install --frozen-lockfile --filter @arix/dashboard

# Next 15 runs ESLint as part of `next build`. Keep the same root flat config
# inside the builder so container builds enforce the React/Next rules too.
COPY eslint.config.js ./eslint.config.js
COPY dashboard ./dashboard

ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm --filter @arix/dashboard build

FROM node:24-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

# Standalone output tracing root is the repo root (see comment above), so it
# nests as `dashboard/server.js` + a shared `node_modules` — both land
# directly under WORKDIR when the whole `standalone/` dir is copied as-is.
COPY --from=builder /app/dashboard/.next/standalone ./
# public/ and .next/static are deliberately excluded from the standalone
# trace (Next.js docs) and must be copied alongside it explicitly.
COPY --from=builder /app/dashboard/public ./dashboard/public
COPY --from=builder /app/dashboard/.next/static ./dashboard/.next/static

# The standalone server only needs read access to its traced files and write
# access to Next's cache. Do not leave the internet-facing process as root.
RUN chown -R node:node /app
USER node

EXPOSE 3000
CMD ["node", "dashboard/server.js"]
