# @arix/server — multi-stage production build.
#
# Builder bundles src/ with tsup (esbuild) into dist/, leaving every real
# dependency external (pg, baileys, pino, pino-pretty, qrcode-terminal,
# bcryptjs, jose, express, cookie-parser, dotenv, openai, zod — the exact
# `dependencies` in package.json). Only app code gets inlined: pino's
# transport workers (pino-pretty) resolve their target module by path at
# runtime, and baileys leans on ESM/proto internals — both only work
# reliably left as real node_modules imports rather than bundled in. The
# runner stage then installs just those dependencies, pruned to
# production-only, so the final image never carries tsx/typescript/vitest/
# tsup or any other devDependency.
#
# Fallback if tsup/esbuild ever regresses on a Baileys/proto edge case:
# drop the `pnpm --filter @arix/server build` step and the dist/ copy below,
# add `tsx` to `dependencies` (not devDependencies), and CMD
# ["node_modules/.bin/tsx", "src/index.ts"] against the pruned prod deps —
# same two stages otherwise, just no bundling.
#
# Build context is the REPO ROOT, not this directory — required to reach the
# root pnpm-lock.yaml/pnpm-workspace.yaml for a workspace-aware, frozen-
# lockfile install of just this package. See docker-compose.yml
# (`server.build: {context: ., dockerfile: server/Dockerfile}`) and the root
# .dockerignore (patterns there are relative to the repo root, not here).

FROM node:24-slim AS builder
WORKDIR /app
RUN corepack enable

# Workspace manifests only, first — this layer only invalidates when a
# dependency actually changes, not on every source edit.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY server/package.json ./server/package.json
RUN pnpm install --frozen-lockfile --filter @arix/server

COPY server ./server
RUN pnpm --filter @arix/server build

# Pruned, production-only dependency tree for the runtime image. --legacy:
# pnpm v10's default deploy mode is for INJECTING other workspace packages as
# dependencies (`inject-workspace-packages`) — @arix/server has none, so the
# simpler legacy implementation (clone from the store, --prod to drop
# devDependencies) is exactly what's needed here.
RUN pnpm --filter=@arix/server deploy --prod --legacy /prod/server

FROM node:24-slim AS runner
WORKDIR /app

# poppler-utils provides `pdftoppm`, used to rasterize PDF receipts for vision.
RUN apt-get update \
  && apt-get install -y --no-install-recommends poppler-utils \
  && rm -rf /var/lib/apt/lists/*

COPY --from=builder /prod/server/node_modules ./node_modules
COPY --from=builder /prod/server/package.json ./package.json
COPY --from=builder /app/server/dist ./dist
# import.meta.url in the bundle resolves to dist/ itself (bundling erases the
# original per-file paths) — server/src/db/pool.ts's migration-dir resolver
# looks for a `db/migrations` sibling of dist/ as its bundled-mode fallback.
COPY --from=builder /app/server/src/db/migrations ./db/migrations

# Run as the image's built-in non-root user. Create the receipts mount point
# with the right ownership beforehand: Docker seeds a fresh named volume's
# permissions from whatever already exists at the mount point in the image.
RUN mkdir -p /app/data/receipts && chown -R node:node /app
USER node

ENV NODE_ENV=production
EXPOSE 3001
CMD ["node", "dist/index.js"]

# Break-glass staff bootstrap (the setup wizard is the normal path):
#   docker compose exec server node dist/create-staff.js <email> <password> [name]
