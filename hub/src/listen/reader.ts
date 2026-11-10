import http from 'node:http'
import https from 'node:https'
import type { Listener } from '../../../shared/listen.ts'
import type { Hub } from '../hub.ts'
import type { KV } from '../kv.ts'
import { log } from '../logger.ts'
import { refusal, safeLookup, type Reach } from '../tell.ts'
import { readFeed } from './feeds.ts'
import type { Inbox } from './inbox.ts'

// Asking, for a hub nothing can reach: every so often the hub reads each feed a listener names, and what is new there is
// handed to the Binder's inbox as if it had been posted. The hub reads an address a person typed, so it only reads out on
// the internet, over https, follows no redirect, and stops at a size. A feed says "nothing new" cheaply (its ETag), and
// that is honoured. Where a feed starts is where it is when first read: what was already there is left alone.

/** The most of a feed that's read, how long it has to answer, and the most taken from it in one look. */
export const feedMostBytes = 2_000_000
const answerWithinMs = 15_000
export const feedMostItems = 50

export interface Got {
  status: number
  body: string
  etag?: string
  modified?: string
}

/** Reads an address, saying what the last read was so an unchanged one answers 304 with nothing. Fails in words a person can read. */
export function getText(address: string, last: { etag?: string; modified?: string } = {}, reach: Reach = {}): Promise<Got> {
  const url = new URL(address)
  const host = url.hostname
  return new Promise((resolve, reject) => {
    const fail = (why: string) => {
      clearTimeout(timer)
      request.destroy()
      reject(new Error(why))
    }
    const request = (url.protocol === 'https:' ? https : http).request(url, {
      method: 'GET',
      agent: false,
      lookup: reach.thisMachineToo ? undefined : safeLookup,
      headers: { accept: 'application/feed+json, application/atom+xml, application/rss+xml, application/xml;q=0.9, application/json;q=0.8, */*;q=0.5', 'user-agent': 'Binders-hub', ...(last.etag ? { 'if-none-match': last.etag } : {}), ...(last.modified ? { 'if-modified-since': last.modified } : {}) },
    }, (response) => {
      const chunks: Buffer[] = []
      let size = 0
      response.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size > feedMostBytes) return fail(`${host}’s feed is larger than the hub reads.`)
        chunks.push(chunk)
      })
      response.on('end', () => {
        clearTimeout(timer)
        const header = (name: string) => (typeof response.headers[name] === 'string' ? (response.headers[name] as string).slice(0, 300) : undefined)
        resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8'), etag: header('etag'), modified: header('last-modified') })
      })
      response.on('error', () => fail(`${host} hung up.`))
    })
    const limit = reach.timeoutMs ?? answerWithinMs
    const timer = setTimeout(() => fail(`${host} didn’t answer within ${Math.max(1, Math.round(limit / 1000))} seconds.`), limit)
    request.on('error', (error: Error & { code?: string }) => {
      const code = error.code ?? ''
      fail(code === 'ENOTFOUND' || code === 'EAI_AGAIN' ? `Couldn’t find ${host}.` : code === 'ECONNREFUSED' ? `${host} refused the connection.` : /CERT|SELF_SIGNED|UNABLE_TO_VERIFY|HOSTNAME_MISMATCH|ERR_TLS/.test(code) ? `${host}’s certificate wasn’t accepted.` : `Couldn’t reach ${host}.`)
    })
    request.end()
  })
}

interface Cursor {
  /** When it was last read, in milliseconds. */
  asked: number
  etag?: string
  modified?: string
  /** It has been read once: what's there from now on is new. */
  started?: boolean
}

const cursorKey = (listener: string) => `feed-cursor:${listener}`

export class FeedReader {
  private hub: Hub
  private inbox: Inbox
  private kv: KV
  private reach: Reach
  private now: () => number
  private get: typeof getText
  private reading = false

  constructor(options: { hub: Hub; inbox: Inbox; kv: KV; reach?: Reach; now?: () => number; get?: typeof getText }) {
    this.hub = options.hub
    this.inbox = options.inbox
    this.kv = options.kv
    this.reach = options.reach ?? {}
    this.now = options.now ?? (() => Date.now())
    this.get = options.get ?? getText
  }

  private async cursorOf(id: string): Promise<Cursor | undefined> {
    try {
      const raw = await this.kv.get(cursorKey(id))
      return raw ? (JSON.parse(raw) as Cursor) : undefined
    } catch {
      return undefined
    }
  }

  /** Says on the listener why it can't be read, or that it can again: only when that changes, so the log isn't written each look. */
  private async say(listener: Listener, failing?: string) {
    const now = this.inbox.listener(listener.id)
    if (!now || (now.failing ?? '') === (failing ?? '')) return
    const { failing: _was, ...rest } = now
    await this.hub.record({ kind: 'hub' }, { type: 'listener.put', listener: failing ? { ...rest, failing } : rest })
  }

  /** Reads every feed that's due, one after another. A look already under way is left to finish. */
  async look() {
    if (this.reading) return
    this.reading = true
    try {
      for (const listener of this.inbox.listeners()) {
        if (listener.kind !== 'feed' || listener.mode === 'off' || !listener.url) continue
        const cursor = await this.cursorOf(listener.id)
        if (cursor && this.now() - cursor.asked < (listener.everyMinutes ?? 15) * 60_000) continue
        await this.read(listener, cursor).catch((err: unknown) => log.warn({ listener: listener.id, why: err instanceof Error ? err.message : String(err) }, 'Reading a listener’s feed failed'))
      }
    } finally {
      this.reading = false
    }
  }

  private async read(listener: Listener, cursor: Cursor | undefined) {
    const keep = (next: Partial<Cursor>) => this.kv.set(cursorKey(listener.id), JSON.stringify({ ...cursor, ...next, asked: this.now() }))
    const wrong = refusal(listener.url!, this.reach)
    if (wrong) {
      await keep({})
      return this.say(listener, wrong)
    }
    let got: Got
    try {
      got = await this.get(listener.url!, { etag: cursor?.etag, modified: cursor?.modified }, this.reach)
    } catch (err) {
      await keep({})
      return this.say(listener, err instanceof Error ? err.message : 'Couldn’t read it.')
    }
    const host = new URL(listener.url!).hostname
    if (got.status === 304) {
      await keep({})
      return this.say(listener)
    }
    if (got.status >= 300 && got.status < 400) {
      await keep({})
      return this.say(listener, `${host} says the feed has moved. Paste its new address.`)
    }
    if (got.status !== 200) {
      await keep({})
      return this.say(listener, `${host} answered ${got.status}.`)
    }
    const feed = readFeed(got.body)
    if (!feed) {
      await keep({})
      return this.say(listener, 'That address doesn’t read as a feed (RSS, Atom or JSON Feed).')
    }
    // The first read is where it starts: what's there already was there before anyone was listening.
    if (!cursor?.started) await this.inbox.seen(listener.id, feed.items.map((item) => item.sourceId))
    // Feeds list the newest first: what's new is taken oldest first, so it's filed in the order it happened.
    else await this.inbox.take(listener.id, feed.items.slice(0, feedMostItems).reverse())
    await keep({ etag: got.etag, modified: got.modified, started: true })
    return this.say(listener)
  }
}
