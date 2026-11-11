import { defineConfig, mergeConfig } from 'vitest/config'
import app from './vite.config.ts'

// The web app's own tests, in jsdom: what the hub's tests can't reach, as they run without a page. A test that waits for
// the screen to show something waits as long as a busy machine takes: the whole suite runs at once, and the machine
// that builds a release is a slow one. A test that passes pays nothing for the longer wait, and one that fails still
// fails, a little later.
export default mergeConfig(app, defineConfig({
  test: {
    environment: 'jsdom',
    include: ['test/**/*.test.{ts,tsx}'],
    restoreMocks: true,
    testTimeout: 30_000,
    hookTimeout: 60_000,
    setupFiles: ['./test/setup.ts'],
  },
}))
