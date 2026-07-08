# Nico server — Baileys gateway + agent. Runs TypeScript directly via tsx.
FROM node:24-slim

WORKDIR /app
# poppler-utils provides `pdftoppm` to rasterize PDF receipts for vision.
RUN apt-get update \
  && apt-get install -y --no-install-recommends poppler-utils \
  && rm -rf /var/lib/apt/lists/*
RUN corepack enable

# Install deps (incl. tsx/typescript which live in devDependencies).
COPY package.json ./
RUN pnpm install --prod=false --no-frozen-lockfile

COPY . .

ENV NODE_ENV=production
EXPOSE 3001
CMD ["pnpm", "start"]
