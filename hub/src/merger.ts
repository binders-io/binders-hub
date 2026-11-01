import { execFile } from 'node:child_process'
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

// Bringing a pull request up to date with its base when GitHub can't do it alone: the hub keeps a working copy of the
// repo, merges the base into the pull request's branch, and settles the conflicts that have one right answer, where
// both sides only added lines at the same place (two new routes, list entries, CSS rules), or one side only added lines
// next to what the other changed. A conflict where both sides changed the same lines is left for an agent. Nothing is
// ever forced.

export interface Resolution {
  /** Merged and pushed: the pull request now has its base in it. */
  pushed: boolean
  /** Files where both sides' additions were kept. */
  kept: string[]
  /** Files with conflicts it couldn't settle: someone has to. */
  left: string[]
}

export interface MergerOptions {
  /** Where the working copies live. */
  dir: string
  /** The repo's address and a token that can push to it. */
  access: (repo: string) => Promise<{ url: string; token: string } | undefined>
  author: { name: string; email: string }
}

export class Merger {
  private options: MergerOptions
  /** One repo at a time: a working copy has one checkout. */
  private queues = new Map<string, Promise<unknown>>()

  constructor(options: MergerOptions) {
    this.options = options
  }

  /** Merges `base` into `head` and pushes, settling additions on both sides; reports what it couldn't settle. */
  pullBaseInto(repo: string, base: string, head: string): Promise<Resolution> {
    const before = this.queues.get(repo) ?? Promise.resolve()
    const next = before.catch(() => undefined).then(() => this.merge(repo, base, head))
    this.queues.set(repo, next.catch(() => undefined))
    return next
  }

  private async merge(repo: string, base: string, head: string): Promise<Resolution> {
    const target = await this.options.access(repo)
    if (!target) throw new Error(`The hub can’t reach ${repo}.`)
    const dir = join(this.options.dir, repo.replace('/', '__'))
    // The token goes in a header from the environment, never on git's command line.
    const auth: Record<string, string> = /^https?:/.test(target.url)
      ? { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: `http.${new URL(target.url).origin}/.extraheader`, GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${target.token}`).toString('base64')}` }
      : {}
    const { name, email } = this.options.author
    const git = (args: string[], network = false) => run('git', ['-c', 'commit.gpgsign=false', '-c', 'merge.conflictstyle=diff3', ...args], {
      cwd: dir, maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, ...(network ? auth : {}), GIT_CEILING_DIRECTORIES: this.options.dir, GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: email, GIT_TERMINAL_PROMPT: '0' },
    })
    if (!(await access(join(dir, '.git')).then(() => true, () => false))) {
      await mkdir(dir, { recursive: true })
      await git(['init', '-q'])
      await git(['remote', 'add', 'origin', target.url])
    }
    await git(['fetch', '-q', '--no-tags', 'origin', `+refs/heads/${base}:refs/remotes/origin/${base}`, `+refs/heads/${head}:refs/remotes/origin/${head}`], true)
    await git(['checkout', '-q', '-f', '-B', 'binders-merge', `origin/${head}`])
    await git(['clean', '-fdq'])
    const merged = await git(['merge', '--no-ff', '--no-edit', '-m', `Bring ${base} into ${head}`, `origin/${base}`]).then(() => true, () => false)
    if (merged) {
      await git(['push', '-q', 'origin', `HEAD:refs/heads/${head}`], true)
      return { pushed: true, kept: [], left: [] }
    }
    const conflicted = (await git(['diff', '--name-only', '--diff-filter=U'])).stdout.split('\n').filter(Boolean)
    const kept: string[] = []
    const left: string[] = []
    for (const file of conflicted) {
      const text = await readFile(join(dir, file), 'utf8').catch(() => undefined)
      const settled = text !== undefined && !text.includes('\u0000') ? keepBothAdditions(text) : undefined
      if (settled === undefined) {
        left.push(file)
        continue
      }
      await writeFile(join(dir, file), settled)
      await git(['add', '--', file])
      kept.push(file)
    }
    if (left.length) {
      await git(['merge', '--abort']).catch(() => undefined)
      return { pushed: false, kept: [], left }
    }
    await git(['commit', '-q', '--no-edit', '-m', `Bring ${base} into ${head}\n\nBoth sides added lines in ${kept.join(', ')}; both are kept.`])
    await git(['push', '-q', 'origin', `HEAD:refs/heads/${head}`], true)
    return { pushed: true, kept, left: [] }
  }
}

/** Whether `side` is `ancestor` kept as it was, with lines only added before and after it: those lines, if so. */
function onlyAdded(ancestor: string[], side: string[]): { before: string[]; after: string[] } | undefined {
  for (let start = 0; start + ancestor.length <= side.length; start++) {
    if (ancestor.every((line, k) => side[start + k] === line)) return { before: side.slice(0, start), after: side.slice(start + ancestor.length) }
  }
  return undefined
}

/**
 * One conflict, settled when it has one right answer: both sides only added lines (the base's first), or one side only
 * added lines around what was there, which go around the other side's change. Undefined when both changed what was
 * there.
 */
export function settleHunk(ancestor: string[], ours: string[], theirs: string[]): string[] | undefined {
  if (!ancestor.some((l) => l.trim())) return [...theirs, ...ours]
  const oursAdded = onlyAdded(ancestor, ours)
  if (oursAdded) return [...oursAdded.before, ...theirs, ...oursAdded.after]
  const theirsAdded = onlyAdded(ancestor, theirs)
  if (theirsAdded) return [...theirsAdded.before, ...ours, ...theirsAdded.after]
  return undefined
}

/**
 * A file with diff3 conflict markers, settled where every conflict is two additions at the same place (the common
 * ancestor had nothing there): the base's lines, then the pull request's. Undefined if any conflict changed lines that
 * were there before, as that needs someone who knows what both sides meant.
 */
export function keepBothAdditions(text: string): string | undefined {
  const lines = text.split('\n')
  const out: string[] = []
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith('<<<<<<< ')) {
      out.push(lines[i])
      continue
    }
    const ours: string[] = []
    const ancestor: string[] = []
    const theirs: string[] = []
    let part: string[] = ours
    let sawAncestor = false
    let j = i + 1
    for (; j < lines.length; j++) {
      const line = lines[j]
      if (line.startsWith('||||||| ')) { part = ancestor; sawAncestor = true }
      else if (line === '=======') part = theirs
      else if (line.startsWith('>>>>>>> ')) break
      else part.push(line)
    }
    // Unclosed markers, or no common ancestor section (not diff3): not ours to settle.
    if (j >= lines.length || part !== theirs || !sawAncestor) return undefined
    // "Ours" is the pull request's branch (checked out), "theirs" the base being brought in.
    const settled = settleHunk(ancestor, ours, theirs)
    if (!settled) return undefined
    out.push(...settled)
    i = j
  }
  return out.join('\n')
}
