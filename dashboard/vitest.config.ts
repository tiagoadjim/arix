import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      // Mirrors the `@/*` path mapping in tsconfig.json. Without it, any test
      // that reaches a component (rather than a leaf module in src/lib) fails
      // to resolve the first `@/` import it hits.
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    environment: 'jsdom',
    include: ['test/**/*.test.{ts,tsx}'],
    setupFiles: ['./test/setup.ts'],
    clearMocks: true,
    restoreMocks: true,
  },
});
