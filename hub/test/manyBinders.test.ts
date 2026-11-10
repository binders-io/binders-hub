import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import type { AddressInfo } from 'node:net'
import { fileURLToPath } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'
import { Redis } from 'ioredis'
import { Auth } from '../src/auth.ts'
import { Hub } from '../src/hub.ts'
import { HubLease, MemoryKV } from '../src/kv.ts'
import { MemoryLog, RedisLog, RedisPair } from '../src/log.ts'
import { Sealer } from '../src/secrets.ts'
import { buildServer } from '../src/server.ts'
import { Spaces, type Member, type Role, type Space, type SpaceInfo } from '../src/spaces.ts'
import type { Change } from '../../shared/state.ts'
import { startRedis, tempDir, until } from './helpers.ts'

// One hub holding many Binders: their logs share two connections, a person's Binders are found without walking them
// all, the hub answers while they start, and a second hub on the same Redis refuses to run.

const folder = (id: string): Change => ({ type: 'folder.put', folder: { id, binderId: 'b1', name: id } })
const entry = (id: string) => ({ client: 'tab-1', id, change: folder(id), by: 'you', at: '2026-11-09T00:00:00.000Z' })

describe('every Binder’s log on one pair of connections', () => {
  let redis: Awaited<ReturnType<typeof startRedis>>
  before(async () => { redis = await startRedis(6401) })
  after(() => redis?.stop())

  /** Connections to Redis, less the one asking. */
  const connections = async (client: Redis) => ((await client.client('LIST')) as string).trim().split('\n').length - 1

  it('uses two connections for twenty logs, each hearing and reading only its own', async (t) => {
    if (!redis) return t.skip('redis-server isn’t installed')
    const client = new Redis(redis.url)
    const pair = new RedisPair(redis.url)
    t.after(() => { pair.close(); client.disconnect() })
    const logs = Array.from({ length: 20 }, (_, n) => new RedisLog(redis!.url, `many-${n}`, pair))
    const heard = logs.map(() => 0)
    logs.forEach((log, n) => log.onAppend(() => { heard[n]++ }))
    await Promise.all(logs.map((log) => log.listening()))
    await until(async () => (await connections(client)) === 2)
    assert.equal(await connections(client), 2, 'a command connection and a listening one, for all twenty')

    // An append wakes its own log's listeners and nobody else's.
    assert.equal(await logs[3].append(entry('a')), 1)
    await until(() => heard[3] === 1)
    await sleep(150)
    assert.deepEqual(heard.filter(Boolean), [1], 'only log 3 was woken')
    assert.equal(heard[3], 1)

    // Each keeps its own keys and versions.
    assert.equal(await logs[4].append(entry('b')), 1, 'its own first version, though log 3 had one')
    assert.equal(await logs[4].append(entry('c')), 2)
    assert.deepEqual((await logs[3].read(0)).map((e) => e.id), ['a'])
    assert.deepEqual((await logs[4].read(0)).map((e) => [e.id, e.version]), [['b', 1], ['c', 2]])
    assert.deepEqual(await logs[5].read(0), [])
    assert.equal(await logs[3].latest(), 1)
    assert.equal(await logs[5].latest(), 0)
    assert.equal(await connections(client), 2, 'and still two')
  })

  it('stops one log’s listening when it closes, and leaves the pair open for the rest', async (t) => {
    if (!redis) return t.skip('redis-server isn’t installed')
    const client = new Redis(redis.url)
    const pair = new RedisPair(redis.url)
    // Closed whatever happens, so a failure here leaves no connection behind for the next test to count.
    t.after(() => { pair.close(); client.disconnect() })
    const one = new RedisLog(redis.url, 'close-one', pair)
    const two = new RedisLog(redis.url, 'close-two', pair)
    const same = new RedisLog(redis.url, 'close-two', pair)
    let heardOne = 0
    let heardTwo = 0
    let heardSame = 0
    one.onAppend(() => { heardOne++ })
    two.onAppend(() => { heardTwo++ })
    same.onAppend(() => { heardSame++ })
    await Promise.all([one.listening(), two.listening(), same.listening()])

    await one.close()
    // Leaving a channel is asked of Redis and done a moment later.
    const channels = async () => (await client.pubsub('CHANNELS', 'hub:close-*')) as string[]
    await until(async () => (await channels()).length === 1)
    assert.deepEqual(await channels(), ['hub:close-two:appended'], 'it left its channel, not the other’s')
    assert.equal(await one.ping(), true, 'the shared connection is still open')
    await one.append(entry('after-close')).catch(() => {})
    await sleep(100)
    assert.equal(heardOne, 0, 'a closed log hears nothing')

    // Two logs on one Binder's channel (two hubs in one process, as tests do): closing one leaves the other listening.
    await same.close()
    await two.append(entry('x'))
    await until(() => heardTwo === 1)
    assert.equal(heardSame, 0)
    assert.equal(await connections(client), 2)

    await two.close()
    await until(async () => (await channels()).length === 0)
    assert.equal(await connections(client), 2, 'the pair stays until the hub closes it')
    pair.close()
    await until(async () => (await connections(client)) === 0)
  })

  it('still opens a pair of its own when it isn’t given one, and closes it', async (t) => {
    if (!redis) return t.skip('redis-server isn’t installed')
    const client = new Redis(redis.url)
    t.after(() => client.disconnect())
    const log = new RedisLog(redis.url, 'alone')
    await log.listening()
    await until(async () => (await connections(client)) === 2)
    await log.close()
    await until(async () => (await connections(client)) === 0)
  })
})

describe('finding a person’s Binders', () => {
  const info = (id: string, members: Member[], extra: Partial<SpaceInfo> = {}): SpaceInfo => ({ id, name: id, createdAt: '2026-11-01T00:00:00.000Z', createdBy: 'hub', members, ...extra })
  const stub = async (id: string) => ({ id }) as Space
  const logins = ['alice', 'ALICE', 'Bob', 'zed', 'dup', 'someone-else']

  /** The mix: team Binders, open ones, personal ones, one taken off the hub, a login named in two cases. */
  const mix = () => {
    const infos: SpaceInfo[] = [info('main', [])]
    for (let n = 0; n < 30; n++) {
      const members: Member[] = [{ login: `owner${n}`, role: 'owner' }]
      if (n % 3 === 0) members.push({ login: n % 2 ? 'Alice' : 'alice', role: n % 4 ? 'member' : 'admin' })
      if (n % 5 === 0) members.push({ login: 'bob', role: 'member' })
      infos.push(info(`team-${n}`, members))
    }
    infos.push(info('open-two', []), info('~alice', [{ login: 'alice', role: 'owner' }], { personal: 'alice' }), info('~bob', [{ login: 'Bob', role: 'owner' }], { personal: 'Bob' }))
    infos.push(info('gone', [{ login: 'alice', role: 'owner' }], { removedAt: '2026-11-02T00:00:00.000Z', removedBy: 'x' }))
    infos.push(info('gone-open', [], { removedAt: '2026-11-02T00:00:00.000Z', removedBy: 'x' }))
    infos.push(info('twice', [{ login: 'Dup', role: 'admin' }, { login: 'dup', role: 'member' }, { login: 'zed', role: 'owner' }]))
    return infos
  }

  /** What `forPerson` has always given, worked out from the saved list alone. */
  const expected = async (kv: MemoryKV, login: string, hubAdmin: boolean) => {
    const saved = JSON.parse((await kv.get('spaces'))!) as SpaceInfo[]
    return saved
      .filter((s) => !s.removedAt)
      .map((s) => {
        const own: Role | undefined = !s.members.length ? 'member' : s.members.find((m) => m.login.toLowerCase() === login.toLowerCase())?.role
        return { id: s.id, role: own ?? (hubAdmin && !s.personal ? ('admin' as const) : undefined) }
      })
      .filter((s) => s.role)
  }

  const sameAsBefore = async (spaces: Spaces, kv: MemoryKV, step: string) => {
    for (const login of logins) {
      for (const admin of [false, true]) {
        const found = spaces.forPerson(login, admin).map((s) => ({ id: s.info.id, role: s.role }))
        assert.deepEqual(found, await expected(kv, login, admin), `${step}: ${login}${admin ? ' as a hub admin' : ''}`)
      }
      for (const s of spaces.list()) assert.equal(spaces.roleOf(s.id, login), (await expected(kv, login, false)).find((e) => e.id === s.id)?.role, `${step}: ${login} in ${s.id}`)
    }
    assert.deepEqual(spaces.list().map((s) => s.id), (JSON.parse((await kv.get('spaces'))!) as SpaceInfo[]).filter((s) => !s.removedAt).map((s) => s.id), `${step}: the list`)
  }

  it('gives what it always gave, for a mix of Binders, as members and Binders change', async () => {
    const kv = new MemoryKV()
    await kv.set('spaces', JSON.stringify(mix()))
    const spaces = await new Spaces(kv, stub).load({ id: 'main', name: 'Main', members: [] })
    await sameAsBefore(spaces, kv, 'as loaded')
    assert.deepEqual(spaces.forPerson('nobody-at-all').map((s) => s.info.id), ['main', 'open-two'], 'the open ones are everyone’s')
    assert.equal(spaces.roleOf('twice', 'DUP'), 'admin', 'the first who names them')
    assert.equal(spaces.roleOf('gone', 'alice'), undefined, 'not one taken off the hub')
    assert.equal(spaces.info('gone'), undefined)

    await spaces.setMember('team-1', 'Zed', 'member', true)
    await sameAsBefore(spaces, kv, 'a member added')
    await spaces.setMember('team-1', 'zed', 'admin', true)
    await sameAsBefore(spaces, kv, 'a role changed')
    await spaces.removeMember('team-0', 'ALICE', true)
    await sameAsBefore(spaces, kv, 'a member removed')
    await spaces.remove('team-3', 'hub')
    await sameAsBefore(spaces, kv, 'a Binder taken off the hub')
    assert.equal(spaces.roleOf('team-3', 'alice'), undefined)
    await spaces.create({ name: 'Brand new', owner: 'Alice' }, 'hub')
    await sameAsBefore(spaces, kv, 'a Binder made')
    assert.deepEqual(spaces.forPerson('alice').map((s) => s.info.id).slice(-2), ['~alice', 'brand-new'], 'in the order made')
    await spaces.ensurePersonal('Zed', undefined)
    await sameAsBefore(spaces, kv, 'a personal Binder made')
    assert.ok(spaces.forPerson('zed').some((s) => s.info.id === '~zed'))
    assert.ok(!spaces.forPerson('zed', true).some((s) => s.info.id === '~alice'), 'a hub admin doesn’t open another’s personal Binder')
    await assert.rejects(spaces.create({ name: 'Again', id: 'gone', owner: 'alice' }, 'hub'), /already/, 'an address taken off the hub stays taken')
  })

  it('does no work for the Binders a person isn’t in', async () => {
    /** Reads of any Binder's address, members or removal: what walking the list would be. */
    const touched = async (count: number) => {
      const infos: SpaceInfo[] = [info('main', [])]
      for (let n = 0; n < count; n++) infos.push(info(`team-${n}`, [{ login: `owner${n}`, role: 'owner' }, ...(n === 7 || n === count - 2 ? [{ login: 'Me', role: 'member' as const }] : [])]))
      infos.push(info('~me', [{ login: 'me', role: 'owner' }], { personal: 'me' }))
      const kv = new MemoryKV()
      await kv.set('spaces', JSON.stringify(infos))
      const spaces = await new Spaces(kv, stub).load({ id: 'main', name: 'Main', members: [] })
      let reads = 0
      for (const found of spaces.list()) {
        for (const field of ['id', 'members', 'removedAt'] as const) {
          let value = found[field]
          Object.defineProperty(found, field, { get: () => (reads++, value), set: (next) => { value = next }, enumerable: true, configurable: true })
        }
      }
      // What each request does: finds the person's Binders and the first one, and makes theirs if it isn't there.
      const mine = spaces.forPerson('me').map((s) => s.info.id)
      assert.deepEqual(mine, ['main', 'team-7', `team-${count - 2}`, '~me'])
      assert.equal(spaces.list()[0].id, 'main')
      assert.equal((await spaces.ensurePersonal('me', undefined)).made, false)
      for (const id of mine) { spaces.roleOf(id, 'me'); spaces.info(id) }
      return reads
    }
    const few = await touched(50)
    const many = await touched(3000)
    assert.ok(many <= few + 4, `a hub with 3000 Binders reads no more of them than one with 50 (${many} against ${few})`)
    assert.ok(many < 60, `and that is only the person’s own (${many})`)
  })
})

describe('a hub that answers while its Binders start', () => {
  it('says it’s up, and not ready, until every Binder has started', async () => {
    const kv = new MemoryKV()
    const sealer = new Sealer('test-secret')
    const auth = new Auth(kv, sealer, { github: () => undefined, allowed: () => ({ users: [], orgs: [] }), devLogin: () => true })
    await kv.set('spaces', JSON.stringify([
      { id: '~ana', name: 'Personal', createdAt: '2026-11-01T00:00:00.000Z', createdBy: 'ana', members: [{ login: 'ana', role: 'owner' }], personal: 'ana' },
      { id: 'main', name: 'Main', createdAt: '2026-11-01T00:00:00.000Z', createdBy: 'hub', members: [] },
    ]))
    const started: string[] = []
    let release = () => {}
    const gate = new Promise<void>((done) => { release = done })
    const spaces = new Spaces(kv, async (id) => {
      if (id === 'main') await gate
      started.push(id)
      return { id, hub: new Hub(new MemoryLog()) } as Space
    })
    const app = await buildServer(spaces, { auth }, { publicUrl: 'http://hub.test' })
    await app.listen({ port: 0, host: '127.0.0.1' })
    const url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`
    try {
      const loading = spaces.load({ id: 'main', name: 'Main', members: [] })
      await sleep(50)
      assert.equal(spaces.ready, false)

      assert.equal((await fetch(`${url}/health`)).status, 200)
      assert.equal((await fetch(`${url}/health?probe=1`)).status, 200)
      const ready = await fetch(`${url}/ready`)
      assert.equal(ready.status, 503)
      assert.equal(((await ready.json()) as { ok: boolean }).ok, false)
      const page = await fetch(`${url}/`)
      assert.equal(page.status, 503)
      assert.equal(await page.text(), 'The hub is still starting. Try again in a moment.')
      assert.ok(Number(page.headers.get('retry-after')) > 0, 'it says when to try again')
      const api = await fetch(`${url}/api/state`)
      assert.equal(api.status, 503)
      assert.deepEqual(await api.json(), { error: 'The hub is still starting. Try again in a moment.' })
      assert.ok(api.headers.get('retry-after'))
      assert.equal((await fetch(`${url}/auth/dev`, { method: 'POST', headers: { 'x-binders': '1' } })).status, 503, 'signing in waits too')

      release()
      await loading
      assert.deepEqual(started, ['main', '~ana'], 'team Binders first, then personal ones')
      assert.equal(spaces.ready, true)
      assert.equal((await fetch(`${url}/health`)).status, 200)
      assert.equal((await fetch(`${url}/ready`)).status, 200)
      assert.equal((await fetch(`${url}/api/state`)).status, 401, 'a request now meets the hub’s own answer')
      assert.notEqual((await fetch(`${url}/`)).status, 503)
    } finally {
      release()
      await app.close()
    }
  })
})

describe('only one hub on a Redis', () => {
  let redis: Awaited<ReturnType<typeof startRedis>>
  before(async () => { redis = await startRedis(6403) })
  after(() => redis?.stop())

  const lease = (client: Redis, id: string, times: ConstructorParameters<typeof HubLease>[1] = {}) => new HubLease(client, { ttlMs: 300, renewMs: 100, waitMs: 0, pollMs: 25, id, ...times })

  it('is taken by one, renewed while it runs, and let go of on stopping', async (t) => {
    if (!redis) return t.skip('redis-server isn’t installed')
    const client = new Redis(redis.url)
    t.after(() => client.disconnect())
    const first = lease(client, 'first')
    assert.deepEqual(await first.take(), { held: true })
    assert.equal(await client.get('hub:_hub:lease'), 'first')
    // Well past its 300 ms: only renewing keeps it.
    await sleep(900)
    assert.equal(await client.get('hub:_hub:lease'), 'first')
    assert.deepEqual(await lease(client, 'second').take(), { held: false, holder: 'first' })

    await first.release()
    assert.equal(await client.get('hub:_hub:lease'), null)
    const third = lease(client, 'third')
    assert.deepEqual(await third.take(), { held: true })
    await third.release()
  })

  it('waits for a hub that went without letting go, and gives up if it doesn’t lapse in time', async (t) => {
    if (!redis) return t.skip('redis-server isn’t installed')
    const client = new Redis(redis.url)
    t.after(() => client.disconnect())
    // A hub that died: its mark is left, with its time running out.
    await client.set('hub:_hub:lease', 'dead', 'PX', 400)
    let waited = 0
    const restarted = lease(client, 'restarted', { waitMs: 3000, onWait: () => { waited++ } })
    const began = Date.now()
    assert.deepEqual(await restarted.take(), { held: true })
    assert.ok(Date.now() - began >= 250, 'it waited for the other’s to lapse')
    assert.equal(waited, 1, 'and said so once')

    const impatient = lease(client, 'impatient', { waitMs: 200 })
    assert.deepEqual(await impatient.take(), { held: false, holder: 'restarted' })
    await restarted.release()
  })

  it('doesn’t let go of a lease that has gone to another hub, and says when it finds it has', async (t) => {
    if (!redis) return t.skip('redis-server isn’t installed')
    const client = new Redis(redis.url)
    t.after(() => client.disconnect())
    const lost: (string | undefined)[] = []
    const mine = lease(client, 'mine', { onLost: (holder) => { lost.push(holder) } })
    await mine.take()
    // Redis emptied under it: it takes it again, as it's nobody else's.
    await client.del('hub:_hub:lease')
    await until(async () => (await client.get('hub:_hub:lease')) === 'mine')
    assert.deepEqual(lost, [])
    // Another hub has it.
    await client.set('hub:_hub:lease', 'other')
    await until(() => lost.length === 1)
    assert.deepEqual(lost, ['other'])
    await mine.release()
    assert.equal(await client.get('hub:_hub:lease'), 'other', 'it’s not theirs to remove')
    await client.del('hub:_hub:lease')
  })

  describe('as whole hubs', () => {
    const main = fileURLToPath(new URL('../src/main.ts', import.meta.url))
    const running: ChildProcess[] = []
    after(() => running.forEach((child) => child.kill('SIGKILL')))

    const start = async (cwd: string, port: number, redisUrl: string) => {
      const { HUB_SPACE: _, ...inherited } = process.env
      const child = spawn(process.execPath, [main], {
        cwd,
        stdio: ['ignore', 'ignore', 'pipe'],
        env: { ...inherited, HOME: cwd, PORT: String(port), HOST: '127.0.0.1', PUBLIC_URL: `http://127.0.0.1:${port}`, REDIS_URL: redisUrl, HUB_SECRET: 'test-secret', HUB_POLL: 'off', HUB_DEV_LOGIN: '1', LOG_LEVEL: 'silent', HUB_LEASE_SECONDS: '3', HUB_LEASE_WAIT_SECONDS: '1' },
      })
      running.push(child)
      let said = ''
      child.stderr!.on('data', (chunk: Buffer) => { said += chunk })
      const exited = new Promise<number | null>((done) => child.once('exit', done))
      return { child, said: () => said, exited }
    }
    const healthy = (port: number) => until(async () => (await fetch(`http://127.0.0.1:${port}/health`).catch(() => undefined))?.ok === true, 30_000)

    it('refuses a second hub on the same Redis, and lets a third start at once after the first stops', async (t) => {
      if (!redis) return t.skip('redis-server isn’t installed')
      const client = new Redis(redis.url)
      t.after(() => client.disconnect())
      await client.flushall()
      const first = await start(await tempDir('lease-one'), 4501, redis.url)
      await healthy(4501)
      assert.ok((await client.get('hub:_hub:lease'))?.includes(`:${first.child.pid}:`), 'the lease names its process')

      const second = await start(await tempDir('lease-two'), 4502, redis.url)
      assert.equal(await second.exited, 1, 'the second hub exits')
      assert.match(second.said(), /Another hub is running on this Redis/)
      assert.match(second.said(), /only one may/)
      assert.equal((await fetch('http://127.0.0.1:4501/health')).status, 200, 'and the first is as it was')
      assert.equal((await client.get('hub:_hub:lease'))?.includes(`:${first.child.pid}:`), true)

      first.child.kill('SIGTERM')
      await first.exited
      assert.equal(await client.get('hub:_hub:lease'), null, 'stopping lets go of it')

      const third = await start(await tempDir('lease-three'), 4503, redis.url)
      await healthy(4503)
      assert.equal(third.child.exitCode, null)
      third.child.kill('SIGTERM')
      await third.exited
    })
  })
})
