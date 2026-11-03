import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Held, heldIn } from '../src/held.ts'

// A holder keeps a program going with nobody reading it, and hands over everything it wrote to whoever comes next.

const root = () => mkdtemp(join(tmpdir(), 'held-'))
const meta = { kind: 'terminal' as const, key: 'k', dir: '/', startedAt: new Date().toISOString() }
const until = async (check: () => boolean | Promise<boolean>, ms = 5000) => {
  const start = Date.now()
  while (!(await check())) {
    if (Date.now() - start > ms) throw new Error('never happened')
    await new Promise((done) => setTimeout(done, 15))
  }
}
const start = (dir: string, id: string, script: string, mode: 'pty' | 'pipe' = 'pipe', env: Record<string, string> = {}) =>
  Held.start(dir, id, { argv: ['/bin/sh', '-c', script], cwd: dir, env: { ...process.env, ...env }, mode, meta })
function collect(held: Held, from = 0) {
  const seen = { text: '', ended: false }
  void held.read(from, (data) => { seen.text += data.toString() }, () => { seen.ended = true })
  return seen
}

describe('a held program', () => {
  it('keeps what stdout and stderr each wrote, and says how it ended', async () => {
    const held = await start(await root(), 'one', 'echo out; echo err >&2; exit 3')
    const seen = collect(held)
    await until(() => seen.ended)
    assert.equal(seen.text, 'out\n')
    assert.match(await held.errors(), /err/)
    assert.deepEqual(await held.exit(), { code: 3, signal: null })
  })

  it('carries on with nobody reading, and the next reader gets all of it, from where it asks', async () => {
    const dir = await root()
    const flag = join(dir, 'go')
    const held = await start(dir, 'two', `echo first; while [ ! -e '${flag}' ]; do sleep 0.02; done; echo second`)
    const first = collect(held)
    await until(() => first.text === 'first\n')
    held.leave()
    await (await import('node:fs/promises')).writeFile(flag, '')
    await until(async () => !!(await held.exit()))

    const found = (await heldIn(dir))[0]
    assert.equal(found.meta.key, 'k')
    const all = collect(found)
    await until(() => all.ended)
    assert.equal(all.text, 'first\nsecond\n')
    const rest = collect(found, 'first\n'.length)
    await until(() => rest.ended)
    assert.equal(rest.text, 'second\n')
  })

  it('outlives whoever started it, as its own process group', async () => {
    const dir = await root()
    const held = await start(dir, 'three', 'exec sleep 30')
    const pid = (await held.programPid())!
    assert.equal(process.kill(pid, 0), true)
    await held.signal('SIGTERM')
    await until(async () => !!(await held.exit()))
    assert.deepEqual(await held.exit(), { code: null, signal: 15 })
  })

  it('stops what the program started too', async () => {
    const dir = await root()
    const pids = join(dir, 'child')
    const held = await start(dir, 'four', `sleep 30 & echo $! > '${pids}'; wait`)
    await until(() => stat(pids).then(() => true, () => false))
    const child = Number(await readFile(pids, 'utf8'))
    await held.signal('SIGTERM')
    await until(async () => !!(await held.exit()))
    await until(() => { try { process.kill(child, 0); return false } catch { return true } })
  })

  it('is a terminal in pty mode: it sees one, takes what’s typed, and hears the size', async () => {
    const dir = await root()
    const held = await start(dir, 'five', `test -t 0 && echo tty; stty size; read line; echo "got $line"`, 'pty')
    const seen = collect(held)
    await until(() => /tty/.test(seen.text) && /\d+ \d+/.test(seen.text))
    held.write('hello\n')
    await until(() => /got hello/.test(seen.text))
    await until(() => seen.ended)
  })

  it('takes a resize in pty mode', async () => {
    const dir = await root()
    const held = await start(dir, 'six', `read a; stty size; read b`, 'pty')
    const seen = collect(held)
    await until(() => held.resize(120, 40))
    await new Promise((done) => setTimeout(done, 50))
    held.write('x\n')
    await until(() => /40 120/.test(seen.text))
    held.write('y\n')
    await until(() => seen.ended)
  })

  it('isn’t a terminal in pipe mode, so tools print as they do for a program', async () => {
    const held = await start(await root(), 'seven', `test -t 1 && echo tty || echo pipe`)
    const seen = collect(held)
    await until(() => seen.ended)
    assert.equal(seen.text, 'pipe\n')
  })

  it('reads the file as it stands when its holder is gone, with no exit to report', async () => {
    const dir = await root()
    const held = await start(dir, 'eight', `echo before; exec sleep 30`)
    const seen = collect(held)
    await until(() => seen.text === 'before\n')
    held.leave()
    const pids = JSON.parse(await readFile(join(held.home, 'pid'), 'utf8')) as { holder: number; program: number }
    process.kill(pids.holder, 'SIGKILL')
    process.kill(pids.program, 'SIGKILL')
    await until(async () => !(await held.listening()) || true)
    await new Promise((done) => setTimeout(done, 50))
    const after = collect(held)
    await until(() => after.ended)
    assert.equal(after.text, 'before\n')
    assert.equal(await held.exit(), undefined)
  })

  it('drops the oldest of a very long output, and a reader asking for it starts where it’s kept from', async () => {
    const dir = await root()
    const held = await start(dir, 'nine', `i=0; while [ $i -lt 400 ]; do echo line-$i-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx; i=$((i+1)); done`, 'pipe', { BINDERS_HOLDER_KEEP: '4000' })
    const seen = collect(held)
    await until(() => seen.ended)
    assert.ok(seen.text.includes('line-399-'))
    const now = (await stat(join(held.home, 'out'))).size
    assert.ok(now <= 4000 + 65536)
    assert.ok(await held.written() > now)
  })
})
