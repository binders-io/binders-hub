import { gzipSync } from 'node:zlib'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// What a browser takes on opening the app: every script and stylesheet index.html names, modulepreloads included, gzipped.
// The largest chunk alone would hide most of it. Run after a build; the Dockerfile's test stage fails over the budget.

const budget = 350_000
const dist = join(import.meta.dirname, '..', 'dist')
const html = readFileSync(join(dist, 'index.html'), 'utf8')
const files = [...new Set([...html.matchAll(/\/assets\/[^"]+\.(?:js|css)/g)].map((m) => m[0]))]
if (!files.length) throw new Error('index.html names no assets: is this a build?')

const sizes = files.map((file) => ({ file, size: gzipSync(readFileSync(join(dist, file)), { level: 9 }).length })).sort((a, b) => b.size - a.size)
const total = sizes.reduce((sum, { size }) => sum + size, 0)
for (const { file, size } of sizes.slice(0, 8)) console.log(`${(size / 1000).toFixed(1).padStart(8)} KB  ${file}`)
console.log(`${(total / 1000).toFixed(1).padStart(8)} KB  on opening the app, of ${budget / 1000} KB`)

if (total > budget) {
  console.error(`Over budget by ${((total - budget) / 1000).toFixed(1)} KB.`)
  process.exit(1)
}
