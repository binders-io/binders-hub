import type { Redis } from 'ioredis'

/** Small things the hub keeps outside the log: sessions, agent tokens' hashes, what a saver last wrote. */
export interface KV {
  get(key: string): Promise<string | undefined>
  set(key: string, value: string, ttlSeconds?: number): Promise<void>
  del(key: string): Promise<void>
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
}
