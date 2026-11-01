import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import { Hub } from '../src/hub.ts'
import { RedisLog } from '../src/log.ts'
import type { Change } from '../../shared/state.ts'
import { tempDir, until } from './helpers.ts'

// Redis going away and coming back, with the log on disk as it is on a server: every change was appended, so a hub
// picks up where the log says, and two hubs on it end up the same.

const port = 6394
const url = `redis://127.0.0.1:${port}`
const folder = (id: string): Change => ({ type: 'folder.put', folder: { id, binderId: 'b1', name: id } })

let running: ChildProcess | undefined
async function startRedis(dir: string) {
  running = spawn('redis-server', ['--port', String(port), '--dir', dir, '--appendonly', 'yes', '--appendfsync', 'always', '--save', '', '--bind', '127.0.0.1'], { stdio: 'ignore' })
  const outcome = await Promise.race([
    new Promise<string>((done) => running!.once('error', () => done('missing'))),
    new Promise<string>((done) => running!.once('exit', () => done('stopped'))),
    sleep(500).then(() => 'up'),
  ])
  // Stopped by itself: the port is taken, likely by a Redis a test before it left behind.
  if (outcome === 'stopped') throw new Error(`redis-server wouldn’t start on port ${port}`)
  return outcome === 'up'
}
async function killRedis() {
  if (running?.exitCode !== null) return
  const stopped = new Promise((done) => running!.once('exit', done))
  running.kill('SIGKILL')
  await stopped
}
after(() => killRedis())

describe('Redis going away', () => {
  it('loses nothing appended, and the hub carries on when it’s back', async (t) => {
    const dir = await tempDir('redis')
    if (!await startRedis(dir)) return t.skip('redis-server isn’t installed')
    const log = new RedisLog(url, 'failover')
    const other = new RedisLog(url, 'failover')
    const hub = new Hub(log)
    const second = new Hub(other)
    await hub.start()
    await second.start()
    await hub.submit('you', 'tab-1', [{ id: 'before', change: folder('before') }])
    await until(() => second.state.folders.some((f) => f.id === 'before'))

    await killRedis()
    await assert.rejects(hub.submit('you', 'tab-1', [{ id: 'during', change: folder('during') }]), 'a change while it’s away fails, for the tab to send again')
    assert.ok(hub.state.folders.some((f) => f.id === 'before'), 'what the hub has stays')

    await startRedis(dir)
    await until(async () => log.ping().catch(() => false), 8000)
    await until(async () => other.ping().catch(() => false), 8000)

    // The tab sends it again, with the same id.
    await hub.submit('you', 'tab-1', [{ id: 'during', change: folder('during') }])
    await hub.submit('you', 'tab-1', [{ id: 'after', change: folder('after') }])
    assert.deepEqual(hub.state.folders.map((f) => f.id), ['before', 'during', 'after'])

    // The other hub hears of it, once it's listening again, or on its next read.
    await until(async () => {
      await second.catchUp()
      return second.state.folders.length === 3
    }, 8000)
    assert.equal(second.version, hub.version)

    const fresh = new RedisLog(url, 'failover')
    const third = new Hub(fresh)
    await third.start()
    assert.deepEqual(third.state.folders.map((f) => f.id), ['before', 'during', 'after'], 'a hub started now reads the same log')
    await Promise.all([log.close(), other.close(), fresh.close()])
    await killRedis()
  })

  it('reads a resend as one change, even when the first try reached the log', async (t) => {
    const dir = await tempDir('redis-resend')
    if (!await startRedis(dir)) return t.skip('redis-server isn’t installed')
    const log = new RedisLog(url, 'resend')
    const hub = new Hub(log)
    await hub.start()
    const [first] = await hub.submit('you', 'tab-1', [{ id: 'same', change: folder('once') }])
    await killRedis()
    await startRedis(dir)
    await until(async () => log.ping().catch(() => false), 8000)
    const [again] = await hub.submit('you', 'tab-1', [{ id: 'same', change: folder('once') }])
    assert.ok(first > 0)
    assert.equal(again, 0, 'the log knows the id across the restart')
    assert.equal(hub.state.folders.length, 1)
    await log.close()
    await killRedis()
  })
})
