import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Redis } from 'ioredis'
import { Hub } from '../src/hub.ts'
import { KeptKV, StateFile } from '../src/kept.ts'
import { MemoryKV } from '../src/kv.ts'
import { MemoryLog, type ChangeLog, type Unnumbered } from '../src/log.ts'
import type { Change, Entry } from '../../shared/state.ts'
import { startRedis, tempDir, until } from './helpers.ts'

// Redis is a working copy: what has to last is in files on the hub's disk, and a hub with an empty Redis carries on.

const folder = (id: string): Change => ({ type: 'folder.put', folder: { id, binderId: 'b1', name: id } })

describe('keys that last', () => {
  it('keeps a key with no time limit through Redis being emptied, and leaves one with a limit to Redis', async () => {
    const file = join(await tempDir('kept'), 'kept.json')
    const kv = await new KeptKV(new MemoryKV(), file).load()
    await kv.set('options', '{"a":1}')
    await kv.set('session:abc', 'someone', 60)
    assert.equal(await kv.get('session:abc'), 'someone')
    assert.ok(!(await readFile(file, 'utf8')).includes('session:abc'))
    assert.equal(((await stat(file)).mode & 0o777), 0o600)

    const rebuilt = await new KeptKV(new MemoryKV(), file).load()
    assert.equal(await rebuilt.get('options'), '{"a":1}')
    assert.equal(await rebuilt.get('session:abc'), undefined)
  })

  it('leaves what the hub makes again in Redis', async () => {
    const file = join(await tempDir('kept'), 'kept.json')
    const inner = new MemoryKV()
    const kv = await new KeptKV(inner, file).load()
    await kv.set('brain:source:note:n1', 'passages')
    await kv.set('repo-index:7', 'repos')
    assert.equal(await kv.get('brain:source:note:n1'), 'passages')
    assert.equal(await inner.get('repo-index:7'), 'repos')
    await kv.set('person', 'stays')
    const text = await readFile(file, 'utf8')
    assert.ok(!text.includes('passages'))
    assert.ok(!text.includes('repos'))
  })

  it('takes what Redis had the first time, and doesn’t bring back what’s since deleted', async () => {
    const file = join(await tempDir('kept'), 'kept.json')
    const inner = new MemoryKV()
    const kv = await new KeptKV(inner, file).load(async (skip) => [['agent-token:h', 'a1'], ['brain:sources', '[]']].filter(([key]) => !skip(key)) as [string, string][])
    assert.equal(await kv.get('agent-token:h'), 'a1')
    assert.ok(!(await readFile(file, 'utf8')).includes('brain:sources'))
    await kv.del('agent-token:h')
    assert.equal(await kv.get('agent-token:h'), undefined)
    assert.equal(await (await new KeptKV(new MemoryKV(), file).load()).get('agent-token:h'), undefined)
  })

  it('takes a one-time key once', async () => {
    const kv = await new KeptKV(new MemoryKV(), join(await tempDir('kept'), 'kept.json')).load()
    await kv.set('once', 'x')
    assert.equal(await kv.take('once'), 'x')
    assert.equal(await kv.take('once'), undefined)
  })

  it('saves a key with Redis away', async () => {
    const file = join(await tempDir('kept'), 'kept.json')
    const away = Object.assign(new MemoryKV(), { set: () => Promise.reject(new Error('Redis is away')) })
    const kv = await new KeptKV(away, file).load()
    await kv.set('options', 'saved')
    assert.equal(await (await new KeptKV(new MemoryKV(), file).load()).get('options'), 'saved')
  })

  it('refuses to start on a file it can’t read, which isn’t the same as a new hub', async () => {
    const dir = await tempDir('kept')
    const file = join(dir, 'kept.json')
    const kv = await new KeptKV(new MemoryKV(), file).load()
    await kv.set('a', 'b')
    const { writeFile } = await import('node:fs/promises')
    await writeFile(file, '{ half a fi')
    await assert.rejects(new KeptKV(new MemoryKV(), file).load())
  })
})

describe('a Binder’s saved state', () => {
  const run = async (file: StateFile) => {
    const hub = new Hub(new MemoryLog())
    await hub.start()
    await hub.record({ kind: 'hub' }, folder('f1'))
    await hub.record({ kind: 'hub' }, folder('f2'))
    await file.follow(hub)
    await file.stop()
    return hub
  }

  it('gives a hub whose log was lost its state and version, and the log goes on from there', async () => {
    const file = new StateFile(join(await tempDir('state'), 'state.json'))
    const was = await run(file)
    const log = new MemoryLog()
    const hub = new Hub(log)
    await hub.start([folder('seeded')], await file.read())
    assert.deepEqual(hub.state.folders.map((f) => f.id), ['f1', 'f2'])
    assert.equal(hub.version, was.version)
    await hub.record({ kind: 'hub' }, folder('f3'))
    assert.equal(hub.version, was.version + 1)
    assert.deepEqual(hub.state.folders.map((f) => f.id), ['f1', 'f2', 'f3'])
  })

  it('goes by the log when it’s as far on as the file, or further', async () => {
    const file = new StateFile(join(await tempDir('state'), 'state.json'))
    await run(file)
    const log = new MemoryLog()
    const writer = new Hub(log)
    await writer.start()
    for (const id of ['x', 'y', 'z']) await writer.record({ kind: 'hub' }, folder(id))
    const hub = new Hub(log)
    await hub.start(undefined, await file.read())
    assert.deepEqual(hub.state.folders.map((f) => f.id), ['x', 'y', 'z'])
  })

  /** A log that holds only these entries, numbered as given: one that lost some of what it had. */
  const logOf = (versions: [number, string][], latest = versions.at(-1)?.[0] ?? 0): ChangeLog => {
    const entries: Entry[] = versions.map(([version, id]) => ({ version, id: `c${version}`, client: 'hub', at: '2026-11-09T00:00:00.000Z', change: folder(id) }))
    let last = latest
    return {
      kind: 'memory',
      append: async (entry: Unnumbered) => { entries.push({ ...entry, version: ++last }); return last },
      read: async (after: number, limit = 1000) => entries.filter((e) => e.version > after).slice(0, limit),
      latest: async () => last,
      startAt: async (version: number) => { last = Math.max(last, version) },
      onAppend: () => {},
      close: async () => {},
    }
  }
  const savedAt = (version: number, ids: string[]) => ({ version, state: { ...new Hub(new MemoryLog()).state, binders: [{ id: 'b1', name: 'Server' }], folders: ids.map((id) => ({ id, binderId: 'b1', name: id })) } })

  it('keeps what it had before its log was lost, on every start after, not only the first', async () => {
    // Redis was emptied at version 2 and the hub carried on: the log now begins at 3, and is as far on as the file.
    const hub = new Hub(logOf([[3, 'f3'], [4, 'f4']]))
    await hub.start([folder('seeded')], savedAt(4, ['f1', 'f2', 'f3', 'f4']))
    assert.deepEqual(hub.state.folders.map((f) => f.id), ['f1', 'f2', 'f3', 'f4'])
    assert.equal(hub.state.binders.length, 1)
    assert.equal(hub.version, 4)
  })

  it('reads what the log has after the saved state, when the file is a little behind it', async () => {
    const hub = new Hub(logOf([[3, 'f3'], [4, 'f4'], [5, 'f5']]))
    await hub.start(undefined, savedAt(3, ['f1', 'f2', 'f3']))
    assert.deepEqual(hub.state.folders.map((f) => f.id), ['f1', 'f2', 'f3', 'f4', 'f5'])
    assert.equal(hub.version, 5)
  })

  it('carries on from the saved state over a hole in the middle of the log, as an older Redis put back leaves', async () => {
    // An older copy of Redis held 1 and 2; the file was at 4; the hub has written 5 since.
    const hub = new Hub(logOf([[1, 'f1'], [2, 'f2'], [5, 'f5']]))
    await hub.start(undefined, savedAt(4, ['f1', 'f2', 'f3', 'f4']))
    assert.deepEqual(hub.state.folders.map((f) => f.id), ['f1', 'f2', 'f3', 'f4', 'f5'])
    assert.equal(hub.version, 5)
  })

  it('goes by a log that’s whole, though a saved state is there', async () => {
    const hub = new Hub(logOf([[1, 'f1'], [2, 'f2'], [3, 'f3']]))
    const saved = savedAt(2, ['stale'])
    await hub.start(undefined, { ...saved, state: { ...saved.state, binders: [] } })
    assert.deepEqual(hub.state.folders.map((f) => f.id), ['f1', 'f2', 'f3'])
  })

  it('takes the saved state when the log reads back less than was saved', async () => {
    // The log says it's at 4 and gives nothing: its entries are gone and its count isn't.
    const hub = new Hub(logOf([], 4))
    await hub.start([folder('seeded')], savedAt(4, ['f1', 'f2']))
    assert.deepEqual(hub.state.folders.map((f) => f.id), ['f1', 'f2'])
    assert.equal(hub.version, 4)
    await hub.record({ kind: 'hub' }, folder('f5'))
    assert.equal(hub.version, 5)
  })

  it('keeps the file as it was before this start beside the new one', async () => {
    const dir = await tempDir('state')
    const file = new StateFile(join(dir, 'state.json'))
    await run(file)
    const before = await readFile(join(dir, 'state.json'), 'utf8')
    const hub = new Hub(new MemoryLog())
    await hub.start()
    await hub.record({ kind: 'hub' }, folder('other'))
    const again = new StateFile(join(dir, 'state.json'))
    await again.follow(hub)
    await again.stop()
    assert.equal(await readFile(join(dir, 'state.prev.json'), 'utf8'), before)
    assert.ok((await readFile(join(dir, 'state.json'), 'utf8')).includes('other'))
  })

  it('starts from the log when the file can’t be read', async () => {
    const dir = await tempDir('state')
    const { writeFile } = await import('node:fs/promises')
    await writeFile(join(dir, 'state.json'), '{ half a fi')
    assert.equal(await new StateFile(join(dir, 'state.json')).read(), undefined)
    assert.equal(await new StateFile(join(dir, 'none.json')).read(), undefined)
  })
})

describe('a whole hub with Redis rebuilt', () => {
  const port = 4497
  const url = `http://127.0.0.1:${port}`
  const main = fileURLToPath(new URL('../src/main.ts', import.meta.url))
  let hub: ChildProcess | undefined
  let stopRedis: (() => void) | undefined

  const start = async (cwd: string, redis: string, extra: Record<string, string> = {}) => {
    const { HUB_SPACE: _, ...inherited } = process.env
    hub = spawn(process.execPath, [main], { cwd, stdio: 'ignore', env: { ...inherited, HOME: cwd, PORT: String(port), HOST: '127.0.0.1', PUBLIC_URL: url, REDIS_URL: redis, HUB_SECRET: 'test-secret', HUB_POLL: 'off', HUB_DEV_LOGIN: '1', LOG_LEVEL: 'silent', ...extra } })
    await until(async () => (await fetch(`${url}/health`).catch(() => undefined))?.ok === true, 30_000)
  }
  const stop = async () => {
    const running = hub
    if (!running || running.exitCode !== null) return
    const stopped = new Promise((done) => running.once('exit', done))
    running.kill('SIGTERM')
    await stopped
  }
  after(async () => {
    await stop()
    stopRedis?.()
  })

  const signIn = async () => {
    const response = await fetch(`${url}/auth/dev`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-binders': '1' }, body: JSON.stringify({ login: 'you' }) })
    assert.equal(response.status, 200)
    return response.headers.getSetCookie()[0].split(';')[0]
  }
  const stateAs = async (cookie: string) => (await fetch(`${url}/api/state`, { headers: { cookie } })).json() as Promise<{ version: number; state: { binders: { id: string }[]; notes: { id: string; text: string }[] } }>
  const addNote = async (cookie: string, id: string, binderId: string) => {
    const response = await fetch(`${url}/api/changes`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json', 'x-binders': '1' },
      body: JSON.stringify({ client: 'test-client', changes: [{ id: `change-${id}`, change: { type: 'note.put', note: { id, title: id, binderId, editedAt: new Date().toISOString(), editors: ['you'], text: `# ${id}\n\nWords of ${id}.` } } }] }),
    })
    assert.equal(response.status, 200)
  }
  const ids = (body: { state: { notes: { id: string }[] } }) => body.state.notes.map((n) => n.id).sort()

  it('keeps its Binders, notes and version through Redis being emptied, stopped or running', async (t) => {
    const redis = await startRedis(6395)
    if (!redis) return t.skip('redis-server isn’t installed')
    stopRedis = redis.stop
    const client = new Redis(redis.url)
    t.after(() => client.disconnect())
    const dir = await tempDir('rebuilt')

    // A hub on a Binder of its own name, with a note in it.
    await start(dir, redis.url, { HUB_SPACE: 'team-one' })
    let cookie = await signIn()
    const first = await stateAs(cookie)
    const binder = first.state.binders[0].id
    await addNote(cookie, 'n1', binder)
    const before = await stateAs(cookie)
    assert.deepEqual(ids(before), ['n1', 'welcome'])
    await stop()
    assert.ok(!(await readFile(join(dir, '.data/hub-kept.json'), 'utf8')).includes('session:'))

    // Redis rebuilt with the hub down, and started with no word of what its first Binder was.
    await client.flushall()
    await start(dir, redis.url)
    assert.equal((await fetch(`${url}/api/state`, { headers: { cookie } })).status, 401, 'a sign-in is only for now')
    cookie = await signIn()
    const after1 = await stateAs(cookie)
    assert.deepEqual(ids(after1), ['n1', 'welcome'])
    // Further on than it was when read above: the hub records notes being saved as it stops.
    assert.ok(after1.version >= before.version)
    const me = await (await fetch(`${url}/api/me`, { headers: { cookie } })).json() as { spaces: { id: string }[] }
    assert.deepEqual(me.spaces.map((s) => s.id), ['team-one', '~you'])

    // Redis emptied under the running hub: what's written next isn't lost.
    await client.flushall()
    cookie = await signIn()
    await addNote(cookie, 'n2', binder)
    await until(async () => ids(await stateAs(cookie)).includes('n2'))
    assert.ok((await stateAs(cookie)).version > after1.version)

    await stop()
    await client.flushall()
    await start(dir, redis.url)
    cookie = await signIn()
    assert.deepEqual(ids(await stateAs(cookie)), ['n1', 'n2', 'welcome'])

    // And an ordinary restart after that, with Redis left alone: its log now begins where it was emptied.
    await addNote(cookie, 'n3', binder)
    await until(async () => ids(await stateAs(cookie)).includes('n3'))
    await stop()
    await start(dir, redis.url)
    cookie = await signIn()
    const later = await stateAs(cookie)
    assert.deepEqual(ids(later), ['n1', 'n2', 'n3', 'welcome'])
    assert.equal(later.state.binders.length, 1)
    await stop()
  })
})
