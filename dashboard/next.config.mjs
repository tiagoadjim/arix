import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const monorepoRoot = path.join(__dirname, '..');

/** @type {import('next').NextConfig} */
const SERVER_API_URL = process.env.SERVER_API_URL || 'http://localhost:3001';

const nextConfig = {
  output: 'standalone',
  reactStrictMode: true,
  // Pin the monorepo root explicitly when it's actually there — without
  // this, Next.js falls back to auto-detecting it from the nearest lockfile,
  // which can pick the wrong directory on a machine that happens to have
  // another pnpm lockfile further up the filesystem tree. The Docker build
  // context is the repo root (see docker-compose.yml / dashboard/Dockerfile),
  // so pnpm-workspace.yaml is normally present; existsSync still guards this
  // for non-Docker builds run from inside ./dashboard alone, where pinning a
  // parent that doesn't exist would make the standalone output nest an extra
  // directory level deep (`.next/standalone/app/server.js` instead of
  // `.next/standalone/server.js`) and break the Dockerfile's
  // `CMD ["node", "server.js"]`.
  outputFileTracingRoot: existsSync(path.join(monorepoRoot, 'pnpm-workspace.yaml'))
    ? monorepoRoot
    : __dirname,
  async rewrites() {
    // Proxy API calls to the server (same-origin in the browser → no CORS).
    return [{ source: '/api/:path*', destination: `${SERVER_API_URL}/api/:path*` }];
  },
};

export default nextConfig;
