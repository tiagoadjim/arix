# Nico dashboard — Next.js (standalone output).
# No NEXT_PUBLIC_* needed: all data goes through the proxied /api (runtime),
# and middleware reads AUTH_JWT_SECRET / SERVER_API_URL at runtime.
FROM node:24-slim AS builder
WORKDIR /app
RUN corepack enable

COPY package.json ./
RUN pnpm install --prod=false --no-frozen-lockfile
COPY . .

ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm build

FROM node:24-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=builder /app/public ./public
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
EXPOSE 3000
CMD ["node", "server.js"]
