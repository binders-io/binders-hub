import { lookup as dnsLookup } from 'node:dns'
import http from 'node:http'
import https from 'node:https'
import type { LookupFunction } from 'node:net'
import { waitingOn, type Waiting } from '../../shared/waiting.ts'
import type { HubState } from '../../shared/state.ts'
import { onOwnNetwork } from './brain/settings.ts'
import { Refused } from './hub.ts'
import type { KV } from './kv.ts'
import { log } from './logger.ts'
import type { Sealer } from './secrets.ts'

// A Binder that tells a channel: when something starts waiting on someone (the one list, shared/waiting.ts), it posts a
// line to an address a person pasted, an incoming webhook from Slack or anything else that takes a JSON post. Nothing
// reaches a person who isn't in the app otherwise. The address is a secret (Slack's carries its key in the path), so it
// is kept sealed in the Binder's own store, never sent back to a browser and never written to the log. The hub posts to
// what a person typed, so it only posts out on the internet, over https, and follows no redirects.

/** How often the hub looks for what began waiting. */
export const everyMs = 30_000
/** The most rows told about in one pass; beyond that, one more post says how many others. */
export const mostPerPass = 10
/** How long after a failed post the next try waits: the first failure, the second, then every third and after. */
export const tryAgainAfter = [60_000, 5 * 60_000, 30 * 60_000]
const answerWithinMs = 10_000

export interface Reach {
  /**
   * Also posts to this machine and its network, over http. Only for a test's stand-in server: the hub never sets it.
   */
  thisMachineToo?: boolean
  /** For a test: how long a post waits for an answer, in milliseconds (ten seconds). */
  timeoutMs?: number
}

/** Something that went wrong that a person can read as it is. */
class Failed extends Error {}

/** Whether a host (a name or an address) is this machine or its network, which `onOwnNetwork` doesn't tell for every spelling. */
export function onThisNetwork(host: string) {
  let name = host.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '')
  // An IPv4 address inside an IPv6 one (::ffff:10.0.0.1, which the web's address parser writes ::ffff:a00:1).
  const mapped = /^::ffff:(?:(\d+\.\d+\.\d+\.\d+)|([0-9a-f]{1,4}):([0-9a-f]{1,4}))$/.exec(name)
  if (mapped) {
    const [high, low] = [parseInt(mapped[2] ?? '0', 16), parseInt(mapped[3] ?? '0', 16)]
    name = mapped[1] ?? `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`
  }
  const first = /^(\d+)\.\d+\.\d+\.\d+$/.exec(name)
  // 0.0.0.0 reaches this machine on some systems, and 224 and up isn't an address of anyone's.
  if (first && (Number(first[1]) === 0 || Number(first[1]) >= 224)) return true
  if (name === '::') return true
  return onOwnNetwork(`https://${name.includes(':') ? `[${name}]` : name}`)
}

/** Why the hub won't post to an address, in plain words, or undefined when it will. Checked when it's set and before each post. */
export function refusal(address: string, reach: Reach = {}): string | undefined {
  let url: URL
  try {
    url = new URL(address)
  } catch {
    return 'That isn’t a web address. Paste the whole thing, starting with https://.'
  }
  if (url.protocol !== 'https:' && !(reach.thisMachineToo && url.protocol === 'http:')) return 'The address has to start with https://, so what’s sent can’t be read on the way.'
  if (url.username || url.password) return 'The address can’t have a name or password in it.'
  if (!reach.thisMachineToo && onThisNetwork(url.hostname)) return `${url.hostname} is on this hub’s own network. The hub only tells addresses out on the internet.`
  return undefined
}

/** Finds a name's address as usual and refuses one on this machine's network: a name can point anywhere. */
export const safeLookup: LookupFunction = (hostname, options, callback) => {
  dnsLookup(hostname, options, (error, address, family) => {
    if (error) return callback(error, address as string, family as number)
    const found = Array.isArray(address) ? address.map((a) => a.address) : [address]
    if (found.some(onThisNetwork)) return callback(new Failed(`${hostname} points at this hub’s own network. The hub only tells addresses out on the internet.`), '', 0)
    callback(null, address as string, family as number)
  })
}

export interface Answer {
  status: number
  /** The start of what it said back, on one line. */
  text: string
}

/** Posts JSON once, with no redirect followed and no more than ten seconds in all. Throws a `Failed` that reads as it is. */
export function postJson(address: string, body: unknown, reach: Reach = {}): Promise<Answer> {
  const url = new URL(address)
  const payload = JSON.stringify(body)
  const host = url.hostname
  return new Promise((resolve, reject) => {
    const request = (url.protocol === 'https:' ? https : http).request(url, {
      method: 'POST',
      agent: false,
      lookup: reach.thisMachineToo ? undefined : safeLookup,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), 'user-agent': 'Binders-hub' },
    }, (response) => {
      let text = ''
      response.setEncoding('utf8')
      response.on('data', (chunk: string) => {
        if (text.length < 300) text += chunk
      })
      response.on('end', () => {
        clearTimeout(timer)
        resolve({ status: response.statusCode ?? 0, text: text.replace(/\s+/g, ' ').trim().slice(0, 200) })
      })
      response.on('error', (error) => fail(error))
    })
    const fail = (error: Error & { code?: string }) => {
      clearTimeout(timer)
      request.destroy()
      if (error instanceof Failed) return reject(error)
      if (error.code === 'ENOTFOUND' || error.code === 'EAI_AGAIN') return reject(new Failed(`Couldn’t find ${host}.`))
      if (error.code === 'ECONNREFUSED') return reject(new Failed(`${host} refused the connection.`))
      if (error.code === 'ECONNRESET') return reject(new Failed(`${host} hung up.`))
      if (/CERT|SELF_SIGNED|UNABLE_TO_VERIFY|HOSTNAME_MISMATCH|ERR_TLS/.test(error.code ?? '')) return reject(new Failed(`${host}’s certificate wasn’t accepted.`))
      reject(new Failed(`Couldn’t reach ${host}.`))
    }
    const limit = reach.timeoutMs ?? answerWithinMs
    const timer = setTimeout(() => fail(new Failed(`${host} didn’t answer within ${Math.max(1, Math.round(limit / 1000))} second${limit > 1500 ? 's' : ''}.`)), limit)
    request.on('error', fail)
    request.end(payload)
  })
}

/** What a post last came to, for Settings to show. */
export interface Last {
  at: string
  ok: boolean
  /** In words: what the address answered, or why it couldn’t be reached. */
  answered: string
}

/** How it stands, as a browser may see it: never the address, only its host. */
export interface TellStatus {
  set: boolean
  host?: string
  last?: Last
  /** After a failed post, when the next try is, as an ISO date. */
  retryAt?: string
}

interface Kept {
  sealed: string
  host: string
}

export interface TellerDeps {
  /** The Binder's state now. */
  state: () => HubState
  /** The Binder's name, and whether the hub has several, which is when its name leads each message. */
  name: () => string
  several: () => boolean
  /** The Binder's address on this hub, with no slash at the end: what a message links to is built on it. */
  base: string
  reach?: Reach
  /** For tests: how often to look, and what time it is. */
  everyMs?: number
  now?: () => number
}

/** Slack reads < > & in a message as its own markup: a card titled "<!channel>" mustn't call everyone. */
const plain = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const oneLine = (text: string, most: number) => {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > most ? `${flat.slice(0, most - 1).trimEnd()}…` : flat
}

/**
 * One Binder's telling: the address it has, what's waiting that was told already, and what's still to tell. A pass
 * every thirty seconds posts each row that wasn't waiting before, once.
 */
export class Teller {
  private kv: KV
  private sealer: Sealer
  private space: string
  private deps: TellerDeps
  private address?: string
  private host?: string
  private last?: Last
  private fails = 0
  private retryAt = 0
  /** The ids of what's waiting now and was told, or was already there when the address was set or the hub started. */
  private known = new Set<string>()
  /** What's waiting and not told yet: a post that failed leaves its rows here for the next one. */
  private pending = new Map<string, Waiting>()
  private timer?: ReturnType<typeof setInterval>
  private busy = false
  /** Changes with the address, so a pass under way doesn't post one address's rows to another. */
  private generation = 0

  constructor(kv: KV, sealer: Sealer, space: string, deps: TellerDeps) {
    this.kv = kv
    this.sealer = sealer
    this.space = space
    this.deps = deps
  }

  private get key() {
    return `tell:${this.space}`
  }

  private now() {
    return this.deps.now?.() ?? Date.now()
  }

  async load() {
    const raw = await this.kv.get(`${this.key}:settings`).catch(() => undefined)
    if (raw) {
      try {
        const kept = JSON.parse(raw) as Kept
        this.address = this.sealer.open(kept.sealed)
        this.host = kept.host
      } catch {
        // Not an address this hub sealed: as good as none.
        this.address = undefined
      }
    }
    const last = await this.kv.get(`${this.key}:last`).catch(() => undefined)
    if (last && this.address) {
      try {
        this.last = JSON.parse(last) as Last
      } catch {
        this.last = undefined
      }
    }
  }

  /** Starts looking. What's waiting now isn't told: it was there before. */
  start() {
    this.seed()
    this.timer = setInterval(() => {
      this.pass().catch((error: Error) => log.warn({ binder: this.space, why: error.message }, 'Telling a channel failed'))
    }, this.deps.everyMs ?? everyMs)
    this.timer.unref()
  }

  stop() {
    clearInterval(this.timer)
    this.timer = undefined
    this.generation++
  }

  get set() {
    return !!this.address
  }

  status(): TellStatus {
    return {
      set: !!this.address,
      host: this.host,
      last: this.last,
      retryAt: this.address && this.retryAt > this.now() ? new Date(this.retryAt).toISOString() : undefined,
    }
  }

  /** What's waiting now counts as told. */
  private seed() {
    this.known = new Set(this.address ? waitingOn(this.deps.state(), undefined).map((row) => row.id) : [])
    this.pending.clear()
  }

  /** Sets the address, after checking it. What's waiting now isn't told; what starts waiting from now on is. */
  async configure(raw: string) {
    const address = raw.trim()
    if (!address) throw new Refused('Paste the channel’s address.')
    if (address.length > 2000) throw new Refused('That address is too long to be one.')
    const why = refusal(address, this.deps.reach)
    if (why) throw new Refused(why)
    this.address = address
    this.host = new URL(address).host
    this.last = undefined
    this.fails = 0
    this.retryAt = 0
    this.generation++
    this.seed()
    await this.kv.set(`${this.key}:settings`, JSON.stringify({ sealed: this.sealer.seal(address), host: this.host } satisfies Kept))
    await this.kv.del(`${this.key}:last`)
    return this.status()
  }

  /** Stops telling. The address is forgotten. */
  async forget() {
    this.address = undefined
    this.host = undefined
    this.last = undefined
    this.fails = 0
    this.retryAt = 0
    this.generation++
    this.known.clear()
    this.pending.clear()
    await this.kv.del(`${this.key}:settings`)
    await this.kv.del(`${this.key}:last`)
  }

  /** Posts one line to see that it arrives. A try that fails changes nothing about when the rows are tried again. */
  async test() {
    const home = `${this.deps.base}/#/home`
    const text = `${this.prefix()}This is a test from Binders. When something starts waiting here, it’s posted to this channel. ${home}`
    const sent = await this.post({ text, kind: 'test', binder: this.deps.name(), url: home })
    if (sent.ok) {
      this.fails = 0
      this.retryAt = 0
    }
    return { ok: sent.ok, answered: sent.answered }
  }

  /** The Binder's name and a colon, when the hub has several Binders. */
  private prefix() {
    return this.deps.several() ? `${plain(this.deps.name())}: ` : ''
  }

  /** Who a row waits on, when it's one person who isn't everyone in particular: from what the row is about. */
  private whoFor(row: Waiting) {
    if (row.for !== 'others') return undefined
    const state = this.deps.state()
    if (row.about.type === 'note') return state.notes.find((n) => n.id === row.about.id)?.locked?.by
    const card = state.cards.find((c) => c.id === row.about.id)
    if (!card) return undefined
    if (row.kind === 'permission') return state.agents.find((a) => a.id === card.permission?.agent)?.owner
    // A question is on its agent's owner, else on the person who made the card, unless the hub or an agent did.
    const maker = card.createdBy && card.createdBy !== 'hub' && !state.agents.some((a) => a.id === card.createdBy) ? card.createdBy : undefined
    return state.agents.find((a) => a.id === card.agentId)?.owner ?? maker
  }

  private link(row: Waiting) {
    const about = row.about
    const path = about.type === 'card' ? `work/${encodeURIComponent(about.id)}` : about.type === 'note' ? `notes/${encodeURIComponent(about.id)}` : about.type === 'changeSet' ? `changes/${encodeURIComponent(about.id)}` : 'delivery'
    return `${this.deps.base}/#/${path}`
  }

  /** What's posted for a row: Slack's `text`, and the rest for whatever else is listening. */
  message(row: Waiting) {
    const who = this.whoFor(row)
    const url = this.link(row)
    const text = `${this.prefix()}${plain(oneLine(row.title, 120))}: ${plain(oneLine(row.detail, 300))}${who ? ` (for ${plain(who)})` : ''} ${url}`
    return { text, kind: row.kind, binder: this.deps.name(), url, ...(who ? { for: who } : {}) }
  }

  /** One post, its result kept. It never throws: a failure is `ok: false`, with why. */
  private async post(body: object): Promise<{ ok: boolean; answered: string }> {
    const address = this.address
    if (!address) return { ok: false, answered: 'No address is set yet.' }
    let ok = false
    let answered: string
    // Checked again here: a name may have come to point somewhere else since it was set.
    const why = refusal(address, this.deps.reach)
    if (why) {
      answered = why
    } else {
      try {
        const reply = await postJson(address, body, this.deps.reach)
        // The address is a secret: nothing it says back keeps it.
        const path = new URL(address).pathname
        const said = reply.text.split(address).join('').split(path.length > 4 ? path : address).join('…')
        if (reply.status >= 300 && reply.status < 400) {
          answered = `It answered ${reply.status}, sending the hub somewhere else. The hub doesn’t follow that: use the address it points to.`
        } else {
          ok = reply.status >= 200 && reply.status < 300
          answered = `It answered ${reply.status}${said ? `: ${said}` : ''}.`
        }
      } catch (error) {
        answered = error instanceof Failed ? error.message : 'The post couldn’t be sent.'
      }
    }
    // The address may have been changed or taken away while this was out.
    if (this.address === address) {
      this.last = { at: new Date(this.now()).toISOString(), ok, answered }
      void this.kv.set(`${this.key}:last`, JSON.stringify(this.last), 30 * 86400).catch(() => undefined)
    }
    return { ok, answered }
  }

  /** What began waiting since the last pass, told to the channel: at most ten rows and one more post that counts the rest. */
  async pass() {
    if (!this.address || this.busy) return
    this.busy = true
    const generation = this.generation
    try {
      const rows = waitingOn(this.deps.state(), undefined)
      const waiting = new Set(rows.map((row) => row.id))
      // What stopped waiting needn't be told, and if it waits again it's news again.
      for (const id of this.known) if (!waiting.has(id)) this.known.delete(id)
      for (const id of this.pending.keys()) if (!waiting.has(id)) this.pending.delete(id)
      for (const row of rows) {
        if (this.pending.has(row.id)) this.pending.set(row.id, row)
        else if (!this.known.has(row.id)) {
          this.known.add(row.id)
          this.pending.set(row.id, row)
        }
      }
      if (!this.pending.size || this.now() < this.retryAt) return
      const batch = [...this.pending.values()]
      for (const row of batch.slice(0, mostPerPass)) {
        if (!this.sent(await this.post(this.message(row)), generation)) return
        this.pending.delete(row.id)
      }
      const rest = batch.slice(mostPerPass)
      if (!rest.length) return
      const home = `${this.deps.base}/#/home`
      const more = `${this.prefix()}${rest.length} other ${rest.length === 1 ? 'thing is' : 'things are'} waiting too. ${home}`
      if (this.sent(await this.post({ text: more, kind: 'more', binder: this.deps.name(), url: home, count: rest.length }), generation)) for (const row of rest) this.pending.delete(row.id)
    } finally {
      this.busy = false
    }
  }

  /** Whether a post worked, and if not, the wait before the next try (a minute, then five, then thirty). False also if the address changed meanwhile. */
  private sent(result: { ok: boolean }, generation: number) {
    if (generation !== this.generation) return false
    if (result.ok) {
      this.fails = 0
      this.retryAt = 0
      return true
    }
    this.fails++
    this.retryAt = this.now() + tryAgainAfter[Math.min(this.fails, tryAgainAfter.length) - 1]
    return false
  }
}
