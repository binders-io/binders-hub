import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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
