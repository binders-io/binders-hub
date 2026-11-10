import { execFile } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { gunzip, gzip } from 'node:zlib'
import { emptyState, type HubState } from '../../shared/state.ts'
import type { Binder } from '../../shared/notes.ts'
import { Refused, type Hub } from './hub.ts'
import { writeWhole, type SavedState } from './kept.ts'
import { log } from './logger.ts'
import { pushEnv, type PushTarget } from './savers/gitNotes.ts'
import type { Member } from './spaces.ts'

// A Binder's copy: its whole state and its notes' documents in one gzip file of JSON, to download, to keep a week of on
// the hub's disk, to push to GitHub and to start a new Binder from. One place makes it and reads it, so all four agree.
// What isn't in it: the Binder's connections (its GitHub App, Jira, the channel it tells) and every token. Those live in
// the hub's own store, which nothing here reads, and the state is only the Binder's log applied.

const run = promisify(execFile)
const gzipped = promisify(gzip)
const gunzipped = promisify(gunzip)

export const copyFormat = 1
/** The most a copy sent to start a Binder from may be, and the most it may come to once unpacked. */
export const copyLimit = 200 * 1024 * 1024
const unpackedLimit = 400 * 1024 * 1024
/** The branch of the Binder's repo a daily copy is pushed to. */
export const copiesBranch = 'binders-copies'

const days = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']
const hour = 60 * 60_000

export interface CopyMeta {
  format: number
  binder: { id: string; name: string }
  madeAt: string
  version: number
  hub: string
  counts: { notes: number; cards: number; changeSets: number; agents: number }
  people: { login: string; role: string }[]
}

/** A copy read: what it says about itself, its state, and each note's document. */
export interface Copy {
  meta: CopyMeta
  state: HubState
  docs: Map<string, Uint8Array>
}

/** Who a copy is of: the Binder's address and name, and the people in it. */
export interface CopyOf {
  id: string
  name: string
  people: Member[]
}

/** A copy's name for a day: the Binder's address, and the date. */
export const copyName = (id: string, at: Date) => `${id}-${at.toISOString().slice(0, 10)}.binder-copy.json.gz`

/**
 * The Binder as it is now, as the bytes of a copy. The state and the documents are taken in one go, so they agree; the
 * rest happens off the event loop. Only the text of the state is held while it's packed.
 */
export async function makeCopy(hub: Hub, of: CopyOf, now = new Date()): Promise<{ bytes: Buffer; version: number }> {
  const version = hub.version
  const state = hub.state
  const meta: CopyMeta = {
    format: copyFormat,
    binder: { id: of.id, name: of.name },
    madeAt: now.toISOString(),
    version,
    hub: process.env.BINDERS_COMMIT?.slice(0, 7) ?? 'dev',
    counts: { notes: state.notes.length, cards: state.cards.length, changeSets: state.changeSets.length, agents: state.agents.length },
    people: of.people.map(({ login, role }) => ({ login, role })),
  }
  const docs: Record<string, string> = {}
  for (const [noteId, bytes] of hub.heldDocs()) docs[noteId] = Buffer.from(bytes).toString('base64')
  const text = Buffer.concat([`{"copy":${JSON.stringify(meta)},"state":`, JSON.stringify(state), `,"docs":${JSON.stringify(docs)}}`].map((part) => Buffer.from(part)))
  return { bytes: await gzipped(text), version }
}

const notACopy = 'That isn’t a Binders copy. Choose a file made by “Download a copy”, which ends in .binder-copy.json.gz.'
const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const withIds = (value: unknown) => Array.isArray(value) && value.every((item) => object(item) && typeof item.id === 'string')

/** Reads a copy's bytes, checking what it is before anything is made of it. Refuses in words. */
export async function readCopy(bytes: Buffer): Promise<Copy> {
  let text: string
  try {
    text = (await gunzipped(bytes, { maxOutputLength: unpackedLimit })).toString('utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE') throw new Refused(`That copy is too large once it’s unpacked: ${unpackedLimit / 1024 / 1024} MB is the most.`)
    throw new Refused(notACopy)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Refused(notACopy)
  }
  if (!object(parsed) || !object(parsed.copy) || typeof parsed.copy.format !== 'number') throw new Refused(notACopy)
  const { copy, state, docs } = parsed
  if (copy.format !== copyFormat) throw new Refused(`That copy is in a format this hub doesn’t know (${copy.format}). A hub as new as the one that made it can start a Binder from it.`)
  const damaged = (what: string) => new Refused(`That copy is damaged: ${what}.`)
  if (!object(copy.binder) || typeof copy.binder.name !== 'string') throw damaged('it doesn’t say which Binder it is of')
  if (typeof copy.madeAt !== 'string' || !Number.isInteger(copy.version) || (copy.version as number) < 0) throw damaged('it doesn’t say when it was made')
  if (!object(state)) throw damaged('it has no state')
  for (const part of ['binders', 'folders', 'notes', 'cards', 'agents', 'changeSets'] as const) {
    if (state[part] !== undefined && !withIds(state[part])) throw damaged(`its ${part} aren’t a list of things with ids`)
  }
  if (!Array.isArray(state.binders) || !Array.isArray(state.notes)) throw damaged('it has no binders or notes')
  if (docs !== undefined && (!object(docs) || !Object.values(docs).every((doc) => typeof doc === 'string'))) throw damaged('its notes’ documents aren’t text')
  return {
    meta: copy as unknown as CopyMeta,
    state: { ...emptyState(), ...(state as unknown as HubState) },
    docs: new Map(Object.entries((docs ?? {}) as Record<string, string>).map(([noteId, doc]) => [noteId, new Uint8Array(Buffer.from(doc, 'base64'))])),
  }
}

/**
 * The state a Binder made from a copy starts with. It starts paused, so it can sit beside the original without writing
 * over it: its notes aren't pushed, its cards aren't kept as issues, review comments aren't posted and copies aren't
 * pushed, and every agent is revoked, as none of their tokens came with the copy. Its repo stays named, so its cards
 * still link to their pull requests. The Binder is named as it's asked to be: a Binder goes by its one binder's name.
 */
export function pausedState(copy: Copy, name: string): SavedState {
  const state = copy.state
  const only = state.binders.length === 1
  state.binders = state.binders.map((binder: Binder) => ({ ...binder, ...(only ? { name } : {}), notes: false, issues: false, reviewComments: false, copies: false }))
  state.agents = state.agents.map((agent) => ({ ...agent, revoked: true }))
  return { version: copy.meta.version, state }
}

/** When a copy was taken, as a sentence has it. */
export const takenOn = (madeAt: string) => {
  const at = new Date(madeAt)
  return Number.isNaN(at.getTime()) ? madeAt : at.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })
}

// Seven days on the hub's disk ---------------------------------------------------------------------------------------

/** What's written beside the copies: which is newest, when it was made, how big it is and at what version. */
export interface Latest {
  file: string
  at: string
  bytes: number
  version: number
  hub: string
}

/** The last push of the copies: when, of which copy and to which repo, or what went wrong. */
interface Pushed {
  at?: string
  copyAt?: string
  repo?: string
  failed?: string
}

export interface CopyStatus {
  latest?: { at: string; bytes: number; version: number }
  /** How many days' copies are on the disk now. */
  days: number
  /** Whether the Binder keeps them in its repo, and how the last push went. Missing for a Binder with no repo. */
  inRepo?: { on: boolean; repo: string; branch: string; at?: string; failed?: string }
}

export interface KeeperOptions {
  /** The folder the copies are written in. */
  dir: string
  hub: Hub
  of: () => CopyOf
  /** Where the copies go in GitHub for a binder, as for its notes: undefined for none. It may throw, in words. */
  pushTo?: (binder: Binder) => Promise<Omit<PushTarget, 'branch'> | undefined>
  author: { name: string; email: string }
}

/** One copy is written at a time across the hub: a hub with thousands of Binders doesn't pack them all in one minute. */
let writing = false

const dayFile = /^copy-(mon|tue|wed|thu|fri|sat|sun)\.binder-copy\.json\.gz$/

/** The day a copy is of: a day turns at 03:00 in the hub's own time, so what's written before then is the day before's. */
const copyDay = (at: Date) => new Date(at.getTime() - 3 * hour)
const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()

/**
 * Once a day for a Binder that changed since its last copy, it writes the Binder's copy for the day of the week, over
 * last week's, and says which is newest in latest.json. It's asked on the scheduler's tick. A day turns at 03:00 in the
 * hub's own time, when a hub is quietest, so that's when a day's copy is made; a Binder with none yet has its first at
 * once. It never runs twice at once, and a copy that fails is logged and tried again in an hour. When the Binder says so, the copies are then pushed to its repo as one commit on a branch of
 * their own. Nothing here stops or slows the hub: every failure ends here, in the log.
 */
export class CopyKeeper {
  private options: KeeperOptions
  private loaded = false
  private latest?: Latest
  private pushed?: Pushed
  private working?: Promise<void>
  private retryAt = 0
  private pushRetryAt = 0

  constructor(options: KeeperOptions) {
    this.options = options
  }

  /** Looks at whether a copy, or a push, is due; does it if so. Never throws, and never starts while another is under way. */
  tick(now = new Date()): Promise<void> {
    if (this.working) return this.working
    const done = this.pass(now).catch((err: Error) => log.warn({ err, binder: this.options.of().id }, 'A Binder’s daily copy failed')).finally(() => {
      if (this.working === done) this.working = undefined
    })
    this.working = done
    return done
  }

  /** Waits for what's under way. */
  async stop() {
    await this.working
  }

  private async load() {
    if (this.loaded) return
    this.loaded = true
    const read = async <T>(name: string) => JSON.parse(await readFile(join(this.options.dir, name), 'utf8')) as T
    this.latest = await read<Latest>('latest.json').catch(() => undefined)
    this.pushed = await read<Pushed>('pushed.json').catch(() => undefined)
  }

  /** The binder whose switch is on, with a repo to push to. */
  private pushing(): Binder | undefined {
    return this.options.hub.state.binders.find((b) => b.copies === true && b.repo)
  }

  private copyDue(now: Date) {
    const { hub } = this.options
    if (now.getTime() < this.retryAt) return false
    if (!this.latest) return true
    return hub.version !== this.latest.version && !sameDay(copyDay(now), copyDay(new Date(this.latest.at)))
  }

  private pushDue(now: Date, binder: Binder | undefined) {
    if (!binder || !this.latest || !this.options.pushTo || now.getTime() < this.pushRetryAt) return false
    return !(this.pushed?.copyAt === this.latest.at && this.pushed.repo === binder.repo && !this.pushed.failed)
  }

  private async pass(now: Date) {
    await this.load()
    const binder = this.pushing()
    const copy = this.copyDue(now)
    if (!copy && !this.pushDue(now, binder)) return
    if (writing) return
    writing = true
    try {
      if (copy && !(await this.write(now))) return
      const again = this.pushing()
      if (this.pushDue(now, again)) await this.push(now, again!)
    } finally {
      writing = false
    }
  }

  /** Writes today's copy. False when it couldn't: said in the log, and tried again in an hour. */
  private async write(now: Date): Promise<boolean> {
    const { dir, hub, of } = this.options
    try {
      const { bytes, version } = await makeCopy(hub, of(), now)
      await mkdir(dir, { recursive: true, mode: 0o700 })
      const file = `copy-${days[copyDay(now).getDay()]}.binder-copy.json.gz`
      await writeWhole(join(dir, file), bytes)
      const latest: Latest = { file, at: now.toISOString(), bytes: bytes.length, version, hub: process.env.BINDERS_COMMIT?.slice(0, 7) ?? 'dev' }
      await writeWhole(join(dir, 'latest.json'), JSON.stringify(latest))
      this.latest = latest
      this.retryAt = 0
      return true
    } catch (err) {
      this.retryAt = now.getTime() + hour
      log.warn({ err, binder: of().id }, 'Couldn’t write a Binder’s daily copy: trying again in an hour')
      return false
    }
  }

  private async push(now: Date, binder: Binder) {
    const { dir, pushTo, author, of } = this.options
    const repo = binder.repo!
    let target: Omit<PushTarget, 'branch'> | undefined
    try {
      target = await pushTo!(binder)
      if (!target) {
        this.pushRetryAt = now.getTime() + hour
        return
      }
      await pushCopies(dir, { ...target, branch: copiesBranch }, author, `Copies of ${of().name}, as of ${now.toISOString().slice(0, 10)}`)
      this.pushed = { at: now.toISOString(), copyAt: this.latest!.at, repo }
      this.pushRetryAt = 0
    } catch (error) {
      const failed = pushWords(error as Error, target?.name ?? repo)
      this.pushed = { ...this.pushed, copyAt: this.latest!.at, repo, failed }
      this.pushRetryAt = now.getTime() + hour
      log.warn({ binder: of().id, why: failed }, 'Pushing a Binder’s copies failed')
    }
    await writeWhole(join(dir, 'pushed.json'), JSON.stringify(this.pushed)).catch(() => undefined)
  }

  /** What the Settings screen shows: the newest copy, how many days there are, and how the push to the repo stands. */
  async status(): Promise<CopyStatus> {
    await this.load()
    const names = await readdir(this.options.dir).catch(() => [] as string[])
    const binder = this.pushing() ?? this.options.hub.state.binders.find((b) => b.repo)
    const on = binder?.copies === true
    const pushed = on && this.pushed?.repo === binder?.repo ? this.pushed : undefined
    return {
      ...(this.latest ? { latest: { at: this.latest.at, bytes: this.latest.bytes, version: this.latest.version } } : {}),
      days: names.filter((name) => dayFile.test(name)).length,
      ...(binder?.repo ? { inRepo: { on, repo: binder.repo, branch: copiesBranch, ...(pushed?.at ? { at: pushed.at } : {}), ...(pushed?.failed ? { failed: pushed.failed } : {}) } } : {}),
    }
  }
}

// Pushing to GitHub ---------------------------------------------------------------------------------------------------

/**
 * The folder's copies as one commit on the target's branch, force-pushed, so the branch never holds more than the
 * seven files. It's made in a throwaway Git folder beside the copies, with the token in the environment as the notes
 * are pushed, never on Git's command line.
 */
export async function pushCopies(dir: string, target: PushTarget, author: { name: string; email: string }, message: string) {
  const names = (await readdir(dir)).filter((name) => dayFile.test(name) || name === 'latest.json')
  if (!names.length) throw new Error('No copies to push yet.')
  const work = await mkdtemp(join(dirname(dir), '.push-'))
  try {
    for (const name of names) await copyFile(join(dir, name), join(work, name))
    const env = { ...process.env, ...pushEnv(target), GIT_CEILING_DIRECTORIES: dirname(work), GIT_TERMINAL_PROMPT: '0', GIT_AUTHOR_NAME: author.name, GIT_AUTHOR_EMAIL: author.email, GIT_COMMITTER_NAME: author.name, GIT_COMMITTER_EMAIL: author.email }
    const git = (...args: string[]) => run('git', ['-c', 'commit.gpgsign=false', ...args], { cwd: work, env, timeout: 3 * 60_000, maxBuffer: 4 * 1024 * 1024 })
    await git('init', '-q', '-b', target.branch)
    await git('add', '-A')
    await git('commit', '-q', '-m', message)
    await git('push', '-q', '--force', target.url, `HEAD:refs/heads/${target.branch}`)
  } finally {
    await rm(work, { recursive: true, force: true })
  }
}

/** What went wrong with a push, in a sentence: never the command line, which names the repo's address. */
function pushWords(error: Error, name: string) {
  const said = String((error as { stderr?: string }).stderr || error.message)
  if (/403|denied|not found|404|Authentication failed/i.test(said)) return `The hub can’t write to ${name}: is the GitHub App installed there, with contents write?`
  if (/protected branch|GH006/i.test(said)) return `${copiesBranch} on ${name} is protected, so the hub can’t replace it. Take the protection off that branch.`
  return said.split('\n').map((line) => line.trim()).find((line) => line && !line.startsWith('Command failed'))?.slice(0, 200) ?? 'Pushing the copies failed.'
}
