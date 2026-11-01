import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// The hub runs beside the web app; its API, live feed, sign-in, MCP and webhooks come through the same address.
const target = process.env.HUB_URL ?? 'http://127.0.0.1:4400'
const hub = Object.fromEntries(['/api', '/auth', '/setup', '/mcp', '/webhooks', '/runner', '/health', '/ready'].map((path) => [path, { target, ws: path === '/api', changeOrigin: false }]))

export default defineConfig({
  plugins: [react()],
  server: { proxy: hub, fs: { allow: ['..'] } },
  preview: { proxy: hub },
})
