import { createHash, randomUUID } from 'node:crypto'
import type { Entry } from '../../../shared/state.ts'
import type { Card, Stage } from '../../../shared/work.ts'
import type { Folder, Note } from '../../../shared/notes.ts'
import { Refused, type Hub } from '../hub.ts'
import type { KV } from '../kv.ts'
import { log } from '../logger.ts'
import { BrainIndex, type Hit, type IndexSource, type SourceKind } from './index.ts'
import { captureNote, firstWords, withSummary, withTranscript, type Capture } from './captures.ts'
import { conversation, type Summary, type Turn } from './models.ts'
import { askPerson, boardFor, boardRules, doRules, heardAnswer, onlyTellRules, propose, proposalView, readDo, spoken, type Asked, type Board, type Proposal, type WorkPlace } from './board.ts'
import type { BrainSettingsStore } from './settings.ts'
import type { VectorFiles } from './vectorFiles.ts'

// A Binder's brain: the index of its notes and cards, kept up as they change, what's captured on a phone or Mac put in
// as notes and summed up, and questions answered from it all. The index is the Binder's own, in its own store; a
// question asked across several Binders asks each, and only those the person is in.

const stageNames: Record<Stage, string> = { proposed: 'Proposed', ready: 'Ready', working: 'In progress', blocked: 'Blocked', review: 'In review', live: 'Done' }

/** Where each kind of capture goes, when the sender doesn't say: the folders the Mac's Send to Hub uses. */
export const captureFolders: Record<Capture['kind'], string> = { dictation: 'Dictations', conversation: 'Captures', meeting: 'Meetings', note: 'Inbox' }

/** The card lines worth finding a card by: people's words and what its agents said, not every step they took. */
const sayingKinds = new Set(['comment', 'question', 'answer', 'said', 'completed', 'message'])

const short = (text: string, length = 12) => createHash('sha256').update(text).digest('hex').slice(0, length)

/**
 * Summaries the hub writes, two at a time across every Binder: a phone's outbox sending a day of conversations, or a
 * meeting hours long, waits its turn rather than calling the model dozens of times at once.
 */
export class Turns {
  private running = 0
  private waiting: (() => void)[] = []
  private most: number

  constructor(most: number) {
    this.most = most
  }

  async run<T>(work: () => Promise<T>): Promise<T> {
    if (this.running >= this.most) await new Promise<void>((go) => this.waiting.push(go))
    this.running++
    try {
      return await work()
    } finally {
      this.running--
      this.waiting.shift()?.()
    }
  }
}

const summaryTurns = new Turns(2)
/** A transcription server is usually one GPU: one recording at a time, the rest in line. */
export const transcriptionTurns = new Turns(1)

function keyOf(change: Entry['change']): string | undefined {
  const c = change as { type: string; id?: string; note?: { id: string }; card?: { id: string } }
  if (c.type === 'note.put') return `note:${c.note!.id}`
  if (c.type.startsWith('note.') && c.type !== 'note.work' && c.type !== 'note.distill' && c.id) return `note:${c.id}`
  if (c.type === 'card.put') return `card:${c.card!.id}`
  if (c.type.startsWith('card.') && c.id) return `card:${c.id}`
  return undefined
}

export class SpaceBrain {
  readonly id: string
  readonly index: BrainIndex
  /** The Binder's own store, for what the brain keeps beside its index (what came of a phone's captures and moments). */
  readonly kv: KV
  /** Where its vectors are kept for the long term; a personal Binder's passages have none. */
  readonly files?: VectorFiles
  /** Until what a rebuilt hub fetches back is here, nothing is sent to the embeddings model. */
  private ready: Promise<void> = Promise.resolve()
  private hub: Hub
  private settings: BrainSettingsStore
  private quietMs: number
  private retryMs: number
  /** Whether its passages go to the embeddings model: not a personal Binder's, which is its person's alone. */
  private embeds: boolean
  private due = new Set<string>()
  private timer?: NodeJS.Timeout
  private retryTimer?: NodeJS.Timeout
  private working?: Promise<void>
  /** The settings' version the index last caught up with: another embeddings model means new vectors for everything. */
  private seenVersion = -1
  /** Until when the embeddings model is left alone after it failed: words are indexed meanwhile. */
  private vectorsDownUntil = 0
  private stopped = false
  private summaries = new Set<Promise<void>>()

  constructor(options: { id: string; hub: Hub; kv: KV; settings: BrainSettingsStore; quietMs?: number; retryMs?: number; embeds?: boolean; files?: VectorFiles }) {
    this.id = options.id
    this.hub = options.hub
    this.settings = options.settings
    this.files = options.files
    this.index = new BrainIndex(options.kv, options.files)
    this.kv = options.kv
    this.quietMs = options.quietMs ?? 10_000
    this.retryMs = options.retryMs ?? 5 * 60_000
    this.embeds = options.embeds ?? true
  }

  /**
   * Indexes everything as it is now, then whatever changes. Started after the Binder's hub has read its log. What's kept
   * from before and gone now (a note deleted just before the hub stopped) is taken out.
   */
  start() {
    for (const note of this.hub.state.notes) this.due.add(`note:${note.id}`)
    for (const card of this.hub.state.cards) this.due.add(`card:${card.id}`)
    this.hub.on('entries', this.follow)
    this.ready = this.files ? this.files.start().catch((err: unknown) => log.error({ err, binder: this.id }, 'Couldn’t read the kept embeddings')) : Promise.resolve()
    void this.ready.then(() => this.index.keys()).then((keys) => {
      for (const key of [...keys, ...(this.files?.keys() ?? [])]) {
        const cut = key.indexOf(':')
        if (!this.sourceFor(key.slice(0, cut) as SourceKind, key.slice(cut + 1))) this.due.add(key)
      }
      this.soon(1000)
    }).catch(() => this.soon(1000))
  }

  stop() {
    this.stopped = true
    clearTimeout(this.timer)
    clearTimeout(this.retryTimer)
    this.hub.off('entries', this.follow)
  }

  /** Whether a note or card is still there: one gone since it was indexed is never quoted. */
  has(kind: SourceKind, id: string) {
    return kind === 'note' ? this.hub.state.notes.some((n) => n.id === id) : this.hub.state.cards.some((c) => c.id === id)
  }

  private follow = (entries: Entry[]) => {
    for (const { change } of entries) {
      const key = keyOf(change)
      if (key) this.due.add(key)
      // A folder or binder renamed: what's in it is somewhere else now.
      if (change.type === 'folder.put' || change.type === 'binder.put') {
        const binderId = change.type === 'folder.put' ? change.folder.binderId : change.binder.id
        for (const note of this.hub.state.notes) if (note.binderId === binderId) this.due.add(`note:${note.id}`)
      }
    }
    if (this.due.size) this.soon(this.quietMs)
  }

  private soon(ms: number) {
    if (this.timer || this.stopped) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.run()
    }, ms)
    this.timer.unref?.()
  }

  /** Indexes what's due, a source at a time, letting the hub answer between them. */
  private run(): Promise<void> {
    if (this.working) return this.working
    this.working = (async () => {
      await this.ready
      const embedder = this.embeds ? this.settings.embedder() : undefined
      const vectorsUp = Date.now() >= this.vectorsDownUntil
      if (embedder && vectorsUp && this.settings.version !== this.seenVersion) {
        this.seenVersion = this.settings.version
        for (const s of await this.index.withoutVectors(embedder.key)) this.due.add(`${s.kind}:${s.id}`)
      }
      const embed = embedder ? { key: embedder.key, embed: (texts: string[]) => embedder.embed(texts, 'document') } : undefined
      let vectorsFailed = !vectorsUp
      let done = 0
      while (this.due.size && !this.stopped) {
        const [key] = this.due
        this.due.delete(key)
        const cut = key.indexOf(':')
        const kind = key.slice(0, cut) as SourceKind
        const id = key.slice(cut + 1)
        const source = this.sourceFor(kind, id)
        try {
          // With the model down, vectors can still come from their long-term home.
          if (source) await this.index.put(source, vectorsFailed ? (embed && this.files ? { key: embed.key, embed: () => Promise.reject(new Error('The embeddings model is down.')) } : undefined) : embed)
          else await this.index.remove(kind, id)
        } catch (err) {
          // Its words are indexed; vectors are made when the embeddings model answers again.
          if (!vectorsFailed) log.warn({ binder: this.id, why: err instanceof Error ? err.message : String(err) }, 'The brain couldn’t embed passages; finding them by their words until it can')
          vectorsFailed = true
          this.vectorsDownUntil = Date.now() + this.retryMs
          this.retryLater()
        }
        if (++done % 25 === 0) {
          await this.index.flush()
          await new Promise((go) => setImmediate(go))
        }
      }
      await this.index.flush()
    })().catch((err) => log.error({ err, binder: this.id }, 'Indexing a binder’s notes and cards failed')).finally(() => {
      this.working = undefined
      if (this.due.size) this.soon(this.quietMs)
    })
    return this.working
  }

  /** Vectors for what has none, once the embeddings model has had time to come back. */
  private retryLater() {
    if (this.retryTimer || this.stopped) return
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined
      this.seenVersion = -1
      void this.run()
    }, this.retryMs)
    this.retryTimer.unref?.()
  }

  /** For tests and the first question: indexes what's due now. */
  async caughtUp() {
    clearTimeout(this.timer)
    this.timer = undefined
    await this.run()
    if (this.due.size) await this.run()
  }

  /** The words a note or card is found by, as it is now; undefined when it's gone. */
  sourceFor(kind: SourceKind, id: string): IndexSource | undefined {
    const state = this.hub.state
    if (kind === 'note') {
      const note = state.notes.find((n) => n.id === id)
      if (!note) return undefined
      return { kind, id, title: note.title || 'Untitled', text: note.text, context: this.placeOf(note) }
    }
    const card = state.cards.find((c) => c.id === id)
    if (!card) return undefined
    return { kind, id, title: card.title, text: cardWords(card), context: `${state.binders.find((b) => b.id === card.binderId)?.name ?? 'A binder'} · ${stageNames[card.stage] ?? card.stage}` }
  }

  private placeOf(note: Note) {
    const state = this.hub.state
    const names: string[] = []
    let folder: Folder | undefined = state.folders.find((f) => f.id === note.folderId)
    for (let depth = 0; folder && depth < 20; depth++) {
      names.unshift(folder.name)
      const parent: string | undefined = folder.parentId
      folder = parent ? state.folders.find((f) => f.id === parent) : undefined
    }
    const binder = state.binders.find((b) => b.id === note.binderId)?.name
    return [binder, ...names].filter(Boolean).join(' › ')
  }

  /** Whether a capture gets a summary: the hub has a model, summing up is on, and it's a conversation or meeting of some length. */
  wantsSummary(capture: Capture) {
    return Boolean(this.settings.model()) && this.settings.get().summarize && (capture.kind === 'conversation' || capture.kind === 'meeting') && capture.text.trim().split(/\s+/).length >= 25
  }

  /**
   * Puts a capture in as a note: in the binder named (or the Binder's first), in the folder named (or the one for its
   * kind), made at the top if it isn't there. With `sourceId`, the device's own id for it, sending it again gives back
   * the note it made the first time, so a phone's outbox can't make two.
   */
  async capture(login: string, capture: Capture, where: { binderId?: string; folder?: string; sourceId?: string } = {}) {
    const state = this.hub.state
    const binder = where.binderId ? state.binders.find((b) => b.id === where.binderId) : state.binders[0]
    if (!binder) throw new Refused(where.binderId ? `There’s no binder ${where.binderId} here.` : 'This Binder has no binder to put it in.')
    const id = where.sourceId ? `note-cap-${short(`${binder.id}\u0000${where.sourceId}`, 16)}` : `note-cap-${randomUUID().replace(/-/g, '').slice(0, 16)}`
    const already = state.notes.find((n) => n.id === id)
    if (already) return { note: already, created: false, summarizing: false, written: Promise.resolve(undefined as Summary | undefined) }
    const folderName = (where.folder?.trim() || captureFolders[capture.kind]).replace(/[/\\]+/g, ' ').slice(0, 80)
    const changes: Entry['change'][] = []
    // Its id comes from its name, so two captures arriving at once make one folder; once made, it's found by that id
    // wherever it was moved and whatever it was renamed, and left as people have it.
    const folderId = `folder-${folderName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'inbox'}-${short(`${binder.id}\u0000${folderName.toLowerCase()}`, 8)}`
    let folder = state.folders.find((f) => f.id === folderId)
      ?? state.folders.find((f) => f.binderId === binder.id && !f.parentId && f.name.toLowerCase() === folderName.toLowerCase())
    if (!folder) {
      folder = { id: folderId, binderId: binder.id, name: folderName }
      changes.push({ type: 'folder.put', folder })
    }
    const title = capture.title?.trim().slice(0, 120) || firstWords(capture.text)
    const at = new Date().toISOString()
    const note: Note = { id, title, binderId: binder.id, folderId: folder.id, editedAt: at, editedBy: login, editors: [login], text: captureNote(capture, title), captured: capture.kind }
    changes.push({ type: 'note.put', note })
    await this.hub.recordAll({ kind: 'user', login }, changes)
    const summarizing = this.wantsSummary(capture)
    // Resolves with the summary once it's written (undefined without one), for whoever wants to say what came of it.
    let written: Promise<Summary | undefined> = Promise.resolve(undefined)
    if (summarizing) {
      const chosen = capture.title?.trim() ? undefined : title
      written = summaryTurns.run(() => this.summarize(id, capture, chosen))
      const work: Promise<void> = written.then(() => undefined).finally(() => this.summaries.delete(work))
      this.summaries.add(work)
    }
    return { note: this.hub.state.notes.find((n) => n.id === id) ?? note, created: true, summarizing, written }
  }

  /**
   * Sums up a capture's note and puts the summary in it, as the hub, not its person: they didn't write it. A title the
   * hub chose (`chosen`) becomes the summary's, while the note still has it. A note locked meanwhile is left alone.
   */
  private async summarize(id: string, capture: Capture, chosen?: string): Promise<Summary | undefined> {
    const model = this.settings.model()
    if (!model || this.stopped) return undefined
    try {
      const summary = await model.summarize({ kind: capture.kind, text: capture.text, title: capture.title, at: capture.recordedAt })
      const note = this.hub.state.notes.find((n) => n.id === id)
      if (!note || note.locked) return summary
      const retitle = chosen !== undefined && note.title === chosen ? chosen : undefined
      await this.hub.record({ kind: 'hub' }, { type: 'note.edit', id, text: withSummary(note.text, summary, retitle), title: retitle ? summary.title : note.title, by: 'hub', at: new Date().toISOString() })
      return summary
    } catch (err) {
      log.warn({ binder: this.id, note: id, why: err instanceof Error ? err.message : String(err) }, 'Summing up a capture failed')
      return undefined
    }
  }

  /**
   * A captured note's transcript, written down again by the hub's transcription model: put in place of the device's,
   * and summed up again, as the hub. A note locked meanwhile, or one that's gone, is left alone.
   */
  async rewriteTranscript(id: string, capture: Capture): Promise<{ rewritten: boolean; written: Promise<Summary | undefined> }> {
    const none = { rewritten: false, written: Promise.resolve(undefined as Summary | undefined) }
    const note = this.hub.state.notes.find((n) => n.id === id)
    if (!note || note.locked || this.stopped) return none
    await this.hub.record({ kind: 'hub' }, { type: 'note.edit', id, text: withTranscript(note.text, capture.text), title: note.title, by: 'hub', at: new Date().toISOString() })
    if (!this.wantsSummary(capture)) return { ...none, rewritten: true }
    const written = summaryTurns.run(() => this.summarize(id, capture))
    const work: Promise<void> = written.then(() => undefined).finally(() => this.summaries.delete(work))
    this.summaries.add(work)
    return { rewritten: true, written }
  }

  /** For tests: waits for the summaries being written. */
  async summariesWritten() {
    await Promise.all([...this.summaries])
  }
}

/** What a card is found by: its brief, what done means, and what people and its agents said on it. */
export function cardWords(card: Card) {
  const lines = [card.brief, card.doneWhen ? `Done when: ${card.doneWhen}` : '', card.quote ? `From the note: “${card.quote}”` : '']
  let room = 20_000
  for (const a of card.activity) {
    if (!sayingKinds.has(a.kind) || !a.text) continue
    const line = a.text.slice(0, 2000)
    room -= line.length
    if (room < 0) break
    lines.push(line)
  }
  return lines.filter(Boolean).join('\n\n')
}

/** A Binder a question is asked in, as the person reaches it. */
export interface AskPlace {
  id: string
  name: string
  brain: SpaceBrain
  /** Its web address for a note or card. */
  url: (kind: SourceKind, id: string) => string
  /** Which of its notes and cards may be used, when not all. */
  keep?: (kind: SourceKind, id: string) => boolean
  /** Its work, for how things stand now and what can be done about it. */
  work?: WorkPlace
}

export interface AskSource {
  /** Its number in the answer, from 1. */
  n: number
  binder: string
  binderName: string
  kind: SourceKind
  id: string
  title: string
  context?: string
  /** The passage the answer rests on. */
  text: string
  url: string
}

export interface AskResult {
  /** The model's answer, each stretch with the numbers of the sources it rests on. None without a model. */
  answer?: { text: string; parts: { text: string; sources: number[] }[] }
  sources: AskSource[]
  model?: string
  searchedBy: 'words' | 'words and meaning'
  /** Why there's no answer, in words, when the model couldn't give one. */
  problem?: string
  /** Something it would do, asked for in the question, for the person to answer with a button. */
  proposal?: ReturnType<typeof proposalView>
}

/**
 * Answers a question from the notes and cards of these Binders: the passages that best match it, by their words and,
 * with an embeddings model, by what they mean; then the model's answer, citing them. Without a model, the passages.
 */
/** The passages in these Binders that best match `query`: by its words and, with an embeddings model, by what it means. */
async function find(settings: BrainSettingsStore, places: AskPlace[], query: string, most: number, embedWithinMs?: number) {
  const embedder = settings.embedder()
  let vector: Float32Array | undefined
  if (embedder) {
    try {
      const embedding = embedder.embed([query], 'query').then(([v]) => v)
      // Searching as someone types can't wait on a slow model: its words are found at once, and it goes on without.
      vector = embedWithinMs ? await Promise.race([embedding, new Promise<undefined>((done) => { setTimeout(() => done(undefined), embedWithinMs).unref?.() })]) : await embedding
    } catch (err) {
      log.warn({ why: err instanceof Error ? err.message : String(err) }, 'The brain couldn’t embed a question; finding by words')
    }
  }
  const found: { hit: Hit; place: AskPlace }[] = []
  for (const place of places) {
    const keep = place.keep
    for (const hit of await place.brain.index.search(query, 12, { vector, embedKey: vector ? embedder!.key : undefined, keep: (kind, id) => place.brain.has(kind, id) && (!keep || keep(kind, id)) })) found.push({ hit, place })
  }
  // The best passages over all the Binders, at most two from any one note or card.
  found.sort((a, b) => b.hit.score - a.hit.score)
  const perSource = new Map<string, number>()
  const chosen = found.filter(({ hit, place }) => {
    const key = `${place.id}:${hit.kind}:${hit.id}`
    const count = perSource.get(key) ?? 0
    perSource.set(key, count + 1)
    return count < 2
  }).slice(0, most)
  const sources: AskSource[] = chosen.map(({ hit, place }, i) => ({
    n: i + 1,
    binder: place.id,
    binderName: place.name,
    kind: hit.kind,
    id: hit.id,
    title: hit.title,
    ...(hit.context ? { context: hit.context } : {}),
    text: hit.text,
    url: place.url(hit.kind, hit.id),
  }))
  const searchedBy: AskResult['searchedBy'] = vector ? 'words and meaning' : 'words'
  const passages = chosen.map(({ hit, place }) => ({ title: hit.title, text: hit.text, context: `${hit.kind === 'note' ? 'A note' : 'A card'} in ${place.name}${hit.context ? `: ${hit.context}` : ''}` }))
  return { sources, passages, searchedBy }
}

/** What ⌘K shows as someone types: the passages that match, with no model's answer. */
export async function search(settings: BrainSettingsStore, places: AskPlace[], query: string) {
  const asked = query.trim().slice(0, 500)
  if (!asked) throw new Refused('Search for something.')
  const { sources, searchedBy } = await find(settings, places, asked, 8, 2500)
  return { sources, searchedBy }
}

/** How the work stands in these places for this person, when any of them has its work to hand. */
function boardOf(places: AskPlace[], person?: string) {
  const work = places.flatMap((p) => (p.work ? [p.work] : []))
  return person && work.length ? boardFor(work, person) : undefined
}

/** What a model's line comes to: something to ask the person, or why it can't be. */
function proposalFrom(wanted: Asked, board: Board, person: string): { proposal: Proposal } | { refused: string } {
  try {
    const proposal = propose(wanted, board, person)
    askPerson(proposal)
    return { proposal }
  } catch (err) {
    if (err instanceof Refused) return { refused: err.message }
    throw err
  }
}

/**
 * `person`: who's asking, so it goes by how their work stands too. `may`: they can answer it here, so a question can
 * come to something it would do, which waits for their answer.
 */
export async function ask(settings: BrainSettingsStore, places: AskPlace[], question: string, options: { most?: number; onSources?: (sources: AskSource[]) => void; person?: string; may?: boolean } = {}): Promise<AskResult> {
  const asked = question.trim().slice(0, 2000)
  if (!asked) throw new Refused('Ask a question.')
  const { sources, passages, searchedBy } = await find(settings, places, asked, options.most ?? 8)
  options.onSources?.(sources)
  const model = settings.model()
  const board = boardOf(places, options.person)
  if (!model || (!sources.length && !board)) return { sources, searchedBy, ...(model ? { model: model.label } : {}) }
  try {
    const answer = await model.answer(asked, board ? [...passages, board.passage] : passages, board ? `${boardRules}\n${options.may ? doRules : onlyTellRules}` : undefined)
    const said = (words: string, proposal?: Proposal) => ({ answer: { text: words, parts: [{ text: words, sources: [] }] }, sources, model: answer.model ?? model.label, searchedBy, ...(proposal ? { proposal: proposalView(proposal) } : {}) })
    // The board isn't a source to show: it's only what's so now. A line a model gave is taken out of what's shown.
    let wanted: Asked | undefined
    const parts = answer.parts.flatMap((part) => {
      const read = readDo(part.text)
      wanted ??= read.asked
      if (read.asked && !read.words) return []
      return [{ text: read.asked ? read.words : part.text, sources: part.sources.filter((s) => s < sources.length).map((s) => s + 1) }]
    })
    if (wanted) {
      if (!options.may || !board || !options.person) {
        if (!parts.length) return said('You can’t do that from here. Talk can, on the iPhone, and so can Ask on the hub.')
      } else {
        const came = proposalFrom(wanted, board, options.person)
        return 'proposal' in came ? said(came.proposal.what, came.proposal) : said(came.refused)
      }
    }
    return { answer: { text: parts.map((p) => p.text).join('').trim(), parts }, sources, model: answer.model ?? model.label, searchedBy }
  } catch (err) {
    return { sources, model: model.label, searchedBy, problem: err instanceof Error ? err.message : String(err) }
  }
}

/** What Talk on the iPhone hears back: the brain's reply, to read out, and the passages it had to go on. */
export interface TalkResult {
  reply: string
  sources: AskSource[]
  model: string
}

/**
 * One turn of a conversation out loud: what the person just said, after what was said before. The brain looks in these
 * Binders for it (with what they said before it, for a short follow-up such as "and the second one?"), and its model
 * answers as people talk: from the passages when they help, and from what it knows when they don't.
 */
export async function talk(settings: BrainSettingsStore, places: AskPlace[], turns: Turn[], options: { onSources?: (sources: AskSource[]) => void; person?: string } = {}): Promise<TalkResult> {
  const said = conversation(turns.slice(-12).map((t): Turn => ({ role: t.role === 'assistant' ? 'assistant' : 'user', text: String(t.text ?? '').slice(0, 2000) })))
  if (!said.length) throw new Refused('Say something first.')
  const model = settings.model()
  if (!model) throw new Refused('Your hub has no model to talk with.')
  const theirs = said.filter((t) => t.role === 'user').map((t) => t.text)
  const latest = theirs[theirs.length - 1]
  // Their answer to what they were just asked is read here, from their own words, and goes nowhere near the model.
  const answered = options.person ? await heardAnswer(options.person, latest) : undefined
  if (answered) return { reply: answered, sources: [], model: model.label }
  const query = theirs.length > 1 && latest.split(/\s+/).length < 8 ? `${theirs[theirs.length - 2]} ${latest}` : latest
  const { sources, passages } = await find(settings, places, query.slice(0, 2000), 5)
  options.onSources?.(sources)
  const board = boardOf(places, options.person)
  if (!board || !options.person) return { reply: await model.talk(said, passages), sources, model: model.label }
  const reply = await model.talk(said, [...passages, board.passage], `${boardRules}\n${doRules}`)
  const { words, asked } = readDo(reply)
  if (!asked) return { reply: words, sources, model: model.label }
  // What's read out is the hub's words for what would happen, whatever else the model said.
  const came = proposalFrom(asked, board, options.person)
  return { reply: 'proposal' in came ? spoken(came.proposal) : came.refused, sources, model: model.label }
}

/** An answer as plain text, for an MCP client: the answer with [n] after what each source supports, then the sources. */
export function askText(result: AskResult) {
  if (!result.sources.length && !result.answer) return 'Nothing in these binders matches that question.'
  const answer = result.answer
    ? result.answer.parts.map((p) => `${p.text.replace(/\s+$/, '')}${p.sources.length ? ` [${p.sources.join(', ')}]` : ''}${/\s$/.test(p.text) ? p.text.match(/\s+$/)![0] : ''}`).join('').trim()
    : result.problem
      ? `No answer from the model (${result.problem}). The passages that match best:`
      : 'The hub has no model to answer with, so here are the passages that match best:'
  const list = result.sources.map((s) => `[${s.n}] ${s.kind === 'note' ? 'Note' : 'Card'} “${s.title}” in ${s.binderName}${s.context ? ` (${s.context})` : ''}, id ${s.id}${result.answer ? '' : `\n${s.text.slice(0, 600)}`}`).join('\n')
  return list ? `${answer}\n\nSources:\n${list}` : answer
}
