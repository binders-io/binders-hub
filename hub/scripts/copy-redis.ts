import { Redis } from 'ioredis'

// Copies a hub's keys (hub:…: every Binder's, and the hub's own in hub:_hub:…; or one Binder's with --space) from one
// Redis to another, for moving a hub to a server. It goes key by key, so
// the two Redis versions don't have to match: strings with what's left of their expiry, and streams entry by entry
// with the same ids. The target's keys for the space are replaced only when asked (--replace), and the hub using the
// target should be stopped while it runs.
//
//   node scripts/copy-redis.ts --from redis://127.0.0.1:6390 --to redis://127.0.0.1:6399 [--space <binder>] [--replace]

const args = process.argv.slice(2)
const arg = (name: string) => {
  const at = args.indexOf(`--${name}`)
  return at >= 0 ? args[at + 1] : undefined
}
const fromUrl = arg('from')
const toUrl = arg('to')
const space = arg('space')
const replace = args.includes('--replace')
if (!fromUrl || !toUrl) {
  console.error('Usage: node scripts/copy-redis.ts --from redis://… --to redis://… [--space <binder>] [--replace]')
  process.exit(2)
}

const from = new Redis(fromUrl, { lazyConnect: true })
const to = new Redis(toUrl, { lazyConnect: true })
await from.connect()
await to.connect()
const pattern = space ? `hub:${space}:*` : 'hub:*'
const what = space ?? 'the hub'

async function keysOf(redis: Redis) {
  const keys: string[] = []
  let cursor = '0'
  do {
    const [next, batch] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 1000)
    keys.push(...batch)
    cursor = next
  } while (cursor !== '0')
  return keys
}

const there = await keysOf(to)
if (there.length && !replace) {
  console.error(`The target already has ${there.length} keys for ${what}. Run again with --replace to replace them.`)
  process.exit(1)
}
for (let i = 0; i < there.length; i += 500) await to.unlink(...there.slice(i, i + 500))

const counts = { strings: 0, streams: 0, entries: 0 }
for (const key of await keysOf(from)) {
  const type = await from.type(key)
  if (type === 'string') {
    const value = await from.getBuffer(key)
    if (value === null) continue
    const left = await from.pttl(key)
    if (left > 0) await to.set(key, value, 'PX', left)
    else if (left === -1) await to.set(key, value)
    counts.strings++
  } else if (type === 'stream') {
    let start = '-'
    for (;;) {
      const rows = await from.xrangeBuffer(key, start, '+', 'COUNT', 1000)
      if (!rows.length) break
      const batch = to.pipeline()
      for (const [id, fields] of rows) batch.xadd(key, id.toString(), ...fields)
      const results = await batch.exec()
      const failed = results?.find(([error]) => error)
      if (failed) throw failed[0]
      counts.entries += rows.length
      start = `(${rows[rows.length - 1][0].toString()}`
    }
    // Ids handed out and since deleted aren't handed out again.
    const info = (await from.xinfo('STREAM', key)) as unknown[]
    const last = info[info.indexOf('last-generated-id') + 1]
    if (typeof last === 'string' && last !== '0-0') await to.xsetid(key, last)
    counts.streams++
  } else {
    throw new Error(`${key} is a ${type}; this only copies strings and streams.`)
  }
}

console.log(`Copied ${counts.strings} strings and ${counts.streams} streams (${counts.entries} entries) for ${what}.`)
await from.quit()
await to.quit()
