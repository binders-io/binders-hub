import { randomUUID } from 'node:crypto'
import { atLeast, briefsSince } from '../../../shared/agents.ts'
import { briefNoteText, briefText, briefTitle, docsFolderName, repoFolders } from '../../../shared/briefs.ts'
import { briefId, briefMost, briefOf, lessonMost, lessonsKept, type Agent, type BriefAsk, type RepoBrief } from '../../../shared/work.ts'
import { Refused, type Actor } from '../hub.ts'
import { ChallengeService } from './challenges.ts'
import { tidy } from './base.ts'

// A repo's brief: what an agent should know before it works or reviews there, written by an agent from the repo's
// default branch and kept in the binder's log, with what agents and people learn meanwhile beside it.

const repoPattern = /^[\w.-]+\/[\w.-]+$/

/** How long an agent may sit on a brief before another may be asked: writing one reads a whole repo. */
const briefPending = 60 * 60_000

// What a secret looks like, so one copied out of a config file never goes into a brief every agent reads.
const secretPatterns = [
  /\bgh[pousr]_[A-Za-z0-9]{30,}/, /\bgithub_pat_[A-Za-z0-9_]{40,}/, /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{24,}/, /\bAKIA[0-9A-Z]{16}\b/,
  /\bxox[abpr]-[A-Za-z0-9-]{20,}/, /-----BEGIN [A-Z ]*PRIVATE KEY-----/, /\bAIza[0-9A-Za-z_-]{35}\b/, /\bhf_[A-Za-z0-9]{30,}/,
]
export const looksSecret = (text: string) => secretPatterns.some((p) => p.test(text))

const actorId = (actor: Actor) => (actor.kind === 'user' ? actor.login : actor.kind === 'agent' ? actor.id : 'hub')

export abstract class BriefService extends ChallengeService {
  /** The repos this binder works in: its projects', its agents', and its pull requests'. */
  knownRepos() {
    const all = [
      ...this.hub.state.binders.map((b) => b.repo),
      ...this.hub.state.agents.filter((a) => !a.revoked).flatMap((a) => a.repos),
      ...this.hub.state.pulls.map((p) => p.repo),
      ...(this.hub.state.briefs ?? []).map((b) => b.repo),
    ].filter((r): r is string => !!r && repoPattern.test(r))
    const seen = new Map<string, string>()
    for (const repo of all) if (!seen.has(briefId(repo))) seen.set(briefId(repo), repo)
    return [...seen.values()]
  }

  private known(repo: string) {
    const clean = repo.trim().replace(/\.git$/, '')
    if (!repoPattern.test(clean)) throw new Refused('A repo is written owner/name.')
    const found = this.knownRepos().find((r) => briefId(r) === briefId(clean))
    if (!found) throw new Refused(`${clean} isn’t one of this binder’s repos: link it to a project or an agent first.`)
    return found
  }

  /** Whether an agent works in a repo: one of its own, or any when it isn't limited to some. */
  worksInRepo(agent: Agent, repo: string) {
    return !agent.repos.length || agent.repos.some((r) => briefId(r) === briefId(repo))
  }

  private pending(ask: BriefAsk | undefined) {
    return !!ask && (ask.state === 'asked' || ask.state === 'writing') && Date.now() - Date.parse(ask.at) < briefPending
  }

  /**
   * Asks an agent to write a repo's brief, or to write it again from the one there. A person names the agent or the hub
   * picks one; an agent asks for itself, as its runner does when it finds none, or one far behind. Only one agent writes
   * a brief at a time: asked while one is, it says who, and an agent asking is told rather than refused.
   */
  async askBrief(actor: Actor, repo: string, agentId?: string, refresh?: boolean) {
    const name = this.known(repo)
    const before = briefOf(this.hub.state, name)
    if (this.pending(before?.ask)) {
      const who = this.hub.state.agents.find((a) => a.id === before!.ask!.agentId)?.name ?? 'An agent'
      if (actor.kind === 'agent') return { brief: before!, already: who }
      throw new Refused(`${who} is already writing ${name}’s brief.`)
    }
    let agent: Agent | undefined
    if (agentId) {
      agent = this.agent(agentId)
      if (!this.worksInRepo(agent, name)) throw new Refused(`${agent.name} doesn’t work in ${name}: add it to the agent’s repos first.`)
    } else {
      // One whose runner writes briefs, listening and free first, then one that works in the repo at all.
      const presence = this.hub.presence()
      const busy = new Set(this.hub.state.cards.filter((c) => c.stage === 'working' && c.agentId).map((c) => c.agentId))
      const able = this.hub.state.agents.filter((a) => !a.revoked && this.worksInRepo(a, name) && atLeast(a.runnerSeen?.version, briefsSince))
      agent = able.find((a) => presence[a.id]?.listening && !busy.has(a.id)) ?? able.find((a) => presence[a.id]?.listening) ?? able[0]
      if (!agent) throw new Refused(`No agent can write ${name}’s brief: it takes one that works in ${name}, on runner ${briefsSince} or newer.`)
    }
    const ask: BriefAsk = { agentId: agent.id, askedBy: actorId(actor), at: this.now(), state: 'asked', ...((refresh ?? !!briefText(this.hub.state, before)) ? { refresh: true } : {}) }
    const brief: RepoBrief = tidy({ ...(before ?? { id: briefId(name), repo: name }), ask })
    await this.hub.record(actor, { type: 'brief.put', brief })
    return { brief: briefOf(this.hub.state, name)! }
  }

  private briefing(agentId: string, repo: string) {
    const brief = briefOf(this.hub.state, repo)
    if (!brief?.ask || brief.ask.agentId !== agentId || (brief.ask.state !== 'asked' && brief.ask.state !== 'writing')) throw new Refused(`No brief of ${repo} is waiting for you: request_repo_brief asks for one.`)
    return brief as RepoBrief & { ask: BriefAsk }
  }

  /** The agent writing a brief: what it's doing meanwhile, that it couldn't and why, or the brief itself. */
  async sendBrief(agentId: string, repo: string, sent: { doing?: string; failed?: string; text?: string; sha?: string }) {
    const brief = this.briefing(agentId, repo)
    const actor: Actor = { kind: 'agent', id: agentId }
    if (sent.failed !== undefined) {
      const failed = sent.failed.trim().slice(0, 1000) || 'It stopped without one.'
      await this.hub.record(actor, { type: 'brief.put', brief: tidy({ ...brief, ask: tidy({ ...brief.ask, state: 'failed' as const, doing: undefined, failed }) }) })
      return briefOf(this.hub.state, repo)!
    }
    if (sent.text === undefined) {
      const doing = sent.doing?.trim().slice(0, 200)
      if (brief.ask.state === 'writing' && brief.ask.doing === doing) return brief
      await this.hub.record(actor, { type: 'brief.put', brief: tidy({ ...brief, ask: tidy({ ...brief.ask, state: 'writing' as const, doing }) }) })
      return briefOf(this.hub.state, repo)!
    }
    const text = sent.text.trim()
    if (text.length < 200) throw new Refused('That brief is too short to help anyone: write each of its sections.')
    if (text.length > briefMost) throw new Refused(`A brief is at most ${briefMost.toLocaleString('en')} characters, and that’s ${text.length.toLocaleString('en')}: keep what an agent most needs.`)
    if (looksSecret(text)) throw new Refused('That brief has what looks like a secret in it (a token or a key): name the setting, never its value, and send it again.')
    const sha = sent.sha?.trim()
    if (sha && !/^[0-9a-f]{7,40}$/i.test(sha)) throw new Refused('sha is the commit it was written from.')
    // Lessons it was given were folded in; ones added while it wrote are kept for next time.
    const lessons = (brief.lessons ?? []).filter((l) => l.at > brief.ask.at)
    const noteId = await this.keepInNote(actor, brief, text)
    await this.hub.record(actor, { type: 'brief.put', brief: tidy({ id: brief.id, repo: brief.repo, noteId, sha: sha?.toLowerCase(), writtenAt: this.now(), writtenBy: agentId, lessons: lessons.length ? lessons : undefined }) })
    return briefOf(this.hub.state, repo)!
  }

  /** Repo docs and the repo's folder in it, made where they aren't yet. */
  private async repoFolder(actor: Actor, repo: string) {
    let { binderId, docs, folder } = repoFolders(this.hub.state, repo)
    if (!binderId) throw new Refused('This Binder has no notes to keep a brief in.')
    const make = async (name: string, parentId?: string) => {
      const id = `folder-${randomUUID().slice(0, 8)}`
      await this.hub.record(actor, { type: 'folder.put', folder: tidy({ id, binderId: binderId!, name, parentId }) })
      return this.hub.state.folders.find((f) => f.id === id)!
    }
    docs ??= await make(docsFolderName)
    folder ??= await make(repo, docs.id)
    return { binderId, folderId: folder.id }
  }

  /** A brief's words into its note in Repo docs: the one it had, or a new one there. */
  private async keepInNote(actor: Actor, brief: RepoBrief, text: string) {
    const body = briefNoteText(text)
    const at = this.now()
    const by = actorId(actor)
    // Its own note, else a brief's note already in its folder (one forgotten here, say, is written over).
    const { folder } = repoFolders(this.hub.state, brief.repo)
    const note = (brief.noteId ? this.hub.state.notes.find((n) => n.id === brief.noteId) : undefined)
      ?? (folder ? this.hub.state.notes.find((n) => n.folderId === folder.id && n.title === briefTitle) : undefined)
    if (note) {
      await this.hub.record(actor, { type: 'note.edit', id: note.id, text: body, title: briefTitle, by, at })
      return note.id
    }
    const { binderId, folderId } = await this.repoFolder(actor, brief.repo)
    const id = `note-${randomUUID().slice(0, 12)}`
    await this.hub.record(actor, { type: 'note.put', note: { id, title: briefTitle, binderId, folderId, editedAt: at, editedBy: by, editors: [by], text: body } })
    return id
  }

  /** Briefs written before they were kept in notes, into notes: once, when the hub starts. */
  async moveBriefsToNotes() {
    for (const brief of this.hub.state.briefs ?? []) {
      if (!brief.text || brief.noteId) continue
      const noteId = await this.keepInNote({ kind: 'hub' }, brief, brief.text)
      const now = briefOf(this.hub.state, brief.repo)!
      await this.hub.record({ kind: 'hub' }, { type: 'brief.put', brief: tidy({ ...now, noteId, text: undefined }) })
    }
  }

  /** Something learned about a repo that the next agent there should know, kept beside its brief until it's next written. */
  async addLesson(actor: Actor, repo: string, text: string) {
    const name = this.known(repo)
    const clean = text.replace(/\s+/g, ' ').trim()
    if (!clean) throw new Refused('A lesson needs its words.')
    if (clean.length > lessonMost) throw new Refused(`A lesson is one line, at most ${lessonMost} characters.`)
    if (looksSecret(clean)) throw new Refused('That looks like it has a secret in it: name the setting, never its value.')
    const before = briefOf(this.hub.state, name) ?? { id: briefId(name), repo: name }
    const lessons = before.lessons ?? []
    if (lessons.some((l) => l.text.toLowerCase() === clean.toLowerCase())) return before
    const next = [...lessons, { at: this.now(), by: actorId(actor), text: clean }].slice(-lessonsKept)
    await this.hub.record(actor, { type: 'brief.put', brief: tidy({ ...before, lessons: next }) })
    return briefOf(this.hub.state, name)!
  }

  async removeLesson(login: string, repo: string, at: string) {
    const brief = briefOf(this.hub.state, this.known(repo))
    if (!brief?.lessons?.some((l) => l.at === at)) throw new Refused('No such lesson.')
    const lessons = brief.lessons.filter((l) => l.at !== at)
    await this.hub.record({ kind: 'user', login }, { type: 'brief.put', brief: tidy({ ...brief, lessons: lessons.length ? lessons : undefined }) })
    return briefOf(this.hub.state, repo)!
  }

  /** Forgets a repo's brief and its lessons: the next agent there writes it from nothing. */
  async forgetBrief(login: string, repo: string) {
    const brief = briefOf(this.hub.state, repo)
    if (!brief) throw new Refused(`${repo} has no brief.`)
    await this.hub.record({ kind: 'user', login }, { type: 'brief.delete', id: brief.id })
    return { forgotten: brief.repo }
  }
}
