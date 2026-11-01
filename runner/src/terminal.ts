import { spawn, type ChildProcess } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'
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
  done?: () => Promise<void>
}

interface Session {
  info: TerminalInfo
  child: ChildProcess
  /** What it wrote, its last stretch: what someone opening it sees first. */
  scroll: string
  /** Output not sent yet, sent together a moment later: a terminal app writes in many small pieces. */
  waiting: string
  flush?: NodeJS.Timeout
  done?: () => Promise<void>
}

const keep = 400_000

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
  private options: { hubUrl: string; token: string; version: string; log: (line: string) => void; start: (sid: string, by: string) => Promise<Started> }

  constructor(options: Terminals['options']) {
    this.options = options
  }

  start() {
    this.link()
  }

  stop() {
    this.stopped = true
    this.socket?.close()
    for (const session of this.sessions.values()) session.child.kill('SIGTERM')
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
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message))
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
      case 'input':
        this.sessions.get(message.sid)?.child.stdin?.write(message.data)
        break
      case 'resize': {
        const session = this.sessions.get(message.sid)
        const control = session?.child.stdio[3] as NodeJS.WritableStream | undefined
        control?.write(`${Math.round(message.cols)} ${Math.round(message.rows)}\n`)
        break
      }
      case 'close':
        this.sessions.get(message.sid)?.child.kill('SIGTERM')
        break
      case 'rename': {
        const session = this.sessions.get(message.sid)
        if (!session) break
        const name = terminalName(message.name)
        session.info = { ...session.info, name: name || undefined }
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
    const child = spawn('python3', ['-c', helper, String(cols), String(rows), started.command, ...started.args], {
      cwd: started.cwd,
      env: { ...process.env, ...started.env, TERM: 'xterm-256color', COLORTERM: 'truecolor', LANG: process.env.LANG || 'en_US.UTF-8' },
      stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
    })
    const session: Session = { info: { sid, tool: started.tool, by, startedAt: new Date().toISOString(), dir: started.cwd }, child, scroll: '', waiting: '', done: started.done }
    this.sessions.set(sid, session)
    this.options.log(`Opened a terminal for ${by}: ${started.tool} in ${started.cwd}.`)
    this.tell()
    this.send({ type: 'replay', sid, viewer, data: '' })
    const decoder = new StringDecoder('utf8')
    const out = (chunk: Buffer) => {
      session.waiting += decoder.write(chunk)
      session.flush ??= setTimeout(() => {
        session.flush = undefined
        const data = session.waiting
        session.waiting = ''
        session.scroll = (session.scroll + data).slice(-keep)
        this.send({ type: 'output', sid, data })
      }, 8)
    }
    child.stdout!.on('data', out)
    child.stderr!.on('data', out)
    child.stdin!.on('error', () => {})
    ;(child.stdio[3] as NodeJS.WritableStream | undefined)?.on('error', () => {})
    let failed = ''
    child.on('error', (error) => { failed = /ENOENT/.test(error.message) ? 'The terminal needs python3 on the runner’s machine, and it isn’t there.' : error.message })
    child.on('close', (code) => {
      clearTimeout(session.flush)
      if (session.waiting) this.send({ type: 'output', sid, data: session.waiting })
      this.sessions.delete(sid)
      this.send({ type: 'exit', sid, code, ...(failed ? { why: failed } : code === 127 ? { why: `${started.tool} couldn’t start on this machine.` } : {}) })
      this.tell()
      this.options.log(`The terminal ${by} opened (${started.tool}) ended${code ? ` (exit ${code})` : ''}.`)
      void session.done?.().catch(() => {})
    })
  }
}
