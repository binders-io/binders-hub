import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import { applyChange, emptyState, type Change, type Entry, type HubState, type Outgoing } from '../../shared/state.ts'
import type { ChangeLog } from './log.ts'
import type { SavedState } from './kept.ts'
import type { Presence } from '../../shared/work.ts'
import { changesTo, check, load as loadDoc, NoteDocs, save as saveDoc, textOf, type NoteDoc } from '../../shared/noteDoc.ts'
import { log } from './logger.ts'
import { lockStops } from '../../shared/notes.ts'
import { whatsWrong } from './schemas.ts'
import { describe, noted, stamped, whoIs } from './history.ts'

/** Who's sending a change. */
export type Actor = { kind: 'user'; login: string } | { kind: 'agent'; id: string } | { kind: 'hub' }

/** Changes a person may send straight from the web app. The rest go through the hub's actions, MCP tools or GitHub. */
const fromPeople = new Set<Change['type']>([
  'binder.put', 'binder.delete', 'folder.put', 'folder.delete',
  'note.put', 'note.edit', 'note.link', 'note.move', 'note.delete',
  'card.put', 'card.update', 'card.activity', 'card.delete', 'proposal.update', 'chat.clear', 'test.result',
])

export class Refused extends Error {}

export const clientOf = (actor: Actor) => (actor.kind === 'user' ? `user:${actor.login}` : actor.kind === 'agent' ? `agent:${actor.id}` : 'hub')

/**
 * The hub's state: the log applied in order. Every change goes into the log first and is applied when it's read back,
 * so every hub on the same log, and every client, applies the same changes in the same order.
 */
export class Hub extends EventEmitter<{ entries: [Entry[]]; presence: [Record<string, Presence>] }> {
  state: HubState = emptyState()
  version = 0
  readonly log: ChangeLog
  /** Whether a person is one of this Binder's owners or admins, who may change any locked note. */
  lockManager: (login: string) => boolean = () => false
  private reading: Promise<void> = Promise.resolve()
  /** Each note's Automerge document, in step with the log. */
  private docs = new NoteDocs()
  /** Recent edits' text as merged, by version, so an edit read again from the log is sent as it was merged. */
  private merged = new Map<number, { text: string; title: string }>()
  /** The log's versions that couldn't be applied: not sent to anyone. */
  private skipped = new Set<number>()
  /** Agents' presence: live, so not in the log. How many waits each has open says whether it's listening. */
  private seen = new Map<string, { at: number; waiting: number }>()
  /** When this hub started: what it hasn't heard since then, it hasn't heard at all, as `seen` begins empty. */
  readonly startedAt = Date.now()
  /** Each agent's runners heard from, by the id each gives itself, with where it runs. */
  private runners = new Map<string, Map<string, { at: number; on?: string }>>()

  constructor(log: ChangeLog) {
    super()
    this.log = log
    log.onAppend(() => void this.catchUp())
  }

  /**
   * The state saved before this start, while the log is first read: where the log turns out to have a hole in it, the
   * hub carries on from here. A log loses its beginning when its Redis is emptied, and its middle when an older copy of
   * Redis is put back; either way every later start reads that same holed log.
   */
  private fallback?: SavedState

  /**
   * Starts from the state saved before, with each note's document as it was saved beside it (`docs`), and reads only
   * what the log has after that: how long a Binder takes to start doesn't grow with how long it has been going, and the
   * log needn't hold its whole history. A hub with no saved state reads its whole log, and one whose log is empty
   * starts with what `seed` gives.
   *
   * With a saved state and no documents saved yet (a Binder from before they were), the whole log is read once more, so
   * every note's document is as it was and whoever is editing goes on from theirs: where that log has a hole in it, at
   * its start or in its middle, the saved state stands for what's before the hole.
   */
  async start(seed?: Change[], saved?: SavedState, docs?: Map<string, Uint8Array>) {
    // Listening first, then reading: a change made between the two would otherwise wait for the next one to be heard of.
    await this.log.listening?.()
    const latest = saved ? await this.log.latest().catch(() => undefined) : undefined
    const behind = !!saved && latest !== undefined && latest < saved.version
    if (saved && (docs || behind)) {
      this.take(saved)
      const kept: string[] = []
      for (const [noteId, bytes] of docs ?? []) {
        try {
          this.docs.put(noteId, loadDoc(bytes))
          kept.push(noteId)
        } catch (err) {
          log.warn({ err, note: noteId }, 'Couldn’t read a note’s saved document: it starts again from the note’s text')
        }
      }
      if (behind) {
        log.warn({ log: this.log.kind, latest, saved: saved.version }, 'The change log is behind this Binder’s saved state: carrying on from the saved state')
        await this.log.startAt(saved.version)
      }
      await this.catchUp()
      // A document that doesn't say what its note says would put its own words back at the note's next edit: set aside.
      for (const noteId of kept) {
        const doc = this.docs.peek(noteId)
        const note = this.state.notes.find((n) => n.id === noteId)
        if (doc && (!note || textOf(doc) !== note.text)) {
          if (note) log.warn({ note: noteId }, 'A note’s saved document didn’t match its text: it starts again from the text')
          this.docs.drop(noteId)
        }
      }
    } else {
      this.fallback = saved
      await this.catchUp()
      this.fallback = undefined
      // Read through, and short of what was saved: with none of the binders it had, or, with nothing in the log since
      // the state was saved, fewer binders, notes or cards than it held. The log didn't give what it should have, and
      // the saved state stands, with whatever the log has after it.
      const fewer = !!saved && this.version === saved.version && (
        this.state.binders.length < saved.state.binders.length || this.state.notes.length < saved.state.notes.length || this.state.cards.length < saved.state.cards.length)
      if (saved && (this.version < saved.version || (saved.state.binders.length > 0 && !this.state.binders.length) || fewer)) {
        log.error({ log: this.log.kind, read: this.version, saved: saved.version }, 'The change log gave less than this Binder’s saved state holds: carrying on from the saved state')
        const further = this.version
        this.take(saved)
        await this.log.startAt(Math.max(saved.version, further))
        await this.catchUp()
      }
      // Every document it now has is saved with the state, for the starts after this one.
      this.docs.changeAll()
    }
    if (this.version === 0 && seed?.length) {
      const at = new Date().toISOString()
      for (const [index, change] of seed.entries()) await this.log.append({ id: `seed-${index}`, client: 'hub', at, change })
      await this.catchUp()
    }
  }

  /**
   * The notes' documents that changed since this was last asked, as they're saved (undefined: the note has none any
   * more), for keeping beside the state. `again` puts back ones that couldn't be saved.
   */
  changedDocs(): Map<string, Uint8Array | undefined> {
    return new Map([...this.docs.takeChanged()].map(([noteId, doc]) => [noteId, doc ? saveDoc(doc) : undefined]))
  }

  /** Every note's document the hub holds now, as it's saved: for a copy of the whole Binder. A note with none is made again from its text. */
  heldDocs(): Map<string, Uint8Array> {
    const held = new Map<string, Uint8Array>()
    for (const note of this.state.notes) {
      const doc = this.docs.peek(note.id)
      if (doc) held.set(note.id, saveDoc(doc))
    }
    return held
  }

  docsChangedAgain(noteIds: Iterable<string>) {
    this.docs.changedAgain(noteIds)
  }

  /** Carries on from a saved state: its notes' documents are made again from their text as they're next edited. */
  private take(saved: SavedState) {
    this.state = saved.state
    this.version = saved.version
    this.docs = new NoteDocs()
    this.merged.clear()
    this.skipped.clear()
  }

  catchUp() {
    this.reading = this.reading.then(async () => {
      for (;;) {
        const read = await this.log.read(this.version)
        if (!read.length) return
        const entries: Entry[] = []
        let at = this.version
        for (const entry of read) {
          // A hole: the log goes on from further than the change after the last one read.
          if (entry.version > at + 1) {
            const saved = this.fallback
            this.fallback = undefined
            if (saved && saved.version > at) {
              const lost = entry.version - 1 - saved.version
              log.warn({ log: this.log.kind, after: at, next: entry.version, saved: saved.version, ...(lost > 0 ? { lost } : {}) }, 'The change log has a hole in it: carrying on from this Binder’s saved state')
              this.take(saved)
              at = saved.version
              // What was read so far is of a history the saved state replaces, and the rest is read again from there.
              entries.length = 0
              break
            }
            log.error({ log: this.log.kind, after: at, next: entry.version }, 'The change log has a hole in it, and no saved state covers it')
          }
          at = entry.version
          try {
            // An edit's Automerge changes go into its note's document, and the edit takes the note's text as merged.
            const change = this.docs.apply(this.state, entry.change)
            this.state = applyChange(this.state, change)
            if (change.type === 'note.edit' && change.changes) this.remember(entry.version, change.text, change.title)
            entries.push(change === entry.change ? entry : { ...entry, change })
          } catch (error) {
            // Stopping here would stop the Binder for good: it's still in the log, and everything after it waits. Applying
            // the same log, every reader skips the same ones.
            this.skipped.add(entry.version)
            log.error({ err: error, version: entry.version, type: entry.change?.type }, 'Skipped a change in the log that can’t be applied')
          }
        }
        this.version = at
        if (entries.length) this.emit('entries', entries)
      }
    }).catch((err) => {
      log.error({ err }, 'Reading the change log failed')
    })
    return this.reading
  }

  private remember(version: number, text: string, title: string) {
    this.merged.set(version, { text, title })
    if (this.merged.size > 5000) this.merged.delete(this.merged.keys().next().value!)
  }

  /** The log after a version, each edit with its note's text as merged (as it is now, for an edit read long ago). */
  async read(after: number, limit?: number): Promise<Entry[]> {
    const entries = await this.log.read(after, limit)
    return entries.filter((entry) => !this.skipped.has(entry.version)).map((entry) => {
      const change = entry.change
      if (change.type !== 'note.edit' || !change.changes) return entry
      const merged = this.merged.get(entry.version) ?? this.state.notes.find((n) => n.id === change.id)
      return merged ? { ...entry, change: { ...change, text: merged.text, title: merged.title } } : entry
    })
  }

  /** A note's Automerge document as the hub has it now, to edit from; undefined for no such note. */
  noteDoc(noteId: string): NoteDoc | undefined {
    return this.docs.get(this.state, noteId)
  }

  /**
   * A note edit on its way into the log: its Automerge changes must build on what the hub has, and an edit sent as
   * the whole text becomes the changes that take the note's document there.
   */
  private async prepare(change: Change): Promise<Change> {
    if (change.type !== 'note.edit') return change
    const doc = this.docs.get(this.state, change.id)
    if (!doc) return change
    if (!change.changes) return { ...change, changes: changesTo(doc, change.text) }
    if (!Array.isArray(change.changes) || !change.changes.every((c) => typeof c === 'string')) throw new Refused('An edit’s changes are Automerge changes in base64.')
    let checked
    try {
      checked = check(doc, change.id, change.changes)
      // What it builds on may be in the log already, from another hub: read on and look again.
      if (checked.missing.length) {
        await this.catchUp()
        checked = check(this.docs.get(this.state, change.id) ?? doc, change.id, change.changes)
      }
    } catch {
      throw new Refused('An edit’s changes are Automerge changes in base64.')
    }
    if (checked.forged) throw new Refused('Those changes are written as the note itself: make them under an actor of your own.')
    if (checked.missing.length) throw new Refused('That edit builds on a version of the note the hub doesn’t have: get the note’s document again and redo it.')
    return change
  }

  /**
   * A person's changes from one tab of the web app, in the order sent, each checked first, and by `vet` too: what only
   * GitHub can say (whether they may link a repo). Returns each one's version (0 for a resend).
   */
  async submit(login: string, tab: string, outgoing: Outgoing[], vet?: (change: Change) => Promise<void>) {
    const at = new Date().toISOString()
    const versions: number[] = []
    // Tried first on a copy, each on the ones before it: what can't be applied never reaches the log.
    let trial = this.state
    const noting: string[] = []
    try {
      for (const { id, change } of outgoing) {
        this.check(change, login)
        await vet?.(change)
        // Who deleted a note or a card, and when, is the hub's to say: whatever the client wrote is replaced.
        const ready = stamped(await this.prepare(change), login, at)
        const sentences = describe(trial, ready)
        try {
          trial = applyChange(trial, ready)
        } catch {
          throw new Refused(`That change can’t be applied (${change.type}).`)
        }
        const version = await this.log.append({ id, client: `user:${login}:${tab}`, at, change: ready })
        versions.push(version)
        // A resend is in the log already, and noted.
        if (version) noting.push(...sentences)
      }
    } finally {
      // What went in is noted even when a later change was refused: those before it are in the log.
      await this.catchUp()
      await noted(this, { kind: 'user', login }, noting)
    }
    return versions
  }

  /** A locked note's words and place are only for who may change it, however the change gets here. */
  private guardLock(change: Change, actor: Actor) {
    if (actor.kind === 'hub') return
    const id = change.type === 'note.edit' || change.type === 'note.move' || change.type === 'note.delete' ? change.id : change.type === 'note.put' ? change.note.id : undefined
    const note = id ? this.state.notes.find((n) => n.id === id) : undefined
    if (!note?.locked) return
    const login = actor.kind === 'user' ? actor.login : undefined
    if (lockStops(note, { login, manager: !!login && this.lockManager(login) })) throw new Refused(`“${note.title}” is locked by @${note.locked.by}. Propose the change instead, for them to review.`)
  }

  private check(change: Change, login: string) {
    if (!fromPeople.has(change.type)) throw new Refused(`That can’t be sent from the web app (${change.type}).`)
    const wrong = whatsWrong(change)
    if (wrong) throw new Refused(`That change can’t be used (${change.type}): ${wrong}.`)
    this.guardLock(change, { kind: 'user', login })
    // Put back from the trash is the hub's own doing, from its copy: a client's copy of a note or card isn't "restored".
    if ((change.type === 'note.put' || change.type === 'card.put') && change.restored) throw new Refused('A note or a card is put back from the trash, not written.')
    // A permission runs something on an agent's machine: answered through answerPermission, by its owner, never written.
    if (change.type === 'card.update' && change.fields.permission) throw new Refused('A permission is answered on its card, by its agent’s owner.')
    if (change.type === 'card.put' && change.card.permission && JSON.stringify(change.card.permission) !== JSON.stringify(this.state.cards.find((c) => c.id === change.card.id)?.permission)) throw new Refused('A permission is answered on its card, by its agent’s owner.')
    if (change.type === 'test.result') {
      // A result is the person's own, on a test the debrief has.
      if (change.result && change.result.by.toLowerCase() !== login.toLowerCase()) throw new Refused('A test’s result is recorded by whoever ran it.')
      const debrief = (this.state.changeSets.find((s) => s.id === change.id) ?? this.state.cards.find((c) => c.id === change.id))?.debrief
      if (!debrief?.testPlan?.some((t) => t.id === change.test)) throw new Refused('That debrief has no such test.')
    }
    if (change.type === 'binder.delete') {
      const used = this.state.notes.some((n) => n.binderId === change.id) || this.state.cards.some((c) => c.binderId === change.id) || this.state.folders.some((f) => f.binderId === change.id)
      if (used) throw new Refused('Only an empty binder can be deleted: move or delete its notes, folders and cards first.')
    }
    if (change.type === 'binder.put' && change.binder.repo && !/^[\w.-]+\/[\w.-]+$/.test(change.binder.repo)) throw new Refused('A binder’s repo is written owner/name.')
    if (change.type === 'binder.put' && change.binder.notesBranch && (!/^[\w./-]{1,100}$/.test(change.binder.notesBranch) || /\.\.|\/\/|^\/|\/$|\.lock$/.test(change.binder.notesBranch))) throw new Refused('That isn’t a branch name git takes.')
  }

  /** An agent called, and, with `waiting`, opened (+1) or closed (-1) a wait for work. */
  touch(agentId: string, waiting = 0) {
    const was = this.seen.get(agentId)
    const now = { at: Date.now(), waiting: Math.max(0, (was?.waiting ?? 0) + waiting) }
    this.seen.set(agentId, now)
    // Others hear when listening starts or stops, or when an agent shows up after a while.
    if (!was || waiting !== 0 || now.at - was.at > 60_000) this.emit('presence', this.presence())
  }

  /**
   * The last time this agent was heard from, in milliseconds: a call of its own or its runner's, or now while it has a
   * wait open. Never before the hub started, so a restart doesn't make every agent look gone.
   */
  lastHeard(agentId: string, now = Date.now()) {
    const seen = this.seen.get(agentId)
    if (seen && seen.waiting > 0) return now
    return Math.max(this.startedAt, seen?.at ?? 0, ...[...(this.runners.get(agentId)?.values() ?? [])].map((r) => r.at))
  }

  /** A runner of an agent was heard from: one more running for it, if it's new. */
  runnerSeen(agentId: string, runner: string, on?: string) {
    const known = this.runners.get(agentId) ?? new Map<string, { at: number; on?: string }>()
    const fresh = !known.has(runner)
    known.set(runner, { at: Date.now(), on: on ?? known.get(runner)?.on })
    this.runners.set(agentId, known)
    if (fresh) this.emit('presence', this.presence())
  }

  /** A runner of an agent has stopped: the next one to start isn't a second one. */
  runnerGone(agentId: string, runner: string) {
    if (this.runners.get(agentId)?.delete(runner)) this.emit('presence', this.presence())
  }

  /** The agent's other runners heard from in the last two minutes: they take the same work as this one. */
  otherRunners(agentId: string, runner: string) {
    const since = Date.now() - 2 * 60_000
    return [...(this.runners.get(agentId) ?? new Map()).entries()].filter(([id, r]) => id !== runner && r.at > since).map(([, r]) => ({ on: r.on, at: new Date(r.at).toISOString() }))
  }

  presence(): Record<string, Presence> {
    const since = Date.now() - 2 * 60_000
    return Object.fromEntries([...this.seen.entries()].map(([id, p]) => {
      const lately = [...(this.runners.get(id)?.values() ?? [])].filter((r) => r.at > since)
      const places = [...new Set(lately.flatMap((r) => (r.on ? [r.on] : [])))]
      return [id, { at: new Date(p.at).toISOString(), listening: p.waiting > 0, ...(lately.length ? { runners: lately.length } : {}), ...(places.length ? { runnersOn: places } : {}) }]
    }))
  }

  /** The hub's own changes, and what agents do through its tools. */
  async record(actor: Actor, change: Change, id: string = randomUUID()) {
    this.guardLock(change, actor)
    const at = new Date().toISOString()
    const ready = stamped(await this.prepare(change), whoIs(this.state, actor), at)
    const sentences = describe(this.state, ready)
    const version = await this.log.append({ id, client: clientOf(actor), at, change: ready })
    await this.catchUp()
    await noted(this, actor, sentences)
    return version
  }

  /** Several at once, in order. */
  async recordAll(actor: Actor, changes: Change[]) {
    for (const change of changes) this.guardLock(change, actor)
    for (const change of changes) await this.log.append({ id: randomUUID(), client: clientOf(actor), at: new Date().toISOString(), change: await this.prepare(change) })
    await this.catchUp()
  }
}
