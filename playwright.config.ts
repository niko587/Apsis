import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright runs against the PRODUCTION build (`vite preview`), not the dev
 * server: the artifact that ships is the one whose layout we are making claims
 * about. `npm run test:e2e` builds first.
 *
 * One worker, no retries. This machine has intermittent heavy load
 * (AI_DEVELOPMENT_PROTOCOL, "machine contention is real here") and its headless
 * Chromium software-rasterizes WebGL, so parallel browser contexts fight over
 * the same CPU. A flake retried into green is exactly the kind of check that
 * lies; if it fails, look at it.
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: !!process.env.CI,
  // The `github` reporter turns each failure into a `::error::` annotation.
  // Raw job logs need admin rights on the repository; annotations do not, so
  // this is the difference between a red badge and a readable diagnosis.
  reporter: process.env.CI ? [['github'], ['list']] : [['list']],
  timeout: 90_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: 'http://localhost:4173',
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'npx vite preview --port 4173 --strictPort',
    url: 'http://localhost:4173',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
