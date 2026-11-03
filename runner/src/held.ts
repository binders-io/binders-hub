import { spawn } from 'node:child_process'
import { chmod, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { connect, type Socket } from 'node:net'
import { uptime } from 'node:os'
import { join } from 'node:path'

/**
 * What the runner starts lives in a small process of its own, a holder, and not as the runner's child: the runner can
 * stop, update or crash and the agent carries on, and the next runner picks it up where it was. A holder keeps what its
 * program writes in a file, and serves that file over a socket from wherever a reader asks, so nothing is lost while
 * nobody is reading, and the file is all the buffer a slow reader needs.
 *
 * It's Python for the reason the runner's terminals already are: macOS and Linux have its pty module, and the runner
 * stays one file with nothing to compile. In its folder:
 *
 *   meta.json  what the runner wants to remember about it
 *   s          the socket: send {"from": offset} and receive what it wrote from there, as it writes
 *   out, err   what it wrote (a pty's whole stream is out)
 *   pid        the holder's and the program's process ids
 *   exit       how it ended, written once it has
 */
const holder = String.raw`
import base64, fcntl, json, os, pty, select, signal, socket, struct, sys, termios, time
home, mode, cols, rows = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4])
argv = sys.argv[5:]
keep = int(os.environ.pop('BINDERS_HOLDER_KEEP', str(64 * 1024 * 1024)))
def size(fd, c, r):
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', r, c, 0, 0))
def run():
    try:
        os.execvp(argv[0], argv)
    except Exception as error:
        os.write(2, (str(error) + '\r\n').encode())
        os._exit(127)
sources = {}
if mode == 'pty':
    pid, fd = pty.fork()
    if pid == 0:
        size(0, cols, rows)
        run()
    sources[fd] = 'out'
    to_program = fd
else:
    out_r, out_w = os.pipe()
    err_r, err_w = os.pipe()
    in_r, in_w = os.pipe()
    pid = os.fork()
    if pid == 0:
        os.setsid()
        os.dup2(in_r, 0); os.dup2(out_w, 1); os.dup2(err_w, 2)
        for f in (in_r, in_w, out_r, out_w, err_r, err_w):
            os.close(f)
        run()
    for f in (in_r, out_w, err_w):
        os.close(f)
    sources[out_r] = 'out'
    sources[err_r] = 'err'
    to_program = in_w
os.set_blocking(to_program, False)
out_path = os.path.join(home, 'out')
out = os.open(out_path, os.O_CREAT | os.O_WRONLY | os.O_APPEND, 0o600)
reader = os.open(out_path, os.O_RDONLY)
err = os.open(os.path.join(home, 'err'), os.O_CREAT | os.O_WRONLY | os.O_APPEND, 0o600)
written = 0
base = 0
def drop_old():
    global out, reader, base
    length = written - base
    if length <= keep:
        return
    start = length - keep // 2
    tail = os.pread(reader, keep, start)
    next_path = out_path + '.next'
    next_file = os.open(next_path, os.O_CREAT | os.O_TRUNC | os.O_WRONLY | os.O_APPEND, 0o600)
    os.write(next_file, tail)
    os.replace(next_path, out_path)
    os.close(out); os.close(reader)
    out = next_file
    reader = os.open(out_path, os.O_RDONLY)
    base += start
    with open(os.path.join(home, 'base'), 'w') as f:
        f.write(str(base))
listener = socket.socket(socket.AF_UNIX)
path = os.path.join(home, 's')
try:
    os.unlink(path)
except OSError:
    pass
listener.bind(path)
os.chmod(path, 0o600)
listener.listen(8)
listener.setblocking(False)
with open(os.path.join(home, 'pid.next'), 'w') as f:
    json.dump({'holder': os.getpid(), 'program': pid}, f)
os.replace(os.path.join(home, 'pid.next'), os.path.join(home, 'pid'))
def group(sig):
    try:
        os.killpg(pid, sig)
    except OSError:
        pass
signal.signal(signal.SIGHUP, signal.SIG_IGN)
signal.signal(signal.SIGINT, signal.SIG_IGN)
signal.signal(signal.SIGPIPE, signal.SIG_IGN)
signal.signal(signal.SIGTERM, lambda *_: group(signal.SIGTERM))
clients = {}
waiting_in = b''
status = None
ended_at = None
def finish(status):
    code, sig = None, None
    if os.WIFEXITED(status):
        code = os.WEXITSTATUS(status)
    elif os.WIFSIGNALED(status):
        sig = os.WTERMSIG(status)
    with open(os.path.join(home, 'exit.next'), 'w') as f:
        json.dump({'code': code, 'signal': sig}, f)
    os.replace(os.path.join(home, 'exit.next'), os.path.join(home, 'exit'))
def drop(client):
    clients.pop(client, None)
    try:
        client.close()
    except OSError:
        pass
def heard(client, line):
    global waiting_in
    try:
        message = json.loads(line)
    except ValueError:
        return
    if 'from' in message:
        clients[client]['pos'] = max(base, min(written, int(message['from'])))
        clients[client]['reading'] = True
    elif message.get('t') == 'i':
        waiting_in += base64.b64decode(message['d'])
    elif message.get('t') == 'r' and mode == 'pty':
        try:
            size(to_program, int(message['c']), int(message['r']))
            os.killpg(pid, signal.SIGWINCH)
        except (OSError, ValueError):
            pass
    elif message.get('t') == 's':
        group(int(message['s']))
while True:
    wanting = [c for c, s in clients.items() if s['reading'] and s['pos'] < written]
    if waiting_in and to_program is not None:
        wanting.append(to_program)
    try:
        readable, writable, _ = select.select([listener, *sources, *clients], wanting, [], 0.25)
    except InterruptedError:
        continue
    for fd in readable:
        if fd is listener:
            try:
                client, _ = listener.accept()
                client.setblocking(False)
                clients[client] = {'pos': 0, 'line': b'', 'reading': False}
            except OSError:
                pass
        elif fd in sources:
            try:
                data = os.read(fd, 65536)
            except OSError:
                data = b''
            if not data:
                del sources[fd]
                continue
            if sources[fd] == 'out':
                os.write(out, data)
                written += len(data)
                drop_old()
            else:
                os.write(err, data)
        elif fd in clients:
            try:
                data = fd.recv(65536)
            except OSError:
                data = b''
            if not data:
                drop(fd)
                continue
            clients[fd]['line'] += data
            while fd in clients and b'\n' in clients[fd]['line']:
                line, clients[fd]['line'] = clients[fd]['line'].split(b'\n', 1)
                heard(fd, line)
    for fd in writable:
        if fd == to_program:
            try:
                waiting_in = waiting_in[os.write(fd, waiting_in):]
            except OSError:
                waiting_in = b''
        elif fd in clients:
            state = clients[fd]
            state['pos'] = max(state['pos'], base)
            try:
                state['pos'] += fd.send(os.pread(reader, 65536, state['pos'] - base))
            except BlockingIOError:
                pass
            except OSError:
                drop(fd)
    if status is None:
        done, result = os.waitpid(pid, os.WNOHANG)
        if done:
            status = result
            ended_at = time.time()
    if status is not None:
        # Whatever it left running may hold its output open: a moment for the last of it, then it's over.
        if sources and time.time() - ended_at < 2:
            continue
        for fd in list(sources):
            del sources[fd]
        if not os.path.exists(os.path.join(home, 'exit')):
            finish(status)
        behind = [s for s in clients.values() if s['reading'] and s['pos'] < written]
        if not behind or time.time() - ended_at > 10:
            break
try:
    os.unlink(path)
except OSError:
    pass
`

export interface HeldMeta {
  /** What it's for: a card's run, or a terminal someone opened. */
  kind: 'card' | 'terminal'
  /** The card, or the terminal's id. */
  key: string
  dir: string
  tool?: string
  by?: string
  startedAt: string
  /** The tool's config, to remove once it's over. */
  config?: string
  /** The folder holding the card's GitHub token, for the next runner to go on renewing. */
  github?: string
  /** People's words on the card when the run started, so what they write while no runner is watching is still heard. */
  before?: number
  /** What its owner called it, for a terminal. */
  name?: string
  /** The card a terminal was opened for. */
  card?: string
  /** A card's run as a live terminal, whose output is a screen and not a stream. */
  live?: boolean
  /** The run's secret for the agent’s binders command. */
  desk?: string
}

export interface HeldExit {
  code: number | null
  /** The signal's name, or number on the way from the holder. */
  signal: number | null
}

const socketRoom = 100

/** One held program, whether started just now or found again. */
export class Held {
  readonly home: string
  meta: HeldMeta
  private socket?: Socket

  constructor(home: string, meta: HeldMeta) {
    this.home = home
    this.meta = meta
  }

  /** Starts a program in a holder of its own, and returns once the holder is listening. */
  static async start(root: string, id: string, options: { argv: string[]; cwd: string; env: NodeJS.ProcessEnv; mode: 'pty' | 'pipe'; cols?: number; rows?: number; meta: HeldMeta }) {
    const home = join(root, id)
    if (Buffer.byteLength(join(home, 's')) > socketRoom) throw new Error('This machine’s path to the runner’s folder is too long for a socket.')
    await mkdir(home, { recursive: true, mode: 0o700 })
    await chmod(home, 0o700)
    const held = new Held(home, options.meta)
    await held.saveMeta()
    const child = spawn('python3', ['-c', holder, home, options.mode, String(options.cols ?? 100), String(options.rows ?? 30), ...options.argv], {
      cwd: options.cwd,
      env: options.env,
      detached: true,
      stdio: 'ignore',
    })
    let failed: Error | undefined
    child.on('error', (error) => {
      failed = /ENOENT/.test(error.message) ? new Error('Holding a run needs python3 on this machine, and it isn’t there.') : error
    })
    let ended = false
    child.on('exit', () => { ended = true })
    child.unref()
    for (let tries = 0; tries < 200; tries++) {
      if (failed) throw failed
      if (await held.listening()) return held
      if (ended && !(await held.exit())) throw new Error('Its holder stopped before it started.')
      if (ended) return held
      await new Promise((done) => setTimeout(done, 25))
    }
    throw new Error('Its holder didn’t start.')
  }

  async saveMeta() {
    const next = join(this.home, 'meta.next')
    await writeFile(next, JSON.stringify(this.meta), { mode: 0o600 })
    await rename(next, join(this.home, 'meta.json'))
  }

  private dial() {
    return new Promise<Socket>((resolve, reject) => {
      const socket = connect(join(this.home, 's'))
      socket.once('connect', () => { socket.off('error', reject); resolve(socket) })
      socket.once('error', reject)
    })
  }

  /** Whether a holder is there to answer. */
  async listening() {
    const socket = await this.dial().catch(() => undefined)
    socket?.destroy()
    return !!socket
  }

  /**
   * Reads what it wrote from an offset, then as it writes. onEnd says it's over: it ended (exit says how), or its holder
   * is gone (exit says nothing: the machine restarted, say). With no holder to ask, the file is read as it stands.
   */
  async read(from: number, onData: (data: Buffer) => void, onEnd: () => void) {
    this.socket?.destroy()
    const socket = await this.dial().catch(() => undefined)
    // What's left in the file, for when no holder is there, or it went before sending it all.
    const rest = async (at: number) => {
      const whole = await readFile(join(this.home, 'out')).catch(() => Buffer.alloc(0))
      const skip = Math.max(0, at - (await this.base()))
      if (skip < whole.length) onData(whole.subarray(skip))
      onEnd()
    }
    if (!socket) return rest(from)
    this.socket = socket
    let at = from
    socket.on('data', (data: Buffer) => {
      at += data.length
      onData(data)
    })
    socket.on('error', () => {})
    socket.once('close', () => {
      if (this.socket === socket) this.socket = undefined
      void rest(at)
    })
    socket.write(`${JSON.stringify({ from })}\n`)
  }

  /** Stops reading: the program and its holder carry on. */
  leave() {
    const socket = this.socket
    this.socket = undefined
    socket?.removeAllListeners('close')
    socket?.destroy()
  }

  private async base() {
    return Number(await readFile(join(this.home, 'base'), 'utf8').catch(() => '0')) || 0
  }

  /** How much it has written, all told. */
  async written() {
    const [length, base] = await Promise.all([stat(join(this.home, 'out')).then((s) => s.size, () => 0), this.base()])
    return length + base
  }

  private send(message: object) {
    if (this.socket && !this.socket.destroyed) {
      this.socket.write(`${JSON.stringify(message)}\n`)
      return true
    }
    return false
  }

  write(data: string | Buffer) {
    return this.send({ t: 'i', d: Buffer.from(data).toString('base64') })
  }

  resize(cols: number, rows: number) {
    return this.send({ t: 'r', c: Math.round(cols), r: Math.round(rows) })
  }

  private async pids() {
    return JSON.parse(await readFile(join(this.home, 'pid'), 'utf8').catch(() => '{}')) as { holder?: number; program?: number }
  }

  async programPid() {
    return (await this.pids()).program
  }

  /** Signals the program and whatever it started. */
  async signal(signal: NodeJS.Signals) {
    const number = ({ SIGTERM: 15, SIGKILL: 9, SIGINT: 2, SIGHUP: 1 } as Record<string, number>)[signal] ?? 15
    if (this.send({ t: 's', s: number })) return
    const socket = await this.dial().catch(() => undefined)
    if (socket) {
      socket.write(`${JSON.stringify({ t: 's', s: number })}\n`, () => socket.destroy())
      return
    }
    // No holder: only what it left behind is left to stop, if anything.
  }

  /** How it ended, once it has. */
  async exit(): Promise<HeldExit | undefined> {
    const text = await readFile(join(this.home, 'exit'), 'utf8').catch(() => undefined)
    return text ? (JSON.parse(text) as HeldExit) : undefined
  }

  /** Its last words on stderr. */
  async errors(length = 2000) {
    return (await readFile(join(this.home, 'err'), 'utf8').catch(() => '')).slice(-length)
  }

  /** How far the output had been read and passed on, for the next runner. */
  async cursor() {
    return Number(await readFile(join(this.home, 'cursor'), 'utf8').catch(() => '0')) || 0
  }

  async saveCursor(offset: number) {
    await writeFile(join(this.home, 'cursor'), String(offset), { mode: 0o600 }).catch(() => {})
  }

  /**
   * Its holder went and its program may not have (a crash, with nothing to tell it): that's stopped, so a new run
   * isn't working beside it. After a restart there's nothing to stop, and that process id may be someone else's by now.
   */
  async stopOrphan() {
    const { program } = await this.pids()
    const bootedAt = Date.now() - uptime() * 1000
    if (!program || Date.parse(this.meta.startedAt) < bootedAt) return
    try {
      process.kill(-program, 'SIGKILL')
    } catch {
      // Already gone.
    }
  }

  /** Stops it and waits for its holder to go, a few seconds at most. */
  async stopAndWait(ms = 5000) {
    await this.signal('SIGTERM')
    const until = Date.now() + ms
    while (Date.now() < until && (await this.listening())) await new Promise((done) => setTimeout(done, 50))
  }

  async remove() {
    this.leave()
    // Its holder may be writing its last as it goes.
    await rm(this.home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}

/** What's held under a folder, whether or not its holders are still there. */
export async function heldIn(root: string): Promise<Held[]> {
  const names = await readdir(root).catch(() => [] as string[])
  const found = await Promise.all(names.map(async (name) => {
    const meta = await readFile(join(root, name, 'meta.json'), 'utf8').catch(() => undefined)
    if (!meta) return undefined
    try {
      return new Held(join(root, name), JSON.parse(meta) as HeldMeta)
    } catch {
      return undefined
    }
  }))
  return found.filter((h): h is Held => !!h)
}

/** Whether held runs can work on this machine at all. */
export const canHold = () => process.platform !== 'win32'
