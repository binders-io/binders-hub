import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type { KV } from './kv.ts'
import type { Sealer } from './secrets.ts'
import { Refused, type Hub } from './hub.ts'
import { handMove, type Activity, type Card, type Stage } from '../../shared/work.ts'
import { log } from './logger.ts'

// Jira Cloud, as one binder's own tracker: its address, a service account, and the project its issues are made in.
// Cards go out (savers/jira.ts); what people do to those issues comes back (the webhook, at the end): a status they
// change moves the card by the board's own rules, a comment lands on it. Only issues the saver made count, and its own
// writes are known by who made them. The hub is the one copy of the words: Jira's description is written, never read
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
  /** The status each stage stands for, by name as the project's workflow has it. */
  statuses?: StageStatuses
  on?: boolean
}

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
      statuses: tidyStatuses(fields.statuses),
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

  private auth() {
    return 'Basic ' + Buffer.from(`${this.settings.email}:${this.settings.token}`).toString('base64')
  }

  private async call<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
    if (!this.settings.baseUrl) throw new Refused('Jira isn’t set up on this binder.')
    const response = await fetch(`${this.settings.baseUrl}/rest/api/3${path}`, {
      method: init.method ?? 'GET',
      // The token goes to the address that was set, not wherever that address points next.
      redirect: 'error',
      signal: AbortSignal.timeout(20_000),
      headers: { authorization: this.auth(), accept: 'application/json', ...(init.body ? { 'content-type': 'application/json' } : {}) },
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

  /** Text as Jira's document format: a paragraph per blank line, bold as the words have it, nothing cleverer. */
  adf(text: string) {
    return {
      type: 'doc',
      version: 1,
      content: text.split(/\n{2,}/).filter((p) => p.trim()).map((paragraph) => ({
        type: 'paragraph',
        content: paragraph.split('\n').flatMap((line, index) => {
          const parts = line.split('**').map((part, i) => (part ? { type: 'text', text: part, ...(i % 2 ? { marks: [{ type: 'strong' }] } : {}) } : undefined)).filter(Boolean) as { type: string; text: string }[]
          return index ? [{ type: 'hardBreak' }, ...parts] : parts
        }),
      })),
    }
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
      return at.type === 'paragraph' ? `${inner}\n\n` : inner
    }
    return walk(body).replace(/\n{3,}/g, '\n\n').trim()
  }

  create(cardId: string, fields: { summary: string; description: string }) {
    return this.call<{ id: string; key: string }>('/issue', {
      method: 'POST',
      body: {
        fields: {
          project: { key: this.settings.project },
          issuetype: { name: this.settings.issueType ?? 'Task' },
          summary: oneLine(fields.summary),
          description: this.adf(fields.description),
          labels: ['binders', labelFor(cardId)],
        },
      },
    })
  }

  /** The issue's title and words, as one write. */
  async update(id: string, fields: { summary: string; description: string }) {
    await this.call(`/issue/${encodeURIComponent(id)}`, { method: 'PUT', body: { fields: { summary: oneLine(fields.summary), description: this.adf(fields.description) } } })
  }

  /** Moves an issue to a status, if its workflow goes there from where it is. False when it doesn't. */
  async transitionTo(id: string, statusName: string): Promise<boolean> {
    const path = `/issue/${encodeURIComponent(id)}/transitions`
    const { transitions } = await this.call<{ transitions?: { id: string; name?: string; to?: { name?: string } }[] }>(path)
    const wanted = (transitions ?? []).find((t) => sameName(t.to?.name, statusName) || sameName(t.name, statusName))
    if (!wanted) return false
    await this.call(path, { method: 'POST', body: { transition: { id: wanted.id } } })
    return true
  }

  async issue(id: string): Promise<JiraIssue> {
    const one = await this.call<IssueJSON>(`/issue/${encodeURIComponent(id)}?fields=summary,status`)
    return { id: one.id, key: one.key, summary: one.fields?.summary, status: one.fields?.status?.name }
  }

  /** The issue a card already has, by its label: none found is an answer, and Jira not answering throws. */
  async issueOf(cardId: string): Promise<{ id: string; key: string } | undefined> {
    const jql = encodeURIComponent(`project = "${this.settings.project}" AND labels = "${labelFor(cardId)}" ORDER BY created ASC`)
    const found = await this.call<{ issues?: { id: string; key?: string; fields?: { key?: string } }[] }>(`/search/jql?maxResults=1&fields=key&jql=${jql}`)
    const issue = found.issues?.[0]
    const key = issue?.key ?? issue?.fields?.key
    return issue ? { id: issue.id, key: key ?? issue.id } : undefined
  }
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
export function stageOf(status: string | undefined, statuses: StageStatuses | undefined, card: Pick<Card, 'stage'> | undefined): Stage | undefined {
  if (!status) return undefined
  const mapped = Object.entries(statuses ?? {}).find(([, name]) => sameName(name, status))?.[0] as Stage | undefined
  const stage = mapped ?? usualNames[named(status)]
  return stage && stage !== card?.stage ? stage : undefined
}

/** The status a stage goes to in Jira: the binder's map, or what a stock workflow calls it. */
export const statusFor = (stage: Stage, statuses: StageStatuses | undefined) => statuses?.[stage] ?? usualStatus(stage)

const usualStatus = (stage: Stage) => ({ proposed: 'To Do', ready: 'To Do', working: 'In Progress', blocked: 'Blocked', review: 'In Review', live: 'Done' })[stage]

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
  lost(cardId: string): void
}

interface JiraEvent {
  webhookEvent?: unknown
  issue?: { id?: unknown; key?: unknown }
  user?: { accountId?: string }
  changelog?: { items?: { field?: string }[] }
  comment?: { body?: unknown; author?: { displayName?: string; accountId?: string }; created?: string }
}

/** Jira telling the hub what people did to an issue the saver made. Any other issue is someone else's. */
export async function handleWebhook(hub: Hub, jira: JiraConnection, mirror: JiraMirror, payload: Record<string, unknown>): Promise<string> {
  if (!jira.on()) return 'off'
  const { webhookEvent, issue, user, changelog, comment } = payload as JiraEvent
  const issueId = String(issue?.id ?? '')
  if (!/^\d+$/.test(issueId)) return 'ignored'
  const cardId = mirror.cardOfIssue(issueId)
  const card = cardId ? hub.state.cards.find((c) => c.id === cardId) : undefined
  if (!card) return 'not ours'
  const at = new Date().toISOString()

  if (webhookEvent === 'jira:issue_deleted') {
    mirror.lost(card.id)
    await hub.record({ kind: 'hub' }, { type: 'card.activity', id: card.id, activity: { at, by: 'Jira', kind: 'said', text: `Its Jira issue${issue?.key ? ` ${String(issue.key)}` : ''} was deleted.` } })
    return 'deleted'
  }

  if (webhookEvent === 'comment_created') {
    const text = jira.textOf(comment?.body).slice(0, 2000)
    if (!text || (await jira.isMe(comment?.author))) return 'ignored'
    const activity = commentFrom(comment?.author?.displayName, text, comment?.created ?? at)
    // Jira sends again when it isn't sure: the same words at the same moment are that, and the same words later are said again.
    if (card.activity.some((a) => a.kind === 'comment' && a.at === activity.at && a.by === activity.by && a.text === text)) return 'echo'
    await hub.record({ kind: 'hub' }, { type: 'card.activity', id: card.id, activity })
    return 'comment'
  }

  // Issue events also fire for edits and comments: only a status someone changed says anything about the stage.
  if (webhookEvent !== 'jira:issue_updated' || !changelog?.items?.some((item) => item.field === 'status')) return 'ignored'
  if (await jira.isMe(user)) return 'echo'
  let now: JiraIssue
  try {
    now = await jira.issue(issueId)
  } catch (error) {
    log.warn({ binder: jira.settings.project, why: (error as Error).message }, 'Couldn’t read a Jira issue back')
    return 'failed'
  }
  const stage = stageOf(now.status, jira.settings.statuses, card)
  const fields = stage && handMove(card, stage)
  if (!stage || !fields) return 'ignored'
  mirror.heard(card.id, stage)
  await hub.record({ kind: 'hub' }, { type: 'card.update', id: card.id, fields, activity: { at, by: 'Jira', kind: 'moved', text: `Jira moved it to ${now.status}` } })
  return 'moved'
}

/** Named as from Jira: its display names are anyone's to pick, and mustn't pass for someone in the binder. */
const commentFrom = (name: string | undefined, text: string, at: string): Activity => ({ at, by: `${name?.slice(0, 80) || 'Someone'} on Jira`, kind: 'comment', text })
