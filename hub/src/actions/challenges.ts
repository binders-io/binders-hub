import type { Change } from '../../../shared/state.ts'
import { findingCard, authorOf, authorsOf, byWorst, type BlastRadius, cardsOfSet, setOfCard, setPath, challengeable, confidences, findingComment, findingKinds, findingWhere, pullOf, repliable, replying, replyVerdicts, severities, type Challenge, type Finding, type FindingOutcome, type ReplyRound, type ReplyVerdict } from '../../../shared/changeSet.ts'
import { worksIn, type Agent, type Card } from '../../../shared/work.ts'
import { Refused, type Actor } from '../hub.ts'
import { DebriefService } from './debriefs.ts'
import { keptBlast, openSet, reasoningText, maxFindings, tidy, type Subject } from './base.ts'

// A Challenge: an agent that didn't write the work finds what's wrong with it, and its author answers.

export abstract class ChallengeService extends DebriefService {
  /**
   * A person asks for a Challenge: an adversarial review by an agent that didn't write the work, of a card's whole change
   * set once it's in one (all its pull requests together, so what goes wrong between them shows), or of the card alone
   * while it's being built. It goes to the agent they name, if that agent wrote none of it, or else to one the hub
   * picks: listening and free first, and one that didn't write the debrief (it read the authors' log) before one that
   * did. With none listening, to the first that may work in the project, for when its runner is back.
   */
  async askChallenge(login: string, cardId: string, agentId?: string, effort?: string) {
    const subject = this.subject(cardId)
    if (subject.kind === 'card' ? !challengeable(subject.card.stage) : !openSet(subject.set)) throw new Refused(subject.kind === 'card' ? 'A Challenge is for a card being built or in review.' : 'A Challenge is for a change set that hasn’t shipped.')
    if (this.reviewOf(subject)?.source === 'none') throw new Refused('There’s nothing to challenge yet: no pull request or worktree diff.')
    const name = (id: string) => this.hub.state.agents.find((a) => a.id === id)?.name ?? 'An agent'
    const before = subject.challenge
    // One at a time, unless the reviewer went quiet on it for half an hour.
    const pending = before && (before.state === 'asked' || before.state === 'reviewing') && Date.now() - Date.parse(before.askedAt) < 30 * 60_000
    if (pending) throw new Refused(`${name(before.agentId)} is already challenging it.`)
    const answering = subject.cards.map((c) => c.challenge?.replies).find((round) => replying(round))
    if (answering) throw new Refused(`${name(answering.agentId)} is replying to the last findings: challenge it again once it has.`)
    const authors = [...new Set(subject.cards.flatMap((c) => authorsOf(this.hub.state, c)))]
    const may = (a: Agent) => !a.revoked && worksIn(a, subject.binderId, this.hub.state.binders)
    let agent: Agent | undefined
    // Any agent may review, one that wrote part of it too: it's a model with a reviewer's instructions and a session of
    // its own, and it never sees the authors' plan or log. Left to the hub, one that didn't write it comes first.
    if (agentId) {
      agent = this.agent(agentId)
      if (!may(agent)) throw new Refused(`${agent.name} doesn’t work in this binder.`)
    } else {
      const presence = this.hub.presence()
      const busy = new Set(this.hub.state.cards.filter((c) => c.stage === 'working' && c.agentId).map((c) => c.agentId))
      const candidates = this.hub.state.agents.filter(may)
      const score = (a: Agent) => (authors.includes(a.id) ? 0 : 4) + (presence[a.id]?.listening && !busy.has(a.id) ? 2 : 0) + (subject.debrief?.agentId === a.id ? 0 : 1)
      agent = candidates.map((a, i) => ({ a, i })).sort((x, y) => score(y.a) - score(x.a) || x.i - y.i)[0]?.a
      if (!agent) throw new Refused('No agent works in this binder to challenge it: set one up in Agents.')
    }
    const at = this.now()
    const reasoning = this.effortOf(subject, effort)
    const challenge: Challenge = { ...before, state: 'asked', askedBy: login, askedAt: at, agentId: agent.id, picked: agentId ? 'person' : 'hub', authors, effort: reasoning, doing: undefined, failed: undefined, fromSet: undefined }
    await this.keep(subject, { kind: 'user', login }, { challenge: tidy(challenge) }, { at, by: login, kind: 'challenge', text: `Asked ${agent.name} to challenge it, at ${reasoningText(reasoning)}` })
    return this.exact(subject.id).challenge!
  }

  /** The card or change set, when its Challenge is waiting for this agent or under way. */
  challenging(agentId: string, id: string) {
    const known = this.hub.state.cards.some((c) => c.id === id) || this.hub.state.changeSets.some((s) => s.id === id)
    if (!known) return undefined
    const waits = (s: Subject) => !!s.challenge && s.challenge.agentId === agentId && (s.challenge.state === 'asked' || s.challenge.state === 'reviewing')
    // Named by one of its cards, a change set's Challenge is still the set's.
    const named = this.exact(id)
    const subject = !waits(named) && named.kind === 'card' && waits(this.subject(id)) ? this.subject(id) : named
    return waits(subject) ? { subject, challenge: subject.challenge! } : undefined
  }

  /** Whether this agent is challenging a card, alone or as part of its change set: it then doesn't see the authors' log. */
  reviewing(agentId: string, card: Card) {
    const set = setOfCard(this.hub.state, card)
    return !!this.challenging(agentId, card.id) || (!!set && !!this.challenging(agentId, set.id))
  }

  /** What the reviewer may see: the diff (all a change set's), brief and done-when, not the authors' log. */
  async challengeSet(agentId: string, id: string) {
    const found = this.challenging(agentId, id)
    if (!found) throw new Refused('No Challenge of that is waiting for you.')
    return this.changeSet(found.subject.id)
  }

  /** The reviewer: what it's doing meanwhile, that it couldn't, or its findings (an empty list when it found nothing). */
  /**
   * Findings a reviewer has sent so far, as it goes through the change set a file at a time, so no one answer has to
   * hold them all (a model's output limit). Each is checked as it comes; send_challenge takes them in.
   */
  protected findingDrafts = new Map<string, Omit<Finding, 'id'>[]>()

  async addFindings(agentId: string, cardId: string, findings: Omit<Finding, 'id'>[]) {
    const found = this.challenging(agentId, cardId)
    if (!found) throw new Refused('No Challenge of that is waiting for you.')
    const { subject, challenge } = found
    const key = `${agentId}:${subject.id}`
    const kept = this.findingDrafts.get(key) ?? []
    // Checked now, so a finding missing something goes back at once, numbered as sent.
    this.vetFindings(subject, findings)
    kept.push(...findings)
    if (kept.length > maxFindings) throw new Refused(`That's more than ${maxFindings} findings: send the worst, and say in the summary what else you saw.`)
    this.findingDrafts.set(key, kept)
    await this.keep(subject, { kind: 'agent', id: agentId }, { challenge: tidy<Challenge>({ ...challenge, state: 'reviewing', doing: `Reviewing: ${kept.length} finding${kept.length === 1 ? '' : 's'} so far` }) })
    return kept.length
  }

  /** Findings as kept: each says where, what goes wrong, how sure and how bad, or they all go back to the reviewer. */
  protected vetFindings(subject: Subject, sent: Omit<Finding, 'id'>[]) {
    const set = this.reviewOf(subject)
    const missing: string[] = []
    const paths = new Set(set?.files.map((f) => f.path))
    // A path as `git diff` writes it ("b/src/a.ts") is the diff's own when that's the file it means.
    const pathOf = (file: string) => (!paths.has(file) && /^[ab]\//.test(file) && paths.has(file.slice(2)) ? file.slice(2) : file)
    // A change set's files are named with their pull request ("acme/web#7: src/a.ts"): each finding goes to that one.
    const several = (set?.pulls?.length ?? 0) > 1
    const pulls = new Set(set?.pulls?.map((p) => p.id))
    const findings: Finding[] = sent.map((f, i) => {
      const named = setPath(pathOf((f.file ?? '').trim()))
      const pull = several ? named.pull : set?.pull?.id
      const finding = {
        kind: f.kind, file: (several ? named.path : pathOf((f.file ?? '').trim())).slice(0, 300), line: Math.floor(Number(f.line)), what: (f.what ?? '').trim().slice(0, 3000),
        confidence: f.confidence, severity: f.severity, fix: f.fix?.trim().slice(0, 2000) || undefined, pull,
      }
      if (several && (!pull || !pulls.has(pull))) missing.push(`finding ${i + 1}: file as get_challenge_set names it, with its pull request ("owner/repo#7: path")`)
      const lacks = [
        !findingKinds.includes(finding.kind) && 'kind', !finding.file && 'file', !(finding.line >= 1) && 'line (1 or more)', !finding.what && 'what goes wrong',
        !confidences.includes(finding.confidence) && 'confidence (confirmed or plausible)', !severities.includes(finding.severity) && 'severity (high, medium or low)',
      ].filter(Boolean)
      if (lacks.length) missing.push(`finding ${i + 1}: ${lacks.join(', ')}`)
      return tidy<Finding>({ id: '', ...finding })
    })
    if (missing.length) throw new Refused(`The findings need ${missing.join('; ')}.`)
    return { findings, set }
  }

  async sendChallenge(agentId: string, cardId: string, sent: { doing?: string; failed?: string; summary?: string; findings?: Omit<Finding, 'id'>[]; blast?: BlastRadius }) {
    const found = this.challenging(agentId, cardId)
    if (!found) throw new Refused('No Challenge of that is waiting for you.')
    const { subject, challenge } = found
    const actor: Actor = { kind: 'agent', id: agentId }
    const at = this.now()
    const draftKey = `${agentId}:${subject.id}`
    if (sent.failed !== undefined) {
      this.findingDrafts.delete(draftKey)
      const why = sent.failed.trim().slice(0, 1000) || 'It stopped without findings.'
      await this.keep(subject, actor, { challenge: tidy<Challenge>({ ...challenge, state: 'failed', doing: undefined, failed: why }) }, { at, by: agentId, kind: 'challenge', text: `Couldn’t challenge it: ${why}` })
      return this.exact(subject.id).challenge!
    }
    const added = this.findingDrafts.get(draftKey) ?? []
    // Finished when it sends findings or a summary; doing alone (or nothing) is how it's going.
    if (sent.findings === undefined && sent.summary === undefined) {
      const doing = sent.doing?.trim().slice(0, 200)
      const blast = sent.blast ? keptBlast(sent.blast) : challenge.blast
      if (challenge.state === 'reviewing' && challenge.doing === doing && !sent.blast) return challenge
      await this.keep(subject, actor, { challenge: tidy<Challenge>({ ...challenge, state: 'reviewing', doing, blast }) })
      return this.exact(subject.id).challenge!
    }
    // What it sent as it went, then what it sends now.
    const { findings, set } = this.vetFindings(subject, [...added, ...(sent.findings ?? [])].slice(0, maxFindings))
    this.findingDrafts.delete(draftKey)
    findings.sort(byWorst).forEach((f, i) => (f.id = `f${i + 1}`))
    const summary = sent.summary?.trim().slice(0, 2000) || undefined
    const done: Challenge = { state: 'done', askedBy: challenge.askedBy, askedAt: challenge.askedAt, effort: challenge.effort, agentId, picked: challenge.picked, authors: challenge.authors, reviewedAt: at, source: set?.source, summary, findings, blast: challenge.blast }
    const high = findings.filter((f) => f.severity === 'high').length
    const told = { at, by: agentId, kind: 'challenge' as const, text: findings.length ? `Challenged it: ${findings.length} finding${findings.length === 1 ? '' : 's'}${high ? `, ${high} high` : ''}` : 'Challenged it and found nothing wrong' }
    await this.keep(subject, actor, { challenge: tidy(done) }, told)
    // A change set's findings also go to each pull request's card, so each is sent back, dismissed, made a card of,
    // replied to by its author and posted on its pull request, as a card's own are.
    if (subject.kind === 'set') {
      const copies: Change[] = subject.cards.map((card) => {
        const mine = pullOf(this.hub.state, card)?.id
        return { type: 'card.update', id: card.id, fields: { challenge: tidy<Challenge>({ ...done, findings: findings.filter((f) => f.pull === mine), fromSet: subject.id }) } }
      })
      await this.hub.recordAll(actor, copies)
    }
    return this.exact(subject.id).challenge!
  }

  /**
   * A person asks the author of a card's work to reply to its Challenge's findings: one round, each finding fixed or
   * disagreed with and why. The reviewer isn't sent the replies and no round follows, so it can't loop: only a new
   * Challenge brings findings that can be replied to again.
   */
  async askReplies(login: string, cardId: string) {
    const card = this.card(cardId)
    const challenge = card.challenge
    if (!challenge || challenge.state !== 'done') throw new Refused('There are no findings to reply to: the card’s Challenge isn’t done.')
    if (!challenge.findings?.length) throw new Refused('The Challenge found nothing wrong: there’s nothing to reply to.')
    if (challenge.findings.every((f) => f.outcome?.kind === 'dismissed')) throw new Refused('Every finding was dismissed: there’s nothing to reply to.')
    if (!repliable(challenge)) {
      const name = this.hub.state.agents.find((a) => a.id === challenge.replies!.agentId)?.name ?? 'The author'
      throw new Refused(challenge.replies!.state === 'done' ? `${name} has replied to these findings: there is one round of replies, so it doesn’t loop.` : `${name} is already replying to the findings.`)
    }
    const authorId = authorOf(this.hub.state, card, challenge)
    const author = authorId ? this.hub.state.agents.find((a) => a.id === authorId && !a.revoked) : undefined
    if (!author) throw new Refused('No agent wrote this work, so none can reply to its findings.')
    const at = this.now()
    const replies: ReplyRound = { state: 'asked', askedBy: login, askedAt: at, agentId: author.id }
    await this.hub.record({ kind: 'user', login }, { type: 'card.update', id: card.id, fields: { challenge: { ...challenge, replies } }, activity: { at, by: login, kind: 'challenge', text: `Asked ${author.name} to reply to the findings` } })
    return this.card(card.id).challenge!
  }

  /** A change set's findings: each card's author asked to reply to those on its own pull request. */
  async askSetReplies(login: string, setId: string) {
    const set = this.hub.state.changeSets.find((s) => s.id === setId)
    if (!set) throw new Refused('No such change set.')
    const asked: string[] = []
    const refused: string[] = []
    for (const card of cardsOfSet(this.hub.state, set)) {
      if (card.challenge?.fromSet !== set.id || !card.challenge.findings?.length) continue
      try {
        await this.askReplies(login, card.id)
        asked.push(card.title)
      } catch (error) {
        refused.push(`${card.title}: ${(error as Error).message}`)
      }
    }
    if (!asked.length) throw new Refused(refused.length ? refused.join(' ') : 'There are no findings on its pull requests to reply to.')
    return { asked, refused }
  }

  /** The card, when a round of replies to its findings is waiting for this agent or under way. */
  replyingTo(agentId: string, cardId: string) {
    const card = this.hub.state.cards.find((c) => c.id === cardId)
    const challenge = card?.challenge
    const round = challenge?.replies
    return card && challenge && round && challenge.state === 'done' && round.agentId === agentId && (round.state === 'asked' || round.state === 'replying') ? { card, challenge, round } : undefined
  }

  /**
   * The author: what it's doing meanwhile, that it couldn't, or its replies, one to every finding: fixed, or disagree,
   * each with why. Once they're in, the round is over for good.
   */
  async sendReplies(agentId: string, cardId: string, sent: { doing?: string; failed?: string; replies?: { finding: string; verdict: ReplyVerdict; why: string }[] }) {
    const found = this.replyingTo(agentId, cardId)
    if (!found) throw new Refused('No findings of that card are waiting for your reply.')
    const { card, challenge, round } = found
    const actor: Actor = { kind: 'agent', id: agentId }
    const at = this.now()
    if (sent.failed !== undefined) {
      const why = sent.failed.trim().slice(0, 1000) || 'It stopped without replying.'
      await this.hub.record(actor, { type: 'card.update', id: card.id, fields: { challenge: { ...challenge, replies: tidy<ReplyRound>({ ...round, state: 'failed', doing: undefined, failed: why }) } }, activity: { at, by: agentId, kind: 'challenge', text: `Couldn’t reply to the findings: ${why}` } })
      return this.card(card.id).challenge!
    }
    if (sent.replies === undefined) {
      const doing = sent.doing?.trim().slice(0, 200)
      if (round.state === 'replying' && round.doing === doing) return challenge
      await this.hub.record(actor, { type: 'card.update', id: card.id, fields: { challenge: { ...challenge, replies: tidy<ReplyRound>({ ...round, state: 'replying', doing }) } } })
      return this.card(card.id).challenge!
    }
    // One reply to each finding, each saying fixed or disagree and why, or they all go back to the author.
    const findings = challenge.findings ?? []
    const ids = new Set(findings.map((f) => f.id))
    const given = new Map<string, { verdict: ReplyVerdict; why: string }>()
    const problems: string[] = []
    for (const [i, r] of sent.replies.entries()) {
      const id = String(r.finding ?? '').trim()
      const why = String(r.why ?? '').trim().slice(0, 3000)
      const lacks = [!replyVerdicts.includes(r.verdict) && 'verdict (fixed or disagree)', !why && 'why'].filter(Boolean)
      if (!ids.has(id)) problems.push(`reply ${i + 1}: no finding “${id}” (they are ${[...ids].join(', ')})`)
      else if (given.has(id)) problems.push(`reply ${i + 1}: ${id} is answered twice`)
      else if (lacks.length) problems.push(`reply ${i + 1} (${id}): ${lacks.join(', ')}`)
      else given.set(id, { verdict: r.verdict, why })
    }
    // A finding a person dismissed needs no answer, though it may have one.
    const unanswered = findings.filter((f) => f.outcome?.kind !== 'dismissed' && !given.has(f.id) && !sent.replies!.some((r) => String(r.finding ?? '').trim() === f.id)).map((f) => f.id)
    if (unanswered.length) problems.push(`a reply to ${unanswered.join(', ')}`)
    if (problems.length) throw new Refused(`The replies need ${problems.join('; ')}.`)
    const replied: Finding[] = findings.map((f) => (given.has(f.id) ? { ...f, reply: { ...given.get(f.id)!, by: agentId, at } } : f))
    const done: ReplyRound = { state: 'done', askedBy: round.askedBy, askedAt: round.askedAt, agentId, repliedAt: at }
    const fixed = [...given.values()].filter((r) => r.verdict === 'fixed').length
    const parts = [fixed && `${fixed} fixed`, given.size - fixed && `${given.size - fixed} disagreed`].filter(Boolean).join(', ') || 'none open'
    await this.hub.record(actor, { type: 'card.update', id: card.id, fields: { challenge: { ...challenge, findings: replied, replies: done } }, activity: { at, by: agentId, kind: 'challenge', text: `Replied to the findings: ${parts}` } })
    return this.card(card.id).challenge!
  }

  /**
   * A person acts on one of a Challenge's findings. Send back: a comment on the card to the agent that wrote the work,
   * and the card goes back to In progress with it, so its runner carries on with it. Dismiss: it was wrong, or doesn't
   * matter (and reopen undoes that). Make a card: a new card on the board from it.
   */
  async actOnFinding(login: string, cardId: string, findingId: string, action: 'send back' | 'dismiss' | 'card' | 'reopen') {
    const card = this.card(cardId)
    const challenge = card.challenge
    const finding = challenge?.findings?.find((f) => f.id === findingId)
    if (!challenge || !finding) throw new Refused('That finding is gone: the card was challenged again since.')
    const actor: Actor = { kind: 'user', login }
    const at = this.now()
    // From the Challenge as it is when it's recorded, so what changed on it meanwhile (its review posted) isn't undone.
    const settled = (outcome: FindingOutcome | undefined) => {
      const now = this.card(card.id).challenge ?? challenge
      return tidy<Challenge>({ ...now, findings: (now.findings ?? []).map((f) => (f.id === finding.id ? tidy<Finding>({ ...f, outcome }) : f)) })
    }
    if (action === 'reopen') {
      if (finding.outcome?.kind !== 'dismissed') throw new Refused('Only a dismissed finding can be opened again.')
      await this.hub.record(actor, { type: 'card.update', id: card.id, fields: { challenge: settled(undefined) }, activity: { at, by: login, kind: 'challenge', text: `Opened finding ${finding.id} again` } })
      return this.card(card.id)
    }
    if (finding.outcome) throw new Refused(finding.outcome.kind === 'sent back' ? 'That finding was already sent back.' : finding.outcome.kind === 'card' ? 'That finding already has a card.' : 'That finding was dismissed: open it again first.')
    if (action === 'dismiss') {
      await this.hub.record(actor, { type: 'card.update', id: card.id, fields: { challenge: settled({ kind: 'dismissed', by: login, at }) }, activity: { at, by: login, kind: 'challenge', text: `Dismissed finding ${finding.id} (${findingWhere(finding)})` } })
      return this.card(card.id)
    }
    if (action === 'card') {
      const made = await this.createCard(actor, { binderId: card.binderId, noteId: card.noteId, size: 'S', ...findingCard(finding, card) })
      await this.hub.record(actor, { type: 'card.update', id: card.id, fields: { challenge: settled({ kind: 'card', by: login, at, cardId: made.id }) }, activity: { at, by: login, kind: 'challenge', text: `Made a card of finding ${finding.id}: “${made.title}”` } })
      return made
    }
    // Back to the agent that wrote it: the one holding the card, or the one whose pull request it is.
    if (card.stage !== 'working' && card.stage !== 'review') throw new Refused('The card is past review: make a card of the finding instead.')
    const live = (id?: string) => (id && this.hub.state.agents.some((a) => a.id === id && !a.revoked) ? id : undefined)
    const author = live(card.agentId) ?? live(pullOf(this.hub.state, card)?.agentId)
    if (!author) throw new Refused('No agent wrote this work to send it back to: make a card of the finding instead.')
    const reviewer = this.hub.state.agents.find((a) => a.id === challenge.agentId)?.name ?? 'An agent'
    // The comment is the card's last word from a person, so the author's runner carries on with it (resumeFor).
    await this.hub.record(actor, {
      type: 'card.update', id: card.id,
      fields: { stage: 'working', agentId: author, challenge: settled({ kind: 'sent back', by: login, at, agentId: author }) },
      activity: { at, by: login, kind: 'comment', text: findingComment(finding, reviewer) },
    })
    return this.card(card.id)
  }
}
