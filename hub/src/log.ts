import { Redis } from 'ioredis'
import { forWire } from '../../shared/work.ts'
import type { Change, Entry } from '../../shared/state.ts'
import { log } from './logger.ts'

/** A change on its way into the log: everything but its version, which the log gives it. */
export type Unnumbered = Omit<Entry, 'version'>

/**
 * The hub's change log: every change, in one order, each with the next version. Readers catch up from a version they
 * have; `onAppend` says there's more to read (from this hub or another one sharing the same Redis).
 */
export interface ChangeLog {
  /** Appends a change, or returns 0 when the same client already sent one with this id. */
  append(entry: Unnumbered): Promise<number>
  read(after: number, limit?: number): Promise<Entry[]>
  latest(): Promise<number>
  /** Carries on from a version: a log that was lost, with its Binder's state saved at that version. */
  startAt(version: number): Promise<void>
  onAppend(listener: () => void): void
  /** Resolves once it hears of appends, so what's read after that misses nothing. */
  listening?(): Promise<void>
  close(): Promise<void>
  readonly kind: 'redis' | 'memory'
}

/** For tests and for running the hub with no Redis: one process, gone when it stops. */
export class MemoryLog implements ChangeLog {
  readonly kind = 'memory'
  private entries: Entry[] = []
  private seen = new Set<string>()
  private listeners: (() => void)[] = []
  /** The version before its first entry. */
  private base = 0

  async append(entry: Unnumbered) {
    const key = `${entry.client}:${entry.id}`
    if (this.seen.has(key)) return 0
    this.seen.add(key)
    const version = this.base + this.entries.length + 1
    this.entries.push({ ...entry, change: forWire(entry.change), version })
    queueMicrotask(() => this.listeners.forEach((listener) => listener()))
    return version
  }

  async read(after: number, limit = 1000) {
    const from = Math.max(0, after - this.base)
    return this.entries.slice(from, from + limit)
  }

  async latest() {
    return this.base + this.entries.length
  }

  async startAt(version: number) {
    this.base = version
    this.entries = []
  }

  onAppend(listener: () => void) {
    this.listeners.push(listener)
  }

  async close() {}
}

// The version and the stream entry in one step, so readers never see a gap, and a client's resend is dropped by its id.
// The stream id is the version itself ("12-0"), so reading after a version is a range read.
const appendScript = `
if redis.call('SET', KEYS[4], '1', 'NX', 'EX', 86400) == false then return 0 end
local floor = tonumber(ARGV[2]) or 0
if (tonumber(redis.call('GET', KEYS[2])) or 0) < floor then redis.call('SET', KEYS[2], floor) end
local v = redis.call('INCR', KEYS[2])
redis.call('XADD', KEYS[1], v .. '-0', 'e', ARGV[1])
redis.call('PUBLISH', KEYS[3], v)
return v
`

/** The log on Redis Streams: shared by every hub on the same Redis, and kept across restarts with persistence on. */
export class RedisLog implements ChangeLog {
  readonly kind = 'redis'
  readonly redis: Redis
  private subscriber: Redis
  private keys: { stream: string; version: string; channel: string; seen: string }
  private listeners: (() => void)[] = []
  private subscribed: Promise<unknown>
  /**
   * The highest version this hub has seen. Each append goes on from at least there, in the same step as it's numbered:
   * with Redis emptied under a running hub, a lower number would be read after by nobody.
   */
  private highest = 0

  constructor(url: string, space: string) {
    this.redis = new Redis(url, { lazyConnect: false, maxRetriesPerRequest: 3 })
    this.subscriber = new Redis(url, { lazyConnect: false })
    this.keys = { stream: `hub:${space}:log`, version: `hub:${space}:version`, channel: `hub:${space}:appended`, seen: `hub:${space}:seen:` }
    this.redis.defineCommand('hubAppend', { numberOfKeys: 4, lua: appendScript })
    // It goes on trying by itself. Without someone listening, each try is an "unhandled error" on stderr.
    for (const client of [this.redis, this.subscriber]) client.on('error', (error: Error) => log.warn({ why: error.message }, 'The change log can’t reach Redis'))
    this.subscribed = this.subscriber.subscribe(this.keys.channel).catch(() => {})
    this.subscriber.on('message', () => this.listeners.forEach((listener) => listener()))
  }

  async ping() {
    return (await this.redis.ping()) === 'PONG'
  }

  /** Subscribed, or Redis is away and a read will say so: a hub doesn't wait long to find out. */
  async listening() {
    await Promise.race([this.subscribed, new Promise((done) => { setTimeout(done, 3000).unref?.() })])
  }

  async append(entry: Unnumbered) {
    const { stream, version, channel, seen } = this.keys
    const run = (this.redis as unknown as { hubAppend: (...args: string[]) => Promise<number> }).hubAppend
    const given = Number(await run.call(this.redis, stream, version, channel, `${seen}${entry.client}:${entry.id}`, JSON.stringify({ ...entry, change: forWire(entry.change) }), String(this.highest)))
    this.highest = Math.max(this.highest, given)
    return given
  }

  async read(after: number, limit = 1000) {
    const rows = await this.redis.xrange(this.keys.stream, `${after + 1}-0`, '+', 'COUNT', limit)
    const entries = rows.map(([id, fields]) => {
      const entry = JSON.parse(fields[fields.indexOf('e') + 1]) as Unnumbered
      return { ...entry, version: Number(id.split('-')[0]) }
    })
    this.highest = Math.max(this.highest, entries.at(-1)?.version ?? 0)
    return entries
  }

  async startAt(version: number) {
    if ((await this.latest()) < version) await this.redis.set(this.keys.version, version)
    this.highest = Math.max(this.highest, version)
  }

  async latest() {
    return Number((await this.redis.get(this.keys.version)) ?? 0)
  }

  onAppend(listener: () => void) {
    this.listeners.push(listener)
  }

  async close() {
    this.subscriber.disconnect()
    this.redis.disconnect()
  }
}

export const isChange = (value: unknown): value is Change =>
  typeof value === 'object' && value !== null && typeof (value as { type?: unknown }).type === 'string'
