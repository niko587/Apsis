import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    // `/api` is served by a SEPARATE process (`npm run dev:api`, port 8787) so
    // the vendor credential never enters the Vite process. This proxy holds no
    // secret — only a route — and gives development the same single origin the
    // deployed app has, so the browser code path is identical in both.
    proxy: { '/api': { target: 'http://localhost:8787', changeOrigin: false } },
  },
  test: {
    // Vitest's default include globs (`**/*.spec.ts` among them) otherwise
    // collect `e2e/reachability.spec.ts`, which is Playwright's and needs a
    // browser — `npx vitest run` would fail on a file it should never open.
    // Two runners, two directories, no overlap: unit tests live beside their
    // modules under src/, browser tests live in e2e/.
    exclude: ['**/node_modules/**', '**/dist/**', 'e2e/**'],
  },
})
