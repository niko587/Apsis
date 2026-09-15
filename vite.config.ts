import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  test: {
    // Vitest's default include globs (`**/*.spec.ts` among them) otherwise
    // collect `e2e/reachability.spec.ts`, which is Playwright's and needs a
    // browser — `npx vitest run` would fail on a file it should never open.
    // Two runners, two directories, no overlap: unit tests live beside their
    // modules under src/, browser tests live in e2e/.
    exclude: ['**/node_modules/**', '**/dist/**', 'e2e/**'],
  },
})
