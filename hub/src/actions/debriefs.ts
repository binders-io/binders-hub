import type { Change } from '../../../shared/state.ts'
import { effortFor, efforts, type AskedEffort, type Effort, debriefable, debriefSpeech, doneWhenPoints, outOfDate, pullOf, type Debrief, type DebriefPoint, type DebriefSince } from '../../../shared/changeSet.ts'
import { worksIn, type Agent } from '../../../shared/work.ts'
import { Refused, type Actor } from '../hub.ts'
import { ChangeSetService } from './changeSets.ts'
import { openSet, reasoningText, same, tidy, type Subject } from './base.ts'

// A debrief: what a change set proposes, written by an agent when a person asks.

export abstract class DebriefService extends ChangeSetService {
  /**
   * A person asks for a debrief: of a card's whole change set once it's in one (all its pull requests together), or of
   * the card alone while it's being built. It goes to the agent they name, or else to one that's listening and free, one
   * of its own first; with none listening, to its agent or the first that may work in its project, for when its runner
   * is back.
   */
  /** The reasoning asked for, or by the change's size when it's auto or not said. */
  protected effortOf(subject: Subject, asked?: string): AskedEffort {
    const lines = (this.reviewOf(subject)?.files ?? []).reduce((n, f) => n + f.added + f.removed, 0)
    if (asked && efforts.includes(asked as Effort)) return { level: asked as Effort, auto: false, lines }
    return { level: effortFor(lines), auto: true, lines }
  }

  async askDebrief(login: string, cardId: string, agentId?: string, effort?: string) {
    const subject = this.subject(cardId)
    if (subject.kind === 'card' ? !debriefable(subject.card.stage) : !openSet(subject.set)) throw new Refused(subject.kind === 'card' ? 'A debrief is for a card being built or in review.' : 'A debrief is for a change set that hasn’t shipped.')
    const before = subject.debrief
    // One at a time, unless the agent went quiet on it for half an hour.
    const pending = before && (before.state === 'asked' || before.state === 'writing') && Date.now() - Date.parse(before.askedAt) < 30 * 60_000
    if (pending) throw new Refused(`${this.hub.state.agents.find((a) => a.id === before.agentId)?.name ?? 'An agent'} is already writing its debrief.`)
    const may = (a: Agent) => !a.revoked && worksIn(a, subject.binderId, this.hub.state.binders)
    const own = new Set(subject.cards.map((c) => c.agentId).filter(Boolean))
    let agent: Agent | undefined
    if (agentId) {
      agent = this.agent(agentId)
      if (!may(agent)) throw new Refused(`${agent.name} doesn’t work in this binder.`)
    } else {
      const presence = this.hub.presence()
      const busy = new Set(this.hub.state.cards.filter((c) => c.stage === 'working' && c.agentId).map((c) => c.agentId))
      const free = this.hub.state.agents.filter((a) => may(a) && presence[a.id]?.listening && !busy.has(a.id))
      const all = this.hub.state.agents.filter(may)
      agent = free.find((a) => own.has(a.id)) ?? free[0] ?? all.find((a) => own.has(a.id)) ?? all[0]
      if (!agent) throw new Refused('No agent works in this binder to write its debrief: set one up in Agents.')
    }
    const at = this.now()
    const reasoning = this.effortOf(subject, effort)
    const debrief: Debrief = { ...before, state: 'asked', askedBy: login, askedAt: at, agentId: agent.id, effort: reasoning, doing: undefined, failed: undefined, since: undefined }
    await this.keep(subject, { kind: 'user', login }, { debrief: tidy(debrief) }, { at, by: login, kind: 'debrief', text: `Asked ${agent.name} for a debrief, at ${reasoningText(reasoning)}` })
    return this.exact(subject.id).debrief!
  }

  /** A debrief as kept (a card's change set's, once it's in one), with the words to say it aloud. */
  debriefOf(cardId: string) {
    const subject = this.subject(cardId)
    const debrief = subject.debrief ?? (subject.kind === 'set' && cardId !== subject.id ? this.card(cardId).debrief : undefined)
    if (!debrief) throw new Refused('There’s no debrief yet.')
    const agent = this.hub.state.agents.find((a) => a.id === debrief.agentId)?.name ?? 'An agent'
    return { ...debrief, speech: debriefSpeech(debrief, { title: subject.title, agent }) }
  }

  protected debriefing(agentId: string, id: string) {
    // Named by one of its cards, a change set's debrief is still the set's.
    const named = this.exact(id)
    const waits = (s: Subject) => s.debrief?.agentId === agentId && (s.debrief.state === 'asked' || s.debrief.state === 'writing')
    const subject = !waits(named) && named.kind === 'card' && this.subject(id).kind === 'set' && waits(this.subject(id)) ? this.subject(id) : named
    const debrief = subject.debrief
    if (!debrief || debrief.agentId !== agentId || (debrief.state !== 'asked' && debrief.state !== 'writing')) throw new Refused('No debrief of that is waiting for you.')
    return { subject, debrief }
  }

  /** The agent writing a debrief: what it's doing meanwhile, that it couldn't, or the debrief itself. */
  /**
   * What a debrief's writer has added so far, area by area and point by point as it reads the change set a file at a
   * time, so no one answer has to hold it all (a model's output limit). Kept until it sends the debrief, which takes
   * them in.
   */
  protected debriefDrafts = new Map<string, { changes: { area: string; what: string }[]; against: DebriefPoint[]; lookAt: string[] }>()

  async addToDebrief(agentId: string, cardId: string, part: { changes?: { area: string; what: string }[]; against?: DebriefPoint[]; lookAt?: string[] }) {
    const { subject, debrief } = this.debriefing(agentId, cardId)
    const key = `${agentId}:${subject.id}`
    const draft = this.debriefDrafts.get(key) ?? { changes: [], against: [], lookAt: [] }
    draft.changes.push(...(part.changes ?? []).map((c) => ({ area: c.area.trim().slice(0, 120), what: c.what.trim().slice(0, 2000) })).filter((c) => c.area && c.what))
    // A point marked again is marked as it says now.
    for (const p of part.against ?? []) {
      const point = { point: p.point.trim().slice(0, 500), mark: p.mark, where: p.where.trim().slice(0, 1000) }
      const at = draft.against.findIndex((q) => same(q.point, point.point))
      if (at >= 0) draft.against[at] = point
      else if (point.point) draft.against.push(point)
    }
    draft.lookAt.push(...(part.lookAt ?? []).map((l) => l.trim().slice(0, 1000)).filter(Boolean))
    draft.changes = draft.changes.slice(0, 40)
    draft.lookAt = draft.lookAt.slice(0, 40)
    this.debriefDrafts.set(key, draft)
    const doing = `Writing: ${draft.changes.length} area${draft.changes.length === 1 ? '' : 's'}, ${draft.against.length} point${draft.against.length === 1 ? '' : 's'} so far`
    await this.keep(subject, { kind: 'agent', id: agentId }, { debrief: tidy<Debrief>({ ...debrief, state: 'writing', doing }) })
    return draft
  }

  async sendDebrief(agentId: string, cardId: string, sent: { doing?: string; failed?: string; does?: string; changes?: { area: string; what: string }[]; against?: DebriefPoint[]; lookAt?: string[]; tryIt?: string; since?: string }) {
    const { subject, debrief } = this.debriefing(agentId, cardId)
    const actor: Actor = { kind: 'agent', id: agentId }
    const at = this.now()
    const draftKey = `${agentId}:${subject.id}`
    if (sent.failed !== undefined) {
      this.debriefDrafts.delete(draftKey)
      const why = sent.failed.trim().slice(0, 1000) || 'It stopped without one.'
      await this.keep(subject, actor, { debrief: tidy<Debrief>({ ...debrief, state: 'failed', doing: undefined, failed: why }) }, { at, by: agentId, kind: 'debrief', text: `Couldn’t write the debrief: ${why}` })
      return this.exact(subject.id).debrief!
    }
    const writing = [sent.does, sent.changes, sent.against, sent.lookAt, sent.tryIt].every((part) => part === undefined)
    if (writing) {
      const doing = sent.doing?.trim().slice(0, 200)
      if (debrief.state === 'writing' && debrief.doing === doing) return debrief
      await this.keep(subject, actor, { debrief: tidy<Debrief>({ ...debrief, state: 'writing', doing }) })
      return this.exact(subject.id).debrief!
    }
    // What it added as it went, then what it sends now: a point marked in both, as it says now.
    const draft = this.debriefDrafts.get(draftKey)
    if (draft) {
      const sentPoints = sent.against ?? []
      sent = {
        ...sent,
        changes: [...draft.changes, ...(sent.changes ?? [])],
        against: [...draft.against.filter((p) => !sentPoints.some((q) => same(q.point, p.point))), ...sentPoints],
        lookAt: sent.lookAt || draft.lookAt.length ? [...draft.lookAt, ...(sent.lookAt ?? [])] : undefined,
      }
    }
    // All five sections, and a mark for every done-when point, or it goes back to the agent to finish.
    const missing: string[] = []
    const does = sent.does?.trim() ?? ''
    if (!does) missing.push('does (what it does)')
    const changes = (sent.changes ?? []).map((c) => ({ area: c.area.trim().slice(0, 120), what: c.what.trim().slice(0, 2000) })).filter((c) => c.area && c.what).slice(0, 40)
    if (!changes.length) missing.push('changes (what changed, by area)')
    const review = this.reviewOf(subject)
    const points = doneWhenPoints(review?.doneWhen ?? '')
    const given = (sent.against ?? []).map((p) => ({ point: p.point.trim().slice(0, 500), mark: p.mark, where: p.where.trim().slice(0, 1000) }))
    let against: DebriefPoint[]
    if (points.length) {
      // Each point's mark found by its words, else by its place when every point has one.
      const byWords = points.map((point) => given.find((g) => same(g.point, point)))
      const byPlace = given.length === points.length
      const marked = points.map((_, i) => byWords[i] ?? (byPlace ? given[i] : undefined))
      const unmarked = points.filter((_, i) => !marked[i])
      if (unmarked.length) missing.push(`against: a mark for each done-when point (none yet for ${unmarked.map((p) => `“${p.slice(0, 60)}”`).join(', ')})`)
      // The card's own words for each point, whatever the agent wrote for it.
      against = points.map((point, i) => ({ point, mark: marked[i]?.mark ?? 'not met', where: marked[i]?.where ?? '' }))
    } else {
      against = given.filter((p) => p.point).slice(0, 30)
      if (!against.length) missing.push('against (the card has no done-when: mark the brief’s points)')
    }
    const tryIt = sent.tryIt?.trim() ?? ''
    if (!tryIt) missing.push('try_it (how to try it)')
    if (sent.lookAt === undefined) missing.push('look_at (an empty list if nothing stands out)')
    if (missing.length) throw new Refused(`The debrief needs ${missing.join('; ')}.`)
    const lookAt = sent.lookAt!.map((l) => l.trim().slice(0, 1000)).filter(Boolean).slice(0, 40)
    // Written again with new commits on the pull request (any of a change set's): it starts with what they changed.
    const pull = subject.kind === 'card' ? pullOf(this.hub.state, subject.card) : subject.set.prIds.length === 1 ? this.hub.state.pulls.find((p) => p.id === subject.set.prIds[0]) : undefined
    const head = subject.kind === 'set' ? (await this.setReview(subject.id)).head : pull ? (pull.head ?? await this.readHead(pull)) : undefined
    const moved = outOfDate(debrief, head)
    const said = sent.since?.trim() ?? ''
    if (moved && !said) throw new Refused('The pull request has new commits since its last debrief: the debrief needs since (what the new commits changed, since the last debrief).')
    const gap = moved && pull ? await this.compareGap(pull.repo, moved.from, moved.to) : undefined
    const since: DebriefSince | undefined = moved ? { from: moved.from, to: moved.to, what: said.slice(0, 2000), commits: (gap?.commits ?? []).slice(0, 50), ...(gap?.files ? { files: gap.files } : {}) } : undefined
    // The comment it's kept in on GitHub stays, to be edited with this writing.
    this.debriefDrafts.delete(draftKey)
    const done: Debrief = { state: 'done', askedBy: debrief.askedBy, askedAt: debrief.askedAt, effort: debrief.effort, agentId, writtenAt: at, head, source: review?.source, does: does.slice(0, 2000), changes, against, lookAt, tryIt: tryIt.slice(0, 2000), since, comment: debrief.comment }
    await this.keep(subject, actor, { debrief: tidy(done) }, { at, by: agentId, kind: 'debrief', text: `Wrote the debrief: ${against.filter((p) => p.mark === 'met').length} of ${against.length} met${since ? `, on ${since.commits.length} new commit${since.commits.length === 1 ? '' : 's'} since the last` : ''}` })
    // A change set's debrief also goes on each of its cards, and so on each one's issue, in the comment it had there.
    if (subject.kind === 'set') {
      await this.hub.recordAll(actor, subject.cards.map((card): Change => ({ type: 'card.update', id: card.id, fields: { debrief: tidy<Debrief>({ ...done, comment: card.debrief?.comment, fromSet: subject.id }) } })))
    }
    return this.exact(subject.id).debrief!
  }
}
