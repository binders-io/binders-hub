import { spawn, type ChildProcess } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { join, resolve } from 'node:path'

// A sandbox of the hub's own: the machines it keeps for agents that have none. Each job is one agent's machine: a clone
// of its repo and a Binders runner started there, with a token of the agent's, as a machine of someone's would be. The
// hub takes each step of its model, so nothing here holds a model key, and nothing here is a Binder's own data.
//
//   binders-runner sandbox --port 4500 --root /var/lib/binders/sandboxes
//
// The hub at the other end of it sets BINDERS_SANDBOX_URL and BINDERS_SANDBOX_SECRET; here, the secret is read from
// BINDERS_SANDBOX_SECRET too, so the two ends agree and nothing else may start a runner.

interface Job {
  id: string
  name?: string
  hub: string
  token: string
  /** The repos to clone, each with the token to clone it, and the folder in the machine it goes in. */
  clones: { url: string; dir: string }[]
  branch?: string
}

/** One machine here: its folder, its token file, and the runner it started. */
interface Running {
  id: string
  dir: string
  tokenFile: string
  /** Where each clone's GitHub token is kept, for its git to read: renewed by the hub, as the tokens last an hour. */
  gitDir: string
  process: ChildProcess
  since: string
}

const most = 64 * 1024
const jobs = new Map<string, Running>()

const say = (line: string) => console.log(line)

/** A job as it was sent: an id, a hub, a token and something to clone, all of them text and none of them huge. */
function jobFrom(body: unknown): Job {
  const asked = body as Partial<Job> | null
  const text = (value: unknown, most: number) => (typeof value === 'string' && value.trim() && value.length <= most ? value.trim() : undefined)
  const id = text(asked?.id, 120)
  const hub = text(asked?.hub, 500)
  const token = text(asked?.token, 500)
  if (!id || !/^[\w.-]+$/.test(id)) throw new Error('A job needs an id of letters, digits, dots, dashes or underscores.')
  if (!hub || !/^https?:\/\//.test(hub)) throw new Error('A job needs the hub’s address.')
  if (!token) throw new Error('A job needs the agent’s token.')
  if (!Array.isArray(asked?.clones) || !asked.clones.length || asked.clones.length > 12) throw new Error('A job needs something to clone: one repo, or up to twelve.')
  const clones = asked.clones.map((clone) => {
    const url = text(clone?.url, 2000)
    const dir = text(clone?.dir, 120)
    if (!url) throw new Error('A job needs something to clone.')
    if (!dir || !/^[\w.-]+$/.test(dir) || dir === '.' || dir === '..') throw new Error('A repo’s folder is letters, digits, dots, dashes or underscores.')
    return { url, dir }
  })
  return { id, hub, token, clones, name: text(asked?.name, 120), branch: text(asked?.branch, 200) }
}

/** The clones a job names, as sent: checked as a job's are, for the hub's renewed tokens. */
function clonesFrom(body: unknown): Job['clones'] {
  const asked = body as { clones?: unknown } | null
  if (!Array.isArray(asked?.clones) || !asked.clones.length || asked.clones.length > 12) throw new Error('Name the clones, one to twelve.')
  return asked.clones.map((clone: { url?: unknown; dir?: unknown }) => {
    const url = typeof clone?.url === 'string' && clone.url.length <= 2000 ? clone.url.trim() : ''
    const dir = typeof clone?.dir === 'string' ? clone.dir.trim() : ''
    if (!url || !/^[\w.-]+$/.test(dir) || dir === '.' || dir === '..') throw new Error('A clone is a url and a folder of letters, digits, dots, dashes or underscores.')
    return { url, dir }
  })
}

/**
 * A clone's address without its token, and the token: the remote keeps the one, and a file the other. Git uses a token
 * in the remote's address before asking any helper, so one left there would be used after its hour is up, for every
 * fetch and push, and be on the disk for whatever reads .git/config.
 */
export function splitToken(url: string): { url: string; token?: string } {
  const found = /^(https?:\/\/)([^@/]*)@(.*)$/.exec(url)
  if (!found) return { url }
  const secret = found[2]!.includes(':') ? found[2]!.slice(found[2]!.indexOf(':') + 1) : found[2]
  return { url: `${found[1]}${found[3]}`, token: secret ? decodeURIComponent(secret) : undefined }
}

/** Keeps a clone's token where its git reads it: a file only this user reads. */
async function keepToken(gitDir: string, dir: string, token: string | undefined) {
  if (!token) return
  await fs.mkdir(gitDir, { recursive: true, mode: 0o700 })
  await fs.writeFile(join(gitDir, dir), token, { mode: 0o600 })
}

async function body(request: IncomingMessage): Promise<unknown> {
  let text = ''
  for await (const chunk of request) {
    text += chunk
    if (text.length > most) throw new Error('That is more than a job is.')
  }
  try {
    return JSON.parse(text || '{}')
  } catch {
    throw new Error('A job is JSON.')
  }
}

function answer(response: ServerResponse, status: number, value: unknown) {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  response.writeHead(status, { 'content-type': typeof value === 'string' ? 'text/plain; charset=utf-8' : 'application/json' })
  response.end(text)
}

/** Runs a command to its end, and gives what it said: for the clone, which is done before the runner starts. */
function run(line: string, args: string[], env: NodeJS.ProcessEnv = process.env): Promise<{ code: number | null; out: string }> {
  return new Promise((done) => {
    const child = spawn(line, args, { stdio: ['ignore', 'pipe', 'pipe'], env })
    let out = ''
    child.stdout.on('data', (chunk: Buffer) => { out += chunk.toString('utf8') })
    child.stderr.on('data', (chunk: Buffer) => { out += chunk.toString('utf8') })
    child.on('error', (error) => done({ code: null, out: `${out}\n${error.message}` }))
    child.on('close', (code) => done({ code, out }))
  })
}

/** The runner to start here: this program, as it was started. A test's stand-in is named instead. */
function runnerFile(): string {
  return process.env.BINDERS_SANDBOX_RUNNER || process.argv[1]
}

/**
 * One agent's machine, started: its repo cloned into a folder of its own, then the Binders runner there, with its token
 * in a file only this process and the runner read. The runner is the same program a machine of someone's runs, so what
 * it does reaches the hub as any machine's does.
 */
async function machine(job: Job, root: string): Promise<Running> {
  const dir = join(root, job.id)
  const tokenFile = join(root, `${job.id}.token`)
  const gitDir = join(root, `${job.id}.git`)
  // Started again, it starts from a clone of its own: what it held before is the runner's to hand back, not to keep.
  await fs.rm(dir, { recursive: true, force: true })
  await fs.mkdir(root, { recursive: true })
  // One repo is the machine itself; more are a folder of repos, each in a folder of its own, as a runner lays them out.
  const one = job.clones.length === 1
  for (const clone of job.clones) {
    const where = one ? dir : join(dir, clone.dir)
    if (!one) await fs.mkdir(join(dir, clone.dir), { recursive: true })
    const made = await run('git', ['clone', '--depth', '1', ...(job.branch ? ['--branch', job.branch] : []), clone.url, where])
    if (made.code !== 0) throw new Error(`Couldn’t clone ${clone.url.replace(/\/\/[^@]*@/, '//')}: ${made.out.trim().slice(-500).replace(/\/\/[^@\s]*@/g, '//')}`)
    // Its remote without the token, and its git reading the token from a file the hub renews: the runner's own fetches
    // (before a card's worktree, for a brief) work past the hour, and a card's run puts its own helper first.
    const split = splitToken(clone.url)
    await keepToken(gitDir, clone.dir, split.token)
    const tokenAt = join(gitDir, clone.dir).replace(/'/g, `'\\''`)
    const helper = `!f() { test "$1" = get || exit 0; test -r '${tokenAt}' || exit 0; echo username=x-access-token; printf 'password=%s\\n' "$(cat '${tokenAt}')"; }; f`
    // An empty helper first clears any the machine has (a global one would answer before this one), then this one.
    for (const args of [['remote', 'set-url', 'origin', split.url], ['config', '--replace-all', 'credential.helper', ''], ['config', '--add', 'credential.helper', helper]]) {
      const set = await run('git', ['-C', where, ...args])
      if (set.code !== 0) throw new Error(`Couldn’t set up ${split.url}: ${set.out.trim().slice(-300)}`)
    }
  }
  await fs.writeFile(tokenFile, job.token, { mode: 0o600 })
  // Whatever a command here runs reads this environment: the secret that starts machines, and the stand-in a test uses,
  // are not in it.
  const env = { ...process.env }
  delete env.BINDERS_SANDBOX_SECRET
  delete env.BINDERS_SANDBOX_RUNNER
  const child = spawn(process.execPath, [runnerFile(), '--hub', job.hub, '--workspace', dir, '--token-file', tokenFile, ...(job.name ? ['--name', job.name] : [])], { stdio: ['ignore', 'pipe', 'pipe'], env })
  const label = job.name ?? job.id
  child.stdout.on('data', (chunk: Buffer) => process.stdout.write(`[${label}] ${chunk.toString('utf8')}`))
  child.stderr.on('data', (chunk: Buffer) => process.stderr.write(`[${label}] ${chunk.toString('utf8')}`))
  const running: Running = { id: job.id, dir, tokenFile, gitDir, process: child, since: new Date().toISOString() }
  jobs.set(job.id, running)
  child.on('close', (code) => {
    // A runner that ends is a machine gone: the next job for it starts a new one. Its token goes with it, so a token no
    // machine of the hub's is using isn't left on the disk.
    if (jobs.get(job.id) === running) jobs.delete(job.id)
    void fs.rm(tokenFile, { force: true }).catch(() => undefined)
    void fs.rm(gitDir, { recursive: true, force: true }).catch(() => undefined)
    say(`The machine for ${label} ended${code === null ? '' : ` (${code})`}.`)
  })
  return running
}

async function stop(id: string): Promise<boolean> {
  const running = jobs.get(id)
  if (!running) return false
  jobs.delete(id)
  const child = running.process
  await new Promise<void>((done) => {
    if (child.exitCode !== null) return done()
    const kill = setTimeout(() => child.kill('SIGKILL'), 5_000)
    kill.unref?.()
    child.once('close', () => { clearTimeout(kill); done() })
    child.kill('SIGTERM')
  })
  await fs.rm(running.tokenFile, { force: true })
  await fs.rm(running.gitDir, { recursive: true, force: true })
  return true
}

/** What the hub calls: a job started, a job stopped, and what is here. */
export async function sandboxCommand(args: string[]) {
  const option = (name: string, fallback?: string) => {
    const at = args.indexOf(name)
    return at >= 0 ? args[at + 1] : fallback
  }
  const port = Number(option('--port', process.env.BINDERS_SANDBOX_PORT ?? '4500'))
  const host = option('--host', '0.0.0.0')!
  const root = resolve(option('--root', process.env.BINDERS_SANDBOX_ROOT ?? '/tmp/binders-sandboxes')!)
  const secret = option('--secret', process.env.BINDERS_SANDBOX_SECRET)
  if (!secret) {
    console.error('A sandbox needs a secret: set BINDERS_SANDBOX_SECRET, the same as the hub’s.')
    process.exit(1)
  }
  await fs.mkdir(root, { recursive: true })
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://sandbox')
    // A health check is how the hub's compose knows the sandbox is up: it says nothing of what is here.
    if (request.method === 'GET' && url.pathname === '/health') return answer(response, 200, { ok: true })
    // Only the hub starts machines here, and it says so with the secret both ends hold.
    if (request.headers.authorization !== `Bearer ${secret}`) return answer(response, 401, { error: 'Not the hub.' })
    try {
      if (request.method === 'GET' && url.pathname === '/jobs') return answer(response, 200, { jobs: [...jobs.values()].map((j) => ({ id: j.id, since: j.since, pid: j.process.pid })) })
      if (request.method === 'POST' && url.pathname === '/jobs') {
        const job = jobFrom(await body(request))
        // The same agent again is a fresh machine: its own is stopped and another started, as its token has changed.
        await stop(job.id)
        const running = await machine(job, root)
        say(`Keeping a machine for ${job.name ?? job.id} (pid ${running.process.pid}).`)
        return answer(response, 202, { id: job.id, pid: running.process.pid })
      }
      // The hub's renewed GitHub tokens for a machine's clones: written where their git reads them.
      const renewed = /^\/jobs\/([\w.-]+)\/credentials$/.exec(url.pathname)
      if (request.method === 'PUT' && renewed) {
        const running = jobs.get(renewed[1]!)
        if (!running) return answer(response, 404, { error: 'No machine for that agent.' })
        for (const clone of clonesFrom(await body(request))) await keepToken(running.gitDir, clone.dir, splitToken(clone.url).token)
        return answer(response, 204, '')
      }
      const stopped = /^\/jobs\/([\w.-]+)$/.exec(url.pathname)
      if (request.method === 'DELETE' && stopped) {
        const id = stopped[1]!
        const there = await stop(id)
        // A machine that ended by itself is taken away as it stands: its clone and its token go too.
        if (!there) {
          await fs.rm(join(root, id), { recursive: true, force: true })
          await fs.rm(join(root, `${id}.token`), { force: true })
          await fs.rm(join(root, `${id}.git`), { recursive: true, force: true })
        }
        return answer(response, there ? 204 : 404, there ? '' : { error: 'No machine for that agent.' })
      }
      return answer(response, 404, { error: 'Nothing here.' })
    } catch (error) {
      return answer(response, 422, { error: error instanceof Error ? error.message : 'That didn’t work.' })
    }
  })
  await new Promise<void>((done) => server.listen(port, host, done))
  console.log(`Binders sandbox on http://${host}:${port}, keeping machines in ${root}.`)
  const leaving = async () => {
    await Promise.all([...jobs.keys()].map((id) => stop(id).catch(() => undefined)))
    server.close()
    process.exit(0)
  }
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => void leaving())
  // It stays: the hub's machines are as long-lived as the hub is.
  await new Promise<void>(() => undefined)
}

