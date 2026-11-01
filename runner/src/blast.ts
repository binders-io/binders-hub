import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { BlastRadius, BlastSymbol } from '../../shared/changeSet.ts'

// A change's blast radius, for a Challenge: what it changed (functions, types, exports), and where else the code uses
// those, outside the change itself, and which tests mention them. Worked out on this machine, in the folder the
// reviewer reads, with git alone: declarations found by their shape in the diff and its hunks' headers (which name the
// function a hunk is in), uses found by `git grep -w`. A first cut, not a compiler: a name used for two things counts
// both, and a use through a string or a re-export under another name is missed.

const run = promisify(execFile)

/** A file of the change as the hub gives it: its path ("owner/repo#7: path" in a change set) and its numbered diff. */
export interface DiffFile {
  path: string
  diff: string
}

const declarations: RegExp[] = [
  /\b(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/,
  /\b(?:export\s+)?(?:abstract\s+|final\s+|public\s+|open\s+)*class\s+([A-Za-z_$][\w$]*)/,
  /\b(?:export\s+)?(?:declare\s+)?(?:interface|type|enum)\s+([A-Za-z_$][\w$]*)/,
  /\bexport\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/,
  /\b(?:func|def|fn)\s+([A-Za-z_][\w]*)/,
  /\b(?:struct|protocol|trait)\s+([A-Za-z_][\w]*)/,
  // A method: "name(…) {" or "async name(…): T {" at the start of a line.
  /^\s*(?:(?:public|private|protected|static|readonly|async|override|get|set)\s+)*([A-Za-z_$][\w$]*)\s*(?:<[^>()]*>)?\s*\([^()]*\)\s*(?::[^{=;]+)?\{\s*$/,
]
/** Words that look like a declaration's name but aren't one, or are too common to follow. */
const skip = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'else', 'do', 'try', 'function', 'constructor', 'init', 'main', 'render', 'toString', 'default', 'index', 'test', 'it', 'describe', 'get', 'set', 'new', 'with', 'self', 'super', 'this'])

const declared = (text: string) => {
  for (const pattern of declarations) {
    const name = pattern.exec(text)?.[1]
    if (name && name.length >= 3 && !skip.has(name)) return name
  }
  return undefined
}

/** A file is a test by where it is and what it's called, in the usual layouts. */
export const isTest = (file: string) => /(^|\/)(tests?|__tests__|spec|specs|Tests|[A-Za-z]+Tests)\//.test(file) || /\.(test|spec)\.[a-z]+$|_test\.[a-z]+$|(^|\/)test_[^/]+\.py$|Tests?\.swift$/i.test(file)

/** Where a change set names a file: its pull request, its repo and its path. */
const located = (path: string) => {
  const at = /^([\w.-]+\/[\w.-]+)#\d+: (.+)$/.exec(path)
  return at ? { repo: at[1], path: at[2] } : { repo: undefined, path }
}

interface Parsed {
  file: string
  repo?: string
  added: Set<string>
  removed: Set<string>
  /** Declarations whose bodies the change touched: named by the hunks' headers. */
  touched: Set<string>
  /** The text of every line it adds or removes, to tell its own lines from uses elsewhere. */
  lines: Set<string>
  /** Words on its added lines, for tests it adds. */
  words: string
}

function parse(file: DiffFile): Parsed {
  const { repo, path } = located(file.path)
  const parsed: Parsed = { file: path, repo, added: new Set(), removed: new Set(), touched: new Set(), lines: new Set(), words: '' }
  let context: string | undefined
  let changed = false
  const close = () => {
    if (context && changed) {
      const name = declared(context)
      if (name) parsed.touched.add(name)
    }
  }
  for (const line of file.diff.split('\n')) {
    if (line.startsWith('@@')) {
      close()
      context = line.slice(2).trim()
      changed = false
      continue
    }
    const at = /^\s*\d* ([ +-])(.*)$/.exec(line)
    if (!at) continue
    const [, kind, text] = at
    if (kind === ' ') continue
    changed = true
    parsed.lines.add(text.trim())
    const name = declared(text)
    if (kind === '+') {
      parsed.words += ` ${text}`
      if (name) parsed.added.add(name)
    } else if (name) parsed.removed.add(name)
  }
  close()
  return parsed
}

/**
 * The blast radius of a change, in `dir` (a checkout of `repo`): its changed symbols, each with its uses outside the
 * change and the tests that mention it. Files of other repos (a change set across repos) are named in `elsewhere`,
 * as this machine can't search them.
 */
export async function blastRadius(files: DiffFile[], dir: string, repo?: string, limits = { symbols: 60, uses: 15 }): Promise<BlastRadius> {
  const parsed = files.map(parse)
  const here = (p: Parsed) => !p.repo || !repo || p.repo.toLowerCase() === repo.toLowerCase()
  const elsewhere = [...new Set(parsed.filter((p) => !here(p)).map((p) => p.repo!))]
  const local = parsed.filter(here)

  // Each name once: removed and added in the change is a changed signature; a body it touched is changed too.
  const found = new Map<string, { file: string; change: BlastSymbol['change'] }>()
  for (const p of local) {
    for (const name of p.removed) found.set(name, { file: p.file, change: p.added.has(name) ? 'changed' : 'removed' })
    for (const name of p.added) if (!found.has(name)) found.set(name, { file: p.file, change: 'added' })
    for (const name of p.touched) if (!found.has(name)) found.set(name, { file: p.file, change: 'changed' })
  }
  // Something added in one file and removed from another moved: it's changed, not gone.
  for (const [name, entry] of found) if (entry.change === 'removed' && local.some((p) => p.added.has(name))) found.set(name, { ...entry, change: 'changed' })
  const order: Record<BlastSymbol['change'], number> = { removed: 0, changed: 1, added: 2 }
  const names = [...found.entries()].sort((a, b) => order[a[1].change] - order[b[1].change]).slice(0, limits.symbols)

  const own = new Map(local.map((p) => [p.file, p.lines]))
  const symbols: BlastSymbol[] = []
  for (const [name, { file, change }] of names) {
    const hits = await run('git', ['-C', dir, 'grep', '-n', '-w', '-I', '--full-name', '-e', name], { maxBuffer: 8 * 1024 * 1024 })
      .then((r) => r.stdout.split('\n').filter(Boolean), () => [] as string[])
    const uses: BlastSymbol['uses'] = []
    const tests = new Set<string>()
    let more = 0
    for (const hit of hits) {
      const at = /^([^:]+):(\d+):(.*)$/.exec(hit)
      if (!at) continue
      const [, path, line, text] = at
      // The change's own lines (and its declaration) aren't uses elsewhere.
      if (own.get(path)?.has(text.trim()) || declared(text) === name) continue
      if (isTest(path)) {
        tests.add(path)
        continue
      }
      if (uses.length < limits.uses) uses.push({ file: path, line: Number(line), text: text.trim().slice(0, 160) })
      else more++
    }
    // Tests the change adds that mention it count too.
    for (const p of local) if (isTest(p.file) && new RegExp(`\\b${name.replace(/\$/g, '\\$')}\\b`).test(p.words)) tests.add(p.file)
    symbols.push({ name, file, change, uses, ...(more ? { more } : {}), tests: [...tests].slice(0, 10) })
  }
  return {
    at: new Date().toISOString(),
    repo,
    symbols,
    outside: symbols.reduce((n, s) => n + s.uses.length + (s.more ?? 0), 0),
    stillUsed: symbols.filter((s) => s.change === 'removed' && s.uses.length > 0).length,
    untested: symbols.filter((s) => s.change !== 'removed' && !s.tests.length).length,
    ...(elsewhere.length ? { elsewhere } : {}),
    ...(found.size > names.length ? { cut: found.size - names.length } : {}),
  }
}

/** The blast radius in a few plain lines, for a reviewer that reads a prompt rather than the hub's tools. */
export function blastSummary(blast: BlastRadius) {
  if (!blast.symbols.length) return 'Blast radius: no functions, types or exports found in the change.'
  const lines = [`Blast radius (found by name with git grep, so check before trusting it): ${blast.symbols.length} changed symbols, ${blast.outside} uses outside the change, ${blast.stillUsed} removed but still used, ${blast.untested} with no test that mentions them.`]
  for (const s of blast.symbols.filter((x) => x.uses.length || x.change === 'removed').slice(0, 25)) {
    lines.push(`- ${s.name} (${s.change}, ${s.file}): ${s.uses.length ? s.uses.slice(0, 5).map((u) => `${u.file}:${u.line}`).join(', ') + (s.uses.length + (s.more ?? 0) > 5 ? ` and ${s.uses.length + (s.more ?? 0) - 5} more` : '') : 'no other uses'}${s.tests.length ? '' : ' · no tests'}`)
  }
  if (blast.elsewhere?.length) lines.push(`Not searched (not on this machine): ${blast.elsewhere.join(', ')}.`)
  return lines.join('\n')
}
