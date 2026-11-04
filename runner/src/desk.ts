import { chmod, mkdir, rm, writeFile } from 'node:fs/promises'
import { connect, createServer, type Server, type Socket } from 'node:net'
import { dirname, join } from 'node:path'

/**
 * How an agent talks to Binders without MCP: a `binders` command on its PATH, which asks its runner over a socket on
 * this machine. The agent needs no config, no schema and no token: the runner holds the token, and a run's own secret
 * lets that run speak about its own card and nothing else. It works in any tool that can run a command.
 */

export interface DeskRun {
  card: string
  dir: string
}

export type DeskAnswer = { ok: true; result?: unknown; waiting?: number } | { ok: false; error: string }

/** The runner's side: the socket, the runs it knows, and what to do when one asks for something. */
export class Desk {
  private server?: Server
  private runs = new Map<string, DeskRun>()
  readonly path: string
  /** `gone`: whoever asked has stopped waiting, as a tool does when it kills its hook. */
  private handle: (run: DeskRun, verb: string, args: Record<string, unknown>, gone: AbortSignal) => Promise<{ result?: unknown; waiting?: number }>

  constructor(path: string, handle: Desk['handle']) {
    this.path = path
    this.handle = handle
  }

  add(secret: string, run: DeskRun) {
    this.runs.set(secret, run)
  }

  remove(secret: string) {
    this.runs.delete(secret)
  }

  async listen() {
    if (this.server) return
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
    await rm(this.path, { force: true })
    const server = createServer((socket) => this.serve(socket))
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(this.path, () => {
        server.off('error', reject)
        resolve()
      })
    })
    await chmod(this.path, 0o600)
    this.server = server
  }

  close() {
    this.server?.close()
    this.server = undefined
  }

  private serve(socket: Socket) {
    let text = ''
    const gone = new AbortController()
    socket.on('close', () => gone.abort())
    socket.on('error', () => {})
    socket.on('data', (data) => {
      text += data.toString('utf8')
      if (text.length > 1_000_000) return socket.destroy()
      const at = text.indexOf('\n')
      if (at < 0) return
      const line = text.slice(0, at)
      text = ''
      void this.answer(line, gone.signal).then((answer) => socket.end(`${JSON.stringify(answer)}\n`))
    })
  }

  private async answer(line: string, gone: AbortSignal): Promise<DeskAnswer> {
    try {
      const { run: secret, verb, args } = JSON.parse(line) as { run?: string; verb?: string; args?: Record<string, unknown> }
      const run = secret ? this.runs.get(secret) : undefined
      if (!run) return { ok: false, error: 'This isn’t a run its runner knows.' }
      return { ok: true, ...(await this.handle(run, String(verb), args ?? {}, gone)) }
    } catch (error) {
      return { ok: false, error: (error as Error).message }
    }
  }
}

/** The agent's `binders`, as a small script on its PATH, so it's the agent's command and not the person's. */
export async function writeShim(folder: string, node: string, runner: string) {
  await mkdir(folder, { recursive: true, mode: 0o700 })
  const file = join(folder, 'binders')
  const quote = (text: string) => `'${text.replace(/'/g, `'\\''`)}'`
  await writeFile(file, `#!/bin/sh\nexec ${quote(node)} ${quote(runner)} agent "$@"\n`, { mode: 0o755 })
  await chmod(file, 0o755)
  return file
}

function ask(path: string, secret: string, verb: string, args: Record<string, unknown>) {
  return new Promise<DeskAnswer>((resolve, reject) => {
    const socket = connect(path)
    let text = ''
    socket.on('connect', () => socket.write(`${JSON.stringify({ run: secret, verb, args })}\n`))
    socket.on('data', (data) => { text += data.toString('utf8') })
    socket.on('error', reject)
    socket.on('close', () => {
      try {
        resolve(JSON.parse(text) as DeskAnswer)
      } catch {
        reject(new Error('No answer from the runner.'))
      }
    })
  })
}

/** What it asks, retried while its runner restarts, which is a matter of seconds: the run outlives it. */
async function askPatiently(path: string, secret: string, verb: string, args: Record<string, unknown>, patience: number): Promise<DeskAnswer> {
  const until = Date.now() + patience
  for (;;) {
    try {
      return await ask(path, secret, verb, args)
    } catch (error) {
      if (Date.now() > until) throw error
      await new Promise((done) => setTimeout(done, 300))
    }
  }
}

export const agentHelp = `binders: your line to Binders, for the card you're working on.

  binders card                 the card: its brief, what done means, the conversation, its note
  binders progress TEXT        say what you're doing now, in one line (--of 0.5 for how far along)
  binders inbox                what people wrote on the card since you last looked
  binders comment TEXT         leave a comment on the card
  binders ask QUESTION         ask a person, then stop: you're started again with the answer
  binders done SUMMARY         finish the card (--pr owner/repo#12 for the pull request you opened)
  binders release WHY          give the card back, so another agent or a person can take it
  binders note ID              read a note
  binders note-append ID TEXT  add to the end of a note
  binders lesson TEXT          one line the team should know about this repo

Terminals of your own, which last beyond a command and which your team can open and watch on the card:

  binders term new COMMAND     start one (--name web, --cwd ../other-repo; with no command, a shell)
  binders term ls              the ones you have open
  binders term read NAME       what it wrote lately, as plain text (--lines 100)
  binders term send NAME TEXT  type a line into it
  binders term wait NAME       wait until it ends, or prints something (--output "ready", --seconds 60)
  binders term kill NAME       stop it

They end when your card does. Use them for what keeps running: a dev server, a watcher, a long test.

What you do is seen without reporting it: your tool steps reach the card by themselves. People can write to you while
you work. When a command says someone wrote to you, read it with binders inbox and take it into account.
Each command prints JSON or plain text, and exits 1 with why if it was refused.`

function flags(argv: string[]) {
  const words: string[] = []
  const named: Record<string, string> = {}
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--') && argv[i + 1] !== undefined) named[argv[i].slice(2)] = argv[++i]
    else words.push(argv[i])
  }
  return { words, named }
}

const hookEvents: Record<string, string> = { 'session-start': 'SessionStart', 'post-tool': 'PostToolUse', stop: 'Stop', notification: 'Notification', permission: 'PermissionRequest' }

/** What a tool's hook hands over: its JSON on stdin, when there is any, without waiting long for it. */
function hookInput(stdin: NodeJS.ReadStream) {
  if (stdin.isTTY) return Promise.resolve(undefined)
  return new Promise<unknown>((resolve) => {
    let text = ''
    const done = () => {
      clearTimeout(timer)
      stdin.removeAllListeners()
      stdin.pause()
      try {
        resolve(JSON.parse(text))
      } catch {
        resolve(undefined)
      }
    }
    const timer = setTimeout(done, 1000)
    stdin.setEncoding('utf8')
    stdin.on('data', (data) => { text += data })
    stdin.on('end', done)
    stdin.on('error', done)
  })
}

/** Words from people, as an agent reads them: framed as what they wrote on this card. */
export const framed = (messages: { by: string; text: string }[]) =>
  `People wrote on your Binders card while you were working:\n${messages.map((m) => `${m.by}: ${m.text}`).join('\n')}\nTake it into account and carry on.`

/** What the runner answers a hook with: words for the agent now, or a reason to keep it from stopping. */
export interface HookReply {
  context?: string
  block?: string
  /** A person's answer to a permission. None: it asks in its own terminal, as it would have. */
  decision?: { behavior: 'allow' } | { behavior: 'deny'; message: string }
}

/**
 * What a tool's hook runs. It never gets in the way: with no runner to ask, or nothing to say, it says nothing and the
 * tool carries on, quickly.
 */
async function hook(path: string, secret: string, which: string) {
  const event = hookEvents[which]
  if (!event) return 0
  const payload = await hookInput(process.stdin)
  const answer = await ask(path, secret, 'hook', { which, payload }).catch(() => undefined)
  const reply = (answer?.ok ? answer.result : undefined) as HookReply | undefined
  if (reply?.decision) console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: event, decision: reply.decision } }))
  else if (reply?.block) console.log(JSON.stringify({ decision: 'block', reason: reply.block }))
  else if (reply?.context) console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: reply.context } }))
  return 0
}

/** The agent's `binders`. */
export async function agentCommand(argv: string[], env: NodeJS.ProcessEnv = process.env, print: (line: string) => void = console.log, complain: (line: string) => void = console.error): Promise<number> {
  const [verb, ...rest] = argv
  if (!verb || verb === 'help' || verb === '--help' || verb === '--skill') {
    print(agentHelp)
    return 0
  }
  const { BINDERS_DESK: path, BINDERS_RUN: secret } = env
  if (!path || !secret) {
    complain('This is Binders’ command for an agent working a card, and this isn’t one of its runs.')
    return 1
  }
  if (verb === 'hook') return hook(path, secret, rest[0] ?? '')
  if (verb === 'term') {
    const [what = '', ...terms] = rest
    const { words, named } = flags(terms)
    // What it runs may have flags of its own: after the name, everything is the command's.
    const [name, ...text] = words
    const args = what === 'new' ? { ...named, command: words.join(' ') } : { ...named, name, text: text.join(' ') }
    const answer = await askPatiently(path, secret, `term-${what}`, args, Number(env.BINDERS_DESK_PATIENCE) || 120_000).catch((error: Error) => ({ ok: false as const, error: `Its runner didn’t answer: ${error.message}` }))
    if (!answer.ok) {
      complain(answer.error)
      return 1
    }
    if (answer.result !== undefined) print(typeof answer.result === 'string' ? answer.result : JSON.stringify(answer.result, null, 2))
    return 0
  }
  const { words, named } = flags(rest)
  const text = words.join(' ').trim()
  const args: Record<string, unknown> = verb === 'note' || verb === 'note-append'
    ? { id: words[0], text: words.slice(1).join(' ') }
    : { text, ...named }
  const answer = await askPatiently(path, secret, verb, args, Number(env.BINDERS_DESK_PATIENCE) || 120_000).catch((error: Error) => ({ ok: false as const, error: `Its runner didn’t answer: ${error.message}` }))
  if (!answer.ok) {
    complain(answer.error)
    return 1
  }
  if (answer.result !== undefined) print(typeof answer.result === 'string' ? answer.result : JSON.stringify(answer.result, null, 2))
  if (answer.waiting) print(`${answer.waiting === 1 ? 'Someone wrote' : `${answer.waiting} messages were written`} on your card: read it with binders inbox.`)
  return 0
}
