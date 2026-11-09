import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import type { Entry } from '../../shared/state.ts'
import type { Activity, Card, Stage } from '../../shared/work.ts'
import type { Binder, Folder, Note } from '../../shared/notes.ts'
import { titleOf } from '../../shared/notes.ts'
import type { Space, Spaces } from './spaces.ts'
import { personalId } from './spaces.ts'
import { Refused } from './hub.ts'
import { Refusal } from './auth.ts'
import { ask, talk, transcriptionTurns, type AskPlace, type AskSource } from './brain/brain.ts'
import { BrainUnavailable } from './brain/models.ts'
import { speakersByOverlap, transcriptMarkdown, type SaidBy } from './brain/captures.ts'
import type { BrainSettingsStore } from './brain/settings.ts'
import type { SourceKind } from './brain/index.ts'
import { log } from './logger.ts'

// The hub as an iPhone's brain. With "Your hub" chosen, the iPhone sends the hub the very calls it would send its Mac
// over their link: tools (list_tasks, get_note, ask_knowledge…), the binders/* methods (conversation, moment, outcomes,
// suggestions, decision…) and binders/changed in return, the same JSON-RPC in the same shapes, here over a WebSocket
// signed in as the person. So every screen the iPhone has works with no Mac. Its binders are the binders of every Binder
// the person is in, each kept to its own; what it captures goes to the person's own Binder, never a team's unless they
// put it there. What the hub can't do yet isn't in the features it lists, so the iPhone hides it rather than half-work.

const columnOf: Record<Stage, string> = { proposed: 'backlog', ready: 'ready', working: 'in_progress', blocked: 'blocked', review: 'review', live: 'done' }
const stageOf: Record<string, Stage> = { backlog: 'proposed', ready: 'ready', in_progress: 'working', blocked: 'blocked', review: 'review', done: 'live' }

/** What the iPhone's events call each kind of line on a card. */
const eventKinds: Partial<Record<Activity['kind'], string>> = {
  created: 'created', moved: 'moved', claimed: 'claimed', released: 'released', progress: 'progress', step: 'progress', ran: 'progress',
  said: 'comment', comment: 'comment', message: 'comment', debrief: 'comment', challenge: 'comment', question: 'question', answer: 'answer',
  pr: 'edited', completed: 'completed', merged: 'completed', deployed: 'completed', permission: 'decision',
}

/** Times as the iPhone reads them: no fraction of a second. */
export const isoNoFraction = (value: string | number | Date | undefined) => {
  if (value === undefined || value === '') return ''
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '' : date.toISOString().replace(/\.\d{3}Z$/, 'Z')
}

/** Swift's reference date: what CaptureOutcome's times are counted from. */
const referenceSeconds = (date: Date) => date.getTime() / 1000 - 978_307_200

/** A binder as the iPhone has it: one binder of one Binder the person is in, named so no two have the same name. */
interface Place {
  key: string
  name: string
  space: Space
  spaceId: string
  spaceName: string
  binder: Binder
  personal: boolean
}

/** What came of a capture or moment, as the iPhone's CaptureOutcome has it (camelCase, its own keys). */
interface Outcome {
  id: string
  state: string
  line: string
  title?: string
  settled?: boolean
  binder?: string
  kind?: string
  card?: string
  actions?: string[]
  sources?: string[]
  /** Kept for Undo: what it made. */
  made?: { space: string; kind: 'card' | 'note'; id: string }
  /** Its audio is being written down on the hub, and nothing is filed yet: the iPhone's own transcript may still come. */
  transcribing?: boolean
  at: string
}

/** What the iPhone sends with a conversation's audio (as the X-Binders-Capture header): when, from where, and its voices. */
export interface AudioCapture {
  id: string
  started?: string
  ended?: string
  device?: string
  /** The voices as the iPhone told them apart: each one's turns, in seconds from the start of the audio. */
  turns?: { start: number; end: number; speaker: string }[]
  /** The iPhone's label for a voice → the name to show: "Speaker 1" → "You". */
  speakers?: Record<string, string>
  /**
   * Where each stretch of the file was heard: seconds into the file → seconds since `started` on the wall clock. The
   * iPhone records only speech, so a minute into the file can be an hour into the conversation; its transcript's times
   * are on the clock, and the hub's are put there too.
   */
  clock?: { file: number; wall: number }[]
  language?: string
}

/** A time in a recording's file, on the clock its `clock` gives (the file's own time without one). */
export function onTheClock(seconds: number, clock: { file: number; wall: number }[] = []) {
  if (!clock.length) return seconds
  let span = clock[0]
  for (const stretch of clock) if (stretch.file <= seconds) span = stretch
  return Math.max(0, span.wall + seconds - span.file)
}

interface Suggestion {
  id: string
  conversation: string
  kind: 'card' | 'answer' | 'idea'
  text: string
  binder: string
  sources: string[]
  status: 'offered' | 'accepted' | 'dismissed'
  at: string
}

/** Told when something the iPhone polls for changed: a capture written up, a moment decided, a suggestion. */
export const appEvents = new EventEmitter<{ changed: [login: string, kinds: string[]] }>()
appEvents.setMaxListeners(0)

/** A write the iPhone may send twice (its outbox resending): the first answer, again, for the same request id. */
const answered = new Map<string, unknown>()
const remember = (key: string, value: unknown) => {
  answered.set(key, value)
  if (answered.size > 2000) answered.delete(answered.keys().next().value!)
}

export interface AppLinkDeps {
  spaces: Spaces
  login: string
  settings?: BrainSettingsStore
  webUrl: (space: string, kind: SourceKind, id: string) => string
  /** The person's own GitHub in a Binder, when they've connected it: what merges and deploys goes as them. */
  githubIn?: (space: string) => Promise<string | undefined>
  hubName: string
  version: string
  /** Sends a message to the iPhone (a reply or a notification). */
  send: (message: Record<string, unknown>) => void
}

class Failure extends Error {
  code: number
  constructor(code: number, message: string) {
    super(message)
    this.code = code
  }
}

export class AppLinkSession {
  private deps: AppLinkDeps
  private login: string
  private subscribed = false
  private pending = new Set<string>()
  private flushTimer?: NodeJS.Timeout
  private stops: (() => void)[] = []
  /** Permission requests already told to the iPhone, so each rings once. */
  private toldApprovals = new Set<string>()

  constructor(deps: AppLinkDeps) {
    this.deps = deps
    this.login = deps.login
  }

  close() {
    clearTimeout(this.flushTimer)
    for (const stop of this.stops) stop()
    this.stops = []
  }

  // Places ---------------------------------------------------------------------------------------------------------

  /** The binders of every Binder the person is in (as a member: a hub admin's others aren't theirs to carry about). */
  places(): Place[] {
    const out: Place[] = []
    for (const { info } of this.deps.spaces.forPerson(this.login, false)) {
      const space = this.deps.spaces.get(info.id)
      if (!space) continue
      const binders = space.hub.state.binders
      for (const binder of binders) {
        const base = binders.length === 1 ? (info.personal ? 'Personal' : info.name) : `${info.personal ? 'Personal' : info.name} · ${binder.name}`
        out.push({ key: `${info.id}/${binder.id}`, name: base, space, spaceId: info.id, spaceName: info.name, binder, personal: Boolean(info.personal) })
      }
    }
    // Names the iPhone tells apart: a second of the same name says which Binder it's in.
    const seen = new Map<string, number>()
    for (const place of out) seen.set(place.name.toLowerCase(), (seen.get(place.name.toLowerCase()) ?? 0) + 1)
    for (const place of out) if ((seen.get(place.name.toLowerCase()) ?? 0) > 1) place.name = `${place.name} (${place.spaceId})`
    return out
  }

  /** A binder by the name or id the iPhone sent, or its first own (personal) binder when none is named. */
  private place(ref?: string): Place {
    const places = this.places()
    if (ref) {
      const wanted = ref.trim().toLowerCase()
      const found = places.find((p) => p.key.toLowerCase() === wanted) ?? places.find((p) => p.name.toLowerCase() === wanted)
        ?? places.find((p) => p.binder.name.toLowerCase() === wanted)
      if (!found) throw new Refused(`No binder ${ref} on your hub.`)
      return found
    }
    const own = places.find((p) => p.spaceId === personalId(this.login)) ?? places[0]
    if (!own) throw new Refused('You’re not in any binder on your hub.')
    return own
  }

  private own(): Place {
    return this.place()
  }

  /** The place an id the iPhone has (`space/item`) is in, and the item's own id. */
  private split(ref: string) {
    const cut = ref.indexOf('/')
    if (cut <= 0) throw new Refused(`No ${ref} on your hub.`)
    const spaceId = ref.slice(0, cut)
    const id = ref.slice(cut + 1)
    const places = this.places().filter((p) => p.spaceId === spaceId)
    if (!places.length) throw new Refused(`No ${ref} on your hub.`)
    return { places, space: places[0].space, spaceId, id }
  }

  private placeOfBinder(spaceId: string, binderId: string) {
    return this.places().find((p) => p.spaceId === spaceId && p.binder.id === binderId)
  }

  private agentName(space: Space, id?: string) {
    if (!id) return ''
    return space.hub.state.agents.find((a) => a.id === id)?.name ?? id
  }

  private agentNamed(space: Space, name?: string) {
    if (!name) return undefined
    const wanted = name.trim().toLowerCase()
    const agent = space.hub.state.agents.find((a) => !a.revoked && (a.name.toLowerCase() === wanted || a.id === name))
    if (!agent) throw new Refused(`No agent ${name} in that binder.`)
    return agent
  }

  // Messages -------------------------------------------------------------------------------------------------------

  /** One JSON-RPC message from the iPhone: its reply, or nothing for a notification. */
  async handle(message: { id?: unknown; method?: unknown; params?: unknown }) {
    const id = typeof message.id === 'number' ? message.id : undefined
    const method = typeof message.method === 'string' ? message.method : ''
    const params = (message.params && typeof message.params === 'object' ? message.params : {}) as Record<string, unknown>
    try {
      const result = await this.call(method, params)
      if (id !== undefined) this.deps.send({ jsonrpc: '2.0', id, result })
    } catch (err) {
      const words = err instanceof Refused || err instanceof Refusal || err instanceof Failure ? err.message : 'The hub couldn’t do that.'
      if (!(err instanceof Refused || err instanceof Refusal || err instanceof Failure)) log.warn({ err, method }, 'An iPhone’s call failed on the hub')
      const code = err instanceof Failure ? err.code : -32602
      if (id !== undefined) this.deps.send({ jsonrpc: '2.0', id, error: { code, message: words } })
    }
  }

  features() {
    const settings = this.deps.settings
    const model = Boolean(settings?.model())
    return [
      'conversation', 'outcomes', 'dedupe', 'askProgress', 'folders', 'todosAreCards', 'approvals',
      // Talk: a conversation out loud with the hub's model (binders/talk), read out by its voice or the iPhone's own.
      ...(model ? ['suggestions', 'moment', 'talks'] : []),
      // It writes down what the iPhone sends as audio (POST /api/app/audio), and reads answers out (binders/speak).
      ...(settings?.transcriber() ? ['transcribes'] : []),
      ...(settings?.speaker() ? ['speaks'] : []),
    ]
  }

  private async call(method: string, params: Record<string, unknown>): Promise<unknown> {
    switch (method) {
      case 'binders/hello':
        return { name: this.deps.hubName, version: this.deps.version, protocol: 1, features: this.features() }
      case 'binders/subscribe':
        if (!this.subscribed) this.subscribe()
        return {}
      case 'ping':
        return {}
      case 'binders/warm':
        // Talk opening: the hub's model and voice get ready, as one on your machines loads when first asked for. Capture's
        // own warm-ups (every couple of minutes while someone talks) don't load anything.
        if (params.talk === true) this.warmForTalk()
        return {}
      case 'binders/talk':
        return this.talkTurn(params)
      case 'tools/call':
        return this.tool(String(params.name ?? ''), (params.arguments ?? {}) as Record<string, unknown>)
      case 'binders/format':
        // Cleaned up on the iPhone for now: the hub's models are too slow for the four seconds dictation waits.
        return { text: String(params.text ?? ''), model: '', used_model: false }
      case 'binders/dictation':
        return this.dictation(params)
      case 'binders/speak':
        return this.speak(params)
      case 'binders/conversation':
        return this.conversation(params)
      case 'binders/outcomes':
        return this.outcomes(params)
      case 'binders/outcome':
        return this.outcomeAction(params)
      case 'binders/suggestions':
        return this.suggestions()
      case 'binders/suggestion':
        return this.suggestionAction(params)
      case 'binders/moment':
        return this.moment(params)
      case 'binders/decision':
        return this.decision(params)
      default:
        throw new Failure(-32601, `The hub doesn’t do ${method || 'that'} yet.`)
    }
  }

  /** A tool's result, as the Mac's MCP server gives it: its JSON as text, or the refusal with isError. */
  private async tool(name: string, args: Record<string, unknown>) {
    const reply = (value: unknown, isError = false) => ({ content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }], isError })
    const requestId = typeof args.request_id === 'string' && args.request_id ? `${this.login}:${name}:${args.request_id}` : undefined
    if (requestId && answered.has(requestId)) return answered.get(requestId)
    let result: ReturnType<typeof reply>
    try {
      result = reply(await this.runTool(name, args))
    } catch (err) {
      if (err instanceof Failure) throw err
      if (err instanceof Refused || err instanceof Refusal) result = reply(err.message, true)
      else {
        log.warn({ err, tool: name }, 'An iPhone’s tool failed on the hub')
        result = reply('The hub couldn’t do that.', true)
      }
    }
    if (requestId && !result.isError) remember(requestId, result)
    return result
  }

  private async runTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    const text = (key: string) => (typeof args[key] === 'string' ? (args[key] as string) : '')
    switch (name) {
      case 'list_binders':
        return this.places().map((p) => {
          const notes = p.space.hub.state.notes.filter((n) => n.binderId === p.binder.id)
          return { id: p.key, name: p.name, archived: false, shared: !p.personal, meetings: notes.filter((n) => n.captured === 'meeting').length, notes: notes.length, what_goes_here: '' }
        })
      case 'list_tasks': {
        const only = text('binder') ? this.place(text('binder')) : undefined
        const column = text('column')
        const cards = (only ? [only] : this.places()).flatMap((p) => p.space.hub.state.cards.filter((c) => c.binderId === p.binder.id).map((card) => ({ card, place: p })))
          .filter(({ card }) => (column ? columnOf[card.stage] === column : card.stage !== 'live'))
          .sort((a, b) => b.card.updatedAt.localeCompare(a.card.updatedAt))
          .slice(0, 100)
        return cards.map(({ card, place }) => this.cardShape(card, place))
      }
      case 'get_task': {
        const { card, place } = this.card(text('id'))
        return this.cardDetail(card, place)
      }
      case 'create_task':
        return this.createTask(args)
      case 'update_task':
        return this.updateTask(args)
      case 'claim_task':
        throw new Refused('On your hub, agents take cards: give it to one of them.')
      case 'release_task':
        throw new Refused('On your hub, an agent lets go of its own cards.')
      case 'comment_task': {
        const { card, place } = this.card(text('id'))
        const words = text('text').trim()
        if (!words) throw new Refused('Say something first.')
        await place.space.actions.comment(this.login, card.id, words)
        return { message: card.needsYou ? 'Answered.' : 'Said on the card.' }
      }
      case 'list_agents':
        return this.agents()
      case 'list_notes':
        return this.notes(args)
      case 'list_folders':
        return this.folders(args)
      case 'get_note': {
        const { note, place } = this.note(text('id'))
        return { id: `${place.spaceId}/${note.id}`, title: note.title || titleOf(note.text), updated: isoNoFraction(note.editedAt), binder: place.name, text: note.text, digest: '', ...(note.editedBy ? { edited_by: this.agentName(place.space, note.editedBy) || note.editedBy, edited_at: isoNoFraction(note.editedAt) } : {}) }
      }
      case 'add_note':
        return this.addNote(args)
      case 'add_todo': {
        // To-dos are cards: something to do goes on the board, in Backlog.
        const place = this.place(text('binder') || undefined)
        const title = text('text').trim().split('\n')[0].slice(0, 200)
        if (!title) throw new Refused('Say what to do.')
        const card = await place.space.actions.createCard({ kind: 'user', login: this.login }, { binderId: place.binder.id, title, stage: 'proposed' })
        return { message: `On the ${place.name} board: ${title}`, id: `${place.spaceId}/${card.id}` }
      }
      case 'list_todos':
        return []
      case 'set_todo_status':
        throw new Refused('To-dos are cards on your hub: move the card instead.')
      case 'list_meetings':
        return this.meetings(args)
      case 'get_meeting':
        return this.meeting(text('id'))
      case 'ask_knowledge':
        return this.askKnowledge(text('question'), text('progress_token'))
      case 'work_streams':
        return this.workStreams()
      default:
        throw new Failure(-32602, `Unknown tool: ${name}`)
    }
  }

  // Cards ----------------------------------------------------------------------------------------------------------

  private card(ref: string) {
    const { places, id } = this.split(ref)
    for (const place of places) {
      const card = place.space.hub.state.cards.find((c) => c.id === id && c.binderId === place.binder.id)
      if (card) return { card, place }
    }
    throw new Refused('That card isn’t on your hub any more.')
  }

  private cardShape(card: Card, place: Place) {
    const space = place.space
    const held = card.agentId ? this.agentName(space, card.agentId) : ''
    return {
      id: `${place.spaceId}/${card.id}`,
      title: card.title,
      column: columnOf[card.stage] ?? 'ready',
      assignee: held,
      assignee_is_agent: Boolean(card.agentId),
      claim_expires: '',
      binder: place.name,
      due: '',
      links: (card.prId ? 1 : 0) + (card.issue ? 1 : 0),
      updated: isoNoFraction(card.updatedAt),
      preview: card.brief.slice(0, 200),
      todo: '',
      meant_for: card.meantFor ? this.agentName(space, card.meantFor) : '',
      meant_for_confirmed: true,
      ...(card.noteId ? { note_id: `${place.spaceId}/${card.noteId}` } : {}),
    }
  }

  private cardDetail(card: Card, place: Place) {
    const space = place.space
    const who = (by: string) => {
      const agent = space.hub.state.agents.find((a) => a.id === by)
      if (agent) return { who: agent.name, agent: true }
      if (by.toLowerCase() === this.login.toLowerCase()) return { who: 'You', agent: false }
      return { who: by === 'hub' ? 'Binders' : by, agent: false }
    }
    const timeline = card.activity.filter((a) => eventKinds[a.kind]).slice(-60).map((a) => ({ when: isoNoFraction(a.at), ...who(a.by), kind: eventKinds[a.kind]!, text: a.text, to: '' }))
    const waiting = card.permission && !card.permission.answer ? card.permission : undefined
    if (waiting) timeline.push({ when: isoNoFraction(waiting.at), ...who(waiting.agent), kind: 'approval', text: waiting.what, to: '' })
    const note = card.noteId ? space.hub.state.notes.find((n) => n.id === card.noteId) : undefined
    const links = [card.issue?.url, card.prId ? space.hub.state.pulls.find((p) => p.id === card.prId)?.url : undefined].filter((l): l is string => Boolean(l))
    return {
      ...this.cardShape(card, place),
      links,
      details: [card.brief, card.doneWhen ? `Done when: ${card.doneWhen}` : ''].filter(Boolean).join('\n\n'),
      source: note ? `From the note “${note.title || titleOf(note.text)}”` : '',
      timeline,
      ...(waiting ? { approval: { id: waiting.request, who: this.agentName(space, waiting.agent), when: isoNoFraction(waiting.at), action: waiting.tool, recipients: [], text: waiting.what, link: this.deps.webUrl(place.spaceId, 'card', card.id), headline: `${this.agentName(space, waiting.agent)} asks to use ${waiting.tool}` } } : {}),
    }
  }

  private async createTask(args: Record<string, unknown>) {
    const text = (key: string) => (typeof args[key] === 'string' ? (args[key] as string).trim() : '')
    const place = this.place(text('binder') || undefined)
    const title = text('title')
    if (!title) throw new Refused('A card needs a title.')
    const agent = this.agentNamed(place.space, text('for') || undefined)
    const stage: Stage = text('column') === 'ready' || agent ? 'ready' : 'proposed'
    const card = await place.space.actions.createCard({ kind: 'user', login: this.login }, { binderId: place.binder.id, title: title.slice(0, 200), brief: text('details'), stage, meantFor: agent?.id })
    return { message: `Card “${card.title}” added to the ${place.name} board, in ${stage === 'ready' ? 'Ready' : 'Backlog'}.`, id: `${place.spaceId}/${card.id}` }
  }

  private async updateTask(args: Record<string, unknown>) {
    const text = (key: string) => (typeof args[key] === 'string' ? (args[key] as string) : undefined)
    const { card, place } = this.card(text('id') ?? '')
    const fields: Partial<Card> = {}
    if (text('for') !== undefined) {
      const agent = text('for') ? this.agentNamed(place.space, text('for')) : undefined
      fields.meantFor = agent?.id
      if (agent && card.stage === 'proposed') fields.stage = 'ready'
    }
    const column = text('column')
    if (column) {
      const stage = stageOf[column]
      if (!stage) throw new Refused(`No column ${column}.`)
      fields.stage = stage
    }
    if (!Object.keys(fields).length) throw new Refused('Nothing to change.')
    await place.space.hub.record({ kind: 'user', login: this.login }, { type: 'card.update', id: card.id, fields: { ...fields, updatedAt: new Date().toISOString() } })
    return { message: 'Done.' }
  }

  private async decision(params: Record<string, unknown>) {
    const { card, place } = this.card(String(params.card ?? ''))
    await place.space.actions.answerPermission(this.login, card.id, String(params.approval ?? ''), params.approve === true)
    return { message: params.approve === true ? 'Approved.' : 'Declined.' }
  }

  private agents() {
    const seen = new Set<string>()
    const agents = []
    for (const place of this.places()) {
      for (const agent of place.space.hub.state.agents) {
        if (agent.revoked || seen.has(`${place.spaceId}/${agent.id}`)) continue
        seen.add(`${place.spaceId}/${agent.id}`)
        const binders = this.places().filter((p) => p.spaceId === place.spaceId && (!agent.binders.length || agent.binders.includes(p.binder.id))).map((p) => p.name)
        const avatar = ['claude', 'codex', 'opencode', 'copilot', 'cursor', 'grok'].includes(agent.provider) ? agent.provider : 'other'
        agents.push({ name: agent.name, wakes: 'board', avatar, vendor: agent.provider, binders, owner: agent.owner, online: Boolean(place.space.hub.presence()[agent.id]?.listening) })
      }
    }
    return { paused: false, agents }
  }

  // Notes and folders ------------------------------------------------------------------------------------------------

  private note(ref: string) {
    const { places, id } = this.split(ref)
    for (const place of places) {
      const note = place.space.hub.state.notes.find((n) => n.id === id && n.binderId === place.binder.id)
      if (note) return { note, place }
    }
    throw new Refused('That note isn’t on your hub any more.')
  }

  private folderPath(space: Space, folderId?: string) {
    const names: string[] = []
    let folder: Folder | undefined = space.hub.state.folders.find((f) => f.id === folderId)
    for (let depth = 0; folder && depth < 20; depth++) {
      names.unshift(folder.name)
      const parent: string | undefined = folder.parentId
      folder = parent ? space.hub.state.folders.find((f) => f.id === parent) : undefined
    }
    return names.join('/')
  }

  private notes(args: Record<string, unknown>) {
    const binder = typeof args.binder === 'string' && args.binder ? this.place(args.binder) : undefined
    const folder = typeof args.folder === 'string' ? args.folder : undefined
    const limit = Math.min(500, Math.max(1, Number(args.limit) || 50))
    let pairs = (binder ? [binder] : this.places()).flatMap((p) => p.space.hub.state.notes.filter((n) => n.binderId === p.binder.id).map((note) => ({ note, place: p })))
    if (folder === '/') pairs = pairs.filter(({ note }) => !note.folderId)
    else if (folder) {
      const folderId = folder.includes('/') ? folder.slice(folder.indexOf('/') + 1) : folder
      pairs = pairs.filter(({ note }) => note.folderId === folderId)
    }
    return pairs.sort((a, b) => (b.note.editedAt ?? '').localeCompare(a.note.editedAt ?? '')).slice(0, limit).map(({ note, place }) => ({
      id: `${place.spaceId}/${note.id}`,
      title: note.title || titleOf(note.text),
      updated: isoNoFraction(note.editedAt),
      binder: place.name,
      preview: note.text.replace(/^#.*\n+/, '').replace(/\s+/g, ' ').trim().slice(0, 200),
      folder: this.folderPath(place.space, note.folderId),
    }))
  }

  private folders(args: Record<string, unknown>) {
    const place = this.place(typeof args.binder === 'string' ? args.binder : undefined)
    const parentRef = typeof args.parent === 'string' ? args.parent : '/'
    const parentId = parentRef === '/' || !parentRef ? undefined : parentRef.includes('/') ? parentRef.slice(parentRef.indexOf('/') + 1) : parentRef
    const state = place.space.hub.state
    return state.folders.filter((f) => f.binderId === place.binder.id && (f.parentId ?? undefined) === parentId).map((f) => ({
      id: `${place.spaceId}/${f.id}`,
      name: f.name,
      path: this.folderPath(place.space, f.id),
      binder: place.name,
      binder_id: place.key,
      parent_id: f.parentId ? `${place.spaceId}/${f.parentId}` : '',
      notes: state.notes.filter((n) => n.folderId === f.id).length,
      meetings: state.notes.filter((n) => n.folderId === f.id && n.captured === 'meeting').length,
      folders: state.folders.filter((c) => c.parentId === f.id).length,
    }))
  }

  private async addNote(args: Record<string, unknown>) {
    const words = typeof args.text === 'string' ? args.text.trim() : ''
    if (!words) throw new Refused('A note needs its words.')
    let place = this.place(typeof args.binder === 'string' && args.binder ? args.binder : undefined)
    let folderId: string | undefined
    if (typeof args.folder === 'string' && args.folder) {
      const { spaceId, id } = this.split(args.folder)
      const folder = this.places().filter((p) => p.spaceId === spaceId).flatMap((p) => p.space.hub.state.folders.filter((f) => f.id === id).map((f) => ({ f, p })))[0]
      // A folder that's gone: the note goes at the top, as on the Mac.
      if (folder) {
        folderId = folder.f.id
        place = this.placeOfBinder(spaceId, folder.f.binderId) ?? place
      }
    }
    const firstLine = words.split('\n')[0].replace(/^#+\s*/, '').trim()
    const title = firstLine.slice(0, 120) || 'Note'
    const text = words.startsWith('#') ? words : `# ${title}\n\n${words.split('\n').slice(1).join('\n').trim()}`.trimEnd() + '\n'
    const id = `note-${Date.now().toString(36)}-${randomUUID().slice(0, 6)}`
    const at = new Date().toISOString()
    const note: Note = { id, title, binderId: place.binder.id, ...(folderId ? { folderId } : {}), editedAt: at, editedBy: this.login, editors: [this.login], text }
    await place.space.hub.record({ kind: 'user', login: this.login }, { type: 'note.put', note })
    return { message: `Note saved in ${place.name}.`, id: `${place.spaceId}/${id}` }
  }

  // Meetings and captures ----------------------------------------------------------------------------------------------

  private meetings(args: Record<string, unknown>) {
    const binder = typeof args.binder === 'string' && args.binder ? this.place(args.binder) : undefined
    const limit = Math.min(200, Math.max(1, Number(args.limit) || 50))
    return (binder ? [binder] : this.places()).flatMap((p) => p.space.hub.state.notes.filter((n) => n.binderId === p.binder.id && n.captured === 'meeting').map((note) => ({ note, place: p })))
      .sort((a, b) => (b.note.editedAt ?? '').localeCompare(a.note.editedAt ?? '')).slice(0, limit)
      .map(({ note, place }) => ({ id: `${place.spaceId}/${note.id}`, title: note.title, date: isoNoFraction(note.editedAt), duration_minutes: 0, attendees: [], binder: place.name, status: 'done', preview: note.text.replace(/^#.*\n+/, '').replace(/\s+/g, ' ').trim().slice(0, 200) }))
  }

  /** A meeting or capture: by the note's id, or by the capture's own id from the iPhone. */
  private async meeting(ref: string) {
    let found: { note: Note; place: Place } | undefined
    if (ref.includes('/')) found = this.note(ref)
    else {
      const kept = await this.ledgerGet<{ space: string; note: string; duration?: number; device?: string; speakers?: string[] }>(`app:capture:${ref.toLowerCase()}`)
      if (kept) found = this.note(`${kept.space}/${kept.note}`)
      if (found && kept) {
        const { note, place } = found
        return { id: ref, title: note.title, date: isoNoFraction(note.editedAt), duration_minutes: Math.round((kept.duration ?? 0) / 60), attendees: kept.speakers ?? [], app: kept.device ?? '', binder: place.name, notes: note.text, own_notes: '' }
      }
    }
    if (!found) throw new Refused('That isn’t on your hub any more.')
    const { note, place } = found
    return { id: ref, title: note.title, date: isoNoFraction(note.editedAt), duration_minutes: 0, attendees: [], app: '', binder: place.name, notes: note.text, own_notes: '' }
  }

  /** The person's own Binder's store: where what came of their captures and moments is kept. */
  private ledger() {
    const own = this.deps.spaces.get(personalId(this.login))?.brain ?? this.own().space.brain
    if (!own) throw new Refused('Your hub has no brain to keep this in.')
    return own.kv
  }

  private async ledgerGet<T>(key: string): Promise<T | undefined> {
    try {
      const raw = await this.ledger().get(key)
      return raw ? (JSON.parse(raw) as T) : undefined
    } catch {
      return undefined
    }
  }

  private async ledgerSet(key: string, value: unknown) {
    await this.ledger().set(key, JSON.stringify(value), 60 * 86_400)
  }

  private async setOutcome(outcome: Outcome) {
    await this.ledgerSet(`app:outcome:${outcome.id.toLowerCase()}`, outcome)
    appEvents.emit('changed', this.login, ['meetings', 'dictations'])
  }

  private outcomeShape(outcome: Outcome) {
    const { made: _made, at: _at, transcribing: _t, ...shown } = outcome
    return shown
  }

  private async outcomes(params: Record<string, unknown>) {
    const ids = Array.isArray(params.ids) ? params.ids.slice(0, 50).map(String) : []
    const found = await Promise.all(ids.map((id) => this.ledgerGet<Outcome>(`app:outcome:${id.toLowerCase()}`)))
    return { outcomes: found.filter((o): o is Outcome => Boolean(o)).map((o) => this.outcomeShape(o)) }
  }

  private async dictation(params: Record<string, unknown>) {
    const id = String(params.id ?? '').toLowerCase()
    if (!id) return {}
    const key = `app:dictations:${this.login.toLowerCase()}`
    const kept = (await this.ledgerGet<{ id: string; text: string; app: string; date: string }[]>(key)) ?? []
    if (!kept.some((d) => d.id === id)) {
      kept.unshift({ id, text: String(params.text ?? '').slice(0, 20_000), app: String(params.app ?? ''), date: String(params.date ?? new Date().toISOString()) })
      await this.ledgerSet(key, kept.slice(0, 300))
    }
    return {}
  }

  /** A conversation All-day capture heard: kept once as a note in the person's own Binder, summed up, and what came of it said. */
  private async conversation(params: Record<string, unknown>) {
    const id = String(params.id ?? '')
    if (!id) throw new Refused('A conversation needs its id.')
    const already = await this.ledgerGet<Outcome>(`app:outcome:${id.toLowerCase()}`)
    if (already && !already.transcribing) return { id }
    const segments = (Array.isArray(params.segments) ? params.segments : []) as { start?: number; end?: number; text?: string; speaker?: string }[]
    const names = (params.speakers && typeof params.speakers === 'object' ? params.speakers : {}) as Record<string, string>
    const said: SaidBy[] = segments.map((s) => ({ start: Number(s.start) || 0, end: Number(s.end) || Number(s.start) || 0, text: String(s.text ?? ''), ...(s.speaker ? { speaker: String(s.speaker) } : {}) }))
    const transcript = transcriptMarkdown(said, names)
    const lines = transcript ? transcript.split('\n\n') : []
    const words = lines.join(' ').split(/\s+/).length
    const place = this.own()
    const at = new Date().toISOString()
    // A few words are no conversation: not kept, as on the Mac.
    if (words < 12) {
      await this.setOutcome({ id, state: 'not-kept', line: 'Not kept: too short to be a conversation', title: 'Not kept', settled: true, at })
      return { id }
    }
    const brain = place.space.brain
    if (!brain) throw new Refused('Your hub can’t take captures.')
    const started = typeof params.started === 'string' ? params.started : at
    const ended = typeof params.ended === 'string' ? params.ended : started
    const duration = Math.max(0, (Date.parse(ended) - Date.parse(started)) / 1000) || 0
    const speakers = [...new Set(lines.map((l) => /\*\*\[[^\]]*\] ([^:]+):\*\*/.exec(l)?.[1]).filter((s): s is string => Boolean(s)))]
    const made = await brain.capture(this.login, { kind: 'conversation', text: lines.join('\n\n'), recordedAt: started, durationSeconds: duration, device: String(params.device ?? 'iPhone'), speakers }, { binderId: place.binder.id, sourceId: id })
    await this.ledgerSet(`app:capture:${id.toLowerCase()}`, { space: place.spaceId, note: made.note.id, duration, device: String(params.device ?? 'iPhone'), speakers })
    await this.setOutcome({ id, state: made.summarizing ? 'writing' : 'filed', line: `Filed in ${place.name}: ${made.note.title}`, title: made.note.title, binder: place.name, settled: !made.summarizing, made: { space: place.spaceId, kind: 'note', id: made.note.id }, at })
    void made.written.then(async (summary) => {
      const note = place.space.hub.state.notes.find((n) => n.id === made.note.id)
      const title = note?.title ?? made.note.title
      await this.setOutcome({ id, state: 'filed', line: `Filed in ${place.name}: ${title}`, title, binder: place.name, settled: true, made: { space: place.spaceId, kind: 'note', id: made.note.id }, at })
      if (!summary?.followUps.length) return
      const key = `app:suggestions:${this.login.toLowerCase()}`
      const kept = (await this.ledgerGet<Suggestion[]>(key)) ?? []
      const fresh: Suggestion[] = summary.followUps.slice(0, 3).map((line, i) => ({ id: `${id.toLowerCase()}-${i}`, conversation: id, kind: 'card', text: line, binder: place.name, sources: [], status: 'offered', at: new Date().toISOString() }))
      await this.ledgerSet(key, [...fresh, ...kept.filter((s) => s.conversation !== id)].slice(0, 100))
      appEvents.emit('changed', this.login, ['meetings'])
    }).catch((err) => log.warn({ err }, 'Saying what came of a capture failed'))
    return { id }
  }

  /**
   * A conversation's audio, sent by the iPhone when the hub has a transcription model: written down here (one at a time),
   * with the voices the iPhone told apart, then filed as a conversation; or, when the iPhone's own transcript got here
   * first, put in its note in place of that. The audio isn't kept.
   */
  async audio(meta: AudioCapture, audio: Uint8Array, mime: string) {
    const transcriber = this.deps.settings?.transcriber()
    if (!transcriber) throw new Refused('Your hub has no transcription model.')
    const id = meta.id
    const key = `app:outcome:${id.toLowerCase()}`
    const already = await this.ledgerGet<Outcome>(key)
    const filed = await this.ledgerGet<{ space: string; note: string }>(`app:capture:${id.toLowerCase()}`)
    if (!already && !filed) {
      await this.setOutcome({ id, state: 'writing', line: 'Writing it down on your hub…', title: 'Writing it down', settled: false, transcribing: true, at: new Date().toISOString() })
    }
    const done = transcriptionTurns.run(async () => {
      const heard = await transcriber.transcribe(audio, mime, meta.language)
      // Voices by the file's own times (the iPhone's turns are on them), then every time on the clock.
      const clock = [...(meta.clock ?? [])].sort((a, b) => a.file - b.file)
      const segments = speakersByOverlap(heard.segments, meta.turns ?? []).map((s) => ({ ...s, start: onTheClock(s.start, clock), end: onTheClock(s.end, clock) }))
      const names = meta.speakers ?? {}
      const capture = await this.ledgerGet<{ space: string; note: string }>(`app:capture:${id.toLowerCase()}`)
      if (capture) {
        // The iPhone's transcript was filed first: the hub's goes in its place, when it has the times the iPhone's has.
        // A model that gave back words with no times would lose who said what, and when.
        if (!heard.segments.some((s) => s.end > s.start)) {
          log.info('The hub’s transcript had no times; the iPhone’s stays')
          return
        }
        const space = this.deps.spaces.get(capture.space)
        const text = transcriptMarkdown(segments, names)
        if (!space?.brain || !text) return
        const speakers = [...new Set(segments.map((s) => names[s.speaker ?? ''] || s.speaker).filter((s): s is string => Boolean(s)))]
        await space.brain.rewriteTranscript(capture.note, { kind: 'conversation', text, recordedAt: meta.started, device: meta.device, speakers })
        appEvents.emit('changed', this.login, ['meetings'])
        return
      }
      await this.conversation({ id, segments, speakers: names, started: meta.started, ended: meta.ended, device: meta.device ?? 'iPhone' })
    })
    void done.catch(async (err) => {
      log.warn({ why: err instanceof Error ? err.message : String(err) }, 'Writing down a capture’s audio failed')
      // Nothing filed and nothing else coming: say so. When the iPhone's transcript is filed, that stays as it is.
      const now = await this.ledgerGet<Outcome>(key)
      if (now?.transcribing) await this.setOutcome({ id, state: 'failed', line: `Not written down: ${err instanceof Error ? err.message : 'the hub’s transcription failed'}`, title: 'Not written down', settled: true, at: new Date().toISOString() })
    })
    return { id, done }
  }

  /** Words read out by the hub's speech model, for the iPhone to play. */
  private async speak(params: Record<string, unknown>) {
    const speaker = this.deps.settings?.speaker()
    if (!speaker) throw new Refused('Your hub has no speech model.')
    const text = String(params.text ?? '').trim().slice(0, 4000)
    if (!text) throw new Refused('Nothing to say.')
    const { audio, mime } = await speaker.speak(text)
    return { audio: audio.toString('base64'), mime }
  }

  private async suggestions() {
    const since = Date.now() - 3 * 86_400_000
    const kept = (await this.ledgerGet<Suggestion[]>(`app:suggestions:${this.login.toLowerCase()}`)) ?? []
    return { suggestions: kept.filter((s) => Date.parse(s.at) >= since).map(({ at: _at, ...s }) => s) }
  }

  private async suggestionAction(params: Record<string, unknown>) {
    const key = `app:suggestions:${this.login.toLowerCase()}`
    const kept = (await this.ledgerGet<Suggestion[]>(key)) ?? []
    const found = kept.find((s) => s.id === String(params.id ?? ''))
    if (!found) throw new Refused('That suggestion isn’t here any more.')
    if (found.status !== 'offered') return { message: found.status === 'accepted' ? 'Already on the board.' : 'Already set aside.' }
    if (params.action === 'accept' || params.action === 'give') {
      const place = this.place(found.binder)
      const agent = params.action === 'give' ? this.agentNamed(place.space, typeof params.agent === 'string' ? params.agent : undefined) : undefined
      await place.space.actions.createCard({ kind: 'user', login: this.login }, { binderId: place.binder.id, title: found.text.slice(0, 200), stage: found.kind === 'idea' ? 'proposed' : 'ready', meantFor: agent?.id })
      found.status = 'accepted'
    } else found.status = 'dismissed'
    await this.ledgerSet(key, kept)
    appEvents.emit('changed', this.login, ['meetings', 'tasks'])
    return { message: found.status === 'accepted' ? 'On the board.' : 'Set aside.' }
  }

  /** Something said to Binders on its own: sorted by the hub's model, done at once, and answered with what came of it. */
  private async moment(params: Record<string, unknown>) {
    const id = String(params.id ?? randomUUID())
    const already = await this.ledgerGet<Outcome>(`app:outcome:${id.toLowerCase()}`)
    if (already) return { id, outcome: this.outcomeShape(already) }
    const said = String(params.text ?? '').trim()
    const model = this.deps.settings?.model()
    const at = new Date().toISOString()
    if (!said || !model) {
      const outcome: Outcome = { id, state: 'nothing', line: model ? 'Nothing was heard.' : 'Your hub has no model to act on that yet.', title: 'Nothing', kind: 'none', settled: true, at }
      await this.setOutcome(outcome)
      return { id, outcome: this.outcomeShape(outcome) }
    }
    const sorted = params.kind === 'question' ? { kind: 'question' as const, title: said } : await model.sortMoment(said)
    const place = this.own()
    let outcome: Outcome
    if (sorted.kind === 'todo' || sorted.kind === 'idea') {
      const title = (sorted.title || said).slice(0, 200)
      const card = await place.space.actions.createCard({ kind: 'user', login: this.login }, { binderId: place.binder.id, title, brief: `You said: “${said}”`, stage: 'proposed' })
      outcome = { id, state: 'acted', line: `Added to ${place.name}: ${title}`, title: sorted.kind === 'todo' ? 'Added' : 'Idea kept', binder: place.name, kind: sorted.kind, card: `${place.spaceId}/${card.id}`, actions: ['undo'], settled: true, made: { space: place.spaceId, kind: 'card', id: card.id }, at }
    } else if (sorted.kind === 'note') {
      const made = await this.addNote({ text: `# ${(sorted.title || said).slice(0, 120)}\n\n${said}`, binder: place.key }) as { id: string }
      outcome = { id, state: 'acted', line: `Noted in ${place.name}: ${sorted.title || said}`, title: 'Noted', binder: place.name, kind: 'note', actions: ['undo'], settled: true, made: { space: place.spaceId, kind: 'note', id: made.id.slice(made.id.indexOf('/') + 1) }, at }
    } else if (sorted.kind === 'question') {
      const answer = await this.answerQuestion(sorted.title || said)
      outcome = { id, state: 'answered', line: `${answer.text}\n${answer.sources.join(' · ')}`.trim(), title: 'Answered', kind: 'question', sources: answer.sources, settled: true, at }
    } else {
      outcome = { id, state: 'nothing', line: 'Nothing to do.', title: 'Nothing', kind: 'none', settled: true, at }
    }
    await this.setOutcome(outcome)
    return { id, outcome: this.outcomeShape(outcome) }
  }

  private async outcomeAction(params: Record<string, unknown>) {
    const id = String(params.id ?? '')
    const outcome = await this.ledgerGet<Outcome>(`app:outcome:${id.toLowerCase()}`)
    if (!outcome) throw new Refused('That isn’t here any more.')
    const action = String(params.action ?? '')
    if (action === 'undo' || action === 'not-me') {
      if (outcome.state === 'undone') return { message: 'Already taken back.' }
      const made = outcome.made
      if (made) {
        const space = this.deps.spaces.get(made.space)
        if (made.kind === 'card') {
          const card = space?.hub.state.cards.find((c) => c.id === made.id)
          // Taken back only while nobody has moved it on.
          if (card && (card.stage !== 'proposed' || card.agentId || card.activity.some((a) => a.kind !== 'created'))) throw new Refused('It has moved on the board since: change it there.')
          if (card && space) await space.hub.record({ kind: 'user', login: this.login }, { type: 'card.delete', id: card.id })
        } else {
          const note = space?.hub.state.notes.find((n) => n.id === made.id)
          if (note && space) await space.hub.record({ kind: 'user', login: this.login }, { type: 'note.delete', id: note.id })
        }
      }
      await this.setOutcome({ ...outcome, state: 'undone', line: 'Taken back', title: 'Taken back', actions: [], settled: true })
      return { message: 'Taken back.' }
    }
    if (action === 'not-now') {
      await this.setOutcome({ ...outcome, state: 'dismissed', line: 'Not added', title: 'Not added', settled: true })
      return { message: 'Not added.' }
    }
    throw new Refused(`Your hub doesn’t do “${action}” yet.`)
  }

  // Ask and the boards' digest ---------------------------------------------------------------------------------------

  private askPlaces(): AskPlace[] {
    const bySpace = new Map<string, Place[]>()
    for (const place of this.places()) bySpace.set(place.spaceId, [...(bySpace.get(place.spaceId) ?? []), place])
    return [...bySpace.entries()].flatMap(([spaceId, places]) => {
      const brain = places[0].space.brain
      if (!brain) return []
      const ids = new Set(places.map((p) => p.binder.id))
      const state = places[0].space.hub.state
      return [{
        id: spaceId,
        name: places.length === 1 ? places[0].name : places[0].spaceName,
        brain,
        url: (kind: SourceKind, id: string) => this.deps.webUrl(spaceId, kind, id),
        keep: (kind: SourceKind, id: string) => (kind === 'note' ? state.notes : state.cards).some((x) => x.id === id && ids.has(x.binderId)),
        work: { id: spaceId, name: places.length === 1 ? places[0].name : places[0].spaceName, hub: places[0].space.hub, actions: places[0].space.actions, binders: [...ids], github: () => this.deps.githubIn?.(spaceId) ?? Promise.resolve(undefined) },
      }]
    })
  }

  private async answerQuestion(question: string, onSources?: (sources: AskSource[]) => void) {
    if (!this.deps.settings) throw new Refused('Your hub has no brain to ask.')
    const result = await ask(this.deps.settings, this.askPlaces(), question, { onSources, person: this.login })
    const text = result.answer
      ? result.answer.parts.map((p) => `${p.text.replace(/\s+$/, '')}${p.sources.length ? ` ${p.sources.map((n) => `[${n}]`).join('')}` : ''}${/\s$/.test(p.text) ? p.text.match(/\s+$/)![0] : ''}`).join('').trim()
      : result.sources.length ? (result.problem ? `No answer (${result.problem}). What matches best:` : 'Your hub has no model to answer with, so here’s what matches best.') : 'Nothing in your binders matches that.'
    return { text, result, sources: result.sources.map((s) => s.title) }
  }

  /** A source as the iPhone's Ask shows it: in the Mac's ask_knowledge shape. */
  private static passage(s: AskSource) {
    return { kind: 'note', source_id: `${s.binder}/${s.id}`, title: s.kind === 'card' ? `Card: ${s.title}` : s.title, date: '', binder: s.binderName, text: s.text }
  }

  private warmed = 0

  /** The hub's model and voice, asked for now so they're loaded when Talk needs them: at most once a minute. */
  private warmForTalk() {
    const settings = this.deps.settings
    if (!settings || Date.now() - this.warmed < 60_000) return
    this.warmed = Date.now()
    void settings.model()?.warm?.().catch(() => undefined)
    void settings.speaker()?.speak('Hello.').catch(() => undefined)
  }

  /**
   * One turn of Talk: the conversation so far (`turns`, ending with what the person just said), answered by the hub's
   * model in words to read out. What it found in the binders goes to the iPhone first, as Ask's does (`token`).
   */
  private async talkTurn(params: Record<string, unknown>) {
    if (!this.deps.settings) throw new Refused('Your hub has no brain to talk with.')
    const turns = (Array.isArray(params.turns) ? params.turns : []).map((t) => {
      const turn = (t ?? {}) as Record<string, unknown>
      return { role: turn.role === 'assistant' ? 'assistant' as const : 'user' as const, text: String(turn.text ?? '') }
    })
    const token = typeof params.token === 'string' ? params.token : ''
    let seq = 0
    try {
      const result = await talk(this.deps.settings, this.askPlaces(), turns, {
        person: this.login,
        onSources: (sources) => {
          if (token) this.deps.send({ jsonrpc: '2.0', method: 'binders/ask-progress', params: { token, seq: ++seq, stage: 'sources', sources: sources.map(AppLinkSession.passage) } })
        },
      })
      return { reply: result.reply, sources: result.sources.map(AppLinkSession.passage), model: result.model }
    } catch (err) {
      // The model away or refusing: said to the iPhone in words, as a refusal.
      if (err instanceof BrainUnavailable) throw new Refused(err.message)
      throw err
    }
  }

  private async askKnowledge(question: string, token: string) {
    if (!question.trim()) throw new Refused('Ask a question.')
    const passage = AppLinkSession.passage
    let seq = 0
    const progress = (fields: Record<string, unknown>) => {
      if (token) this.deps.send({ jsonrpc: '2.0', method: 'binders/ask-progress', params: { token, seq: ++seq, ...fields } })
    }
    progress({ stage: 'keyword' })
    const answered = await this.answerQuestion(question, (sources) => progress({ stage: 'sources', sources: sources.map(passage) }))
    return { answer: answered.text, sources: answered.result.sources.map(passage) }
  }

  private workStreams() {
    const day = new Date().toISOString().slice(0, 10)
    const pairs = this.places().flatMap((p) => p.space.hub.state.cards.filter((c) => c.binderId === p.binder.id).map((card) => ({ card, place: p })))
    const byAgent = new Map<string, { who: string; agent: boolean; cards: string[]; doing: { card: string; line: string }[] }>()
    for (const { card, place } of pairs.filter(({ card }) => card.stage === 'working' && card.agentId)) {
      const who = this.agentName(place.space, card.agentId)
      const entry = byAgent.get(who) ?? { who, agent: true, cards: [], doing: [] }
      entry.cards.push(card.title)
      if (card.doing) entry.doing.push({ card: card.title, line: card.doing })
      byAgent.set(who, entry)
    }
    const working = [...byAgent.values()]
    const questions = pairs.filter(({ card }) => card.needsYou && card.stage !== 'live').map(({ card, place }) => ({ card: card.title, who: this.agentName(place.space, card.agentId) || 'An agent', question: card.needsYou! }))
    const reviews = pairs.filter(({ card }) => card.stage === 'review').map(({ card, place }) => ({ card: card.title, who: this.agentName(place.space, card.agentId) || '' }))
    const waiting = pairs.filter(({ card }) => card.stage === 'ready' && card.meantFor).map(({ card, place }) => ({ card: card.title, for: this.agentName(place.space, card.meantFor) }))
    const doneToday = pairs.filter(({ card }) => card.stage === 'live' && card.updatedAt.startsWith(day)).map(({ card }) => card.title)
    const parts = [working.length ? `${working.length} ${working.length === 1 ? 'agent' : 'agents'} working` : 'Nobody working', questions.length ? `${questions.length} ${questions.length === 1 ? 'question' : 'questions'} for you` : '', reviews.length ? `${reviews.length} to review` : ''].filter(Boolean)
    return { headline: `${parts.join(', ')}.`, working, questions, reviews, waiting_to_start: waiting, done_today: doneToday }
  }

  // Notifications --------------------------------------------------------------------------------------------------

  /** Follows every Binder the person is in, and tells the iPhone what changed, a quarter-second's worth at a time. */
  private subscribe() {
    this.subscribed = true
    const kindsOf = (change: Entry['change']): string[] => {
      const type = change.type
      if (type.startsWith('note.') || type.startsWith('folder.') || type.startsWith('noteProposal.')) return ['notes']
      if (type.startsWith('card.') || type.startsWith('proposal.') || type.startsWith('agent.') || type === 'note.work' || type === 'note.distill') return ['tasks']
      if (type.startsWith('binder.')) return ['binders']
      if (type.startsWith('chat.')) return ['chats']
      return []
    }
    for (const { info } of this.deps.spaces.forPerson(this.login, false)) {
      const space = this.deps.spaces.get(info.id)
      if (!space) continue
      const follow = (entries: Entry[]) => {
        for (const { change } of entries) {
          for (const kind of kindsOf(change)) this.pending.add(kind)
          // A permission an agent asks of its owner: rung once on their iPhone.
          if (change.type === 'card.update' && change.fields?.permission && !change.fields.permission.answer) this.approval(space, info.id, change.id)
        }
        this.soon()
      }
      space.hub.on('entries', follow)
      this.stops.push(() => space.hub.off('entries', follow))
    }
    const mine = (login: string, kinds: string[]) => {
      if (login.toLowerCase() !== this.login.toLowerCase()) return
      for (const kind of kinds) this.pending.add(kind)
      this.soon()
    }
    appEvents.on('changed', mine)
    this.stops.push(() => appEvents.off('changed', mine))
  }

  private approval(space: Space, spaceId: string, cardId: string) {
    const card = space.hub.state.cards.find((c) => c.id === cardId)
    const asked = card?.permission
    if (!card || !asked || asked.answer || this.toldApprovals.has(asked.request)) return
    const agent = space.hub.state.agents.find((a) => a.id === asked.agent)
    if (!agent || agent.owner.toLowerCase() !== this.login.toLowerCase()) return
    this.toldApprovals.add(asked.request)
    this.deps.send({ jsonrpc: '2.0', method: 'binders/approval', params: { card: `${spaceId}/${card.id}`, approval: asked.request, agent: agent.name, headline: `${agent.name} asks to use ${asked.tool}`, title: card.title, asked: isoNoFraction(asked.at) } })
  }

  private soon() {
    if (this.flushTimer || !this.pending.size) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined
      const kinds = [...this.pending].sort()
      this.pending.clear()
      this.deps.send({ jsonrpc: '2.0', method: 'binders/changed', params: { kinds } })
    }, 250)
    this.flushTimer.unref?.()
  }
}

/** Reads the messages in one frame: one JSON-RPC message, or several on lines of their own. */
export function framesOf(raw: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = []
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const parsed = JSON.parse(trimmed) as unknown
      if (parsed && typeof parsed === 'object') out.push(parsed as Record<string, unknown>)
    } catch {
      // Not JSON: nothing the iPhone sent.
    }
  }
  return out
}

export { referenceSeconds }
