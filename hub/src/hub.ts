import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import { applyChange, emptyState, type Change, type Entry, type HubState, type Outgoing } from '../../shared/state.ts'
import type { ChangeLog } from './log.ts'
import type { Presence } from '../../shared/work.ts'
import { changesTo, check, NoteDocs, type NoteDoc } from '../../shared/noteDoc.ts'
import { log } from './logger.ts'
import { whatsWrong } from './schemas.ts'

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
  private reading: Promise<void> = Promise.resolve()
  /** Each note's Automerge document, in step with the log. */
  private docs = new NoteDocs()
  /** Recent edits' text as merged, by version, so an edit read again from the log is sent as it was merged. */
  private merged = new Map<number, { text: string; title: string }>()
  /** The log's versions that couldn't be applied: not sent to anyone. */
  private skipped = new Set<number>()
  /** Agents' presence: live, so not in the log. How many waits each has open says whether it's listening. */
  private seen = new Map<string, { at: number; waiting: number }>()
  /** Each agent's runners heard from, by the id each gives itself, with where it runs. */
  private runners = new Map<string, Map<string, { at: number; on?: string }>>()

  constructor(log: ChangeLog) {
    super()
    this.log = log
    log.onAppend(() => void this.catchUp())
  }

  /** Reads the whole log; a hub whose log is empty starts with what `seed` gives. */
  async start(seed?: Change[]) {
    await this.catchUp()
    if (this.version === 0 && seed?.length) {
      const at = new Date().toISOString()
      for (const [index, change] of seed.entries()) await this.log.append({ id: `seed-${index}`, client: 'hub', at, change })
      await this.catchUp()
    }
  }

  catchUp() {
    this.reading = this.reading.then(async () => {
      for (;;) {
        const read = await this.log.read(this.version)
        if (!read.length) return
        const entries: Entry[] = []
        for (const entry of read) {
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
        this.version = read[read.length - 1].version
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
    for (const { id, change } of outgoing) {
      this.check(change, login)
      await vet?.(change)
      const ready = await this.prepare(change)
      try {
        trial = applyChange(trial, ready)
      } catch {
        throw new Refused(`That change can’t be applied (${change.type}).`)
      }
      versions.push(await this.log.append({ id, client: `user:${login}:${tab}`, at, change: ready }))
    }
    await this.catchUp()
    return versions
  }

  private check(change: Change, login: string) {
    if (!fromPeople.has(change.type)) throw new Refused(`That can’t be sent from the web app (${change.type}).`)
    const wrong = whatsWrong(change)
    if (wrong) throw new Refused(`That change can’t be used (${change.type}): ${wrong}.`)
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
    const version = await this.log.append({ id, client: clientOf(actor), at: new Date().toISOString(), change: await this.prepare(change) })
    await this.catchUp()
    return version
  }

  /** Several at once, in order. */
  async recordAll(actor: Actor, changes: Change[]) {
    for (const change of changes) await this.log.append({ id: randomUUID(), client: clientOf(actor), at: new Date().toISOString(), change: await this.prepare(change) })
    await this.catchUp()
  }
}
