import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const monorepoRoot = path.join(__dirname, '..');

/** @type {import('next').NextConfig} */
// Next's development runtime and React Refresh evaluate generated modules.
// Permit that only for `next dev`; production keeps the stricter policy.
const SCRIPT_SRC = process.env.NODE_ENV === 'production'
  ? "script-src 'self' 'unsafe-inline'"
  : "script-src 'self' 'unsafe-inline' 'unsafe-eval'";
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "style-src 'self' 'unsafe-inline'",
  SCRIPT_SRC,
  "connect-src 'self'",
].join('; ');

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
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          {
            key: 'Content-Security-Policy',
            value: CONTENT_SECURITY_POLICY,
          },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
        ],
      },
    ];
  },
};

export default nextConfig;
