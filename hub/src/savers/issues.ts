import { createHash } from 'node:crypto'
import type { Entry } from '../../../shared/state.ts'
import { titleOf } from '../../../shared/notes.ts'
import { debriefMarkdown, debriefToComment } from '../../../shared/changeSet.ts'
import type { Card } from '../../../shared/work.ts'
import { GitHubError, type GitHub } from '../github.ts'

/** GitHub as the hub for a repo, or nothing when the hub can't reach that repo. */
export interface RepoAccess {
  forRepo(repo: string): Promise<GitHub | undefined>
}
import type { Hub } from '../hub.ts'
import { log } from '../logger.ts'
import { sameRepo } from '../../../shared/work.ts'

// Cards kept as GitHub Issues in their binder's repo. Edits to a card within a moment become one write; Binders' own
// fields ride along in a hidden block at the end of the body, so the issue alone can rebuild the card and GitHub stays
// the only copy. An issue someone edits on GitHub comes back through the webhook (webhooks.ts), and what this saver
// wrote itself is recognised and not taken back. A card's debrief, once written, is kept as a comment on its issue,
// edited in place each time it's written again, so it's on GitHub (and GitHub's apps) even with Binders off.

const marker = '<!-- binders '

/** Binders' own fields, read back out of an issue's body. */
export function readMetadata(body: string | null | undefined): Record<string, unknown> | undefined {
  if (!body) return undefined
  const at = body.lastIndexOf(marker)
  if (at < 0) return undefined
  try {
    return JSON.parse(body.slice(at + marker.length, body.indexOf('-->', at)).trim())
  } catch {
    return undefined
  }
}

/** The body without the hidden block, as a person wrote or reads it. */
export const withoutMetadata = (body: string | null | undefined) => (body ?? '').split(marker)[0].trimEnd()

/** "Done when: …" read back out of a body someone edited on GitHub. */
export function readBody(body: string) {
  const plain = withoutMetadata(body)
  const done = /\n\*\*Done when:\*\*\s*([^\n]*)/.exec(plain)
  const brief = plain.split(/\n\*\*Done when:\*\*/)[0].split(/\n\n_From /)[0].trim()
  return { brief, doneWhen: done?.[1]?.trim() }
}

export interface IssuesOptions {
  quietMs?: number
  /** The web app's address, for links from issues back to the hub. */
  publicUrl?: string
}

export class IssuesSaver {
  private hub: Hub
  private github: RepoAccess
  private timers = new Map<string, NodeJS.Timeout>()
  private queue: Promise<void> = Promise.resolve()
  /** What was last written to each issue, so a webhook echo of it is recognised. */
  private written = new Map<string, string>()
  private states = new Map<string, string>()
  private quietMs: number
  private publicUrl?: string

  constructor(hub: Hub, github: RepoAccess, options: IssuesOptions = {}) {
    this.hub = hub
    this.github = github
    this.quietMs = options.quietMs ?? 1500
    this.publicUrl = options.publicUrl
  }

  start() {
    this.hub.on('entries', (entries) => this.follow(entries))
  }

  private follow(entries: Entry[]) {
    for (const { change } of entries) {
      if (change.type === 'card.put') this.later(change.card.id)
      // A card.update that only records its issue is this saver's own (but its debrief may be waiting for it); one that
      // only brings its worktree's diff or its Challenge isn't in the issue; one that only brings its debrief is, when it's
      // newly written.
      else if (change.type === 'card.update' && 'debrief' in change.fields && Object.keys(change.fields).length === 1) {
        if (debriefToComment(change.fields.debrief)) this.later(change.id)
      } else if (change.type === 'card.update' && 'issue' in change.fields && Object.keys(change.fields).length === 1) {
        if (debriefToComment(this.hub.state.cards.find((c) => c.id === change.id)?.debrief)) this.later(change.id)
      } else if (change.type === 'card.update' && !(Object.keys(change.fields).length === 1 && ('worktree' in change.fields || 'challenge' in change.fields))) this.later(change.id)
      else if (change.type === 'card.claim' || change.type === 'card.release') this.later(change.id)
      else if (change.type === 'binder.put') for (const card of this.hub.state.cards) if (card.binderId === change.binder.id && !card.issue && change.binder.repo) this.later(card.id)
    }
  }

  private later(cardId: string) {
    clearTimeout(this.timers.get(cardId))
    this.timers.set(cardId, setTimeout(() => {
      this.timers.delete(cardId)
      this.queue = this.queue.then(() => this.save(cardId)).catch((error) => {
        const binderId = this.hub.state.cards.find((c) => c.id === cardId)?.binderId
        if (binderId) this.problems.set(binderId, `GitHub said: ${(error as Error).message}`)
        log.error({ err: error }, 'Saving a card to GitHub failed')
      })
    }, this.quietMs))
  }

  bodyOf(card: Card) {
    const lines = [card.brief || '_No brief yet._']
    if (card.doneWhen) lines.push('', `**Done when:** ${card.doneWhen}`)
    const note = card.noteId ? this.hub.state.notes.find((n) => n.id === card.noteId) : undefined
    if (note) lines.push('', `_From “${titleOf(note.text)}”${card.quote ? `: “${card.quote}”` : ''}${this.publicUrl ? ` ([open in Binders](${this.publicUrl}/#/work/${card.id}))` : ''}_`)
    const agent = this.hub.state.agents.find((a) => a.id === card.agentId)
    const meta = { card: card.id, binder: card.binderId, stage: card.stage, size: card.size, agent: agent?.name, meantFor: card.meantFor, waitsFor: card.waitsFor, note: card.noteId }
    lines.push('', `${marker}${JSON.stringify(meta)} -->`)
    return lines.join('\n')
  }

  labelsOf(card: Card) {
    return ['binders', `stage: ${card.stage}`, `size: ${card.size}`]
  }

  /** Whether an issue's title and body are what this saver last wrote there. */
  isEcho(repo: string, number: number, title: string, body: string) {
    return this.written.get(`${repo}#${number}`) === hash(title, body)
  }

  /** What last went wrong keeping each binder's cards as issues, by binder. */
  readonly problems = new Map<string, string>()

  /** Every card in the binder saved again, as when its repo or switch changes or a person asks. */
  syncBinder(binderId: string) {
    this.problems.delete(binderId)
    for (const card of this.hub.state.cards) if (card.binderId === binderId) this.later(card.id)
  }

  private async save(cardId: string) {
    const card = this.hub.state.cards.find((c) => c.id === cardId)
    if (!card) return
    const binder = this.hub.state.binders.find((b) => b.id === card.binderId)
    const repo = binder?.repo
    if (!binder || !repo || binder.issues === false) return
    // A proposed card waits for a person before it's anyone's issue.
    if (card.stage === 'proposed' && !card.issue) return
    const github = await this.github.forRepo(repo)
    if (!github) {
      this.problems.set(binder.id, `The hub can’t reach ${repo}: install the GitHub App on it, or check the name.`)
      return
    }
    this.problems.delete(binder.id)
    const body = this.bodyOf(card)
    const fields = { title: card.title, body, labels: this.labelsOf(card), state: card.stage === 'live' ? 'closed' as const : 'open' as const }
    if (card.issue && sameRepo(card.issue.repo, repo)) {
      const key = `${repo}#${card.issue.number}`
      const written = hash(card.title, body)
      if (this.written.get(key) !== written || this.states.get(key) !== fields.state) {
        await github.updateIssue(repo, card.issue.number, fields)
        this.written.set(key, written)
        this.states.set(key, fields.state)
      }
      await this.saveDebrief(github, card.id)
      return
    }
    const issue = await github.createIssue(repo, { title: fields.title, body, labels: fields.labels })
    this.written.set(`${repo}#${issue.number}`, hash(card.title, body))
    this.states.set(`${repo}#${issue.number}`, 'open')
    await this.hub.record({ kind: 'hub' }, { type: 'card.update', id: card.id, fields: { issue: { repo, number: issue.number, url: issue.html_url } } })
  }

  /** The card's written debrief, as a comment on its issue: the comment it's already in, edited, or a new one. */
  private async saveDebrief(github: GitHub, cardId: string) {
    const card = this.hub.state.cards.find((c) => c.id === cardId)
    const debrief = card?.debrief
    if (!card?.issue || !debrief || !debriefToComment(debrief)) return
    const { repo, number } = card.issue
    const agent = this.hub.state.agents.find((a) => a.id === debrief.agentId)?.name ?? 'An agent'
    const body = `${debriefMarkdown(debrief, { agent, link: this.publicUrl ? `${this.publicUrl}/#/work/${card.id}` : undefined })}\n\n${marker}${JSON.stringify({ debrief: card.id })} -->`
    // A comment someone deleted on GitHub is made again.
    const edited = sameRepo(debrief.comment?.repo, repo) ? await github.updateComment(repo, debrief.comment!.id, body).catch((error) => {
      if (error instanceof GitHubError && error.status === 404) return undefined
      throw error
    }) : undefined
    const comment = edited ?? await github.createComment(repo, number, body)
    // Read again: it may have been asked for again while GitHub answered. Only the comment is this saver's.
    const now = this.hub.state.cards.find((c) => c.id === cardId)?.debrief
    if (!now) return
    await this.hub.record({ kind: 'hub' }, { type: 'card.update', id: cardId, fields: { debrief: { ...now, comment: { repo, id: comment.id, url: comment.html_url, writtenAt: debrief.writtenAt! } } } })
  }

  async stop() {
    const waiting = [...this.timers.keys()]
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
    for (const id of waiting) this.queue = this.queue.then(() => this.save(id)).catch(() => {})
    await this.queue
  }
}

const hash = (title: string, body: string) => createHash('sha256').update(`${title}\n${body}`).digest('hex')
