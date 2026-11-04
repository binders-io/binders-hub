import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type { KV } from './kv.ts'
import type { Sealer } from './secrets.ts'
import { Refused, type Hub } from './hub.ts'
import { handMove, type Activity, type Card, type Stage } from '../../shared/work.ts'
import { log } from './logger.ts'

// Jira Cloud, as one binder's own tracker: its address, a service account, and the project its issues are made in. Once
// it's connected, Jira says what that project has and most of the mapping fills itself in (discoverJira). A note becomes
// an Epic and the cards distilled from it the Stories under it, when the binder says so. Cards go out (savers/jira.ts); what people do to those issues comes back (the webhook, at the end): a status they
// change moves the card by the board's own rules, a comment lands on it. The hub also asks every minute (savers/jira.ts),
// so this works with no webhook set up. Only issues the saver made count, and its own moves are known by where they went,
// not who made them: the account may well be a person's own. The hub is the one copy of the words: Jira's description is written, never read
// back.

export type StageStatuses = Partial<Record<Stage, string>>

export interface JiraSettings {
  /** https://yourcompany.atlassian.net */
  baseUrl?: string
  /** The service account's email. */
  email?: string
  token?: string
  project?: string
  /** The issue type new issues are made as. */
  issueType?: string
  /** The issue type a note becomes, with its cards under it. Unset: notes stay out of Jira. */
  noteIssueType?: string
  /** The status each stage stands for, by name as the project's workflow has it. */
  statuses?: StageStatuses
  /** The stage each other status of the workflow counts as when someone moves an issue there: an issue only goes to `statuses`. */
  inbound?: Record<string, Stage>
  /** The field an issue's points go in, as Jira names it (customfield_10016), what sort of field, and what each size of card is in it. Unset: points are left alone. */
  pointsField?: string
  pointsKind?: PointsKind
  points?: Record<Card['size'], number | string>
  /** The board whose active sprint an issue joins once work on it starts. Unset: sprints are left alone. */
  sprintBoard?: number
  /** False: agents aren't asked to make their changes in Jira with their own tools, and the hub makes them all. */
  agentWrites?: boolean
  on?: boolean
}

/** The sorts of custom field a card's size can go in: a number, a dropdown's option, or a line of text. */
export type PointsKind = 'number' | 'option' | 'string'

export const usualPoints: Record<Card['size'], number> = { S: 1, M: 3, L: 5 }

/** What a size is in a field of this kind until someone says otherwise: 1, 3, 5, or the size's own letter. */
export const usualPointsOf = (kind: PointsKind): Record<Card['size'], number | string> => (kind === 'number' ? usualPoints : { S: 'S', M: 'M', L: 'L' })

/** The stages a Jira issue can stand for: a proposed card has no issue yet. */
export const stages: Stage[] = ['ready', 'working', 'blocked', 'review', 'live']

/** A Jira Cloud address as the hub keeps it, or undefined: the hub sends its token here and nowhere else. */
export function jiraAddress(raw: string | undefined): string | undefined {
  const address = raw?.trim().replace(/\/+$/, '').toLowerCase()
  return address && /^https:\/\/[a-z0-9][a-z0-9-]*\.atlassian\.net$/.test(address) ? address : undefined
}

export const validProject = (key: string | undefined) => !!key && /^[A-Z][A-Z0-9_]{0,63}$/.test(key.trim().toUpperCase())

/** The label an issue carries for its card, so it's found again exactly, however many issues the project has. */
export const labelFor = (cardId: string) => `binders-${cardId}`

/** The same for a note's Epic. */
export const noteLabelFor = (noteId: string) => `binders-note-${noteId}`

export interface JiraIssue {
  id: string
  key: string
  summary?: string
  status?: string
}

interface IssueJSON {
  id: string
  key: string
  fields?: { summary?: string; status?: { name?: string } }
}

const digest = (text: string) => createHash('sha256').update(text).digest()

export interface JiraCredentials {
  baseUrl: string
  email: string
  token: string
}

async function jiraCall<T>(who: JiraCredentials, path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  // Sprints are the one part of Jira under another API.
  const response = await fetch(`${who.baseUrl}${path.startsWith('/rest/') ? path : `/rest/api/3${path}`}`, {
    method: init.method ?? 'GET',
    // The token goes to the address that was set, not wherever that address points next.
    redirect: 'error',
    signal: AbortSignal.timeout(20_000),
    headers: { authorization: 'Basic ' + Buffer.from(`${who.email}:${who.token}`).toString('base64'), accept: 'application/json', ...(init.body ? { 'content-type': 'application/json' } : {}) },
    body: init.body ? JSON.stringify(init.body) : undefined,
  }).catch((error: Error) => {
    throw new Refused(`Jira couldn’t be reached (${error.message}).`)
  })
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Refused(`Jira said ${response.status}${text ? `: ${text.slice(0, 300)}` : ''}.`)
  }
  if (response.status === 204) return undefined as T
  return (await response.json()) as T
}

export class JiraConnection {
  private kv: KV
  private sealer: Sealer
  private space: string
  private savedSecret?: string
  private self?: Promise<string | undefined>
  settings: JiraSettings = {}

  constructor(kv: KV, sealer: Sealer, space: string) {
    this.kv = kv
    this.sealer = sealer
    this.space = space
  }

  private get key() {
    return `jira:${this.space}`
  }

  async load() {
    const raw = await this.kv.get(`${this.key}:settings`).catch(() => undefined)
    if (!raw) return
    try {
      const { sealed, ...rest } = JSON.parse(raw) as JiraSettings & { sealed?: string }
      this.settings = { ...rest, token: sealed ? this.unseal(sealed) : undefined }
    } catch {
      // Not settings this hub wrote: as good as none.
    }
  }

  async configure(fields: JiraSettings) {
    const token = fields.token?.trim() || this.settings.token || ''
    const baseUrl = fields.baseUrl?.trim().replace(/\/+$/, '') || undefined
    const email = fields.email?.trim() || undefined
    const project = fields.project?.trim().toUpperCase() || undefined
    this.self = undefined
    this.settings = {
      baseUrl,
      email,
      token: token || undefined,
      project,
      issueType: fields.issueType?.trim() || 'Task',
      noteIssueType: fields.noteIssueType?.trim() || undefined,
      statuses: tidyStatuses(fields.statuses),
      inbound: fields.inbound && Object.keys(fields.inbound).length ? fields.inbound : undefined,
      pointsField: fields.pointsField?.trim() || undefined,
      pointsKind: fields.pointsField?.trim() ? fields.pointsKind ?? 'number' : undefined,
      points: fields.pointsField?.trim() ? fields.points ?? usualPointsOf(fields.pointsKind ?? 'number') : undefined,
      sprintBoard: fields.sprintBoard,
      agentWrites: fields.agentWrites === false ? false : undefined,
      on: fields.on !== false && !!baseUrl && !!email && !!token && !!project,
    }
    await this.kv.set(`${this.key}:settings`, JSON.stringify({ ...this.settings, token: undefined, sealed: token ? this.sealer.seal(token) : undefined }))
    await this.secret()
    return this.publicSettings()
  }

  /** Forgets the connection: its token and the webhook's secret. Issues already in Jira stay there. */
  async disconnect() {
    this.settings = {}
    this.savedSecret = undefined
    this.self = undefined
    await this.kv.del(`${this.key}:settings`)
    await this.kv.del(`${this.key}:secret`)
  }

  /** The settings as the web app sees them: the token's last two characters, never the whole. */
  publicSettings() {
    const { token } = this.settings
    return { ...this.settings, token: undefined, tokenSet: !!token, hint: token ? `…${token.slice(-2)}` : undefined }
  }

  /** The secret a Jira webhook's address carries, made the first time it's asked for. */
  async secret() {
    if (this.savedSecret) return this.savedSecret
    const old = await this.kv.get(`${this.key}:secret`)
    this.savedSecret = old ?? randomBytes(18).toString('base64url')
    if (!old) await this.kv.set(`${this.key}:secret`, this.savedSecret)
    return this.savedSecret
  }

  /** Whether a webhook's secret is this binder's. A binder with no connection has none to match. */
  async knowsSecret(given: string | undefined) {
    if (!given) return false
    const saved = this.savedSecret ?? (await this.kv.get(`${this.key}:secret`))
    return !!saved && timingSafeEqual(digest(saved), digest(given))
  }

  on() {
    const s = this.settings
    return !!s.on && !!s.baseUrl && !!s.email && !!s.token && !!s.project
  }

  private unseal(sealed: string) {
    try {
      return this.sealer.open(sealed)
    } catch {
      return undefined
    }
  }

  private async call<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
    if (!this.settings.baseUrl) throw new Refused('Jira isn’t set up on this binder.')
    return jiraCall<T>({ baseUrl: this.settings.baseUrl, email: this.settings.email ?? '', token: this.settings.token ?? '' }, path, init)
  }

  /** Who the token is, for Settings' test. */
  myself() {
    return this.call<{ accountId?: string; displayName?: string; emailAddress?: string }>('/myself')
  }

  /** Whether Jira's event was the service account's own doing, so the hub's writes don't come back as news. */
  async isMe(user: { accountId?: string } | undefined) {
    if (!user?.accountId) return false
    this.self ??= this.myself().then((me) => me.accountId).catch(() => {
      this.self = undefined
      return undefined
    })
    return (await this.self) === user.accountId
  }

  /** Text as Jira's document format: a heading per heading line, a paragraph per blank line, bold as the words have it, nothing cleverer. */
  adf(text: string) {
    const inline = (line: string) => line.split('**').map((part, i) => (part ? { type: 'text', text: part, ...(i % 2 ? { marks: [{ type: 'strong' }] } : {}) } : undefined)).filter(Boolean) as { type: string; text: string }[]
    const content: object[] = []
    let lines: string[] = []
    const paragraph = () => {
      if (lines.length) content.push({ type: 'paragraph', content: lines.flatMap((line, index) => (index ? [{ type: 'hardBreak' }, ...inline(line)] : inline(line))) })
      lines = []
    }
    for (const line of text.split('\n')) {
      const heading = /^(#{1,6})\s+(\S.*?)\s*#*\s*$/.exec(line)
      if (heading) {
        paragraph()
        content.push({ type: 'heading', attrs: { level: heading[1].length }, content: inline(heading[2]) })
      } else if (line.trim()) lines.push(line)
      else paragraph()
    }
    paragraph()
    return { type: 'doc', version: 1, content }
  }

  /** Where a person reads an issue. */
  browse(key: string) {
    return `${this.settings.baseUrl}/browse/${encodeURIComponent(key)}`
  }

  /** A comment's body as plain text: Jira's webhooks send a string, its API a document, however deeply it nests. */
  textOf(body: unknown): string {
    if (typeof body === 'string') return body.trim()
    const walk = (node: unknown): string => {
      if (Array.isArray(node)) return node.map(walk).join('')
      if (!node || typeof node !== 'object') return ''
      const at = node as { type?: string; text?: string; content?: unknown }
      if (at.type === 'text') return at.text ?? ''
      if (at.type === 'hardBreak') return '\n'
      const inner = walk(at.content)
      return at.type === 'paragraph' || at.type === 'heading' ? `${inner}\n\n` : inner
    }
    return walk(body).replace(/\n{3,}/g, '\n\n').trim()
  }

  create(cardId: string, fields: { summary: string; description: string }, parent?: string) {
    return this.call<{ id: string; key: string }>('/issue', {
      method: 'POST',
      body: {
        fields: {
          project: { key: this.settings.project },
          issuetype: { name: this.settings.issueType ?? 'Task' },
          summary: oneLine(fields.summary),
          description: this.adf(fields.description),
          labels: ['binders', labelFor(cardId)],
          ...(parent ? { parent: { key: parent } } : {}),
        },
      },
    })
  }

  /** A note's Epic. Some projects insist on an Epic Name as well, and only say which field that is by refusing. */
  async createEpic(noteId: string, fields: { summary: string; description: string }) {
    const body = {
      project: { key: this.settings.project },
      issuetype: { name: this.settings.noteIssueType ?? 'Epic' },
      summary: oneLine(fields.summary),
      description: this.adf(fields.description),
      labels: ['binders', noteLabelFor(noteId)],
    }
    try {
      return await this.call<{ id: string; key: string }>('/issue', { method: 'POST', body: { fields: body } })
    } catch (error) {
      const field = /"(customfield_\d+)"\s*:\s*"Epic Name/i.exec((error as Error).message)?.[1]
      if (!field) throw error
      return this.call<{ id: string; key: string }>('/issue', { method: 'POST', body: { fields: { ...body, [field]: oneLine(fields.summary) } } })
    }
  }

  async setParent(id: string, parent: string) {
    await this.call(`/issue/${encodeURIComponent(id)}`, { method: 'PUT', body: { fields: { parent: { key: parent } } } })
  }

  /** The issue's title and words, as one write. */
  async update(id: string, fields: { summary: string; description: string }) {
    await this.call(`/issue/${encodeURIComponent(id)}`, { method: 'PUT', body: { fields: { summary: oneLine(fields.summary), description: this.adf(fields.description) } } })
  }

  /** The points an issue of this size is worth, when the binder has a field for them. */
  pointsOf(size: Card['size']) {
    return this.settings.pointsField ? (this.settings.points ?? usualPointsOf(this.settings.pointsKind ?? 'number'))[size] : undefined
  }

  async setPoints(id: string, points: number | string) {
    const kind = this.settings.pointsKind ?? 'number'
    const value = kind === 'option' ? { value: String(points) } : kind === 'number' ? Number(points) : String(points)
    await this.call(`/issue/${encodeURIComponent(id)}`, { method: 'PUT', body: { fields: { [this.settings.pointsField!]: value } } })
  }

  async addComment(id: string, text: string) {
    await this.call(`/issue/${encodeURIComponent(id)}/comment`, { method: 'POST', body: { body: this.adf(text.slice(0, 30_000)) } })
  }

  /** The board's active sprint, the latest to start if it runs several. */
  async activeSprint(): Promise<JiraSprint | undefined> {
    const { values = [] } = await this.call<{ values?: JiraSprint[] }>(`/rest/agile/1.0/board/${this.settings.sprintBoard}/sprint?state=active&maxResults=50`)
    return values.sort((a, b) => (Date.parse(b.startDate ?? '') || 0) - (Date.parse(a.startDate ?? '') || 0))[0]
  }

  /** The sprint an issue is in now, and whether it's been through any that closed. */
  async sprintsOf(id: string) {
    const { fields } = await this.call<{ fields?: { sprint?: { id: number } | null; closedSprints?: unknown[] | null } }>(`/rest/agile/1.0/issue/${encodeURIComponent(id)}?fields=sprint,closedSprints`)
    return { current: fields?.sprint?.id, closed: !!fields?.closedSprints?.length }
  }

  async addToSprint(sprintId: number, id: string) {
    await this.call(`/rest/agile/1.0/sprint/${sprintId}/issue`, { method: 'POST', body: { issues: [id] } })
  }

  /** The words of an issue's latest comments. */
  async commentTexts(id: string) {
    const { comments = [] } = await this.call<{ comments?: JiraComment[] }>(`/issue/${encodeURIComponent(id)}/comment?maxResults=100&orderBy=-created`)
    return comments.map((c) => this.textOf(c.body))
  }

  /** Whether this project's workflow for cards has a status of this name: going through others to one it doesn't would only wander. */
  private async hasStatus(statusName: string) {
    const byType = await this.call<{ name: string; statuses?: { name: string }[] }[]>(`/project/${encodeURIComponent(this.settings.project ?? '')}/statuses`)
    const own = byType.filter((t) => sameName(t.name, this.settings.issueType))
    return (own.length ? own : byType).some((t) => t.statuses?.some((s) => sameName(s.name, statusName)))
  }

  /**
   * Moves an issue to a status. With `through`, where the workflow has no direct way it goes through the statuses
   * between, as far as it can, never through one that ends the work. `reached` says whether it got there; `status` is
   * where it is now, and `from` where it was.
   */
  async moveTo(id: string, statusName: string, through?: { backwards: boolean }): Promise<{ reached: boolean; status?: string; from?: string }> {
    const path = `/issue/${encodeURIComponent(id)}/transitions`
    const from = (await this.issue(id)).status
    let at = from
    if (sameName(at, statusName)) return { reached: true, status: at, from }
    const been = new Set(at ? [named(at)] : [])
    for (let step = 0; step < 8; step++) {
      const { transitions = [] } = await this.call<{ transitions?: JiraTransition[] }>(path)
      const direct = transitions.find((t) => sameName(t.to?.name, statusName) || sameName(t.name, statusName))
      if (!direct && (!through || (step === 0 && !(await this.hasStatus(statusName))))) return { reached: false, status: at, from }
      const next = direct ?? onward(transitions, been, through!.backwards)
      if (!next) return { reached: false, status: at, from }
      await this.call(path, { method: 'POST', body: { transition: { id: next.id } } })
      at = next.to?.name ?? statusName
      been.add(named(at))
      if (direct) return { reached: true, status: at, from }
    }
    return { reached: false, status: at, from }
  }

  /** The issues the hub made, those changed in the last while or all of them, with their status and comments. */
  async recent(minutes?: number): Promise<JiraPolled[]> {
    const jql = encodeURIComponent(`project = "${this.settings.project}" AND labels = "binders"${minutes ? ` AND updated >= -${minutes}m` : ''} ORDER BY updated DESC`)
    const found: JiraPolled[] = []
    let next: string | undefined
    for (let page = 0; page < 20; page++) {
      const one = await this.call<{ issues?: { id: string; fields?: { status?: { name?: string }; comment?: { comments?: JiraComment[] } } }[]; nextPageToken?: string }>(`/search/jql?maxResults=100&fields=status,comment&jql=${jql}${next ? `&nextPageToken=${encodeURIComponent(next)}` : ''}`)
      found.push(...(one.issues ?? []).map((i) => ({ id: i.id, status: i.fields?.status?.name, comments: i.fields?.comment?.comments ?? [] })))
      next = one.nextPageToken
      if (!next) break
    }
    return found
  }

  async issue(id: string): Promise<JiraIssue> {
    const one = await this.call<IssueJSON>(`/issue/${encodeURIComponent(id)}?fields=summary,status`)
    return { id: one.id, key: one.key, summary: one.fields?.summary, status: one.fields?.status?.name }
  }

  /** The issue a card already has, by its label: none found is an answer, and Jira not answering throws. */
  issueOf(cardId: string) {
    return this.labelled(labelFor(cardId))
  }

  /** The Epic a note already has, by its label. */
  epicOf(noteId: string) {
    return this.labelled(noteLabelFor(noteId))
  }

  private async labelled(label: string): Promise<{ id: string; key: string } | undefined> {
    const jql = encodeURIComponent(`project = "${this.settings.project}" AND labels = "${label}" ORDER BY created ASC`)
    const found = await this.call<{ issues?: { id: string; key?: string; fields?: { key?: string } }[] }>(`/search/jql?maxResults=1&fields=key&jql=${jql}`)
    const issue = found.issues?.[0]
    const key = issue?.key ?? issue?.fields?.key
    return issue ? { id: issue.id, key: key ?? issue.id } : undefined
  }
}

interface JiraTransition {
  id: string
  name?: string
  to?: { name?: string; statusCategory?: { key?: string } }
}

export interface JiraSprint {
  id: number
  name: string
  startDate?: string
}

export interface JiraComment {
  body?: unknown
  author?: { displayName?: string; accountId?: string }
  created?: string
}

export interface JiraPolled {
  id: string
  status?: string
  comments: JiraComment[]
}

/** The next status on the way, where there's no direct one: the work's own statuses, not one that ends it, nor one it's been to. */
function onward(transitions: JiraTransition[], been: Set<string>, backwards: boolean) {
  const open = transitions.filter((t) => t.to?.name && !been.has(named(t.to.name)) && t.to.statusCategory?.key !== 'done' && !looksShelved.test(t.to.name))
  const worth = (t: JiraTransition) => (looksStuck.test(t.to!.name!) ? 2 : (t.to?.statusCategory?.key === 'new') === backwards ? 0 : 1)
  return open.sort((a, b) => worth(a) - worth(b))[0]
}

// A summary is one line of at most 255 characters, or Jira refuses the whole write.
const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim().slice(0, 250)

const named = (text: string) => text.trim().replace(/[\s_-]+/g, '').toLowerCase()

const sameName = (a?: string, b?: string) => !!a && !!b && named(a) === named(b)

// The names Jira's own templates use. Whole names only: "Not Done" and "Dev Done" aren't done.
const usualNames: Record<string, Stage> = {
  todo: 'ready', backlog: 'ready', open: 'ready', reopened: 'ready', selectedfordevelopment: 'ready',
  inprogress: 'working', doing: 'working', started: 'working',
  blocked: 'blocked', onhold: 'blocked', waiting: 'blocked',
  inreview: 'review', review: 'review', codereview: 'review', testing: 'review', intesting: 'review', qa: 'review', inqa: 'review',
  done: 'live', closed: 'live', resolved: 'live', shipped: 'live', released: 'live', live: 'live',
}

/** The stage a status stands for, if it isn't the one the card's at: the binder's map first, then the usual names. */
export function stageOf(status: string | undefined, statuses: StageStatuses | undefined, card: Pick<Card, 'stage'> | undefined, inbound?: Record<string, Stage>): Stage | undefined {
  if (!status) return undefined
  const mapped = Object.entries(statuses ?? {}).find(([, name]) => sameName(name, status))?.[0] as Stage | undefined
  const counted = Object.entries(inbound ?? {}).find(([name]) => sameName(name, status))?.[1]
  const stage = mapped ?? counted ?? usualNames[named(status)]
  return stage && stage !== card?.stage ? stage : undefined
}

/**
 * The status a stage goes to in Jira: the binder's map, or with no map, what a stock workflow calls it. A stage left
 * out of a map goes nowhere: Settings calls that leaving the issue where it is.
 */
export const statusFor = (stage: Stage, statuses: StageStatuses | undefined) => (statuses && Object.keys(statuses).length ? statuses[stage] : usualStatus(stage))

const usualStatus = (stage: Stage) => ({ proposed: 'To Do', ready: 'To Do', working: 'In Progress', blocked: 'Blocked', review: 'In Review', live: 'Done' })[stage]

export interface JiraStatusInfo {
  name: string
  /** Jira's own sorting of a status: new, indeterminate or done, whatever a workflow calls it. */
  category?: string
}

export interface JiraTypeInfo {
  name: string
  /** 1 is what Stories sit under, 0 a Story or a Task. */
  level: number
  statuses: JiraStatusInfo[]
}

const looksShelved = /cancel|reject|won.?t|declin|duplicate|invalid|abandon/i
const looksInReview = /review|test|qa\b|uat|verif/i
const looksStuck = /block|hold|wait|imped/i

/** What a status of a workflow counts as, whatever it's called. A status that ended without being done counts as nothing. */
function countsAs(status: JiraStatusInfo): Stage | undefined {
  const whole = usualNames[named(status.name)]
  if (whole) return whole
  if (looksShelved.test(status.name)) return undefined
  if (status.category === 'new') return 'ready'
  if (status.category === 'done') return 'live'
  if (status.category === 'indeterminate') return looksStuck.test(status.name) ? 'blocked' : looksInReview.test(status.name) ? 'review' : 'working'
  return undefined
}

/**
 * The map a workflow suggests. Each stage goes to one status, its usual name if it has it (To Do over Backlog), and every
 * other status counts as a stage when someone moves an issue there. A stage with no match stays out of it: nothing
 * better than leaving the issue where it is.
 */
export function suggestStatuses(statuses: JiraStatusInfo[]) {
  const chosen: StageStatuses = {}
  for (const stage of stages) {
    const usual = Object.entries(usualNames).filter(([, is]) => is === stage).map(([name]) => statuses.find((s) => named(s.name) === name)).find(Boolean)
    const fit = usual ?? statuses.find((s) => countsAs(s) === stage)
    if (fit) chosen[stage] = fit.name
  }
  const inbound: Record<string, Stage> = {}
  for (const status of statuses) {
    const stage = countsAs(status)
    if (stage && chosen[stage] !== status.name) inbound[status.name] = stage
  }
  return { statuses: chosen, inbound, unmatched: stages.filter((stage) => !chosen[stage]) }
}

const firstNamed = (types: JiraTypeInfo[], names: string[]) => names.map((name) => types.find((t) => named(t.name) === name)).find(Boolean) ?? types[0]

/** What a note and its cards become: an issue's parent is one level up, so a note's type is what Stories sit under. */
export function suggestTypes(types: JiraTypeInfo[]) {
  return {
    noteIssueType: firstNamed(types.filter((t) => t.level === 1), ['epic', 'feature'])?.name,
    issueType: firstNamed(types.filter((t) => t.level === 0), ['story', 'task'])?.name,
  }
}

interface JiraField {
  id: string
  name: string
  schema?: { type?: string; custom?: string }
  scope?: { project?: { id?: string } }
}

const looksStoryPoints = /^story points?( estimate)?$/i

/**
 * The custom fields a card's size can go in, most likely first. A team-managed project's fields are its own, so another
 * project's are left off. Long text isn't here: Jira wants a whole document in those.
 */
export function fieldsForPoints(fields: JiraField[], projectId?: string) {
  const kindOf = (f: JiraField): PointsKind | undefined => (f.schema?.type === 'number' ? 'number' : f.schema?.type === 'option' ? 'option' : f.schema?.type === 'string' && f.schema.custom?.endsWith(':textfield') ? 'string' : undefined)
  const rank = (f: { name: string; kind: PointsKind }) => (looksStoryPoints.test(f.name) ? 0 : { number: 1, option: 2, string: 3 }[f.kind])
  return fields
    .filter((f) => /^customfield_\d+$/.test(f.id) && (!f.scope?.project?.id || !projectId || f.scope.project.id === projectId))
    .flatMap((f) => {
      const kind = kindOf(f)
      return kind ? [{ id: f.id, name: f.name, kind }] : []
    })
    .sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name))
}

/** What the service account can see, and for a project (the one asked for, or the only one) what it has and what to map it to. */
export async function discoverJira(who: JiraCredentials, wanted?: string) {
  const me = await jiraCall<{ displayName?: string; emailAddress?: string }>(who, '/myself').catch((error: Error) => {
    if (/^Jira said 401/.test(error.message)) throw new Refused('Jira didn’t accept that email and API token.')
    throw error
  })
  const projects: { key: string; name: string }[] = []
  let more = true
  // Enough for any picker; someone with more types the key in.
  for (let startAt = 0; more && startAt < 500; startAt += 100) {
    const page = await jiraCall<{ values?: { key: string; name: string }[]; isLast?: boolean }>(who, `/project/search?maxResults=100&orderBy=name&startAt=${startAt}`)
    projects.push(...(page.values ?? []).map(({ key, name }) => ({ key, name })))
    more = page.isLast === false
  }
  const found = { who: me.displayName ?? me.emailAddress, projects }
  const asked = wanted?.trim().toUpperCase()
  const chosen = asked ? projects.find((p) => p.key === asked) : projects.length === 1 ? projects[0] : undefined
  if (!chosen) return found
  const key = encodeURIComponent(chosen.key)
  const [detail, byType, fields] = await Promise.all([
    jiraCall<{ id?: string; issueTypes?: { id?: string; name: string; subtask?: boolean; hierarchyLevel?: number }[] }>(who, `/project/${key}`),
    jiraCall<{ name: string; subtask?: boolean; statuses?: { name: string; statusCategory?: { key?: string } }[] }[]>(who, `/project/${key}/statuses`),
    // Only points need these: a Jira that won't say leaves them to be set by hand.
    jiraCall<JiraField[]>(who, '/field').catch(() => [] as JiraField[]),
  ])
  const pointFields = fieldsForPoints(fields, detail.id)
  const storyPoints = pointFields.filter((f) => looksStoryPoints.test(f.name))
  const levelOf = (name: string, level?: number) => level ?? (/^(epic|feature)$/i.test(name) ? 1 : 0)
  const listed = (detail.issueTypes ?? []).filter((t) => !t.subtask && levelOf(t.name, t.hierarchyLevel) >= 0)
  const types = listed.map((t): JiraTypeInfo => ({
    name: t.name,
    level: levelOf(t.name, t.hierarchyLevel),
    statuses: (byType.find((b) => b.name === t.name)?.statuses ?? []).map((s) => ({ name: s.name, category: s.statusCategory?.key })),
  }))
  // A project usually has one of Jira's own. Where it has both, the one on the type's screen is the one its board adds up.
  // With neither, a number field that says it's points or an estimate. Anything less sure is a person's to pick.
  const fallback = pointFields.find((f) => f.kind === 'number' && /\bpoints?\b|estimate/i.test(f.name))?.id
  const pointsOfType = async (type: { id?: string; hierarchyLevel?: number; name: string }) => {
    if (storyPoints.length === 0) return fallback
    if (storyPoints.length < 2 || !type.id || levelOf(type.name, type.hierarchyLevel) !== 0) return storyPoints[0].id
    const screen = await jiraCall<{ fields?: { fieldId?: string }[]; values?: { fieldId?: string }[] }>(who, `/issue/createmeta/${key}/issuetypes/${encodeURIComponent(type.id)}?maxResults=200`).catch(() => undefined)
    const on = [...(screen?.fields ?? []), ...(screen?.values ?? [])].map((f) => f.fieldId)
    return (storyPoints.find((f) => on.includes(f.id)) ?? storyPoints[0]).id
  }
  const points = await Promise.all(listed.map(pointsOfType))
  // A board has sprints if asking for them works: a team-managed project's says neither scrum nor kanban.
  const { values: boards = [] } = await jiraCall<{ values?: { id: number; name: string; type?: string }[] }>(who, `/rest/agile/1.0/board?projectKeyOrId=${key}&maxResults=50`).catch(() => ({ values: [] }))
  const sprintBoards = (await Promise.all(boards.filter((b) => b.type !== 'kanban').slice(0, 10).map(async ({ id, name, type }) => {
    const works = await jiraCall(who, `/rest/agile/1.0/board/${id}/sprint?maxResults=1`).then(() => true, () => false)
    return works ? { id, name, type } : undefined
  }))).filter((b) => !!b)
  const sprintBoard = (sprintBoards.find((b) => b.type === 'scrum') ?? sprintBoards[0])?.id
  return { ...found, project: { ...chosen, pointFields, sprintBoards: sprintBoards.map(({ id, name }) => ({ id, name })), sprintBoard, types: types.map((t, i) => ({ ...t, suggested: { ...suggestStatuses(t.statuses), pointsField: points[i] } })), suggested: suggestTypes(types) } }
}

export function tidyStatuses(statuses: StageStatuses | undefined): StageStatuses {
  const out: StageStatuses = {}
  for (const stage of stages) {
    const name = statuses?.[stage]?.trim()
    if (name) out[stage] = name
  }
  return out
}

/** What the webhook needs of the saver: which card an issue was made for, and what it should know of what happened. */
export interface JiraMirror {
  cardOfIssue(issueId: string): string | undefined
  heard(cardId: string, stage: Stage): void
  /** Jira's status for an issue: whether it's news, the hub's own moves being known by where they went. */
  statusNews(cardId: string, status: string | undefined): boolean
  lost(cardId: string): void
  /** A note's Epic was deleted: it isn't made again. */
  lostEpic?(issueId: string): void
}

interface JiraEvent {
  webhookEvent?: unknown
  issue?: { id?: unknown; key?: unknown }
  changelog?: { items?: { field?: string }[] }
  comment?: JiraComment
}

/** How long an agent has to make its own changes in Jira before the hub makes them. */
export const agentGraceMs = 120_000

/** How long after finishing it's asked to, and its run kept going: less than that, so the two don't cross. */
const agentAskMs = 90_000

/** What an agent ends a comment with, so the hub knows it's there, and knows it's no one's news when it comes back. */
export const markOf = (cardId: string, said: Pick<Activity, 'at' | 'text'>) => `[binders:${createHash('sha1').update(`${cardId}|${said.at}|${said.text}`).digest('hex').slice(0, 10)}]`
const marked = /\[binders:[0-9a-f]{10}\]/

const ownTools = 'with your own Jira tools (an Atlassian or Jira MCP server), if you have them, so that Jira shows the person you work for did it. If you have none, or one fails, skip it and don’t try again: the hub does it for you'

/**
 * What an agent holding a card is asked to do in Jira. The hub can't act as its owner, but the agent can, with the Jira
 * connection it already has. It's asked to move the issue only once the board has the card there, so a move can't read
 * as a person's. Nothing depends on it: what's still not done when the time's up, the hub does.
 */
export function askOfAgent(settings: JiraSettings, card: Card, agentId: string, now = Date.now()) {
  if (!card.jira) return undefined
  const { key, url } = card.jira
  if (settings.agentWrites === false || card.agentId !== agentId) return { key, url }
  const status = statusFor(card.stage, settings.statuses)
  if (card.stage === 'working') {
    return { key, url, ask: `This card is Jira issue ${key}. Now, ${ownTools}: assign ${key} to yourself${status ? ` and move it to “${status}”` : ''}. Make no other Jira issues, and don’t move it again while you work: complete_task’s reply says what to do at the end.` }
  }
  const done = card.activity.findLast((a) => a.kind === 'completed' && a.by === agentId)
  if ((card.stage === 'review' || card.stage === 'live') && done && now - Date.parse(done.at) < agentAskMs) {
    return { key, url, finishing: true, ask: `One last step before you stop, ${ownTools}: ${status ? `move ${key} to “${status}”, and ` : ''}add this comment to it, with the mark at the end exactly as it is:\n\n${done.text} ${markOf(card.id, done)}` }
  }
  return { key, url }
}

/** The same for something it just said on the card. */
export function commentAskOfAgent(settings: JiraSettings, card: Card, said: Pick<Activity, 'at' | 'text'>) {
  if (!card.jira || settings.agentWrites === false) return undefined
  return `Add this to Jira issue ${card.jira.key} too, ${ownTools}. Keep the mark at the end exactly as it is:\n\n${said.text} ${markOf(card.id, said)}`
}

/** A comment the hub wrote on someone's behalf says so, and it's only that when the service account wrote it: a person using that account is still a person. */
const saidInBinders = /^[*_]*[^\n]{1,200}, in Binders:/
export const inBinders = (who: string, text: string) => `**${who}, in Binders:** ${text}`

/** A comment from Jira lands on its card, once. */
export async function heardComment(hub: Hub, jira: JiraConnection, card: Card, comment: JiraComment | undefined, at: string): Promise<'comment' | 'echo' | 'ignored'> {
  const text = jira.textOf(comment?.body).slice(0, 2000)
  // An agent's own comment is what it already said on the card.
  if (!text || marked.test(text) || (saidInBinders.test(text) && (await jira.isMe(comment?.author)))) return 'ignored'
  const activity = commentFrom(comment?.author?.displayName, text, comment?.created ?? at)
  // Jira sends again when it isn't sure: the same words at the same moment are that, and the same words later are said again.
  if (card.activity.some((a) => a.kind === 'comment' && a.at === activity.at && a.by === activity.by && a.text === text)) return 'echo'
  await hub.record({ kind: 'hub' }, { type: 'card.activity', id: card.id, activity })
  return 'comment'
}

/** A status someone moved an issue to moves its card, by the board's own rules. */
export async function heardStatus(hub: Hub, jira: JiraConnection, mirror: JiraMirror, card: Card, status: string | undefined, at: string): Promise<'moved' | 'echo' | 'ignored'> {
  if (!mirror.statusNews(card.id, status)) return 'echo'
  const stage = stageOf(status, jira.settings.statuses, card, jira.settings.inbound)
  const fields = stage && handMove(card, stage)
  if (!stage || !fields) return 'ignored'
  mirror.heard(card.id, stage)
  await hub.record({ kind: 'hub' }, { type: 'card.update', id: card.id, fields, activity: { at, by: 'Jira', kind: 'moved', text: `Jira moved it to ${status}` } })
  return 'moved'
}

/** Jira telling the hub what people did to an issue the saver made. Any other issue is someone else's. */
export async function handleWebhook(hub: Hub, jira: JiraConnection, mirror: JiraMirror, payload: Record<string, unknown>): Promise<string> {
  if (!jira.on()) return 'off'
  const { webhookEvent, issue, changelog, comment } = payload as JiraEvent
  const issueId = String(issue?.id ?? '')
  if (!/^\d+$/.test(issueId)) return 'ignored'
  const cardId = mirror.cardOfIssue(issueId)
  const card = cardId ? hub.state.cards.find((c) => c.id === cardId) : undefined
  if (!card) {
    if (webhookEvent === 'jira:issue_deleted') mirror.lostEpic?.(issueId)
    return 'not ours'
  }
  const at = new Date().toISOString()

  if (webhookEvent === 'jira:issue_deleted') {
    mirror.lost(card.id)
    await hub.record({ kind: 'hub' }, { type: 'card.activity', id: card.id, activity: { at, by: 'Jira', kind: 'said', text: `Its Jira issue${issue?.key ? ` ${String(issue.key)}` : ''} was deleted.` } })
    return 'deleted'
  }

  if (webhookEvent === 'comment_created') return heardComment(hub, jira, card, comment, at)

  // Issue events also fire for edits and comments: only a status someone changed says anything about the stage.
  if (webhookEvent !== 'jira:issue_updated' || !changelog?.items?.some((item) => item.field === 'status')) return 'ignored'
  let now: JiraIssue
  try {
    now = await jira.issue(issueId)
  } catch (error) {
    log.warn({ binder: jira.settings.project, why: (error as Error).message }, 'Couldn’t read a Jira issue back')
    return 'failed'
  }
  return heardStatus(hub, jira, mirror, card, now.status, at)
}

/** Named as from Jira: its display names are anyone's to pick, and mustn't pass for someone in the binder. */
const commentFrom = (name: string | undefined, text: string, at: string): Activity => ({ at, by: `${name?.slice(0, 80) || 'Someone'} on Jira`, kind: 'comment', text })
