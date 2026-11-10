import { randomBytes } from 'node:crypto'
import { hostname } from 'node:os'
import type { Redis } from 'ioredis'
import { log } from './logger.ts'

/** Small things the hub keeps outside the log: sessions, agent tokens' hashes, what a saver last wrote. */
export interface KV {
  get(key: string): Promise<string | undefined>
  set(key: string, value: string, ttlSeconds?: number): Promise<void>
  del(key: string): Promise<void>
  /** Reads a key and removes it as one step: of two takers at once, only one gets it. */
  take(key: string): Promise<string | undefined>
}

export class MemoryKV implements KV {
  private values = new Map<string, { value: string; until?: number }>()

  async get(key: string) {
    const found = this.values.get(key)
    if (!found) return undefined
    if (found.until && found.until < Date.now()) {
      this.values.delete(key)
      return undefined
    }
    return found.value
  }

  async set(key: string, value: string, ttlSeconds?: number) {
    this.values.set(key, { value, until: ttlSeconds ? Date.now() + ttlSeconds * 1000 : undefined })
  }

  async del(key: string) {
    this.values.delete(key)
  }

  async take(key: string) {
    const value = await this.get(key)
    this.values.delete(key)
    return value
  }
}

export class RedisKV implements KV {
  private redis: Redis
  private prefix: string

  constructor(redis: Redis, space: string) {
    this.redis = redis
    this.prefix = `hub:${space}:kv:`
  }

  async get(key: string) {
    return (await this.redis.get(this.prefix + key)) ?? undefined
  }

  async set(key: string, value: string, ttlSeconds?: number) {
    if (ttlSeconds) await this.redis.set(this.prefix + key, value, 'EX', ttlSeconds)
    else await this.redis.set(this.prefix + key, value)
  }

  async del(key: string) {
    await this.redis.del(this.prefix + key)
  }

  /** Every key with no time limit, but those `skip` says to leave. */
  async lasting(skip: (key: string) => boolean) {
    const found: [string, string][] = []
    let cursor = '0'
    do {
      const [next, keys] = await this.redis.scan(cursor, 'MATCH', `${this.prefix}*`, 'COUNT', 500)
      for (const name of keys) {
        const key = name.slice(this.prefix.length)
        if (skip(key) || (await this.redis.ttl(name)) !== -1) continue
        const value = await this.redis.get(name)
        if (value !== null) found.push([key, value])
      }
      cursor = next
    } while (cursor !== '0')
    return found
  }

  // MULTI, so it doesn't need a Redis new enough for GETDEL.
  async take(key: string) {
    const name = this.prefix + key
    const [read] = (await this.redis.multi().get(name).del(name).exec()) ?? []
    if (read?.[0]) throw read[0]
    return typeof read?.[1] === 'string' ? read[1] : undefined
  }
}

/** How long a hub's lease lasts, how often it's renewed, and how long a hub waits for another's to lapse. */
export interface LeaseTimes {
  ttlMs: number
  renewMs: number
  waitMs: number
  /** How often a hub that's waiting looks again. */
  pollMs: number
}

export const defaultLeaseTimes: LeaseTimes = { ttlMs: 30_000, renewMs: 10_000, waitMs: 40_000, pollMs: 1_000 }

// Each only while the key still holds this hub's own mark: a lease that lapsed and went to another hub isn't touched.
const renewScript = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('PEXPIRE', KEYS[1], ARGV[2]) end return 0`
const releaseScript = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0`

/**
 * What keeps a second hub off a Redis the first is using. One hub process merges, posts issues and asks GitHub, and a
 * second would do each of them again. The running hub holds a key in Redis for a short time and renews it; one that
 * finds it held waits for it to lapse, which is how a hub that was restarted takes over from its earlier self, and
 * then gives up. Stopping releases it, so the next hub starts at once.
 */
export class HubLease {
  /** What identifies this process in the key: no other hub has the same. */
  readonly id: string
  private redis: Redis
  private key: string
  private times: LeaseTimes
  private timer?: NodeJS.Timeout
  private lost?: (holder?: string) => void
  private waiting?: (holder?: string) => void

  /**
   * `onWait` is called once, when another hub holds it and this one starts to wait. `onLost` is called when a renewal
   * finds another hub holding it, which is only after Redis was away for the whole time it lasts.
   */
  constructor(redis: Redis, options: Partial<LeaseTimes> & { key?: string; id?: string; onLost?: (holder?: string) => void; onWait?: (holder?: string) => void } = {}) {
    const { key, id, onLost, onWait, ...times } = options
    this.redis = redis
    this.key = key ?? 'hub:_hub:lease'
    this.id = id ?? `${hostname()}:${process.pid}:${randomBytes(4).toString('hex')}`
    this.times = { ...defaultLeaseTimes, ...times }
    this.lost = onLost
    this.waiting = onWait
  }

  /** Takes the lease, waiting for another hub's to lapse. Otherwise says who holds it. */
  async take(): Promise<{ held: true } | { held: false; holder?: string }> {
    const end = Date.now() + this.times.waitMs
    let told = false
    for (;;) {
      if ((await this.redis.set(this.key, this.id, 'PX', this.times.ttlMs, 'NX')) === 'OK') break
      const holder = (await this.redis.get(this.key)) ?? undefined
      if (holder === this.id) break
      if (Date.now() >= end) return { held: false, holder }
      if (!told) this.waiting?.(holder)
      told = true
      await new Promise((done) => setTimeout(done, this.times.pollMs))
    }
    this.timer = setInterval(() => void this.renew(), this.times.renewMs)
    this.timer.unref()
    return { held: true }
  }

  private async renew() {
    try {
      if (Number(await this.redis.eval(renewScript, 1, this.key, this.id, this.times.ttlMs)) === 1) return
      // Gone: Redis was emptied, or it lapsed while Redis was away. Take it again unless another hub has.
      if ((await this.redis.set(this.key, this.id, 'PX', this.times.ttlMs, 'NX')) === 'OK') return
      const holder = (await this.redis.get(this.key)) ?? undefined
      if (holder === this.id) return
      this.stopRenewing()
      this.lost?.(holder)
    } catch (error) {
      // Redis is away: the next try says.
      log.warn({ why: (error as Error).message }, 'Couldn’t renew the hub’s lease on Redis')
    }
  }

  private stopRenewing() {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
  }

  /** Lets go, so the next hub needn't wait. */
  async release() {
    this.stopRenewing()
    await this.redis.eval(releaseScript, 1, this.key, this.id).catch(() => undefined)
  }
}
