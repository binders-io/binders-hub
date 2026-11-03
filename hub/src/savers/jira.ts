import { createHash } from 'node:crypto'
import type { Card, Stage } from '../../../shared/work.ts'
import { titleOf } from '../../../shared/notes.ts'
import type { Hub } from '../hub.ts'
import type { KV } from '../kv.ts'
import { log } from '../logger.ts'
import { statusFor, type JiraConnection, type JiraMirror } from '../jira.ts'

// Cards mirrored into Jira, the way others are mirrored into GitHub Issues: an edit is one write when the typing
// pauses, and a stage becomes the transition the binder's map names. What's in Jira is remembered only once Jira has
// taken it, so a write that fails is tried again, and what a hub that was down missed is caught up when it starts.

interface Mirrored {
  id: string
  key: string
  /** The words Jira has, and the stage it was last moved for. */
  hash: string
  stage?: Stage
  /** Deleted in Jira: not made again, and not written to. */
  gone?: boolean
}

interface Timing {
  quietMs?: number
  retryMs?: number
  retries?: number
}

export class JiraSaver implements JiraMirror {
  private hub: Hub
  private jira: () => JiraConnection
  private kv: KV
  private space: string
  private timers = new Map<string, NodeJS.Timeout>()
  private attempts = new Map<string, number>()
  private queue = Promise.resolve()
  private issues = new Map<string, Mirrored>()
  private stopped = false
  private quietMs: number
  private retryMs: number
  private retries: number

  constructor(hub: Hub, jira: () => JiraConnection, kv: KV, space: string, timing: Timing = {}) {
    this.hub = hub
    this.jira = jira
    this.kv = kv
    this.space = space
    this.quietMs = timing.quietMs ?? 3000
    this.retryMs = timing.retryMs ?? 60_000
    this.retries = timing.retries ?? 5
  }

  private get key() {
    return `jira:${this.space}:issues`
  }

  /** Catches up with the board: cards that are still going, not its history, which stays out of Jira. */
  async load() {
    if (!this.jira().on()) return
    // What this hub already holds is newer than what it last wrote down.
    const raw = this.issues.size ? undefined : await this.kv.get(this.key).catch(() => undefined)
    if (raw) {
      try {
        this.issues = new Map(Object.entries(JSON.parse(raw) as Record<string, Mirrored>))
      } catch {
        // Not a map this hub wrote: its labels find the issues again.
      }
    }
    for (const card of this.hub.state.cards) if (this.behind(card)) this.later(card.id, 0)
  }

  /** Forgets what was written: the address or project changed, so those issues aren't where this connection writes. */
  async forget() {
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
    this.attempts.clear()
    this.issues.clear()
    await this.queue.catch(() => undefined)
    this.issues.clear()
    await this.kv.del(this.key).catch(() => undefined)
  }

  private persist() {
    void this.kv.set(this.key, JSON.stringify(Object.fromEntries(this.issues))).catch(() => undefined)
  }

  start() {
    this.hub.on('entries', (entries) => {
      for (const { change } of entries) {
        const id = change.type === 'card.put' ? change.card.id : change.type.startsWith('card.') && change.type !== 'card.delete' ? (change as { id?: string }).id : undefined
        const card = id ? this.hub.state.cards.find((c) => c.id === id) : undefined
        if (!card || !this.behind(card)) continue
        // Typing waits for the pause; anything else (an agent's progress, say) doesn't put off a write already coming.
        const typing = change.type === 'card.update' && ('title' in change.fields || 'brief' in change.fields || 'doneWhen' in change.fields)
        if (typing || !this.timers.has(card.id)) this.later(card.id)
      }
    })
  }

  /** Whether Jira has less than the board does. A card already done when the mirror began isn't brought in. */
  private behind(card: Card) {
    if (card.stage === 'proposed') return false
    const known = this.issues.get(card.id)
    if (!known) return card.stage !== 'live'
    return !known.gone && (known.hash !== this.hashOf(card) || known.stage !== card.stage)
  }

  /** The card's next write, once its edits settle: one write, not one per keystroke. */
  private later(cardId: string, delay = this.quietMs) {
    clearTimeout(this.timers.get(cardId))
    this.timers.set(cardId, setTimeout(() => {
      this.timers.delete(cardId)
      this.queue = this.queue.then(() => this.write(cardId)).then(() => {
        this.attempts.delete(cardId)
      }, (error: Error) => this.failed(cardId, error))
    }, delay))
  }

  private failed(cardId: string, error: Error) {
    const attempt = (this.attempts.get(cardId) ?? 0) + 1
    log.warn({ binder: this.space, card: cardId, attempt, why: error.message }, 'Writing a card to Jira failed')
    if (this.stopped) return
    if (attempt > this.retries) {
      // Jira isn't taking it: the next change to the card, or the hub starting, tries again.
      this.attempts.delete(cardId)
      return
    }
    this.attempts.set(cardId, attempt)
    if (!this.timers.has(cardId)) this.later(cardId, this.retryMs * 2 ** (attempt - 1))
  }

  async stop() {
    this.stopped = true
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
    await this.queue.catch(() => undefined)
  }

  private noteOf(card: Card) {
    return card.noteId ? this.hub.state.notes.find((n) => n.id === card.noteId) : undefined
  }

  private hashOf(card: Card) {
    const note = this.noteOf(card)
    return createHash('sha1').update(`${card.title}|${card.brief}|${card.doneWhen ?? ''}|${note ? titleOf(note.text) : ''}`).digest('hex')
  }

  private body(card: Card) {
    const note = this.noteOf(card)
    return [card.brief || 'No brief yet.', card.doneWhen && `**Done when:** ${card.doneWhen}`, note && `From “${titleOf(note.text)}”`].filter(Boolean).join('\n\n')
  }

  private async write(cardId: string) {
    const jira = this.jira()
    const card = this.hub.state.cards.find((c) => c.id === cardId)
    if (!jira.on() || !card || !this.behind(card)) return
    const words = { summary: card.title, description: this.body(card) }
    const hash = this.hashOf(card)

    let known = this.issues.get(cardId)
    if (!known) {
      // An issue that names this card already (the saver died mid-flight, or lost its map) is adopted, not made twice.
      // When Jira won't say, this throws and tries again later rather than guess.
      const found = await jira.issueOf(cardId)
      const issue = found ?? (await jira.create(cardId, words))
      known = { id: issue.id, key: issue.key, hash: found ? '' : hash }
      this.issues.set(cardId, known)
      this.persist()
    }
    if (known.hash !== hash) {
      await jira.update(known.id, words)
      known.hash = hash
      this.persist()
    }
    if (known.stage !== card.stage) {
      // A status this project's workflow can't reach from here is left: the board keeps the stage either way.
      await jira.transitionTo(known.id, statusFor(card.stage, jira.settings.statuses))
      known.stage = card.stage
      this.persist()
    }
  }

  /** The card an issue was made for: only those are the hub's to hear about. */
  cardOfIssue(issueId: string) {
    for (const [cardId, issue] of this.issues) if (issue.id === issueId) return cardId
    return undefined
  }

  /** A person moved the issue: the card follows, and Jira has no need to be told what it just said. */
  heard(cardId: string, stage: Stage) {
    const known = this.issues.get(cardId)
    if (!known) return
    known.stage = stage
    this.persist()
  }

  lost(cardId: string) {
    const known = this.issues.get(cardId)
    if (!known) return
    known.gone = true
    this.persist()
  }
}
