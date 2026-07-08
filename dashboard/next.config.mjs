import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const SERVER_API_URL = process.env.SERVER_API_URL || 'http://localhost:3001';

const nextConfig = {
  output: 'standalone',
  reactStrictMode: true,
  // Pin the monorepo root explicitly — without this Next.js falls back to
  // auto-detecting it from the nearest lockfile, which can pick the wrong
  // directory on a machine that happens to have another pnpm lockfile
  // further up the filesystem tree.
  outputFileTracingRoot: path.join(__dirname, '..'),
  async rewrites() {
    // Proxy API calls to the server (same-origin in the browser → no CORS).
    return [{ source: '/api/:path*', destination: `${SERVER_API_URL}/api/:path*` }];
  },
};

export default nextConfig;
