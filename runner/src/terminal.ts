import { spawn, type ChildProcess } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'
import { canHold, Held, heldIn, type HeldMeta } from './held.ts'
import { terminalName, type FromRunner, type TerminalInfo, type ToRunner } from '../../shared/terminal.ts'

/**
 * A pseudo-terminal through Python's pty module, which macOS and Linux have, so the runner stays one file with nothing
 * to compile. The helper starts the command on a terminal of its own, sized before it starts, passes stdin and stdout
 * through, and takes "cols rows" lines on fd 3 to resize it.
 */
const helper = String.raw`
import os, pty, sys, select, struct, fcntl, termios, signal
cols, rows = int(sys.argv[1]), int(sys.argv[2])
def size(fd, c, r):
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', r, c, 0, 0))
pid, fd = pty.fork()
if pid == 0:
    size(0, cols, rows)
    try:
        os.execvp(sys.argv[3], sys.argv[3:])
    except Exception as error:
        sys.stderr.write(str(error) + '\r\n')
        os._exit(127)
def write(to, data):
    while data:
        data = data[os.write(to, data):]
watch = [fd, 0, 3]
ctl = b''
while True:
    try:
        ready = select.select(watch, [], [])[0]
    except InterruptedError:
        continue
    if fd in ready:
        try:
            data = os.read(fd, 65536)
        except OSError:
            data = b''
        if not data:
            break
        write(1, data)
    if 0 in ready:
        data = os.read(0, 65536)
        if data:
            write(fd, data)
        else:
            watch.remove(0)
            os.kill(pid, signal.SIGHUP)
    if 3 in ready:
        data = os.read(3, 4096)
        if not data:
            watch.remove(3)
        ctl += data
        while b'\n' in ctl:
            line, ctl = ctl.split(b'\n', 1)
            try:
                c, r = line.split()
                size(fd, int(c), int(r))
                os.kill(pid, signal.SIGWINCH)
            except Exception:
                pass
status = os.waitpid(pid, 0)[1]
sys.exit(os.waitstatus_to_exitcode(status) if hasattr(os, 'waitstatus_to_exitcode') else (status >> 8))
`

/** What a terminal starts: the agent's tool, where, and what to tidy once it ends. */
export interface Started {
  command: string
  args: string[]
  cwd: string
  env: Record<string, string>
  tool: string
  /** Kept in a holder, so it outlasts the runner. */
  held?: boolean
  /** The tool's config, for a later runner to remove once it ends. */
  config?: string
  done?: () => Promise<void>
}

interface Session {
  info: TerminalInfo
  /** What it runs in: the runner's own child, or a holder that can outlast it. */
  child?: ChildProcess
  holder?: Held
  /** What it wrote, its last stretch: what someone opening it sees first. */
  scroll: string
  /** Called with how it ended, instead of the terminal tidying up after itself: a card's run has its own ending. */
  onEnd?: () => void
  /** Whether a person has typed to it, or has it open now. */
  touched?: boolean
  viewers?: number
  /** Output not sent yet, sent together a moment later: a terminal app writes in many small pieces. */
  waiting: string
  flush?: NodeJS.Timeout
  done?: () => Promise<void>
}

const keep = 400_000

/** A terminal's output as plain text: colours, cursor moves and titles out, and each line as it ended up. */
export function plainText(raw: string) {
  return raw
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[@-Z\\-_]/g, '')
    .split('\n')
    .map((line) => line.replace(/\r$/, '').split('\r').pop() ?? '')
    .join('\n')
}

/**
 * The agent's terminals on this machine, and the runner's live link to the hub for them: the hub asks for one to open,
 * passes what's typed and the window's size, and gets back what it writes. Terminals outlast the link (a hub that
 * restarts, a laptop's Wi-Fi), so someone opening one again sees it as it was.
 */
export class Terminals {
  private sessions = new Map<string, Session>()
  private socket?: WebSocket
  private stopped = false
  private wait = 1000
  private options: { hubUrl: string; token: string; version: string; log: (line: string) => void; start: (sid: string, by: string) => Promise<Started>; heldRoot?: () => string; finished?: (meta: HeldMeta) => Promise<void>; webSocket?: boolean; nodeVersion?: string }

  constructor(options: Terminals['options']) {
    this.options = options
  }

  async start() {
    await this.adopt().catch((error) => this.options.log(`Couldn’t look for terminals left running: ${(error as Error).message}`))
    // The link to the hub is Node's own WebSocket, from Node 22: on an older Node, cards work and it would only fail again each second.
    if (!(this.options.webSocket ?? typeof WebSocket !== 'undefined')) {
      this.options.log(`This runner is on Node ${this.options.nodeVersion ?? process.versions.node}. Cards work, but the terminal link to the hub needs Node 22 or newer, so terminals opened from the web app won’t reach this machine until Node is updated.`)
      return
    }
    this.link()
  }

  /** Stops it. Told to leave what's held, those carry on for the next runner, as they were. */
  stop(leaveHeld = false) {
    this.stopped = true
    this.socket?.close()
    for (const session of this.sessions.values()) {
      if (session.child) session.child.kill('SIGTERM')
      else if (leaveHeld) session.holder?.leave()
      else void session.holder?.signal('SIGTERM')
    }
  }

  /** The terminals a runner before this one left: open again, with what they wrote, for whoever comes back to them. */
  private async adopt() {
    const root = this.options.heldRoot?.()
    if (!root) return
    for (const holder of await heldIn(root)) {
      const { meta } = holder
      if (meta.kind !== 'terminal' || this.sessions.has(meta.key)) continue
      if (!(await holder.listening())) {
        // It ended, or the machine restarted under it: nothing to go back to.
        if (!meta.card) await this.options.finished?.(meta).catch(() => {})
        await holder.remove()
        continue
      }
      const session: Session = { info: { sid: meta.key, tool: meta.tool ?? 'Terminal', by: meta.by ?? '', startedAt: meta.startedAt, dir: meta.dir, ...(meta.name ? { name: meta.name } : {}), ...(meta.card ? { card: meta.card } : {}) }, holder, scroll: '', waiting: '', done: meta.card ? undefined : () => this.options.finished?.(meta) ?? Promise.resolve() }
      this.sessions.set(meta.key, session)
      this.options.log(`Picked up the terminal ${meta.by ?? ''} opened (${session.info.tool}): it outlasted the runner before this one.`)
      await this.readHeld(session, Math.max(0, (await holder.written()) - keep))
    }
  }

  /** What a holder's terminal writes, from an offset, until it ends. */
  private async readHeld(session: Session, from: number) {
    const { holder } = session
    if (!holder) return
    const out = this.writer(session)
    await holder.read(from, (data) => out(data), () => void holder.exit().then((ended) => {
      if (session.onEnd) {
        clearTimeout(session.flush)
        if (session.waiting) this.send({ type: 'output', sid: session.info.sid, data: session.waiting })
        this.sessions.delete(session.info.sid)
        this.send({ type: 'exit', sid: session.info.sid, code: ended?.code ?? null })
        this.tell()
        session.onEnd()
        return
      }
      void holder.remove()
      this.ended(session, ended?.code ?? null)
    }))
  }

  /** A card's run in a live terminal: it's on the list for its owner to open, and says when it's over. */
  async track(holder: Held, info: TerminalInfo, onEnd: () => void) {
    const session: Session = { info, holder, scroll: '', waiting: '', onEnd }
    this.sessions.set(info.sid, session)
    this.tell()
    await this.readHeld(session, Math.max(0, (await holder.written()) - keep))
    return session
  }

  /** Stops following a run being left to the next runner. */
  untrack(sid: string) {
    const session = this.sessions.get(sid)
    if (!session) return
    session.holder?.leave()
    clearTimeout(session.flush)
    this.sessions.delete(sid)
    this.tell()
  }

  /** Whether a person is there, or has been: a run they've taken over isn't ended for them. */
  personAt(sid: string) {
    return !!this.sessions.get(sid)?.touched
  }

  /** Starts a terminal for an agent as it works, on the list with its card. */
  async openFor(card: string, options: { sid: string; name: string; tool: string; by: string; argv: string[]; cwd: string; env: NodeJS.ProcessEnv }) {
    const root = this.options.heldRoot?.()
    if (!root || !canHold()) throw new Error('Terminals of its own need python3 on this machine, on macOS or Linux.')
    const startedAt = new Date().toISOString()
    const meta: HeldMeta = { kind: 'terminal', key: options.sid, dir: options.cwd, tool: options.tool, by: options.by, startedAt, name: options.name, card }
    const holder = await Held.start(root, options.sid, { argv: options.argv, cwd: options.cwd, env: options.env, mode: 'pty', cols: 120, rows: 40, meta })
    const session: Session = { info: { sid: options.sid, tool: options.tool, by: options.by, startedAt, dir: options.cwd, name: options.name, card }, holder, scroll: '', waiting: '' }
    this.sessions.set(options.sid, session)
    this.tell()
    await this.readHeld(session, 0)
    return session.info
  }

  /** The terminals an agent opened for a card, without its own run among them. */
  forCard(card: string) {
    return [...this.sessions.values()].filter((s) => s.info.card === card && !s.info.run).map((s) => s.info)
  }

  /** Those that ended while their card went on, for reading and waiting on: a short command may be over before it's asked about. */
  private over = new Map<string, Session & { code: number | null }>()

  private named(card: string, name: string, orOver = false) {
    const matches = (s: Session) => s.info.card === card && !s.info.run && (s.info.name === name || s.info.sid === name)
    const session = [...this.sessions.values()].find(matches) ?? (orOver ? [...this.over.values()].find(matches) : undefined)
    if (!session) throw new Error(`No terminal called ${name} on this card${[...this.over.values()].some(matches) ? ' still running' : ''}: binders term ls has them.`)
    return session
  }

  /** What it wrote lately, as text: the screen's colours and cursor moves left out. */
  readFor(card: string, name: string, lines = 100) {
    const session = this.named(card, name, true)
    return plainText(session.scroll + session.waiting).split('\n').slice(-Math.max(1, Math.min(2000, lines))).join('\n')
  }

  typeFor(card: string, name: string, text: string) {
    this.named(card, name).holder?.write(`${text}\r`)
  }

  async killFor(card: string, name: string) {
    await this.named(card, name).holder?.signal('SIGTERM')
  }

  /** Every terminal an agent opened for a card, stopped: the card's over. */
  async endFor(card: string) {
    // Unless a person has taken one over: it's theirs now, for them to close.
    await Promise.all([...this.sessions.values()].filter((s) => s.info.card === card && !s.info.run && !s.touched).map((s) => s.holder?.stopAndWait(3000)))
    for (const [sid, session] of this.over) if (session.info.card === card) this.over.delete(sid)
  }

  /** Waits until it ends, or prints something, or the time's up: it says which, and it's still running in that last case. */
  async waitFor(card: string, name: string, output: string | undefined, seconds: number) {
    const session = this.named(card, name, true)
    const until = Date.now() + seconds * 1000
    const from = (session.scroll + session.waiting).length
    while (Date.now() < until) {
      if (!this.sessions.has(session.info.sid)) return { state: 'ended', code: this.over.get(session.info.sid)?.code ?? null }
      if (output && plainText((session.scroll + session.waiting).slice(Math.max(0, from - 200))).includes(output)) return { state: 'printed' }
      await new Promise((done) => setTimeout(done, 100))
    }
    return { state: 'running' }
  }

  /** Output on its way to whoever has it open: a terminal app writes in many small pieces, sent together a moment later. */
  private writer(session: Session) {
    const decoder = new StringDecoder('utf8')
    return (chunk: Buffer) => {
      session.waiting += decoder.write(chunk)
      session.flush ??= setTimeout(() => {
        session.flush = undefined
        const data = session.waiting
        session.waiting = ''
        session.scroll = (session.scroll + data).slice(-keep)
        this.send({ type: 'output', sid: session.info.sid, data })
      }, 8)
    }
  }

  private ended(session: Session, code: number | null, why?: string) {
    const { sid, by, tool } = session.info
    clearTimeout(session.flush)
    if (session.waiting) this.send({ type: 'output', sid, data: session.waiting })
    this.sessions.delete(sid)
    if (session.info.card) {
      this.over.set(sid, { ...session, code })
      // Only the last few are worth keeping.
      if (this.over.size > 32) this.over.delete(this.over.keys().next().value!)
    }
    this.send({ type: 'exit', sid, code, ...(why ? { why } : code === 127 ? { why: `${tool} couldn’t start on this machine.` } : {}) })
    this.tell()
    this.options.log(`The terminal ${by} opened (${tool}) ended${code ? ` (exit ${code})` : ''}.`)
    void session.done?.().catch(() => {})
  }

  private link() {
    if (this.stopped) return
    const url = `${this.options.hubUrl.replace(/^http/, 'ws').replace(/\/$/, '')}/api/runner/live`
    let socket: WebSocket
    try {
      socket = new WebSocket(url)
    } catch {
      setTimeout(() => this.link(), this.wait)
      return
    }
    this.socket = socket
    socket.onopen = () => {
      this.wait = 1000
      this.send({ type: 'hello', token: this.options.token, version: this.options.version })
      this.tell()
    }
    socket.onmessage = (event) => {
      try {
        void this.handle(JSON.parse(String(event.data)) as ToRunner)
      } catch {
        // Not ours.
      }
    }
    socket.onclose = () => {
      if (this.socket === socket) this.socket = undefined
      if (this.stopped) return
      setTimeout(() => this.link(), this.wait)
      this.wait = Math.min(30_000, this.wait * 2)
    }
    socket.onerror = () => {
      // onclose follows, and links again.
    }
  }

  private send(message: FromRunner) {
    // Looked at only when there's a socket: with no WebSocket on this Node, there's none, and the name itself isn't there.
    if (this.socket && this.socket.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message))
  }

  /** The terminals open now, for the hub to list. */
  private tell() {
    this.send({ type: 'sessions', sessions: [...this.sessions.values()].map((s) => s.info) })
  }

  private async handle(message: ToRunner) {
    switch (message.type) {
      case 'open':
        await this.open(message.sid, message.by, message.cols, message.rows, message.viewer)
        break
      case 'attach': {
        const session = this.sessions.get(message.sid)
        if (session) this.send({ type: 'replay', sid: message.sid, viewer: message.viewer, data: session.scroll + session.waiting })
        else this.send({ type: 'exit', sid: message.sid, code: null, why: 'That terminal has ended.' })
        break
      }
      case 'input': {
        const session = this.sessions.get(message.sid)
        if (session) session.touched = true
        if (session?.holder) session.holder.write(message.data)
        else session?.child?.stdin?.write(message.data)
        break
      }
      case 'resize': {
        const session = this.sessions.get(message.sid)
        if (session?.holder) {
          session.holder.resize(message.cols, message.rows)
          break
        }
        const control = session?.child?.stdio[3] as NodeJS.WritableStream | undefined
        control?.write(`${Math.round(message.cols)} ${Math.round(message.rows)}\n`)
        break
      }
      case 'close': {
        const session = this.sessions.get(message.sid)
        if (session?.holder) void session.holder.signal('SIGTERM')
        else session?.child?.kill('SIGTERM')
        break
      }
      case 'rename': {
        const session = this.sessions.get(message.sid)
        if (!session) break
        const name = terminalName(message.name)
        session.info = { ...session.info, name: name || undefined }
        if (session.holder) {
          session.holder.meta = { ...session.holder.meta, name: name || undefined }
          void session.holder.saveMeta().catch(() => {})
        }
        this.tell()
        break
      }
    }
  }

  private async open(sid: string, by: string, cols: number, rows: number, viewer: string) {
    if (this.sessions.has(sid) || !/^[\w-]{6,40}$/.test(sid)) return
    let started: Started
    try {
      started = await this.options.start(sid, by)
    } catch (error) {
      this.send({ type: 'exit', sid, code: null, why: (error as Error).message })
      return
    }
    const env = { ...process.env, ...started.env, TERM: 'xterm-256color', COLORTERM: 'truecolor', LANG: process.env.LANG || 'en_US.UTF-8' }
    const root = this.options.heldRoot?.()
    if (started.held && root && canHold()) {
      const startedAt = new Date().toISOString()
      const meta: HeldMeta = { kind: 'terminal', key: sid, dir: started.cwd, tool: started.tool, by, startedAt, config: started.config }
      const holder = await Held.start(root, sid, { argv: [started.command, ...started.args], cwd: started.cwd, env, mode: 'pty', cols, rows, meta }).catch((error) => {
        this.options.log(`Opening a terminal without a holder: ${(error as Error).message}`)
        return undefined
      })
      if (holder) {
        const session: Session = { info: { sid, tool: started.tool, by, startedAt, dir: started.cwd }, holder, scroll: '', waiting: '', done: started.done }
        this.sessions.set(sid, session)
        this.options.log(`Opened a terminal for ${by}: ${started.tool} in ${started.cwd}, in a holder.`)
        this.tell()
        this.send({ type: 'replay', sid, viewer, data: '' })
        await this.readHeld(session, 0)
        return
      }
    }
    const child = spawn('python3', ['-c', helper, String(cols), String(rows), started.command, ...started.args], {
      cwd: started.cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
    })
    const session: Session = { info: { sid, tool: started.tool, by, startedAt: new Date().toISOString(), dir: started.cwd }, child, scroll: '', waiting: '', done: started.done }
    this.sessions.set(sid, session)
    this.options.log(`Opened a terminal for ${by}: ${started.tool} in ${started.cwd}.`)
    this.tell()
    this.send({ type: 'replay', sid, viewer, data: '' })
    const out = this.writer(session)
    child.stdout!.on('data', out)
    child.stderr!.on('data', out)
    child.stdin!.on('error', () => {})
    ;(child.stdio[3] as NodeJS.WritableStream | undefined)?.on('error', () => {})
    let failed = ''
    child.on('error', (error) => { failed = /ENOENT/.test(error.message) ? 'The terminal needs python3 on the runner’s machine, and it isn’t there.' : error.message })
    child.on('close', (code) => this.ended(session, code, failed || undefined))
  }
}
