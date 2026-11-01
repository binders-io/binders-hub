import { defineConfig, mergeConfig } from 'vitest/config'
import app from './vite.config.ts'

// The web app's own tests, in jsdom: what the hub's tests can't reach, as they run without a page.
export default mergeConfig(app, defineConfig({
  test: { environment: 'jsdom', include: ['test/**/*.test.{ts,tsx}'], restoreMocks: true },
}))
