import { brotliCompress, constants, gzip } from 'node:zlib'
import { promisify } from 'node:util'
import { readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { extname, join } from 'node:path'

// A compressed copy beside each file the app fetches, for the hub to send to a browser that takes it. Done once here
// rather than on each request; a hub with nothing in front of it would otherwise send 3.6 MB of WebAssembly as it is.

const worthIt = new Set(['.js', '.css', '.html', '.svg', '.wasm', '.json', '.webmanifest'])
const smallest = 1024
const dist = join(import.meta.dirname, '..', 'dist')
const brotli = promisify(brotliCompress)
const gz = promisify(gzip)

const files = (await readdir(dist, { recursive: true })).map((file) => join(dist, file)).filter((file) => worthIt.has(extname(file)))

async function compress(file: string) {
  if ((await stat(file)).size < smallest) return
  const contents = await readFile(file)
  await writeFile(`${file}.br`, await brotli(contents, { params: { [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_SIZE_HINT]: contents.length } }))
  await writeFile(`${file}.gz`, await gz(contents, { level: 9 }))
}

// A few at a time: the largest take seconds each.
const queue = [...files]
await Promise.all(Array.from({ length: 6 }, async () => {
  for (let file = queue.shift(); file; file = queue.shift()) await compress(file)
}))
