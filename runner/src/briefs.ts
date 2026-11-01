import { execFile } from 'node:child_process'
import { rm } from 'node:fs/promises'
import { promisify } from 'node:util'

// A repo's brief on the runner's side: a checkout of its default branch for the agent writing it, what changed since
// the last one, and the brief as it goes at the top of every prompt for work or a review in that repo.

const run = promisify(execFile)
const git = (args: string[], cwd: string) => run('git', args, { cwd, maxBuffer: 16 * 1024 * 1024 }).then((r) => r.stdout.trim())

/** What get_repo_brief gives. */
export interface BriefRead {
  repo: string
  text?: string
  none?: string
  written_from?: string
  written_at?: string
  written_by?: string
  lessons?: { at: string; by: string; text: string }[]
  /** The team's other notes for the repo: its folder in Repo docs, and Repo docs itself. */
  docs?: { folder: string; notes: { id: string; title: string; text: string; cut?: boolean }[]; more?: string }
  ask?: { state: string; by?: string; refresh?: boolean }
}

/** The team's notes for a repo, as they go in a prompt. */
function docsLines(docs: BriefRead['docs'], lessonsTool: boolean) {
  if (!docs?.notes.length) return []
  return [
    `The team's notes for it, in ${docs.folder} and ${docs.folder.split(' / ')[0]} (read them as part of the brief):`,
    ...docs.notes.map((n) => `<repo-doc title=${JSON.stringify(n.title)}>\n${n.text.trim()}${n.cut ? `\n[cut short${lessonsTool ? `: get_note (id ${n.id}) has all of it` : ''}]` : ''}\n</repo-doc>`),
    ...(docs.more ? [`(${docs.more})`] : []),
  ]
}

/** What wait_for_work gives for a brief to write. */
export interface BriefJSON {
  kind: 'brief'
  id: string
  repo: string
  refresh?: boolean
  asked_by?: string
  written_from?: string
  lessons?: number
}

/** Commits on the default branch since a brief was written before it's written again. */
export const refreshAfterCommits = 25
/** Days before it's written again however little moved, and lessons waiting to be folded in. */
export const refreshAfterDays = 30
export const refreshAfterLessons = 10

/** The default branch as the clone's origin has it now: its name and commit. */
async function defaultBranch(clone: string) {
  await git(['fetch', '--quiet', 'origin'], clone).catch(() => '')
  const head = await git(['rev-parse', '--abbrev-ref', 'origin/HEAD'], clone).catch(() => '')
  const ref = head && head !== 'origin/HEAD' ? head
    : (await git(['rev-parse', '--verify', '-q', 'origin/main'], clone).then(() => 'origin/main', () => ''))
      || (await git(['rev-parse', '--verify', '-q', 'origin/master'], clone).then(() => 'origin/master', () => ''))
      || 'HEAD'
  return { ref, sha: await git(['rev-parse', ref], clone) }
}

/**
 * A checkout of a repo's default branch, apart from the clone's own folder (whatever it has checked out, and whatever's
 * changed there, stays as it is), for the agent writing its brief. Gone with `remove`.
 */
export async function briefCheckout(clone: string, into: string) {
  const { ref, sha } = await defaultBranch(clone)
  await git(['worktree', 'add', '--detach', '--quiet', into, sha], clone)
  return { dir: into, sha, branch: ref.replace(/^origin\//, ''), remove: () => git(['worktree', 'remove', '--force', into], clone).then(() => {}, () => rm(into, { recursive: true, force: true })) }
}

/** What the default branch changed since a brief was written: its commits and the files they touched. Undefined when the clone doesn't have that commit. */
export async function changesSince(dir: string, from: string, to: string) {
  if (!(await git(['cat-file', '-e', `${from}^{commit}`], dir).then(() => true, () => false))) return undefined
  const count = Number(await git(['rev-list', '--count', `${from}..${to}`], dir).catch(() => '0')) || 0
  if (!count) return { count, log: '', stat: '' }
  const log = await git(['log', '--no-merges', '--format=%h %s', '-n', '150', `${from}..${to}`], dir).catch(() => '')
  const stat = await git(['diff', '--stat=120', '--stat-count=80', from, to], dir).catch(() => '')
  return { count, log, stat }
}

/** How many commits the default branch is past the one a brief was written from, from what the clone fetched last. */
export async function behindBy(clone: string, sha: string) {
  const { ref } = await defaultBranch(clone).catch(() => ({ ref: 'HEAD' }))
  const count = await git(['rev-list', '--count', `${sha}..${ref}`], clone).catch(() => '')
  return count ? Number(count) : undefined
}

/** Whether a brief is due to be written again: far behind, old, or with many lessons waiting. */
export function briefDue(brief: BriefRead, behind: number | undefined, now = Date.now()) {
  const days = brief.written_at ? (now - Date.parse(brief.written_at)) / 86_400_000 : 0
  return (behind ?? 0) >= refreshAfterCommits || days >= refreshAfterDays || (brief.lessons?.length ?? 0) >= refreshAfterLessons
}

const sections = [
  '## What it is: a few lines on what it does and who uses it.',
  '## Map: its areas, a line or two each, with their paths: what lives where, the entry points, how a request or a job goes through it, and where its state is kept.',
  '## Rules it keeps: what the code relies on that a change could quietly break. Security and isolation (who may see and do what, and where that\'s checked), data that must never be lost, ordering, what older clients, data or callers still need. Each with the file that keeps it.',
  '## Build, test, run: the exact commands, how long they take, what they need (services, tools on the machine, settings by name), what\'s flaky, and what CI or a deploy runs before a change goes out.',
  '## Where it breaks: fragile areas, past bugs and what caused them, and what looks wrong but is on purpose.',
  '## Conventions: how code here is written (naming, comments, errors, tests, commits), so a change fits in.',
  '## Reviewing a change here: what a reviewer should check on any change to this repo, most important first.',
]

/** The prompt for an agent writing a repo's brief: read the repo, write it to a file, change nothing. */
export function briefPrompt(options: { name: string; job: BriefJSON; dir: string; sha: string; branch: string; answer: string; before?: BriefRead; since?: { count: number; log: string; stat: string } }) {
  const { name, job, dir, sha, branch, answer, before, since } = options
  const again = !!before?.text
  const lessons = before?.lessons ?? []
  return [
    `You're ${name}, one of this team's agents. ${job.asked_by ?? 'A person'} asked you to ${again ? 'write again' : 'write'} the repo brief for ${job.repo}: what an agent should know before it works or reviews code here, so it starts as an engineer who has worked in this repo for months would, rather than from nothing. Every agent that takes a card or reviews work in ${job.repo} gets it at the top of its prompt, so what you write decides how well they do.`,
    '',
    `The repo is checked out in ${dir}, at ${sha.slice(0, 12)} on ${branch}, its default branch. Read it and change nothing. Don't commit, push, or install anything outside ${dir}. You may run its tests when that's quick and safe, to learn what they need and how long they take.`,
    '',
    ...(again ? [
      `There's a brief already, written from ${before!.written_from?.slice(0, 12) ?? 'an earlier commit'}${before!.written_at ? ` on ${before!.written_at.slice(0, 10)}` : ''}:`,
      '<old-brief>',
      before!.text!,
      '</old-brief>',
      since ? (since.count ? `\nSince then, ${since.count} commit${since.count === 1 ? '' : 's'} on ${branch}:\n${since.log}\n\nThe files they touched:\n${since.stat}` : '\nNothing has changed on the default branch since.') : '\nThis clone doesn\'t have the commit it was written from, so check all of it against the code.',
      '',
      'Start from it: read what those commits changed, correct what is no longer true, add what\'s new, and keep what\'s still right. Check anything you keep against the code; don\'t carry a claim over because it was there. It\'s kept as a note that people can edit, so keep what a person wrote there unless the code shows it\'s wrong.',
    ] : [
      'How to go about it:',
      '1. The shape first: the README and any docs, CLAUDE.md, AGENTS.md or CONTRIBUTING, the manifests (package.json, go.mod, pyproject.toml, Cargo.toml and the like), the Dockerfile and CI workflows, and the folder layout.',
      '2. Then the code that matters most: the entry points, how a request or a job goes through, where state is kept, and where permissions are checked.',
      '3. The history: git log over the last few hundred commits, for the areas that change most and for fixes and reverts. Those are where things break.',
      '4. The tests: how they\'re run, what they cover and what they need.',
    ]),
    ...(before?.docs?.notes.length ? ['', ...docsLines(before.docs, false), 'The brief should agree with these notes, or say where the code no longer does. Don\'t copy them into it: agents get them beside it.'] : []),
    ...(lessons.length ? ['', 'Lessons agents and people added since the last brief. Fold in each that holds up against the code, and drop any that doesn\'t:', ...lessons.map((l) => `- ${l.text} (${l.by})`)] : []),
    '',
    `Write the brief in Markdown to ${answer}, at most 14,000 characters, with these sections:`,
    ...sections,
    '',
    'Write what\'s true of this code, specific enough to check: paths, names, commands. Leave out anything that would be true of any repo ("write tests", "handle errors"). If you aren\'t sure of something, leave it out or say it\'s unsure. Put first, in each section, what an agent would most regret not knowing.',
    'Never copy a secret: no tokens, keys, passwords or private addresses from config or .env files. Name the setting, never its value.',
    `Write it to that file and stop: the runner sends it, and it's kept as the note "Brief" in Repo docs / ${job.repo}, saved to the repo with the team's notes. Don't send it with send_repo_brief yourself.`,
  ].join('\n')
}

/** A repo's brief as it goes at the top of a prompt for work or a review there. Empty when there's none and nothing learned. */
export function briefSection(brief: BriefRead | undefined, options: { behind?: number; lessonsTool: boolean }) {
  if (!brief) return ''
  const lessons = brief.lessons ?? []
  const addLesson = options.lessonsTool ? `When you learn something the next agent in ${brief.repo} should know (a command that fails and what works instead, a rule the code keeps that isn't written down, a trap), say it in one line with add_repo_lesson (repo ${brief.repo}).` : ''
  const docs = docsLines(brief.docs, options.lessonsTool)
  if (!brief.text) {
    if (!lessons.length && !docs.length) return addLesson ? `${addLesson}\n` : ''
    return [`What this team knows about ${brief.repo} (it has no brief yet; where this and the code disagree, the code is right):`, ...docs, ...(lessons.length ? ['What agents have learned there:', ...lessons.map((l) => `- ${l.text}`)] : []), addLesson, ''].filter(Boolean).join('\n')
  }
  const from = brief.written_from ? ` from ${brief.written_from.slice(0, 7)}` : ''
  const ago = options.behind ? `, ${options.behind} commit${options.behind === 1 ? '' : 's'} behind its default branch` : ''
  return [
    `What this team knows about ${brief.repo}, from its brief (written by ${brief.written_by ?? 'an agent'}${from}${ago}). Read it before you start, so you work as someone who knows this repo would. Where it and the code disagree, the code is right.`,
    `<repo-brief repo="${brief.repo}">`,
    brief.text,
    '</repo-brief>',
    ...(lessons.length ? ['Learned since it was written:', ...lessons.map((l) => `- ${l.text}`)] : []),
    ...docs,
    addLesson,
    '',
  ].filter((line, i, all) => line !== '' || i === all.length - 1).join('\n')
}
