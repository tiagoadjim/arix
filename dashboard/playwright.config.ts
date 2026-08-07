import { defineConfig, devices } from '@playwright/test';

// Match the hostname emitted by Next's standalone server for middleware
// redirects. Keeping one hostname also makes the host-only session cookie
// survive the agent-role redirect exercised by the authorization test.
const dashboardUrl = 'http://localhost:3100';
const mockApiUrl = 'http://127.0.0.1:3101';
const authSecret = 'e2e-auth-secret-at-least-32-characters';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: 'line',
  outputDir: 'test-results/e2e',
  use: {
    baseURL: dashboardUrl,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    {
      // The functional suite asserts against the desktop two-pane layout, so
      // it stays on one wide viewport. Layout behaviour is covered separately.
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
      testIgnore: /responsive\.spec\.ts/,
    },
    {
      name: 'mobile',
      use: { ...devices['Pixel 5'] },
      testMatch: /responsive\.spec\.ts/,
    },
    {
      // Tablet portrait: past the `md` breakpoint that restores the two-pane
      // console, but short of the `xl` one that docks the details column — the
      // band where both layouts have to hold up at once. Spelled out rather
      // than taken from `devices` because the iPad presets default to WebKit.
      name: 'tablet',
      use: { ...devices['Desktop Chrome'], viewport: { width: 820, height: 1180 }, hasTouch: true },
      testMatch: /responsive\.spec\.ts/,
    },
  ],
  webServer: [
    {
      name: 'mock-api',
      command: 'node e2e/mock-api.mjs',
      url: `${mockApiUrl}/__e2e/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
      stdout: 'pipe',
      stderr: 'pipe',
    },
    {
      name: 'dashboard',
      command:
        'pnpm exec next build && node e2e/prepare-standalone.mjs && node .next/standalone/dashboard/server.js',
      url: `${dashboardUrl}/login`,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        SERVER_API_URL: mockApiUrl,
        AUTH_JWT_SECRET: authSecret,
        HOSTNAME: 'localhost',
        PORT: '3100',
      },
    },
  ],
});
