import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bootstrap, refusedAsRoot, refusedDomain, unitFor } from '../src/daemon.ts'

// The `binders` command's parts that install nothing: what it lists, how it finds an agent, and what it says without
// one. (add, start, stop and restart reach launchd or systemd, so they're tried by hand on a machine.)
const main = join(import.meta.dirname, '../src/main.ts')
const binders = (home: string, ...args: string[]) => {
  try {
    return execFileSync(process.execPath, [main, ...args], { env: { ...process.env, BINDERS_HOME: home }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string }
    return `${e.stdout ?? ''}${e.stderr ?? ''}`
  }
}

describe('as a service', () => {
  it('won’t be set up through sudo, or as root on a Mac, and leaves root’s own Linux logins alone', () => {
    assert.match(refusedAsRoot(0, 'darwin', 'you')!, /without sudo.*chown -R "you"/)
    assert.match(refusedAsRoot(0, 'darwin', undefined)!, /without sudo/)
    assert.match(refusedAsRoot(0, 'linux', 'you')!, /without sudo/)
    assert.equal(refusedAsRoot(0, 'linux', undefined), undefined)
    assert.equal(refusedAsRoot(501, 'darwin', undefined), undefined)
  })

  it('stopping its unit leaves a card’s holder running', () => {
    const unit = unitFor({ name: 'a', agent: 'A', hub: 'https://hub.test', workspace: '/w', addedAt: '' })
    assert.match(unit, /^KillMode=process$/m)
    assert.match(unit, /^ExecStart=.*--token-file /m)
  })
})

describe('the binders command', () => {
  it('lists the agents set up here, and says how to set one up when there are none', async () => {
    const home = await mkdtemp(join(tmpdir(), 'binders-home-'))
    assert.match(binders(home, 'list'), /No agents on this machine yet/)
    assert.match(binders(home, 'help'), /binders add --token/)
    assert.match(binders(home, 'add'), /needs the agent’s token/)
    assert.match(binders(home, 'add', '--token', 'bnd_x', '--hub', 'not a url'), /needs the hub/)
    await mkdir(join(home, 'agents'))
    await writeFile(join(home, 'agents', 'codex-binders.json'), JSON.stringify({ name: 'codex-binders', agent: 'Codex - Binders', hub: 'https://hub.test', workspace: '/tmp/code', addedAt: '2026-10-31T00:00:00Z' }))
    const listed = binders(home, 'list')
    assert.match(listed, /^NAME\s+STATE\s+PID/m)
    assert.match(listed, /codex-binders\s+(off|stopped)\s+-/, 'not running: no service for it')
    assert.match(listed, /Codex - Binders/)
    assert.match(binders(home, 'restart', 'nobody'), /No agent “nobody” on this machine/)
    assert.match(binders(home, 'logs'), /Which agent\? codex-binders/)
  })

  it('is installed by the hub’s script, which checks for Node and passes the rest to binders', async () => {
    const { installer } = await import('../../hub/src/server.ts')
    const script = installer('https://hub.test/')
    assert.match(script, /^HUB="https:\/\/hub\.test"$/m)
    assert.match(script, /Binders needs Node 20 or newer/)
    assert.match(script, /exec "\$DIR\/bin\/binders" "\$@"/)
    const file = join(await mkdtemp(join(tmpdir(), 'binders-install-')), 'install.sh')
    await writeFile(file, script)
    execFileSync('sh', ['-n', file])
    assert.ok(!installer('https://hub.test"; rm -rf ~').includes('rm -rf'), 'the address can’t carry a command')
  })
})

describe('agents in the background on a Mac', () => {
  const refused = Object.assign(new Error('Command failed: launchctl bootstrap gui/501 …'), { stderr: 'Bootstrap failed: 125: Domain does not support specified action\n' })

  it('goes in the user’s own domain when this session has no desktop', async () => {
    const calls: string[][] = []
    const domain = await bootstrap('/x.plist', async (args) => {
      calls.push(args)
      if (args[1].startsWith('gui/')) throw refused
    }, ['gui/501', 'user/501'])
    assert.equal(domain, 'user/501')
    assert.deepEqual(calls.map((c) => c[1]), ['gui/501', 'user/501'])
  })

  it('stays in the desktop session’s domain when it has one, and passes on other failures', async () => {
    assert.equal(await bootstrap('/x.plist', async () => undefined, ['gui/501', 'user/501']), 'gui/501')
    const other = Object.assign(new Error('failed'), { stderr: 'Bootstrap failed: 5: Input/output error' })
    await assert.rejects(bootstrap('/x.plist', async () => { throw other }, ['gui/501', 'user/501']), /failed/)
    assert.ok(refusedDomain(refused))
    assert.ok(!refusedDomain(other))
  })
})
