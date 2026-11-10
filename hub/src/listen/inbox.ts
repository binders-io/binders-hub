import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import type { Entry } from '../../../shared/state.ts'
import type { Folder, Note } from '../../../shared/notes.ts'
import { heardDays, heardKept, heardMost, heardPerHour, strengthOf, type Heard, type Listener, type ListenerKind, type NoteFrom, type Outcome, type Strength } from '../../../shared/listen.ts'
import { firstWords } from '../brain/captures.ts'
import { Refused, type Hub } from '../hub.ts'
import type { KV } from '../kv.ts'
import { log } from '../logger.ts'
import type { Sealer } from '../secrets.ts'
import { refusal, type Reach } from '../tell.ts'

// A Binder's inbox: what its listeners hear, and what becomes of it. Each thing heard is heard once, however often its
// source says it; how strongly it was said is worked out here, from the listener and the sender and never from its words;
// and with the listener on it becomes a note in the listener's folder, marked with where it came from. In Watch the hub
// only says what it would have done. What was heard, and what came of it, is kept in the Binder's store for a month as
// working notes of its own: the notes it made are what lasts.

const short = (text: string, length = 12) => createHash('sha256').update(text).digest('hex').slice(0, length)
const feedKey = 'heard-feed'
const heardKey = (listener: string, sourceId: string) => `heard:${listener}:${short(sourceId, 24)}`
const secretKey = (listener: string) => `listener-secret:${listener}`

/** The most listeners a binder has, and how long a name or a folder's may be. */
export const listenersMost = 20
const kinds: ListenerKind[] = ['post', 'feed', 'github']
const modes: Listener['mode'][] = ['off', 'watch', 'on']
/** The folder a listener's notes go to when none is named. */
export const listenerFolder = 'Inbox'

/** A folder at the top of a binder, by name: the one that's there, or the change that makes it. Named as captures name theirs, so the two share one. */
export function topFolder(state: { folders: Folder[] }, binderId: string, name: string): { folder: Folder; made: boolean } {
  const clean = (name.trim() || listenerFolder).replace(/[/\\]+/g, ' ').slice(0, 80)
  const id = `folder-${clean.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'inbox'}-${short(`${binderId}\u0000${clean.toLowerCase()}`, 8)}`
  const found = state.folders.find((f) => f.id === id) ?? state.folders.find((f) => f.binderId === binderId && !f.parentId && f.name.toLowerCase() === clean.toLowerCase())
  return found ? { folder: found, made: false } : { folder: { id, binderId, name: clean }, made: true }
}

/**
 * Words from outside, as they go in a note: nothing in them is fetched when the note is opened, so no picture loads
 * from a sender's server, and no markup of theirs is drawn. They're cut to what a note holds.
 */
export function outsideWords(text: string) {
  return text.replace(/\r\n?/g, '\n').replace(/!\[/g, '!\\[').replace(/</g, '\\<').slice(0, heardMost).trim()
}

const oneLine = (text: string, most: number) => {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > most ? `${line.slice(0, most - 1)}…` : line
}

/** Who sent something, as a note and a row say it. */
const senderWords = (sender: Heard['sender']) => (sender?.login ? `@${sender.login}` : oneLine(sender?.name || sender?.address || '', 120)) || undefined

export interface ListenerFields {
  name?: string
  kind?: ListenerKind
  binderId?: string
  mode?: Listener['mode']
  folder?: string
  from?: Listener['from']
  url?: string
  everyMinutes?: number
}

export class Inbox {
  private hub: Hub
  private kv: KV
  private sealer: Sealer
  private member: (login: string) => boolean
  private reach: Reach
  private now: () => number
  /** One thing at a time: what was heard is checked and kept in step, so the same thing arriving twice is heard once. */
  private line: Promise<unknown> = Promise.resolve()
  /** When each listener last took something, for its hourly limit. Forgotten when the hub restarts, which only lets a little more in. */
  private taken = new Map<string, number[]>()

  constructor(options: { hub: Hub; kv: KV; sealer: Sealer; member: (login: string) => boolean; reach?: Reach; now?: () => number }) {
    this.hub = options.hub
    this.kv = options.kv
    this.sealer = options.sealer
    this.member = options.member
    this.reach = options.reach ?? {}
    this.now = options.now ?? (() => Date.now())
  }

  listeners(): Listener[] {
    return this.hub.state.listeners ?? []
  }

  listener(id: string) {
    return this.listeners().find((l) => l.id === id)
  }

  private inLine<T>(work: () => Promise<T>): Promise<T> {
    const run = this.line.then(work, work)
    this.line = run.catch(() => undefined)
    return run
  }

  // Setting them up --------------------------------------------------------------------------------------------------

  /**
   * A listener, made or changed. The route says who may. A new post address comes with its secret, said this once.
   * What kind it is and which binder it's in are set when it's made, and stay.
   */
  async put(login: string, id: string | undefined, fields: ListenerFields): Promise<{ listener: Listener; secret?: string }> {
    const was = id ? this.listener(id) : undefined
    if (id && !was) throw new Refused('That listener is gone.')
    const state = this.hub.state
    const kind = was?.kind ?? fields.kind
    if (!kind || !kinds.includes(kind)) throw new Refused('Say what it listens to: an address to post to, a feed to read, or GitHub.')
    const binderId = was?.binderId ?? fields.binderId ?? state.binders[0]?.id
    if (!binderId || !state.binders.some((b) => b.id === binderId)) throw new Refused('Choose the binder its notes go in.')
    if (!was && this.listeners().length >= listenersMost) throw new Refused(`A Binder has at most ${listenersMost} listeners.`)
    const name = oneLine(fields.name ?? was?.name ?? '', 60)
    if (!name) throw new Refused('Give it a name, such as “Support mail”.')
    const mode = fields.mode ?? was?.mode ?? 'watch'
    if (!modes.includes(mode)) throw new Refused('A listener is off, watching, or on.')
    const folder = oneLine((fields.folder ?? was?.folder ?? listenerFolder).replace(/[/\\]+/g, ' '), 80) || listenerFolder
    const listener: Listener = { id: was?.id ?? `listener-${randomUUID().slice(0, 8)}`, binderId, name, kind, mode, folder, createdAt: was?.createdAt ?? new Date(this.now()).toISOString(), createdBy: was?.createdBy ?? login }
    if (kind === 'post') {
      const from = fields.from ?? was?.from ?? 'anyone'
      if (from !== 'binder' && from !== 'anyone') throw new Refused('Say who has its address: people in this Binder, or anyone.')
      listener.from = from
    }
    if (kind === 'feed') {
      const url = (fields.url ?? was?.url ?? '').trim()
      const wrong = refusal(url, this.reach)
      if (wrong) throw new Refused(wrong)
      const every = fields.everyMinutes ?? was?.everyMinutes ?? 15
      if (!Number.isInteger(every) || every < 5 || every > 1440) throw new Refused('Read it between every 5 minutes and once a day.')
      listener.url = url
      listener.everyMinutes = every
      // Another address starts from where that feed is now.
      if (was && was.url !== url) await this.kv.del(`feed-cursor:${listener.id}`)
    }
    await this.hub.record({ kind: 'user', login }, { type: 'listener.put', listener })
    if (was || kind !== 'post') return { listener }
    return { listener, secret: await this.newSecret(listener.id) }
  }

  async remove(login: string, id: string) {
    if (!this.listener(id)) throw new Refused('That listener is gone.')
    await this.hub.record({ kind: 'user', login }, { type: 'listener.delete', id })
    await Promise.all([this.kv.del(secretKey(id)), this.kv.del(`feed-cursor:${id}`)])
  }

  /** A new secret for a post address, said once: the one before it stops working. */
  async newSecret(id: string) {
    const listener = this.listener(id)
    if (listener?.kind !== 'post') throw new Refused('Only an address to post to has a secret.')
    const secret = `bnl_${randomBytes(24).toString('base64url')}`
    await this.kv.set(secretKey(id), this.sealer.seal(secret))
    return secret
  }

  private async secretOf(id: string) {
    const sealed = await this.kv.get(secretKey(id))
    if (!sealed) return undefined
    try {
      return this.sealer.open(sealed)
    } catch {
      return undefined
    }
  }

  /**
   * Whether a post may come in: it carries the address's secret as a bearer token, or a signature of its body made with
   * it (`sha256=…`, as GitHub signs). Compared without saying how much of it was right.
   */
  async admits(id: string, given: { bearer?: string; signature?: string; raw?: Buffer }) {
    const secret = await this.secretOf(id)
    if (!secret) return false
    const same = (a: string, b: string) => {
      const [x, y] = [createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest()]
      return timingSafeEqual(x, y)
    }
    if (given.bearer) return same(given.bearer, secret)
    if (given.signature && given.raw) return same(given.signature, `sha256=${createHmac('sha256', secret).update(given.raw).digest('hex')}`)
    return false
  }

  // Hearing ----------------------------------------------------------------------------------------------------------

  /** Whether something was heard already; remembered for a month when it wasn't. */
  private async firstTime(listener: string, sourceId: string) {
    const key = heardKey(listener, sourceId)
    if (await this.kv.get(key)) return false
    await this.kv.set(key, '1', heardDays * 86_400)
    return true
  }

  /** Marks things as heard without doing anything about them: where a feed starts, so what was already there is left alone. */
  async seen(listenerId: string, sourceIds: string[]) {
    await this.inLine(async () => {
      for (const sourceId of sourceIds) await this.kv.set(heardKey(listenerId, sourceId), '1', heardDays * 86_400)
    })
  }

  private overLimit(listener: string) {
    const hourAgo = this.now() - 3_600_000
    const lately = (this.taken.get(listener) ?? []).filter((at) => at > hourAgo)
    if (lately.length >= heardPerHour) {
      this.taken.set(listener, lately)
      return true
    }
    lately.push(this.now())
    this.taken.set(listener, lately)
    return false
  }

  /**
   * What a listener heard, each thing once: what came of each, newest last. Nothing for a listener that's off or gone.
   * In Watch, nothing changes: each row says what would have been done.
   */
  take(listenerId: string, heard: Heard[]): Promise<Outcome[]> {
    return this.inLine(async () => {
      const outcomes: Outcome[] = []
      for (const one of heard) {
        const listener = this.listener(listenerId)
        if (!listener || listener.mode === 'off') break
        const sourceId = String(one.sourceId ?? '').slice(0, 1000)
        const text = typeof one.text === 'string' ? one.text : ''
        if (!sourceId || (!text.trim() && !one.title?.trim())) continue
        if (!(await this.firstTime(listener.id, sourceId))) continue
        outcomes.push(await this.settle(listener, { ...one, sourceId, text }))
      }
      if (outcomes.length) await this.keep(outcomes)
      return outcomes
    })
  }

  private async settle(listener: Listener, heard: Heard): Promise<Outcome> {
    const strength = strengthOf(listener, heard, this.member)
    const title = oneLine(heard.title?.trim() || firstWords(heard.text), 200) || 'Untitled'
    const sender = senderWords(heard.sender)
    const url = heard.url && /^https?:\/\/[^\s<>"']+$/i.test(heard.url) ? heard.url.slice(0, 2000) : undefined
    const row = (did: Outcome['did'], line: string, note?: string): Outcome => ({ id: randomUUID(), listener: listener.id, listenerName: listener.name, at: new Date(this.now()).toISOString(), ...(sender ? { sender } : {}), title, strength, did, line, ...(note ? { note } : {}), ...(url ? { url } : {}) })
    if (this.overLimit(listener.id)) return row('held', `Held: more than ${heardPerHour} things came through “${listener.name}” within an hour.`)
    if (listener.mode === 'watch') return row('would-note', `Would file it under ${listener.folder}.`)
    try {
      const note = await this.file(listener, heard, { title, sender, url, strength })
      return row('noted', `Filed under ${listener.folder}.`, note.id)
    } catch (err) {
      log.warn({ listener: listener.id, why: err instanceof Error ? err.message : String(err) }, 'Couldn’t file what a listener heard')
      return row('held', `Couldn’t file it: ${err instanceof Refused ? err.message : 'the hub couldn’t write the note'}`)
    }
  }

  /** The note something heard becomes: in the listener's folder, saying where it came from, written by the hub. */
  private async file(listener: Listener, heard: Heard, said: { title: string; sender?: string; url?: string; strength: Strength }): Promise<Note> {
    const state = this.hub.state
    if (!state.binders.some((b) => b.id === listener.binderId)) throw new Refused('Its binder is gone.')
    const { folder, made } = topFolder(state, listener.binderId, listener.folder)
    const id = `note-in-${short(`${listener.id}\u0000${heard.sourceId}`, 16)}`
    const at = new Date(this.now()).toISOString()
    const when = heard.at && !Number.isNaN(Date.parse(heard.at)) ? new Date(heard.at) : new Date(this.now())
    // Names go in a line of the note as plain words: none of their marks is read as Markdown.
    const plain = (words: string) => words.replace(/[*_[\]<>`]/g, ' ').replace(/\s+/g, ' ').trim()
    const where = [`From ${(said.sender && plain(said.sender)) || 'outside'} through ${plain(listener.name)}`, `${when.toISOString().slice(0, 16).replace('T', ' ')} UTC`].join(' · ')
    const from: NoteFrom = { listener: listener.id, name: listener.name, kind: listener.kind, strength: said.strength, ...(said.sender ? { sender: said.sender } : {}), ...(said.url ? { url: said.url } : {}) }
    const text = `# ${said.title.replace(/\n/g, ' ')}\n\n*${where}*${said.url ? ` · [Open it there](${said.url.replace(/[()\s]/g, (c) => `%${c.charCodeAt(0).toString(16).padStart(2, '0')}`)})` : ''}\n\n${outsideWords(heard.text)}\n`
    const note: Note = { id, title: said.title, binderId: listener.binderId, folderId: folder.id, editedAt: at, editedBy: 'hub', editors: [], text, from }
    const changes: Entry['change'][] = [...(made ? [{ type: 'folder.put' as const, folder }] : []), { type: 'note.put', note }]
    await this.hub.recordAll({ kind: 'hub' }, changes)
    return note
  }

  // What came of it --------------------------------------------------------------------------------------------------

  /** "Came in": what was heard and what became of each, newest first. */
  async feed(): Promise<Outcome[]> {
    try {
      const raw = await this.kv.get(feedKey)
      const kept = raw ? (JSON.parse(raw) as Outcome[]) : []
      return Array.isArray(kept) ? kept.filter((o) => typeof o?.id === 'string' && typeof o.line === 'string') : []
    } catch (err) {
      log.warn({ why: err instanceof Error ? err.message : String(err) }, 'Couldn’t read what a Binder’s listeners heard')
      return []
    }
  }

  private async keep(outcomes: Outcome[]) {
    const rows = [...[...outcomes].reverse(), ...(await this.feed())].slice(0, heardKept)
    await this.kv.set(feedKey, JSON.stringify(rows), heardDays * 86_400)
    this.hub.emit('heard', outcomes.length)
  }

  /**
   * Takes back the note something heard became, while it's still as the hub left it: nobody has written in it, and no
   * work has come of it. It goes to the trash, as a note a person deletes does.
   */
  undo(login: string, outcomeId: string): Promise<Outcome> {
    return this.inLine(async () => {
      const rows = await this.feed()
      const row = rows.find((o) => o.id === outcomeId)
      if (!row) throw new Refused('That isn’t here any more.')
      if (row.did === 'undone') return row
      if (row.did !== 'noted' || !row.note) throw new Refused('Nothing was done about it, so there’s nothing to take back.')
      const state = this.hub.state
      const note = state.notes.find((n) => n.id === row.note)
      if (note) {
        const worked = note.editors.length > 0 || (note.work?.length ?? 0) > 0 || state.proposals.some((p) => p.noteId === note.id) || state.cards.some((c) => c.noteId === note.id)
        if (note.from?.listener !== row.listener || worked) throw new Refused('It has been worked on since: change it in Notes.')
        await this.hub.record({ kind: 'user', login }, { type: 'note.delete', id: note.id, by: login, at: new Date(this.now()).toISOString() })
      }
      const undone: Outcome = { ...row, did: 'undone', line: 'Taken back.' }
      await this.kv.set(feedKey, JSON.stringify(rows.map((o) => (o.id === outcomeId ? undone : o))), heardDays * 86_400)
      this.hub.emit('heard', 0)
      return undone
    })
  }

  /** A person read a note from outside and lets it through: its folder's rule may distill it from here. */
  async pass(login: string, noteId: string) {
    const note = this.hub.state.notes.find((n) => n.id === noteId)
    if (!note) throw new Refused('That note isn’t there any more.')
    if (!note.from) throw new Refused('That note didn’t come through a listener.')
    if (note.from.passed || note.from.strength !== 'outside') return
    await this.hub.record({ kind: 'user', login }, { type: 'note.pass', id: noteId, by: login, at: new Date(this.now()).toISOString() })
  }
}
