import { defineConfig } from 'tsup';

// Bundles ONLY this package's own src/ into dist/ — every real dependency
// stays external and is installed for real (pruned, prod-only) in the
// Dockerfile's runner stage. This sidesteps the well-known failure modes of
// bundling Node-native/worker-thread-y deps like `pg`, `baileys`, and
// `pino`/`pino-pretty` (pino's transport workers resolve transport modules
// by path at runtime — that only works if pino itself was never inlined).
export default defineConfig({
  entry: {
    index: 'src/index.ts',
    // Second entry: keeps the `create-staff` break-glass CLI runnable in the
    // built image (`node dist/create-staff.js <email> <password> [name]`).
    'create-staff': 'src/scripts/create-staff.ts',
  },
  outDir: 'dist',
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  splitting: false,
  sourcemap: false,
  clean: true,
  dts: false,
  external: [
    'pg',
    'baileys',
    'pino',
    'pino-pretty',
    'qrcode-terminal',
    'bcryptjs',
    'jose',
    'express',
    'cookie-parser',
    'dotenv',
    'openai',
    'zod',
  ],
});
