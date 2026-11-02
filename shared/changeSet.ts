import type { Activity, Card, ChangeSet, Check, DiffLine, FileDiff, PlanStep, PRState, PullRequest, Stage, WorkState } from './work.ts'

// One card's Change Set: everything its work proposes, in one place. The pull request's diff, or, before there is one,
// the diff of the card's worktree as its runner last saw it; the card's brief and done-when, and the note's words it
// came from; and the agent's progress log. A change set's debrief and its Challenge are built from these, card by card.

/** A worktree's diff, as the runner working the card last sent it. */
export interface WorktreeDiff {
  /** The card's branch, e.g. "binders/card-1a2b". */
  branch: string
  /** The commit the branch is compared with: where it left the workspace. */
  base: string
  files: FileDiff[]
  at: string
  /** Files or lines were left out to keep it small. */
  cut?: boolean
}

export interface CardChangeSet {
  card: { id: string; title: string; binderId: string; stage: Stage; agentId?: string }
  brief: string
  doneWhen: string
  note?: { id: string; quote?: string }
  /** Where the diff comes from: the card's pull request, its worktree, or nothing yet. */
  source: 'pull' | 'worktree' | 'none'
  pull?: { id: string; repo: string; number: number; title: string; url: string; branch: string; state: PRState; checks: Check[] }
  worktree?: { branch: string; base: string; at: string; cut?: boolean }
  files: FileDiff[]
  added: number
  removed: number
  /** A change set's pull requests, when this is a whole change set: its files are then named "owner/repo#7: path". */
  pulls?: { id: string; repo: string; number: number; title: string; url: string; branch: string; state: PRState; checks: Check[]; card?: { id: string; title: string } }[]
  plan?: PlanStep[]
  doing?: string
  progress?: number
  /** The commit at the head of the pull request, as the hub last saw it; nothing while there's only a worktree. */
  head?: string
  /** The card's debrief, and the commits that came after it was written. */
  debrief?: ChangeSetDebrief
  /** The card's log, oldest first: the agent's steps and words, questions and answers, and what happened to it. */
  log: Activity[]
}

/** The card's debrief as its Change Set carries it: when it was written, at which commit, and what came after. */
export interface ChangeSetDebrief {
  state: Debrief['state']
  writtenAt?: string
  /** The commit at the head of the pull request when it was written. */
  head?: string
  /**
   * The commits that landed after it was written: the range only, from state; whoever can ask GitHub fills in the
   * commits and files. Nothing while it's current.
   */
  outOfDate?: { from: string; to: string; commits?: Commit[]; files?: string[] }
}

/** A commit on a pull request, as the hub reads it from GitHub. */
export interface Commit {
  sha: string
  title: string
  /** Who wrote it, and when. */
  by?: string
  at?: string
}

/**
 * What came after the debrief before this one: only the commits that landed since it was written, and what they change.
 * A debrief written again with new commits on the card starts with this.
 */
export interface DebriefSince {
  /** The head the previous debrief was written at, and the head this one was written at. */
  from: string
  to: string
  /** What the new commits change, in a few plain lines: the agent's words. */
  what: string
  /** The commits themselves, oldest first. */
  commits: Commit[]
  /** The files they touch. */
  files?: string[]
}

/** A debrief written at one head, with its pull request now at another: the commits to read before writing it again. */
export function outOfDate(debrief?: Pick<Debrief, 'writtenAt' | 'head'>, head?: string): { from: string; to: string } | undefined {
  if (!debrief?.writtenAt || !debrief.head || !head || debrief.head === head) return undefined
  return { from: debrief.head, to: head }
}

/** How a done-when point stands in a debrief. */
export type Mark = 'met' | 'partly met' | 'not met'
export const marks: Mark[] = ['met', 'partly met', 'not met']

/** One done-when point, as the debrief found it: met or not, and where (a file, a test, or what's missing). */
export interface DebriefPoint {
  point: string
  mark: Mark
  where: string
}

/**
 * A card's debrief: what its Change Set proposes, written by an agent when a person asks, for that person to decide
 * whether it's right. Asked again, the last one stays on show until the new one is written.
 */
/** How hard the agent reasons over a debrief or Challenge, as asked; auto goes by the change's size. */
export type Effort = 'low' | 'medium' | 'high'
export const efforts: Effort[] = ['low', 'medium', 'high']

/** The reasoning asked for: the level, and whether it was picked by the change's size (its changed lines). */
export interface AskedEffort {
  level: Effort
  auto: boolean
  lines?: number
}

/** Auto: small changes don't need high reasoning, big ones do. */
export function effortFor(lines: number): Effort {
  return lines <= 80 ? 'low' : lines <= 600 ? 'medium' : 'high'
}

export interface Debrief {
  /** asked: waiting for its agent; writing: the agent has it; done: written; failed: the agent couldn't. */
  state: 'asked' | 'writing' | 'done' | 'failed'
  askedBy: string
  askedAt: string
  /** How hard its agent reasons over it. */
  effort?: AskedEffort
  /** The agent writing it. */
  agentId: string
  /** On a card: its change set's debrief, which is this. */
  fromSet?: string
  /** While it's writing: what it's doing now. */
  doing?: string
  /** Why it couldn't be written. */
  failed?: string
  /** The sections, once written. */
  writtenAt?: string
  /** The commit at the head of the pull request when it was written: new commits make it out of date. */
  head?: string
  /** Written again after new commits: what they changed since the debrief before this one. */
  since?: DebriefSince
  /** What it was written from: the pull request, the worktree, or the card alone. */
  source?: CardChangeSet['source']
  /** What it does, in a few plain lines. */
  does?: string
  /** What changed, by area: not a file list. */
  changes?: { area: string; what: string }[]
  /** Each done-when point, marked. */
  against?: DebriefPoint[]
  /** Risky spots, work outside the brief, new dependencies, migrations, settings, deleted code, missing tests. */
  lookAt?: string[]
  /** The build or command, and what to click. */
  tryIt?: string
  /**
   * Its functional test plan: what a person (or an agent) runs against the running product to see that it does what the
   * spec says, riskiest first, each tied to the done-when point it proves. Results are recorded on each test.
   */
  testPlan?: TestCase[]
  /**
   * The comment on the card's GitHub issue it's kept in, and which writing of it that comment has: written again, the
   * same comment is edited.
   */
  comment?: { repo: string; id: number; url: string; writtenAt: string }
}

/** How much a functional test matters: what breaks, or who it costs, if it fails. */
export type TestRisk = 'high' | 'medium' | 'low'
export const testRisks: TestRisk[] = ['high', 'medium', 'low']
export type TestOutcome = 'passed' | 'failed'
export const testOutcomes: TestOutcome[] = ['passed', 'failed']

/** A functional test from a debrief's plan: observable behaviour, with exact steps and what you should see. */
export interface TestCase {
  /** "t1", "t2"…, in the plan's order: what a result is recorded against. */
  id: string
  title: string
  /** The done-when point it proves, in the card's words; none for an edge case the points only imply. */
  point?: string
  /** What has to be true first: an account, a plan, some data. */
  setup?: string
  steps: string[]
  /** What you should see when it works. */
  expect: string
  risk?: TestRisk
  /** How it went when someone ran it. */
  result?: TestResult
}

/** Someone ran a test: it passed or failed, with a line on what they saw. */
export interface TestResult {
  outcome: TestOutcome
  note?: string
  by: string
  at: string
}

/** The most tests a plan keeps, steps a test keeps, and characters in any one of its texts. */
export const testsMost = 15
export const testStepsMost = 12
export const testTextMost = 600

/** How a plan stands: how many tests, and how many passed and failed. */
export function testTally(plan: TestCase[] | undefined) {
  const tests = plan ?? []
  return { total: tests.length, passed: tests.filter((t) => t.result?.outcome === 'passed').length, failed: tests.filter((t) => t.result?.outcome === 'failed').length }
}

/** A plan as Markdown, to paste into an issue, a doc or a QA tool. */
export function testPlanMarkdown(plan: TestCase[], title?: string) {
  const lines = [`## Functional test plan${title ? `: ${title}` : ''}`, '']
  for (const t of plan) {
    lines.push(`### ${t.id}. ${t.title}${t.risk ? ` (${t.risk} risk)` : ''}`)
    if (t.point) lines.push(`Proves: ${t.point}`)
    if (t.setup) lines.push(`Setup: ${t.setup}`)
    lines.push('', ...t.steps.map((step, i) => `${i + 1}. ${step}`), '', `Expect: ${t.expect}`)
    if (t.result) lines.push(`Result: ${t.result.outcome} (${t.result.by}, ${t.result.at.slice(0, 10)})${t.result.note ? `: ${t.result.note}` : ''}`)
    lines.push('')
  }
  return lines.join('\n').trimEnd() + '\n'
}

/** A debrief with one test's result set (or cleared, with none). Unchanged when it has no such test. */
export function withTestResult<D extends Pick<Debrief, 'testPlan'>>(debrief: D, test: string, result: TestResult | null | undefined): D {
  if (!debrief.testPlan?.some((t) => t.id === test)) return debrief
  return { ...debrief, testPlan: debrief.testPlan.map((t) => (t.id !== test ? t : result ? { ...t, result } : (({ result: _gone, ...rest }) => rest)(t))) }
}

/** What kind of thing a Challenge found wrong. */
export type FindingKind = 'bug' | 'done-when' | 'security' | 'edge case' | 'simpler' | 'breaks'
export const findingKinds: FindingKind[] = ['bug', 'done-when', 'security', 'edge case', 'simpler', 'breaks']
/** How sure the reviewer is: it showed it goes wrong (a test, a trace through the code), or it could. */
export type Confidence = 'confirmed' | 'plausible'
export const confidences: Confidence[] = ['confirmed', 'plausible']
/** How bad it is, worst first. */
export type Severity = 'high' | 'medium' | 'low'
export const severities: Severity[] = ['high', 'medium', 'low']

/** One thing a Challenge found wrong: where, what goes wrong, how sure, and how bad. */
export interface Finding {
  /** "f1", "f2"…, in the order the reviewer gave them: what Send back, Dismiss and Make a card act on. */
  id: string
  kind: FindingKind
  /** The pull request it's in, when the work has one. */
  pull?: string
  file: string
  line: number
  /** What goes wrong: the inputs or state, and the wrong result. */
  what: string
  confidence: Confidence
  severity: Severity
  /** What would fix it, or the simpler way. */
  fix?: string
  /** What a person did with it. None while it's open. */
  outcome?: FindingOutcome
  /** The author's one answer to it: fixed, or disagrees and why. */
  reply?: FindingReply
}

/** What the author says of a finding: it fixed it, or it disagrees. */
export type ReplyVerdict = 'fixed' | 'disagree'
export const replyVerdicts: ReplyVerdict[] = ['fixed', 'disagree']

/** The author's answer to one finding. */
export interface FindingReply {
  verdict: ReplyVerdict
  /** What it changed, or why the finding is wrong. */
  why: string
  /** The author agent. */
  by: string
  at: string
}

/**
 * The author's one round of replies to a Challenge's findings. A person asks for it; the author answers every finding
 * at once, and that's the end of it: the reviewer isn't sent the replies and no round follows, so it can't loop. Only
 * a new Challenge, with new findings, can be replied to again.
 */
export interface ReplyRound {
  /** asked: waiting for the author; replying: the author has it; done: replies in; failed: it couldn't. */
  state: 'asked' | 'replying' | 'done' | 'failed'
  askedBy: string
  askedAt: string
  /** The author agent that answers. */
  agentId: string
  doing?: string
  failed?: string
  repliedAt?: string
}

/**
 * What a person did with a finding: sent it back to the agent that wrote the work (a comment on the card, which goes
 * back to In progress), dismissed it, or made a card of it.
 */
export interface FindingOutcome {
  kind: 'sent back' | 'dismissed' | 'card'
  by: string
  at: string
  /** The agent it went back to. */
  agentId?: string
  /** The card made from it. */
  cardId?: string
}

/**
 * A card's Challenge: an adversarial review of its Change Set by an agent that didn't write it. The reviewer gets the
 * diff, the brief and the done-when, never the author's plan, progress log or conversation, so it isn't anchored on
 * their reasoning. Asked again, the last findings stay on show until the new ones come.
 */
/** A symbol the change added, changed or removed, with where else the code uses it and the tests that mention it. */
export interface BlastSymbol {
  name: string
  /** Where it's declared, as the change names the file. */
  file: string
  change: 'added' | 'changed' | 'removed'
  /** Uses outside the change itself, not in tests: the first few. */
  uses: { file: string; line: number; text: string }[]
  /** Uses past those. */
  more?: number
  tests: string[]
}

/**
 * A change's blast radius: its changed symbols and their uses beyond it, found by name (git grep) on the reviewer's
 * machine. A first cut: a name used for two things counts both.
 */
export interface BlastRadius {
  at: string
  /** The repo searched; a change set's files in other repos are in elsewhere. */
  repo?: string
  symbols: BlastSymbol[]
  /** Uses outside the change, in all. */
  outside: number
  /** Symbols the change removed that are still used. */
  stillUsed: number
  /** Symbols it added or changed that no test mentions. */
  untested: number
  elsewhere?: string[]
  /** Symbols past the ones followed. */
  cut?: number
}

export interface Challenge {
  /** asked: waiting for its reviewer; reviewing: the reviewer has it; done: findings in; failed: it couldn't. */
  state: 'asked' | 'reviewing' | 'done' | 'failed'
  askedBy: string
  askedAt: string
  /** How hard its reviewer reasons over it. */
  effort?: AskedEffort
  /** The reviewing agent. */
  agentId: string
  /** Whether a person named the reviewer, or the hub picked it. */
  picked: 'person' | 'hub'
  /** The agents that wrote the work, none of whom may review it. */
  authors: string[]
  doing?: string
  failed?: string
  reviewedAt?: string
  source?: CardChangeSet['source']
  /** The reviewer's verdict in a line or two. */
  summary?: string
  /** On a card: the findings on its pull request from its change set's Challenge, which is this. */
  fromSet?: string
  /** What the change touches beyond itself, worked out by the reviewer's runner before it reads the change. */
  blast?: BlastRadius
  /** Worst first. Empty when it found nothing wrong. */
  findings?: Finding[]
  /** The author's one round of replies to these findings, once a person asks for it. */
  replies?: ReplyRound
  /** Its findings as a review on the pull request, when the card's binder posts them there: posted, or why not. */
  review?: ChallengeReview
}

/** A Challenge's findings posted to its pull request as one review, each on its line where the diff has it. */
export interface ChallengeReview {
  repo: string
  number: number
  id?: number
  url?: string
  /** When it was posted, or tried. */
  at: string
  /** How many findings are line comments; the rest are in the review's body. */
  onLines?: number
  failed?: string
}

/** A card can be challenged while it's being built and while it's in review, as it can be debriefed. */
export const challengeable = (stage: Stage) => stage === 'working' || stage === 'review'

/** A round of replies the author hasn't finished, unless it went quiet on it for half an hour. */
export const replying = (round?: ReplyRound) => !!round && (round.state === 'asked' || round.state === 'replying') && Date.now() - Date.parse(round.askedAt) < 30 * 60_000

/**
 * Whether the author may still be asked to reply to a Challenge's findings: it's done, it found something a person
 * hasn't dismissed, and no round has been answered or is under way. A round that failed may be asked again, as it
 * brought no replies.
 */
export const repliable = (challenge?: Challenge) => !!challenge && challenge.state === 'done' && !!challenge.findings?.some((f) => f.outcome?.kind !== 'dismissed') && (!challenge.replies || challenge.replies.state === 'failed' || (challenge.replies.state !== 'done' && !replying(challenge.replies)))

/** The agent that answers for a card's work: the one holding it, else its pull request's, else the first author. */
export function authorOf(state: WorkState, card: Card, challenge: Challenge): string | undefined {
  return card.agentId ?? pullOf(state, card)?.agentId ?? challenge.authors[0]
}

const severityRank: Record<Severity, number> = { high: 0, medium: 1, low: 2 }
/** Findings worst first: by severity, confirmed before plausible, then in the reviewer's order. */
export const byWorst = (a: Finding, b: Finding) => severityRank[a.severity] - severityRank[b.severity] || (a.confidence === b.confidence ? 0 : a.confidence === 'confirmed' ? -1 : 1)

/** The findings no one has sent back, dismissed or made a card of yet. */
export const openFindings = (challenge?: Challenge) => challenge?.findings?.filter((f) => !f.outcome) ?? []

/** A finding's file and line, and its pull request when there is one: "src/a.ts:2 in acme/web#7". */
export const findingWhere = (finding: Finding) => `${finding.file}:${finding.line}${finding.pull ? ` in ${finding.pull}` : ''}`

/** A finding as the comment that sends it back to the agent that wrote the work: all it needs to act on it. */
export function findingComment(finding: Finding, reviewer: string) {
  return [
    `From ${reviewer}’s Challenge (${finding.severity}, ${finding.confidence}, ${finding.kind}) at ${findingWhere(finding)}: ${finding.what}`,
    finding.fix ? `Fix: ${finding.fix}` : '',
    'Fix it in the same work and complete_task again, or say on the card why it isn’t wrong.',
  ].filter(Boolean).join('\n')
}

/** A card made from a finding: its title, brief and done-when. */
export function findingCard(finding: Finding, from: { id: string; title: string }) {
  const first = finding.what.split(/(?<=[.!?])\s/)[0].replace(/[.!?]$/, '')
  return {
    title: (first.length > 90 ? `${first.slice(0, 88).trimEnd()}…` : first) || `Fix ${finding.file}:${finding.line}`,
    brief: [`From the Challenge of “${from.title}” (${from.id}), ${finding.severity} and ${finding.confidence}: ${finding.what}`, `Where: ${findingWhere(finding)}.`, finding.fix ? `Fix: ${finding.fix}` : ''].filter(Boolean).join('\n\n'),
    doneWhen: `What goes wrong at ${finding.file}:${finding.line} no longer does, and a test shows it.`,
  }
}

/**
 * The agents that wrote a card's work: the one holding it, the one whose pull request it is, and any that worked it
 * before and let it go. A Challenge goes to none of them.
 */
export function authorsOf(state: WorkState, card: Card): string[] {
  const agents = new Set(state.agents.map((a) => a.id))
  const worked: Activity['kind'][] = ['claimed', 'released', 'progress', 'step', 'said', 'question', 'pr', 'completed']
  const ids = [card.agentId, pullOf(state, card)?.agentId, ...card.activity.filter((a) => worked.includes(a.kind) && agents.has(a.by)).map((a) => a.by)]
  return [...new Set(ids.filter((id): id is string => !!id))]
}

/**
 * What a Challenge's reviewer may see of a card's Change Set: the diff, the brief, the done-when and the note's words.
 * Not the plan, what the agent is doing, its log, or who wrote it.
 */
export function challengeSet(set: CardChangeSet) {
  return {
    card: { id: set.card.id, title: set.card.title, stage: set.card.stage },
    brief: set.brief,
    doneWhen: set.doneWhen,
    note: set.note,
    source: set.source,
    pull: set.pull,
    pulls: set.pulls,
    worktree: set.worktree,
    files: set.files,
    added: set.added,
    removed: set.removed,
  }
}

/**
 * A file's diff as text with each line's number in the file beside it, so a finding can name its line: the new file's
 * number for added and unchanged lines, the old file's for removed ones.
 */
export function numberedDiff(file: FileDiff) {
  const width = Math.max(3, String(Math.max(0, ...file.lines.map((l) => l.n ?? 0))).length)
  return file.lines.map((l) => (l.kind === '@' ? `@@ ${l.text}` : `${(l.n ? String(l.n) : '').padStart(width)} ${l.kind}${l.text}`)).join('\n')
}

/**
 * Where a finding goes as a line comment on its pull request: its file's line on the side of the diff that has it,
 * the new file's (RIGHT) before the old's (LEFT), as a finding names the new file's line unless it's on a removed one.
 * Nothing when the line isn't in the diff, for GitHub takes comments only on lines it shows.
 */
export function findingAnchor(files: FileDiff[], finding: Pick<Finding, 'file' | 'line'>): { path: string; line: number; side: 'RIGHT' | 'LEFT' } | undefined {
  const file = files.find((f) => f.path === finding.file)
  const at = file?.lines.filter((l) => l.n === finding.line)
  if (!file || !at?.length) return undefined
  return { path: file.path, line: finding.line, side: at.some((l) => l.kind !== '-') ? 'RIGHT' : 'LEFT' }
}

const severityText: Record<Severity, string> = { high: 'High', medium: 'Medium', low: 'Low' }

/** A finding as Markdown: how bad, how sure and what kind, what goes wrong, and the fix. */
export function findingMarkdown(finding: Finding) {
  return [`**${severityText[finding.severity]}** · ${finding.confidence} · ${finding.kind}`, '', finding.what, ...(finding.fix ? ['', `**Fix:** ${finding.fix}`] : [])].join('\n')
}

/**
 * A Challenge as a GitHub pull request review: a line comment for each finding the diff has a line for, and the rest,
 * with the reviewer's summary, in the review's body.
 */
export function challengeReview(challenge: Challenge, files: FileDiff[], by: { agent: string; link?: string }) {
  const findings = challenge.findings ?? []
  const comments: { path: string; line: number; side: 'RIGHT' | 'LEFT'; body: string }[] = []
  const off: Finding[] = []
  for (const f of findings) {
    const anchor = findingAnchor(files, f)
    if (anchor) comments.push({ ...anchor, body: findingMarkdown(f) })
    else off.push(f)
  }
  const high = findings.filter((f) => f.severity === 'high').length
  const lines = [`### Challenge: ${findings.length} finding${findings.length === 1 ? '' : 's'}${high ? `, ${high} high` : ''}`, '', `_By ${by.agent}, an agent that didn’t write this work, from the diff, brief and done-when alone. Asked by ${challenge.askedBy}.${by.link ? ` [Open in Binders](${by.link})` : ''}_`]
  if (challenge.summary) lines.push('', challenge.summary)
  if (off.length) lines.push('', comments.length ? '**Not on a line of this diff**' : '**Findings**', '', ...off.map((f) => `- \`${f.file}:${f.line}\` ${findingMarkdown(f).replace(/\n\n/g, '\n  ')}`))
  return { body: lines.join('\n'), comments }
}

/** A card can be debriefed while it's being built and while it's in review. */
export const debriefable = (stage: Stage) => stage === 'working' || stage === 'review'

/** A written debrief whose comment on the card's issue doesn't have this writing yet. */
export const debriefToComment = (debrief?: Debrief) => !!debrief?.writtenAt && debrief.comment?.writtenAt !== debrief.writtenAt

const metOf = (debrief: Debrief) => `${debrief.against?.filter((p) => p.mark === 'met').length ?? 0} of ${debrief.against?.length ?? 0}`
const markGlyph: Record<Mark, string> = { met: '✅', 'partly met': '🟡', 'not met': '❌' }

/** The comment a written debrief is kept in on its card's GitHub issue: its five sections, for reading on GitHub. */
export function debriefMarkdown(debrief: Debrief, by: { agent: string; link?: string }) {
  const lines = [`### Debrief: ${metOf(debrief)} done-when points met`, '', `_By ${by.agent}${debrief.writtenAt ? ` on ${debrief.writtenAt.slice(0, 10)}` : ''}, asked by ${debrief.askedBy}.${by.link ? ` [Open in Binders](${by.link})` : ''}_`]
  lines.push('', '**What it does**', '', debrief.does ?? '')
  lines.push('', '**What changed**', '', ...(debrief.changes ?? []).map((c) => `- **${c.area}:** ${c.what}`))
  lines.push('', '**Against the brief**', '', ...(debrief.against ?? []).map((p) => `- ${markGlyph[p.mark]} **${p.mark}:** ${p.point}${p.where ? ` (${p.where})` : ''}`))
  lines.push('', '**Things to look at**', '', ...(debrief.lookAt?.length ? debrief.lookAt.map((l) => `- ${l}`) : ['Nothing stood out.']))
  lines.push('', '**How to try it**', '', debrief.tryIt ?? '')
  if (debrief.testPlan?.length) {
    lines.push('', `**Functional test plan** (${debrief.testPlan.length} test${debrief.testPlan.length === 1 ? '' : 's'})`, '')
    for (const t of debrief.testPlan) {
      lines.push(`- [${t.result?.outcome === 'passed' ? 'x' : ' '}] **${t.title}**${t.risk ? ` (${t.risk} risk)` : ''}${t.point ? `: proves “${t.point}”` : ''}`)
      if (t.setup) lines.push(`  Setup: ${t.setup}`)
      lines.push(...t.steps.map((step, i) => `  ${i + 1}. ${step}`), `  Expect: ${t.expect}`)
    }
  }
  return lines.join('\n')
}

/** Markdown and code read as words: no backticks, stars, link addresses, fences or list marks. */
function spoken(text: string) {
  return text
    .replace(/```[^\n]*\n?/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[`*_#>]+/g, '')
    .replace(/^\s*(?:[-+]|\d+[.)])\s+/gm, '')
    .replace(/\s*\n+\s*/g, '. ')
    .replace(/\s+/g, ' ')
    .replace(/([.!?:;])\.+/g, '$1')
    .trim()
}

/** A sentence that ends as one. */
const sentence = (text: string) => {
  const words = spoken(text)
  return !words ? '' : /[.!?]$/.test(words) ? words : `${words}.`
}

/**
 * A debrief as words to say aloud, in the order a person would want to hear it: what it does, how it stands against the
 * brief, what to look at, what changed, and how to try it. For the card's Read aloud and the talk-to-myself loop.
 */
export function debriefSpeech(debrief: Debrief, about: { title: string; agent: string }) {
  if (!debrief.writtenAt) {
    if (debrief.state === 'failed') return sentence(`${about.agent} couldn’t write the debrief of ${about.title}: ${debrief.failed ?? ''}`)
    return sentence(`${about.agent} is still writing the debrief of ${about.title}`)
  }
  const parts = [sentence(`Debrief of ${about.title}, by ${about.agent}`)]
  if (debrief.state === 'asked' || debrief.state === 'writing') parts.push(sentence(`A new one is being written; this is the last one`))
  parts.push(sentence(`What it does: ${debrief.does ?? ''}`))
  const against = debrief.against ?? []
  parts.push(sentence(`Against the brief, ${metOf(debrief)} done-when points are met`))
  for (const p of against) parts.push(sentence(`${p.mark === 'met' ? 'Met' : p.mark === 'partly met' ? 'Partly met' : 'Not met'}: ${p.point.replace(/[.!?]+$/, '')}${p.mark !== 'met' && p.where ? `. ${p.where}` : ''}`))
  parts.push(debrief.lookAt?.length ? sentence(`Things to look at: ${debrief.lookAt.map((l) => l.replace(/[.!?]+$/, '')).join('. ')}`) : 'Nothing stood out to look at.')
  if (debrief.changes?.length) parts.push(sentence(`What changed: ${debrief.changes.map((c) => `${c.area}: ${c.what.replace(/[.!?]+$/, '')}`).join('. ')}`))
  if (debrief.tryIt) parts.push(sentence(`How to try it: ${debrief.tryIt}`))
  if (debrief.testPlan?.length) {
    const tally = testTally(debrief.testPlan)
    parts.push(sentence(`Its test plan has ${tally.total} functional test${tally.total === 1 ? '' : 's'}${tally.passed || tally.failed ? `: ${tally.passed} passed, ${tally.failed} failed` : ''}. ${debrief.testPlan.map((t) => t.title.replace(/[.!?]+$/, '')).join('. ')}`))
  }
  return parts.filter(Boolean).join(' ')
}

/**
 * A card's done-when as the points a debrief marks: one a line when it's a list, else one a sentence.
 */
export function doneWhenPoints(doneWhen: string): string[] {
  const lines = doneWhen.split('\n').map((line) => line.replace(/^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/, '').trim()).filter(Boolean)
  if (lines.length !== 1) return lines
  return lines[0].split(/(?<=[.!?])\s+(?=[A-Z“"(])/).map((s) => s.trim()).filter(Boolean)
}

/** The pull request a card's work went into: the one it names, or one that names it. */
export function pullOf(state: WorkState, card: Card) {
  return (card.prId ? state.pulls.find((p) => p.id === card.prId) : undefined) ?? state.pulls.find((p) => p.cardId === card.id)
}

/** A card's Change Set, from the state alone. The pull request's diff wins over the worktree's once it has one. */
export function cardChangeSet(state: WorkState, cardId: string): CardChangeSet | undefined {
  const card = state.cards.find((c) => c.id === cardId)
  if (!card) return undefined
  const pull = pullOf(state, card)
  // A pull request whose files haven't come from GitHub yet doesn't hide the worktree's diff.
  const fromPull = !!pull && (pull.files.length > 0 || !card.worktree)
  const source = fromPull ? 'pull' : card.worktree ? 'worktree' : 'none'
  const files = fromPull ? pull!.files : card.worktree?.files ?? []
  return {
    card: { id: card.id, title: card.title, binderId: card.binderId, stage: card.stage, agentId: card.agentId },
    brief: card.brief,
    doneWhen: card.doneWhen,
    note: card.noteId ? { id: card.noteId, quote: card.quote } : undefined,
    source,
    pull: pull ? { id: pull.id, repo: pull.repo, number: pull.number, title: pull.title, url: pull.url, branch: pull.branch, state: pull.state, checks: pull.checks } : undefined,
    worktree: !fromPull && card.worktree ? { branch: card.worktree.branch, base: card.worktree.base, at: card.worktree.at, cut: card.worktree.cut } : undefined,
    files,
    added: (fromPull ? pull!.additions : undefined) ?? files.reduce((sum, f) => sum + f.added, 0),
    removed: (fromPull ? pull!.deletions : undefined) ?? files.reduce((sum, f) => sum + f.removed, 0),
    plan: card.plan,
    doing: card.doing,
    progress: card.progress,
    head: pull?.head,
    debrief: card.debrief
      ? { state: card.debrief.state, writtenAt: card.debrief.writtenAt, head: card.debrief.head, outOfDate: outOfDate(card.debrief, pull?.head) }
      : undefined,
    log: card.activity,
  }
}

/** The change set a card's pull request is in, if it has one. */
export function setOfCard(state: WorkState, card: Card): ChangeSet | undefined {
  const pull = pullOf(state, card)
  return pull ? state.changeSets.find((s) => s.prIds.includes(pull.id)) : undefined
}

/** A change set's cards, in its merge order. */
export function cardsOfSet(state: WorkState, set: ChangeSet): Card[] {
  return set.prIds
    .map((id) => state.pulls.find((p) => p.id === id))
    .map((pull) => pull && (state.cards.find((c) => c.id === pull.cardId) ?? state.cards.find((c) => c.prId === pull.id)))
    .filter((c): c is Card => !!c)
}

/** Where a change set's file is: its pull request and path, from the name the set gave it ("acme/web#7: src/a.ts"). */
export function setPath(name: string): { pull?: string; path: string } {
  const at = /^([\w.-]+\/[\w.-]+#\d+): (.+)$/.exec(name)
  return at ? { pull: at[1], path: at[2] } : { path: name }
}

/**
 * Which of a change set's pull requests a finding's file is in, as reviewers write it: "acme/web#7: src/a.ts" in any
 * capitals, "web#7: src/a.ts", the pull request's address, or the file alone (a/ and b/ as git writes them, or the whole
 * path in a checkout), which is enough when one pull request changed it. `among` is the others that could be meant: more
 * than one changed that file, or none did and it says nothing of which.
 */
export function findingPull(file: string, pulls: { id: string; repo: string; number: number }[], paths: string[]): { pull?: string; path: string; among: string[] } {
  const clean = file.trim().replace(/^[`'"]+|[`'"]+$/g, '').trim()
  const tidy = (path: string) => path.trim().replace(/^\.\//, '').replace(/^[ab]\//, '')
  const at = /^(?:https?:\/\/[^/]+\/)?([\w.-]+\/)?([\w.-]+)(?:#|\/pull\/)(\d+)\s*:\s*(.+)$/.exec(clean)
  if (at) {
    const named = pulls.find((p) => p.number === Number(at[3]) && (at[1] ? p.repo.toLowerCase() === `${at[1]}${at[2]}`.toLowerCase() : p.repo.split('/')[1]?.toLowerCase() === at[2].toLowerCase()))
    if (named) return { pull: named.id, path: tidy(at[4]), among: [] }
  }
  const path = tidy(at ? at[4] : clean)
  const inDiff = paths.map(setPath).filter((f) => f.pull)
  const lower = path.toLowerCase()
  const exact = inDiff.filter((f) => f.path === path)
  const close = exact.length ? exact : inDiff.filter((f) => f.path.toLowerCase() === lower || lower.endsWith(`/${f.path.toLowerCase()}`) || f.path.toLowerCase().endsWith(`/${lower}`))
  const candidates = [...new Set(close.map((f) => f.pull!))]
  if (candidates.length === 1) return { pull: candidates[0], path: close[0].path, among: [] }
  return { path: close[0]?.path ?? path, among: candidates }
}

/**
 * A change set as one piece of work, for its debrief and Challenge: every pull request's diff together (each file named
 * with its pull request when there are several), every card's brief, and every card's done-when points, each with its
 * card's title. Its head is all its pull requests' heads, so a new commit on any makes its debrief out of date.
 */
export function setChangeSet(state: WorkState, setId: string): CardChangeSet | undefined {
  const set = state.changeSets.find((s) => s.id === setId)
  if (!set) return undefined
  const pulls = set.prIds.map((id) => state.pulls.find((p) => p.id === id)).filter((p): p is PullRequest => !!p)
  const cardOf = (pull: PullRequest) => state.cards.find((c) => c.id === pull.cardId) ?? state.cards.find((c) => c.prId === pull.id)
  const several = pulls.length > 1
  const files = pulls.flatMap((p) => p.files.map((f) => (several ? { ...f, path: `${p.id}: ${f.path}` } : f)))
  const cards = pulls.map(cardOf).filter((c): c is Card => !!c)
  // One pull request: its own head, so what landed since can be read from GitHub; several: all of theirs.
  const head = pulls.length === 1 ? pulls[0].head : pulls.length && pulls.every((p) => p.head) ? pulls.map((p) => `${p.id}@${p.head}`).join(' ') : undefined
  return {
    card: { id: set.id, title: `Change set #${set.number}: ${set.title}`, binderId: set.binderId, stage: 'review' },
    brief: cards.map((c) => (several ? `## ${c.title}\n\n${c.brief}` : c.brief)).join('\n\n'),
    doneWhen: cards.flatMap((c) => doneWhenPoints(c.doneWhen).map((point) => `- ${several ? `${c.title}: ` : ''}${point}`)).join('\n'),
    source: pulls.length ? 'pull' : 'none',
    pull: pulls.length === 1 ? { id: pulls[0].id, repo: pulls[0].repo, number: pulls[0].number, title: pulls[0].title, url: pulls[0].url, branch: pulls[0].branch, state: pulls[0].state, checks: pulls[0].checks } : undefined,
    pulls: pulls.map((p) => {
      const card = cardOf(p)
      return { id: p.id, repo: p.repo, number: p.number, title: p.title, url: p.url, branch: p.branch, state: p.state, checks: p.checks, card: card ? { id: card.id, title: card.title } : undefined }
    }),
    files,
    added: pulls.reduce((sum, p) => sum + (p.additions ?? p.files.reduce((n, f) => n + f.added, 0)), 0),
    removed: pulls.reduce((sum, p) => sum + (p.deletions ?? p.files.reduce((n, f) => n + f.removed, 0)), 0),
    head,
    debrief: set.debrief ? { state: set.debrief.state, writtenAt: set.debrief.writtenAt, head: set.debrief.head, outOfDate: outOfDate(set.debrief, head) } : undefined,
    log: [],
  }
}

/** How much of a worktree's diff a card keeps: it travels in the log, so a huge one is cut down. */
export const diffKept = { files: 200, lines: 4000, lineLength: 400 }

/** A unified diff's lines, as the review screen draws them (a GitHub file's patch, or one file of `git diff`). */
export function patchLines(patch: string): DiffLine[] {
  // Each hunk's header says where it starts in the old file and the new: a Challenge's findings name lines by them.
  let from = 0
  let to = 0
  return patch.split('\n').filter((line) => line.length || patch.length).map((line): DiffLine => {
    const head = line[0]
    if (head === '@') {
      const at = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line)
      if (at) [from, to] = [Number(at[1]), Number(at[2])]
      return { kind: '@', text: line.replace(/^@@[^@]*@@\s?/, '') }
    }
    // "\ No newline at end of file" is about the line before it, not a line of its own.
    if (head === '\\') return { kind: ' ', text: line.slice(1) }
    if (head === '-') return { kind: head, text: line.slice(1), ...(from ? { n: from++ } : {}) }
    if (head === '+') return { kind: head, text: line.slice(1), ...(to ? { n: to++ } : {}) }
    if (from) from++
    return { kind: ' ', text: line.slice(1), ...(to ? { n: to++ } : {}) }
  })
}

/** `git diff` output as files, each with its hunks' lines, cut to what a card keeps. */
export function parseDiff(diff: string): { files: FileDiff[]; cut: boolean } {
  const files: FileDiff[] = []
  let cut = false
  let lines = 0
  for (const chunk of diff.split(/^diff --git /m).slice(1)) {
    const [header, ...rest] = chunk.split('\n')
    const to = /^\+\+\+ (?:b\/)?(.+)$/m.exec(chunk)?.[1]
    const from = /^--- (?:a\/)?(.+)$/m.exec(chunk)?.[1]
    const renamed = /^rename to (.+)$/m.exec(chunk)?.[1]
    const path = (to && to !== '/dev/null' ? to : renamed ?? (from && from !== '/dev/null' ? from : undefined)) ?? / b\/(.+)$/.exec(header)?.[1] ?? header
    const hunk = rest.findIndex((line) => line.startsWith('@@'))
    const body = hunk < 0 ? [] : rest.slice(hunk).filter((line, i, all) => !(i === all.length - 1 && line === '') && !line.startsWith('\\ '))
    const file: FileDiff = { path, added: body.filter((l) => l[0] === '+').length, removed: body.filter((l) => l[0] === '-').length, lines: [] }
    if (files.length >= diffKept.files) {
      cut = true
      break
    }
    const room = diffKept.lines - lines
    if (body.length > room) cut = true
    file.lines = patchLines(body.slice(0, Math.max(0, room)).join('\n')).map((l) => (l.text.length > diffKept.lineLength ? { ...l, text: `${l.text.slice(0, diffKept.lineLength - 1)}…` } : l))
    lines += file.lines.length
    files.push(file)
  }
  return { files, cut }
}
