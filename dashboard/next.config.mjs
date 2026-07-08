/** @type {import('next').NextConfig} */
const SERVER_API_URL = process.env.SERVER_API_URL || 'http://localhost:3001';

const nextConfig = {
  output: 'standalone',
  reactStrictMode: true,
  async rewrites() {
    // Proxy API calls to the server (same-origin in the browser → no CORS).
    return [{ source: '/api/:path*', destination: `${SERVER_API_URL}/api/:path*` }];
  },
};

export default nextConfig;
