import { cp, mkdir, rm } from 'node:fs/promises';

const appRoot = '.next/standalone/dashboard';

// Next standalone deliberately omits public assets and compiled static chunks.
// Mirror the production Dockerfile layout before starting the E2E server.
await mkdir(`${appRoot}/.next`, { recursive: true });
await rm(`${appRoot}/.next/static`, { recursive: true, force: true });
await rm(`${appRoot}/public`, { recursive: true, force: true });
await cp('.next/static', `${appRoot}/.next/static`, { recursive: true });
await cp('public', `${appRoot}/public`, { recursive: true });
