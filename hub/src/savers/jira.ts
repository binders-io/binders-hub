import { createHash } from 'node:crypto'
import type { Card, Stage } from '../../../shared/work.ts'
import { linkedNotes, linksAsWords, titleOf, type Note } from '../../../shared/notes.ts'
import type { Hub } from '../hub.ts'
import type { KV } from '../kv.ts'
import { log } from '../logger.ts'
import { heardComment, heardStatus, inBinders, stageOf, statusFor, type JiraConnection, type JiraMirror } from '../jira.ts'

// Cards mirrored into Jira, the way others are mirrored into GitHub Issues: an edit is one write when the typing
// pauses, and a stage becomes the transition the binder's map names. What's in Jira is remembered only once Jira has
// taken it, so a write that fails is tried again, and what a hub that was down missed is caught up when it starts. When
// the binder gives notes an issue type, the first of a note's cards to go out makes its Epic, and its cards go under it.

interface Mirrored {
  id: string
  key: string
  /** The words Jira has, and the stage it was last moved for. */
  hash: string
  stage?: Stage
  /** Deleted in Jira: not made again, and not written to. */
  gone?: boolean
  /** The Epic it's under. */
  parent?: string
  /** Where Jira has it, as far as the hub knows: the status it moved it to or last heard of. */
  status?: string
  /** The stage whose status Jira wouldn't move it to, and the card's been told: tried again when the stage changes. */
  stuck?: Stage
  /** The points last written. */
  points?: number
  /** When the last of the card's words to go to Jira were said on the card. */
  saidUpTo?: string
  /** The newest comment heard from Jira. */
  heardUpTo?: number
}

const noteJob = 'note:'
const notesChanged = 'notes-changed'

/** What Jira holds in a description, with room left for saying what's left out. */
const epicRoom = 30_000

interface Timing {
  quietMs?: number
  retryMs?: number
  retries?: number
  pollMs?: number
}

/** What's said on a card goes to its issue, unless Jira said it first. */
const worthSaying = (a: Card['activity'][number]) => (a.kind === 'comment' || a.kind === 'answer' || a.kind === 'question') && !a.by.endsWith(' on Jira')

/** Jira may hold a change back for a while before a search finds it: how far back each look goes. */
const lookBackMinutes = 10

export class JiraSaver implements JiraMirror {
  private hub: Hub
  private jira: () => JiraConnection
  private kv: KV
  private space: string
  private timers = new Map<string, NodeJS.Timeout>()
  private attempts = new Map<string, number>()
  private queue = Promise.resolve()
  private issues = new Map<string, Mirrored>()
  private epics = new Map<string, Mirrored>()
  private stopped = false
  /** The issues being moved right now, whose statuses along the way aren't news. */
  private moving = new Set<string>()
  private polling?: NodeJS.Timeout
  /** Whether every issue's been looked at since starting: after that, those changed lately. */
  private scanned = false
  private pollMs: number
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
    this.pollMs = timing.pollMs ?? 60_000
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
    const epics = this.epics.size ? undefined : await this.kv.get(`${this.key}:epics`).catch(() => undefined)
    if (epics) {
      try {
        this.epics = new Map(Object.entries(JSON.parse(epics) as Record<string, Mirrored>))
      } catch {
        // Their labels find them again too.
      }
    }
    // What was said on a card before its words began to follow isn't brought in all at once.
    const now = new Date().toISOString()
    for (const known of this.issues.values()) known.saidUpTo ??= now
    for (const card of this.hub.state.cards) {
      await this.showKey(card).catch(() => undefined)
      if (this.behind(card)) this.later(card.id, 0)
    }
    for (const noteId of this.epics.keys()) if (this.epicBehind(noteId)) this.later(noteJob + noteId, 0)
  }

  /** Forgets what was written: the address or project changed, so those issues aren't where this connection writes. */
  async forget() {
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
    this.attempts.clear()
    this.issues.clear()
    this.epics.clear()
    this.scanned = false
    await this.queue.catch(() => undefined)
    this.issues.clear()
    this.epics.clear()
    await this.kv.del(this.key).catch(() => undefined)
    await this.kv.del(`${this.key}:epics`).catch(() => undefined)
    for (const card of this.hub.state.cards) await this.showKey(card).catch(() => undefined)
  }

  private persist() {
    void this.kv.set(this.key, JSON.stringify(Object.fromEntries(this.issues))).catch(() => undefined)
    void this.kv.set(`${this.key}:epics`, JSON.stringify(Object.fromEntries(this.epics))).catch(() => undefined)
  }

  start() {
    this.polling = setInterval(() => void this.poll(), this.pollMs)
    this.polling.unref()
    this.hub.on('entries', (entries) => {
      for (const { change } of entries) {
        // Any note can be in an Epic's words, by a link: once they settle, the Epics they've changed are written.
        if (change.type.startsWith('note.')) {
          this.notesSettling()
          continue
        }
        if (change.type === 'card.update' && Object.keys(change.fields).length === 1 && 'jira' in change.fields) continue
        const id = change.type === 'card.put' ? change.card.id : change.type.startsWith('card.') && change.type !== 'card.delete' ? (change as { id?: string }).id : undefined
        const card = id ? this.hub.state.cards.find((c) => c.id === id) : undefined
        if (card && this.keyWrong(card)) void this.showKey(card).catch(() => undefined)
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
    if (known.gone) return false
    const points = this.jira().pointsOf(card.size)
    return known.hash !== this.hashOf(card) || (known.stage !== card.stage && known.stuck !== card.stage) || this.wantsParent(card, known) || (points !== undefined && known.points !== points) || this.unsaid(card, known).length > 0
  }

  private unsaid(card: Card, known: Mirrored) {
    return known.saidUpTo === undefined ? [] : card.activity.filter((a) => worthSaying(a) && a.at > known.saidUpTo!)
  }

  /** A card of a note that's mirrored, not under its Epic yet. */
  private wantsParent(card: Card, known: Mirrored) {
    if (!this.jira().settings.noteIssueType || !this.noteOf(card)) return false
    const epic = this.epics.get(card.noteId!)
    return !epic?.gone && (!epic || known.parent !== epic.key)
  }

  private epicBehind(noteId: string) {
    const epic = this.epics.get(noteId)
    const note = this.hub.state.notes.find((n) => n.id === noteId)
    return !!epic && !epic.gone && !!note && epic.hash !== this.epicHash(note)
  }

  /** The note's words, then those of the notes it links to, so the Epic can be read without them. */
  private epicWords(note: Note) {
    const own = note.text.slice(0, epicRoom).trim()
    const { linked, left } = linkedNotes(this.hub.state.notes, note, epicRoom - own.length)
    const named = left.slice(0, 20).join(', ') + (left.length > 20 ? ` and ${left.length - 20} more` : '')
    const description = [
      own + (note.text.length > epicRoom ? '\n\nThis note goes on in Binders: Jira holds only so much in a description.' : ''),
      ...linked.map((n) => `## Linked note: ${titleOf(n.text)}\n\n${n.text.replace(/^\s*#\s+.*\n*/, '').trim()}`),
      left.length ? `Linked notes too long to fit here, in Binders: ${named}` : '',
    ].filter(Boolean).join('\n\n')
    return { summary: titleOf(note.text) || note.title, description: linksAsWords(description) || 'No words yet.' }
  }

  /** Once notes stop changing, the Epics whose words they've changed. */
  private notesSettling() {
    if (!this.epics.size) return
    clearTimeout(this.timers.get(notesChanged))
    this.timers.set(notesChanged, setTimeout(() => {
      this.timers.delete(notesChanged)
      for (const noteId of this.epics.keys()) if (this.epicBehind(noteId)) this.later(noteJob + noteId, 0)
    }, this.quietMs))
  }

  /** The key the card should show: its issue's, while it has one. */
  private keyOf(card: Card) {
    const known = this.issues.get(card.id)
    return known && !known.gone ? known.key : undefined
  }

  private keyWrong(card: Card) {
    return card.jira?.key !== this.keyOf(card)
  }

  private async showKey(card: Card) {
    if (!this.keyWrong(card)) return
    const key = this.keyOf(card)
    await this.hub.record({ kind: 'hub' }, { type: 'card.update', id: card.id, fields: { jira: key ? { key, url: this.jira().browse(key) } : undefined } })
  }

  private epicHash(note: Note) {
    const { summary, description } = this.epicWords(note)
    return createHash('sha1').update(`${summary}|${description}`).digest('hex')
  }

  /** The Epic a card goes under, made the first time one of its note's cards goes out. */
  private async epicFor(card: Card) {
    const jira = this.jira()
    const note = this.noteOf(card)
    if (!jira.settings.noteIssueType || !note) return undefined
    let epic = this.epics.get(note.id)
    if (epic?.gone) return undefined
    const hash = this.epicHash(note)
    if (!epic) {
      const found = await jira.epicOf(note.id)
      const issue = found ?? (await jira.createEpic(note.id, this.epicWords(note)))
      epic = { id: issue.id, key: issue.key, hash: found ? '' : hash }
      this.epics.set(note.id, epic)
      this.persist()
    }
    if (epic.hash !== hash) await this.writeEpic(note.id)
    return epic
  }

  private async writeEpic(noteId: string) {
    const epic = this.epics.get(noteId)
    const note = this.hub.state.notes.find((n) => n.id === noteId)
    if (!epic || epic.gone || !note) return
    await this.jira().update(epic.id, this.epicWords(note))
    epic.hash = this.epicHash(note)
    this.persist()
  }

  /** Jira won't have it under the Epic, which no retry changes: it stays an issue of its own, and the card says so. */
  private async notUnder(card: Card, epic: Mirrored, known: Mirrored | undefined, error: Error) {
    log.warn({ binder: this.space, card: card.id, why: error.message }, 'Jira wouldn’t put an issue under its Epic')
    if (known) known.parent = epic.key
    await this.hub.record({ kind: 'hub' }, { type: 'card.activity', id: card.id, activity: { at: new Date().toISOString(), by: 'Jira', kind: 'said', text: `Jira wouldn’t put its issue under ${epic.key}: ${error.message.slice(0, 200)}` } }).catch(() => undefined)
  }

  /** The card's next write, once its edits settle: one write, not one per keystroke. */
  private later(cardId: string, delay = this.quietMs) {
    clearTimeout(this.timers.get(cardId))
    this.timers.set(cardId, setTimeout(() => {
      this.timers.delete(cardId)
      this.queue = this.queue.then(() => (cardId.startsWith(noteJob) ? this.writeEpic(cardId.slice(noteJob.length)) : this.write(cardId))).then(() => {
        this.attempts.delete(cardId)
      }, (error: Error) => this.failed(cardId, error))
    }, delay))
  }

  private failed(cardId: string, error: Error) {
    const attempt = (this.attempts.get(cardId) ?? 0) + 1
    log.warn({ binder: this.space, card: cardId, attempt, why: error.message }, 'Writing a card to Jira failed')
    if (this.stopped) return
    // Refused for what it is, a field the project requires, say: no retry changes that, so the card says.
    const card = this.hub.state.cards.find((c) => c.id === cardId)
    if (card && /^Jira said 400/.test(error.message)) {
      this.attempts.delete(cardId)
      void this.say(card, `Jira wouldn’t take this card: ${error.message.slice(0, 300)}`)
      return
    }
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
    clearInterval(this.polling)
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

    const epic = await this.epicFor(card)
    const refusedShape = (error: Error) => /^Jira said 400/.test(error.message)
    let known = this.issues.get(cardId)
    if (!known) {
      // An issue that names this card already (the saver died mid-flight, or lost its map) is adopted, not made twice.
      // When Jira won't say, this throws and tries again later rather than guess.
      const found = await jira.issueOf(cardId)
      let under = !found && epic ? epic.key : undefined
      const issue = found ?? (await jira.create(cardId, words, under).catch(async (error: Error) => {
        if (!under || !refusedShape(error)) throw error
        under = undefined
        const made = await jira.create(cardId, words)
        await this.notUnder(card, epic!, undefined, error)
        return made
      }))
      // Refused once is refused: it isn't asked again for this Epic.
      known = { id: issue.id, key: issue.key, hash: found ? '' : hash, saidUpTo: new Date().toISOString(), ...(epic && !found ? { parent: epic.key } : {}) }
      this.issues.set(cardId, known)
      this.persist()
    }
    await this.showKey(card)
    if (epic && known.parent !== epic.key) {
      await jira.setParent(known.id, epic.key).then(() => {
        known!.parent = epic.key
      }, async (error: Error) => {
        if (!refusedShape(error)) throw error
        await this.notUnder(card, epic, known, error)
      })
      this.persist()
    }
    if (known.hash !== hash) {
      await jira.update(known.id, words)
      known.hash = hash
      this.persist()
    }
    const points = jira.pointsOf(card.size)
    if (points !== undefined && known.points !== points) {
      // A field the project won't take isn't worth asking again until the card's size or the field changes.
      await jira.setPoints(known.id, points).catch(async (error: Error) => {
        if (!refusedShape(error)) throw error
        await this.say(card, `Jira wouldn’t take the points for ${known!.key}: ${error.message.slice(0, 200)}`)
      })
      known.points = points
      this.persist()
    }
    if (known.stage !== card.stage && known.stuck !== card.stage) await this.moveIssue(card, known)
    for (const said of this.unsaid(card, known)) {
      const who = this.hub.state.agents.find((a) => a.id === said.by)?.name ?? said.by
      await jira.addComment(known.id, inBinders(who, said.text))
      known.saidUpTo = said.at
      this.persist()
    }
  }

  /** The issue goes to the status its card's stage stands for. The board keeps the stage either way, and says when Jira won't. */
  private async moveIssue(card: Card, known: Mirrored) {
    const jira = this.jira()
    const settled = () => {
      known.stage = card.stage
      delete known.stuck
    }
    const wanted = statusFor(card.stage, jira.settings.statuses)
    // Left out of the binder's map: it stays where it is.
    if (!wanted) return settled()
    // Going through other statuses is only for one the binder chose, which Jira has: a stock name may not be there at all.
    const chosen = !!jira.settings.statuses?.[card.stage]
    this.moving.add(card.id)
    try {
      const { reached, status, from } = await jira.moveTo(known.id, wanted, chosen ? { backwards: card.stage === 'ready' } : undefined)
      if (status) known.status = status
      if (reached || !chosen) settled()
      else {
        known.stuck = card.stage
        await this.say(card, `Jira’s workflow wouldn’t take ${known.key} to ${wanted}${from ? ` from ${from}` : ''}${status && status !== from ? `: it got as far as ${status}` : ''}.`)
      }
    } catch (error) {
      if (!/^Jira said 400/.test((error as Error).message)) throw error
      known.stuck = card.stage
      await this.say(card, `Jira wouldn’t move ${known.key} to ${wanted}: ${(error as Error).message.slice(0, 200)}`)
    } finally {
      this.moving.delete(card.id)
      this.persist()
    }
  }

  /** A word on the card from Jira's side, not repeated while it's the last thing said. */
  private async say(card: Card, text: string) {
    const now = this.hub.state.cards.find((c) => c.id === card.id)
    if (now?.activity.at(-1)?.text === text) return
    await this.hub.record({ kind: 'hub' }, { type: 'card.activity', id: card.id, activity: { at: new Date().toISOString(), by: 'Jira', kind: 'said', text } }).catch(() => undefined)
  }

  /** Asks Jira what's changed, so what people do there comes back with no webhook set up. In line with the writes, so it can't read one half done. */
  poll() {
    this.queue = this.queue.then(() => this.look()).catch((error: Error) => {
      log.warn({ binder: this.space, why: error.message }, 'Asking Jira what’s changed failed')
    })
    return this.queue
  }

  private async look() {
    const jira = this.jira()
    if (!jira.on() || this.stopped || !this.issues.size) return
    const found = await jira.recent(this.scanned ? lookBackMinutes : undefined)
    this.scanned = true
    const at = new Date().toISOString()
    for (const issue of found) {
      const cardId = this.cardOfIssue(issue.id)
      const known = cardId && this.issues.get(cardId)
      if (!cardId || !known || known.gone) continue
      if (known.status === undefined) this.firstLook(cardId, known, issue.status)
      else {
        const card = this.hub.state.cards.find((c) => c.id === cardId)
        if (card) await heardStatus(this.hub, jira, this, card, issue.status, at)
      }
      for (const comment of issue.comments) {
        const made = Date.parse(comment.created ?? '') || 0
        if (made && made <= (known.heardUpTo ?? 0)) continue
        const card = this.hub.state.cards.find((c) => c.id === cardId)
        if (card) await heardComment(this.hub, jira, card, comment, at)
        if (made) known.heardUpTo = made
      }
    }
    this.persist()
  }

  /**
   * What an issue mirrored before the hub kept track of its status is at. It may have been left behind by a move Jira
   * wouldn't make, which this hub took for done: that's tried again, as the hub has no way to tell it from a person's.
   */
  private firstLook(cardId: string, known: Mirrored, status: string | undefined) {
    known.status = status
    const card = this.hub.state.cards.find((c) => c.id === cardId)
    const { statuses, inbound } = this.jira().settings
    if (!card || !status || known.stage !== card.stage) return
    if (statusFor(card.stage, statuses)?.toLowerCase() === status.toLowerCase() || !stageOf(status, statuses, card, inbound)) return
    known.stage = undefined
    this.later(cardId, 0)
  }

  statusNews(cardId: string, status: string | undefined) {
    const known = this.issues.get(cardId)
    if (!known || !status || this.moving.has(cardId)) return false
    const news = known.status !== status
    known.status = status
    // Someone took it where the card already says: nothing's stuck any more.
    const card = this.hub.state.cards.find((c) => c.id === cardId)
    if (card && known.stuck === card.stage && statusFor(card.stage, this.jira().settings.statuses)?.toLowerCase() === status.toLowerCase()) {
      known.stage = card.stage
      delete known.stuck
    }
    this.persist()
    return news
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
    delete known.stuck
    this.persist()
  }

  lostEpic(issueId: string) {
    for (const epic of this.epics.values()) {
      if (epic.id === issueId) {
        epic.gone = true
        this.persist()
      }
    }
  }

  lost(cardId: string) {
    const known = this.issues.get(cardId)
    if (!known) return
    known.gone = true
    this.persist()
    const card = this.hub.state.cards.find((c) => c.id === cardId)
    if (card) void this.showKey(card).catch(() => undefined)
  }
}
