import { randomUUID } from 'node:crypto'
import type { Change } from '../../../shared/state.ts'
import { titleOf } from '../../../shared/notes.ts'
import { checkTimeZone, describeCron, parseCron, type Schedule } from '../../../shared/schedule.ts'
import { parseDiff } from '../../../shared/changeSet.ts'
import { agentNamed, worksIn, type Agent, type Card, type PlanStep, type Stage, type PullRequest } from '../../../shared/work.ts'
import { parsePullRef } from '../github.ts'
import { Refused, type Actor } from '../hub.ts'
import { ActionsBase, checkedRunner } from './base.ts'

// What people and agents do to a card, and the agents people set up.

export abstract class CardService extends ActionsBase {
  /** In change sets: finishing a card brings its pull request in. */
  abstract linkPull(repo: string, number: number, link: { cardId?: string; agentId?: string }): Promise<PullRequest>

  // People ---------------------------------------------------------------------------------------------------------

  async createCard(actor: Actor, fields: { binderId: string; title: string; brief?: string; doneWhen?: string; size?: Card['size']; stage?: Stage; noteId?: string; quote?: string; meantFor?: string; waitsFor?: string[]; scheduleId?: string }) {
    if (!this.hub.state.binders.some((b) => b.id === fields.binderId)) throw new Refused(`No binder ${fields.binderId}.`)
    if (!fields.title.trim()) throw new Refused('A card needs a title.')
    const at = this.now()
    const by = actor.kind === 'user' ? actor.login : actor.kind === 'agent' ? actor.id : 'hub'
    const waitsFor = this.waitsForIn(fields.binderId, fields.waitsFor ?? [])
    const card: Card = {
      id: `card-${randomUUID().slice(0, 8)}`,
      binderId: fields.binderId,
      title: fields.title.trim().slice(0, 200),
      brief: fields.brief?.trim() ?? '',
      doneWhen: fields.doneWhen?.trim() ?? '',
      size: fields.size ?? 'M',
      // What an agent only suggests waits for a person; a person's card is ready at once.
      stage: fields.stage ?? (actor.kind === 'agent' ? 'proposed' : 'ready'),
      createdAt: at,
      createdBy: by,
      updatedAt: at,
      noteId: fields.noteId,
      quote: fields.quote,
      meantFor: fields.meantFor,
      waitsFor,
      ...(fields.scheduleId ? { scheduleId: fields.scheduleId } : {}),
      activity: [{ at, by, kind: 'created', text: fields.scheduleId ? 'Put it on the board: a scheduled run of its note' : actor.kind === 'agent' ? 'Suggested it' : 'Put it on the board' }],
    }
    const changes: Change[] = [{ type: 'card.put', card }]
    if (card.noteId && card.quote) changes.push({ type: 'note.link', id: card.noteId, link: { itemId: card.id, quote: card.quote } })
    await this.hub.recordAll(actor, changes)
    return card
  }

  /** A schedule's fields checked: its note, its agent, its cron and its time zone. */
  protected scheduleFields(fields: { noteId?: string; agentId?: string; cron?: string; tz?: string }) {
    if (fields.noteId !== undefined && !this.hub.state.notes.some((n) => n.id === fields.noteId)) throw new Refused(`No note ${fields.noteId}.`)
    if (fields.agentId && !this.hub.state.agents.some((a) => a.id === fields.agentId && !a.revoked)) throw new Refused(`No agent ${fields.agentId}.`)
    try {
      if (fields.cron !== undefined) parseCron(fields.cron)
      if (fields.tz !== undefined) checkTimeZone(fields.tz)
    } catch (error) {
      throw new Refused((error as Error).message)
    }
  }

  /** A note run as a card on a timer. */
  async addSchedule(login: string, fields: { noteId: string; agentId?: string; cron: string; tz: string; enabled?: boolean }) {
    this.scheduleFields(fields)
    const note = this.hub.state.notes.find((n) => n.id === fields.noteId)!
    const schedule: Schedule = { id: `schedule-${randomUUID().slice(0, 8)}`, noteId: note.id, binderId: note.binderId, ...(fields.agentId ? { agentId: fields.agentId } : {}), cron: fields.cron.trim(), tz: fields.tz, enabled: fields.enabled ?? true, createdAt: this.now(), createdBy: login }
    await this.hub.record({ kind: 'user', login }, { type: 'schedule.put', schedule })
    return schedule
  }

  async updateSchedule(login: string, id: string, fields: { agentId?: string | null; cron?: string; tz?: string; enabled?: boolean }) {
    if (!(this.hub.state.schedules ?? []).some((x) => x.id === id)) throw new Refused(`No schedule ${id}.`)
    this.scheduleFields({ agentId: fields.agentId ?? undefined, cron: fields.cron, tz: fields.tz })
    const next: Partial<Schedule> = {}
    if (fields.agentId !== undefined) next.agentId = fields.agentId || undefined
    if (fields.cron !== undefined) next.cron = fields.cron.trim()
    if (fields.tz !== undefined) next.tz = fields.tz
    if (fields.enabled !== undefined) next.enabled = fields.enabled
    // Turned on again or retimed: it counts from now, so it doesn't fire at once for times it was off.
    if (fields.enabled || fields.cron !== undefined || fields.tz !== undefined) next.lastRun = this.now()
    await this.hub.record({ kind: 'user', login }, { type: 'schedule.update', id, fields: next })
    return (this.hub.state.schedules ?? []).find((x) => x.id === id)
  }

  async deleteSchedule(login: string, id: string) {
    if (!(this.hub.state.schedules ?? []).some((x) => x.id === id)) throw new Refused(`No schedule ${id}.`)
    await this.hub.record({ kind: 'user', login }, { type: 'schedule.delete', id })
    return { ok: true }
  }

  /**
   * A schedule fires: a card from its note, the note's words as they are now its brief, for its agent. On the timer,
   * a run whose last card isn't done yet is skipped, so runs don't pile up behind a slow or stuck one. Run by a person
   * ("Run now"), it goes regardless.
   */
  async runSchedule(id: string, by?: string) {
    const schedule = (this.hub.state.schedules ?? []).find((x) => x.id === id)
    if (!schedule) throw new Refused(`No schedule ${id}.`)
    const actor: Actor = by ? { kind: 'user', login: by } : { kind: 'hub' }
    const at = this.now()
    const note = this.hub.state.notes.find((n) => n.id === schedule.noteId)
    if (!note) {
      await this.hub.record(actor, { type: 'schedule.update', id, fields: { enabled: false, lastRun: at, lastSkipped: 'Its note is gone, so it’s off.' } })
      return undefined
    }
    const last = schedule.lastCardId ? this.hub.state.cards.find((c) => c.id === schedule.lastCardId) : undefined
    if (!by && last && last.stage !== 'live') {
      await this.hub.record(actor, { type: 'schedule.update', id, fields: { lastRun: at, lastSkipped: `Skipped: the last run (“${last.title}”) isn’t done yet.` } })
      return undefined
    }
    const title = titleOf(note.text) || note.title
    const day = new Date(at).toLocaleDateString('en-US', { timeZone: schedule.tz, month: 'short', day: 'numeric' })
    const card = await this.createCard(actor, {
      binderId: note.binderId,
      title: `${title} · ${day}`,
      brief: `A scheduled run (${describeCron(schedule.cron).toLowerCase()}, ${schedule.tz}) of the note “${title}”. The note, as it was when this run started, is your instructions:\n\n---\n\n${note.text.slice(0, 20_000)}`,
      doneWhen: 'What the note asks for is done, as it says. If it asks for no change to the code, say what you found and finish without a pull request.',
      stage: 'ready',
      noteId: note.id,
      meantFor: schedule.agentId,
      scheduleId: schedule.id,
    })
    await this.hub.record(actor, { type: 'schedule.update', id, fields: { lastRun: at, lastCardId: card.id, lastSkipped: undefined } })
    return card
  }

  /**
   * The cards a new card waits for, as ids: named by id, by issue number (#226) or by title, in its binder. One that
   * names no card is refused, rather than kept as a wait that nothing can ever end.
   */
  private waitsForIn(binderId: string, named: string[]) {
    const cards = this.hub.state.cards
    const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase()
    return [...new Set(named.map((name) => {
      const found = cards.find((c) => c.id === name.trim())
        ?? cards.find((c) => c.binderId === binderId && c.issue && `#${c.issue.number}` === name.trim().replace(/^issue\s*/i, ''))
        ?? cards.find((c) => c.binderId === binderId && same(c.title, name))
      if (!found) throw new Refused(`It waits for “${name.slice(0, 80)}”, which isn’t a card on this board: name each card it waits for by its id, its issue (#226) or its exact title.`)
      return found.id
    }))]
  }

  /** A proposal from Distill, accepted: it becomes a card, and its note marks the words it came from. */
  async acceptProposal(actor: Actor, id: string) {
    const proposal = this.hub.state.proposals.find((p) => p.id === id)
    if (!proposal) throw new Refused(`No proposal ${id}.`)
    if (proposal.state !== 'new') throw new Refused('That proposal was already accepted or dismissed.')
    const card = await this.createCard(actor, { binderId: proposal.binderId, title: proposal.title, brief: proposal.brief, doneWhen: proposal.doneWhen, size: proposal.size, stage: 'ready', noteId: proposal.noteId, quote: proposal.quote, meantFor: proposal.meantFor })
    await this.hub.record(actor, { type: 'proposal.update', id, fields: { state: 'accepted', cardId: card.id } })
    return card
  }

  /** A person's answer to an agent's question, or a comment. */
  async comment(login: string, cardId: string, text: string) {
    const card = this.card(cardId)
    const answering = !!card.needsYou
    // A person writing on a card an agent holds, blocked, unblocks it: the agent carries on with what they wrote.
    const unblock = card.stage === 'blocked' && !!card.agentId
    await this.hub.record({ kind: 'user', login }, { type: 'card.update', id: card.id, fields: { needsYou: undefined, ...(unblock ? { stage: 'working' as const } : {}) }, activity: { at: this.now(), by: login, kind: answering ? 'answer' : 'comment', text } })
  }

  /** A person's message to an agent about a note: one chat for each note and agent. */
  async say(login: string, noteId: string, agentId: string, text: string) {
    const note = this.hub.state.notes.find((n) => n.id === noteId)
    if (!note) throw new Refused('That note is gone.')
    const agent = this.agent(agentId)
    if (!worksIn(agent, note.binderId, this.hub.state.binders)) throw new Refused(`${agent.name} doesn’t work in this note’s binder.`)
    const words = text.trim().slice(0, 8000)
    if (!words) throw new Refused('Say something first.')
    const id = `chat-${noteId}-${agentId}`
    await this.hub.record({ kind: 'user', login }, { type: 'chat.say', id, noteId, agentId, message: { at: this.now(), by: login, text: words } })
    return { id }
  }

  // Agents ---------------------------------------------------------------------------------------------------------

  async claim(agentId: string, cardId: string) {
    const agent = this.agent(agentId)
    const before = this.card(cardId)
    if (before.agentId === agent.id && before.stage === 'working') return before
    if (!before.agentId && this.hub.state.cards.some((c) => c.parent === cardId)) throw new Refused('That card is split into parts: take one of them.')
    if (before.stage === 'ready' && !before.agentId) await this.mayWorkOn(agent, before)
    await this.hub.record({ kind: 'agent', id: agent.id }, { type: 'card.claim', id: cardId, agentId: agent.id, at: this.now() })
    const after = this.card(cardId)
    // The log decided: someone else's claim may have come first.
    if (after.agentId !== agent.id) {
      throw new Refused(after.agentId ? 'Another agent took that card first.' : after.meantFor && after.meantFor !== agent.id ? 'That card is meant for another agent.' : after.stage !== 'ready' ? `That card isn’t ready to take (it’s ${after.stage}).` : 'That card couldn’t be taken.')
    }
    return after
  }

  async progress(agentId: string, cardId: string, report: { doing?: string; progress?: number; plan?: PlanStep[]; steps?: { tool?: string; text: string; result?: string }[]; said?: string; cost?: number; minutes?: number; tokens?: number }) {
    const card = this.held(agentId, cardId)
    const at = this.now()
    const fields: Partial<Card> = {}
    if (report.doing !== undefined) fields.doing = report.doing.slice(0, 200)
    if (report.progress !== undefined) fields.progress = Math.max(0, Math.min(1, report.progress))
    if (report.plan) fields.plan = report.plan.slice(0, 40).map((p) => ({ text: p.text.slice(0, 200), done: !!p.done }))
    // A run's cost, time and tokens add to the card's: a card may take several runs.
    if (report.cost !== undefined) fields.cost = (card.cost ?? 0) + report.cost
    if (report.minutes !== undefined) fields.minutes = (card.minutes ?? 0) + report.minutes
    if (report.tokens !== undefined) fields.tokens = (card.tokens ?? 0) + report.tokens
    const changes: Change[] = [{ type: 'card.update', id: card.id, fields }]
    for (const step of report.steps?.slice(0, 50) ?? []) {
      changes.push({ type: 'card.activity', id: card.id, activity: { at, by: agentId, kind: 'step', tool: step.tool, text: step.text.slice(0, 500), result: step.result?.slice(0, 500) } })
    }
    if (report.said) changes.push({ type: 'card.activity', id: card.id, activity: { at, by: agentId, kind: 'said', text: report.said.slice(0, 2000) } })
    // When it was used, for the day's totals on Home.
    if (report.tokens !== undefined || report.cost !== undefined) {
      const used = [report.tokens !== undefined && `${report.tokens.toLocaleString('en')} tokens`, report.cost !== undefined && `$${report.cost.toFixed(2)}`, report.minutes !== undefined && `${report.minutes} min`].filter(Boolean).join(' · ')
      changes.push({ type: 'card.activity', id: card.id, activity: { at, by: agentId, kind: 'ran', text: `A run ended: ${used}`, tokens: report.tokens, cost: report.cost } })
    }
    await this.hub.recordAll({ kind: 'agent', id: agentId }, changes)
    await this.seen(agentId)
    return this.card(card.id)
  }

  /** The diff of a card's worktree, from its runner: kept on the card until the work has a pull request. */
  async reportDiff(agentId: string, cardId: string, report: { branch: string; base: string; diff: string }) {
    const card = this.held(agentId, cardId)
    const { files, cut } = parseDiff(report.diff)
    const was = card.worktree
    // The same diff again changes nothing, so the log doesn't grow while an agent reads.
    if (was && was.branch === report.branch && was.base === report.base && !!was.cut === cut && JSON.stringify(was.files) === JSON.stringify(files)) return was
    const worktree = { branch: report.branch.slice(0, 200), base: report.base.slice(0, 80), files, at: this.now(), ...(cut ? { cut } : {}) }
    await this.hub.record({ kind: 'agent', id: agentId }, { type: 'card.update', id: card.id, fields: { worktree } })
    return worktree
  }

  async ask(agentId: string, cardId: string, question: string) {
    const card = this.held(agentId, cardId)
    // Waiting on a person: blocked until they answer.
    await this.hub.record({ kind: 'agent', id: agentId }, { type: 'card.update', id: card.id, fields: { needsYou: question.slice(0, 1000), ...(card.stage === 'working' ? { stage: 'blocked' as const } : {}) }, activity: { at: this.now(), by: agentId, kind: 'question', text: question.slice(0, 2000) } })
  }

  async agentComment(agentId: string, cardId: string, text: string) {
    this.card(cardId)
    await this.hub.record({ kind: 'agent', id: agentId }, { type: 'card.activity', id: cardId, activity: { at: this.now(), by: agentId, kind: 'comment', text: text.slice(0, 4000) } })
  }

  async release(agentId: string, cardId: string, why: string) {
    this.held(agentId, cardId)
    // Not offered to it again for a while: a runner that can't start it (no worktree, no tool) would take it and give
    // it back every few seconds, filling the card's activity.
    this.turnedAway.set(`${agentId}/${cardId}`, Date.now() + 5 * 60_000)
    await this.hub.record({ kind: 'agent', id: agentId }, { type: 'card.release', id: cardId, agentId, at: this.now(), why: why.slice(0, 1000) || 'Let it go' })
  }

  /** Finished: with a pull request, the card goes to review and its pull request into a change set; without, it's done. */
  async complete(agentId: string, cardId: string, summary: string, pullRef?: string) {
    const card = this.held(agentId, cardId)
    const at = this.now()
    const actor: Actor = { kind: 'agent', id: agentId }
    // Finished: so is its plan.
    const plan = card.plan?.map((step) => ({ ...step, done: true }))
    if (!pullRef) {
      await this.hub.record(actor, { type: 'card.update', id: card.id, fields: { stage: 'live', doing: undefined, progress: 1, plan }, activity: { at, by: agentId, kind: 'completed', text: summary.slice(0, 4000) } })
      return this.card(card.id)
    }
    const ref = parsePullRef(pullRef)
    if (!ref) throw new Refused('Give the pull request as owner/repo#12 or its address on GitHub.')
    const pull = await this.linkPull(ref.repo, ref.number, { cardId: card.id, agentId })
    await this.hub.record(actor, { type: 'card.update', id: card.id, fields: { stage: 'review', prId: pull.id, doing: undefined, progress: 1, plan }, activity: { at, by: agentId, kind: 'completed', text: summary.slice(0, 4000) } })
    await this.hub.record(actor, { type: 'card.activity', id: card.id, activity: { at, by: agentId, kind: 'pr', text: `Opened ${pull.repo.split('/')[1]}#${pull.number}` } })
    return this.card(card.id)
  }

  /** The agent called: live presence at once; the log hears of it only now and then, for "last seen". */
  async seen(agentId: string) {
    this.hub.touch(agentId)
    const agent = this.hub.state.agents.find((a) => a.id === agentId)
    if (agent && (!agent.lastSeen || Date.now() - Date.parse(agent.lastSeen) > 30 * 60_000)) await this.hub.record({ kind: 'hub' }, { type: 'agent.seen', id: agentId, at: this.now() })
  }

  /** Asks an agent's runners to restart, on the newest runner: what they're running stops and goes back on the board. */
  async restartRunner(login: string, agentId: string) {
    const agent = this.agent(agentId)
    const restartAsked = { at: this.now(), by: login }
    await this.hub.record({ kind: 'user', login }, { type: 'agent.put', agent: { ...agent, restartAsked } })
    return { restartAsked }
  }

  // Agents set up by people ------------------------------------------------------------------------------------------

  async putAgent(login: string, fields: Partial<Agent> & { name: string }, id?: string, by: Actor = { kind: 'user', login }) {
    const existing = id ? this.hub.state.agents.find((a) => a.id === id) : undefined
    if (id && !existing) throw new Refused(`No agent ${id}.`)
    if (!fields.name.trim()) throw new Refused('An agent needs a name.')
    // Names are how people and agents hand out work, without regard to capitals: two that differ only by them can't be told apart.
    const twin = this.hub.state.agents.find((a) => !a.revoked && a.id !== existing?.id && a.name.toLowerCase() === fields.name.trim().toLowerCase())
    if (twin && existing?.name.toLowerCase() !== fields.name.trim().toLowerCase()) throw new Refused(`There’s an agent called ${twin.name} already.`)
    const agent: Agent = {
      runner: fields.runner ? checkedRunner(fields.runner) : existing?.runner,
      id: existing?.id ?? `agent-${randomUUID().slice(0, 8)}`,
      name: fields.name.trim().slice(0, 80),
      provider: fields.provider ?? existing?.provider ?? 'other',
      owner: existing?.owner ?? login,
      repos: (fields.repos ?? existing?.repos ?? []).map((r) => r.trim()).filter(Boolean),
      binders: fields.binders ?? existing?.binders ?? [],
      skills: (fields.skills ?? existing?.skills ?? []).map((s) => s.trim()).filter(Boolean).slice(0, 30),
      runsOn: fields.runsOn ?? existing?.runsOn,
      createdAt: existing?.createdAt ?? this.now(),
      lastSeen: existing?.lastSeen,
      // Found for the tool it ran; another tool's runner lists its own.
      models: fields.runner && fields.runner.tool !== existing?.runner?.tool ? undefined : existing?.models,
      toolModels: existing?.toolModels,
      runnerSeen: existing?.runnerSeen,
      restartAsked: existing?.restartAsked,
    }
    // The hub's admins' choice of who commits, when they made one, is what's kept, whatever the form sent.
    const fixed = this.agentCommits()
    if (fixed !== 'agent' && agent.runner) {
      agent.runner = { ...agent.runner }
      if (fixed === 'app') agent.runner.commitAs = 'app'
      else delete agent.runner.commitAs
    }
    if (!agent.restartAsked) delete agent.restartAsked
    if (!agent.toolModels) delete agent.toolModels
    if (!agent.runnerSeen) delete agent.runnerSeen
    if (!agent.models) delete agent.models
    await this.hub.record(by, { type: 'agent.put', agent })
    return agent
  }

  /**
   * Splits a card into parts, for a swarm of agents: each part a card of its own, meant for the agent it names, and
   * the card waiting for every part: no agent is offered the whole while it has parts, and when the last part is live
   * the card is too (watchSwarm). Each part carries the card's brief, its note, and whatever the card was waiting for.
   */
  async splitCard(login: string, id: string, parts: { title: string; brief?: string; agent?: string }[]) {
    const card = this.hub.state.cards.find((c) => c.id === id)
    if (!card) throw new Refused(`No card ${id}.`)
    if (card.parent) throw new Refused('A part of a swarm can’t be split again: split the card it came from.')
    if (this.hub.state.cards.some((c) => c.parent === id)) throw new Refused('It has parts already.')
    // A card held, in review or not yet accepted has someone answering for the whole: parts would race them, and the
    // card would have no way of finishing when they did.
    if (card.stage !== 'ready' || card.agentId) throw new Refused('Only a card that’s ready, and that no agent holds, can be split.')
    const clean = parts.map((p) => ({ title: (p.title ?? '').trim(), brief: p.brief?.trim(), agent: p.agent?.trim() })).filter((p) => p.title)
    if (clean.length < 2) throw new Refused('A swarm is at least two parts, each with a title.')
    if (clean.length > 12) throw new Refused('Twelve parts at most: split one of them again instead.')
    for (const part of clean) if (part.agent && !agentNamed(this.hub.state.agents, part.agent)) throw new Refused(`No agent ${part.agent}.`)
    const at = this.now()
    const whole = [card.brief, card.doneWhen && `Done when, for all of it: ${card.doneWhen}`].filter(Boolean).join('\n\n')
    const made = clean.map((part, index) => {
      const meant = part.agent ? agentNamed(this.hub.state.agents, part.agent)?.id : undefined
      return {
        id: `card-${randomUUID().slice(0, 8)}`,
        binderId: card.binderId,
        title: part.title.slice(0, 200),
        brief: [part.brief, `This is part of “${card.title}”.`, whole].filter(Boolean).join('\n\n'),
        doneWhen: '',
        size: card.size,
        stage: 'ready' as const,
        createdAt: at,
        createdBy: login,
        updatedAt: at,
        meantFor: meant,
        parent: card.id,
        noteId: card.noteId,
        quote: card.quote,
        waitsFor: [...card.waitsFor],
        activity: [{ at, by: login, kind: 'created' as const, text: `Part ${index + 1} of ${clean.length}, split from “${card.title}”` }],
      } satisfies Card
    })
    await this.hub.recordAll({ kind: 'user', login }, [
      ...made.map((part): Change => ({ type: 'card.put', card: part })),
      { type: 'card.update', id: card.id, fields: { waitsFor: [...card.waitsFor, ...made.map((p) => p.id)] }, activity: { at, by: login, kind: 'moved', text: `Split into ${made.length} parts` } },
    ])
    return made
  }

  /** Follows swarms: when the last part of a card is live, or the last that wasn't is deleted, and nobody holds the card, it's live too. */
  watchSwarm() {
    const finishing = new Set<string>()
    this.hub.on('entries', (entries) => {
      if (!entries.some(({ change }) => change.type === 'card.delete' || (change.type === 'card.update' && 'stage' in change.fields))) return
      const cards = this.hub.state.cards
      for (const parentId of new Set(cards.flatMap((c) => (c.parent ? [c.parent] : [])))) {
        const parent = cards.find((c) => c.id === parentId)
        if (!parent || parent.stage !== 'ready' || parent.agentId || finishing.has(parentId)) continue
        const parts = cards.filter((c) => c.parent === parentId)
        if (!parts.every((p) => p.stage === 'live')) continue
        finishing.add(parentId)
        void this.hub.record({ kind: 'hub' }, {
          type: 'card.update', id: parent.id, fields: { stage: 'live' },
          activity: { at: this.now(), by: 'hub', kind: 'moved', text: `Every part is live: ${parts.length} parts` },
        }).catch(() => undefined).finally(() => finishing.delete(parentId))
      }
    })
  }
}
