import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import { Actions } from '../src/actions.ts'
import { Auth } from '../src/auth.ts'
import { GitHubConnection } from '../src/githubConnection.ts'
import { Sealer } from '../src/secrets.ts'
import { Hub } from '../src/hub.ts'
import { MemoryKV } from '../src/kv.ts'
import { MemoryLog } from '../src/log.ts'
import { buildServer } from '../src/server.ts'
import { installer, windowsInstaller } from '../src/routes/machines.ts'
import { Webhooks } from '../src/webhooks.ts'
import { IssuesSaver } from '../src/savers/issues.ts'
import { BrainSettingsStore } from '../src/brain/settings.ts'
import { BrainMachines } from '../src/brain/machines.ts'
import { Spaces, type Space } from '../src/spaces.ts'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join as path } from 'node:path'
import { joinAgent } from '../../runner/src/brain.ts'
import { daemonCommand, type Saved } from '../../runner/src/daemon.ts'
import { seed } from './helpers.ts'

// Adding a machine with one line: made on the Agents page by anyone in a Binder, run on each machine with code on it.
// The hub chooses the tool and makes an ordinary agent; for a hub admin's line it also takes the machine's models.

/** One Binder's running parts, with the seeded board in it. */
async function part(id: string, kv: MemoryKV, sealer: Sealer) {
  const hub = new Hub(new MemoryLog())
  await hub.start(seed())
  const github = new GitHubConnection(kv, sealer, { webUrl: 'http://unused', apiUrl: 'http://unused' }, {})
  const actions = new Actions(hub, github)
  const webhooks = new Webhooks(hub, actions, new IssuesSaver(hub, github, { quietMs: 20 }))
  return { id, hub, actions, webhooks, github } satisfies Space
}

async function setUp() {
  const kv = new MemoryKV()
  const sealer = new Sealer('test-secret')
  const github = new GitHubConnection(kv, sealer, { webUrl: 'http://unused', apiUrl: 'http://unused' }, {})
  const auth = new Auth(kv, sealer, { github: () => github.signIn(), allowed: () => ({ users: [], orgs: [] }), devLogin: () => true })
  const settings = await new BrainSettingsStore(kv, sealer, {}).load()
  const machines = await new BrainMachines(kv).load()
  settings.useMachines(machines)
  const members = (...logins: [string, 'owner' | 'member'][]) => logins.map(([login, role]) => ({ login, role }))
  const spaces = Spaces.of(kv, [
    { info: { id: 'test', name: 'Test', members: members(['boss', 'owner'], ['ana', 'owner'], ['ben', 'member']) }, space: await part('test', kv, sealer) },
    { info: { id: 'other', name: 'Other', members: members(['boss', 'owner'], ['ana', 'owner']) }, space: await part('other', kv, sealer) },
  ])
  const app = await buildServer(spaces, { auth, brain: settings, machines }, { publicUrl: 'http://hub.test', admins: ['boss'] })
  await app.listen({ port: 0, host: '127.0.0.1' })
  const url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`
  return { kv, auth, spaces, machines, url, agents: (id = 'test') => spaces.get(id)!.hub.state.agents, close: async () => { machines.closeAll(); await app.close() } }
}

async function signIn(url: string, login: string) {
  const response = await fetch(`${url}/auth/dev`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-binders': '1' }, body: JSON.stringify({ login }) })
  return /binders_session=[^;]+/.exec(response.headers.get('set-cookie') ?? '')![0]
}

function api(url: string, cookie: string, binder = 'test') {
  return async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${url}${path}`, { method, headers: { cookie, 'x-binders': '1', 'x-binders-space': binder, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined })
    const text = await response.text()
    return { status: response.status, body: text ? JSON.parse(text) : undefined }
  }
}

/** A machine running the line: no sign-in, as the line is the proof. */
async function join(url: string, body: Record<string, unknown>) {
  const response = await fetch(`${url}/api/machines/join`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  return { status: response.status, body: (await response.json()) as Record<string, any> }
}

const studio = { host: 'Studio-Mac.local', tools: ['claude'], folder: '/Users/ana/code', repos: ['acme/web'] }

describe('adding a machine with one line', () => {
  it('makes the line for anyone in the Binder, with the whole command for each system', async () => {
    const set = await setUp()
    try {
      const ben = api(set.url, await signIn(set.url, 'ben'))
      const made = await ben('POST', '/api/agents/join-line', {})
      assert.equal(made.status, 200)
      assert.match(made.body.token, /^bnj_/)
      assert.equal(made.body.command.unix, `curl -fsSL http://hub.test/install | sh -s -- join ${made.body.token}`)
      assert.equal(made.body.command.windows, `& ([scriptblock]::Create((irm http://hub.test/install.ps1))) join ${made.body.token}`)
      const hours = (Date.parse(made.body.expiresAt) - Date.now()) / 3_600_000
      assert.ok(hours > 23.9 && hours <= 24, `works for a day, not ${hours} hours`)
      // Each line is its own, and the line is never the brain's.
      assert.notEqual((await ben('POST', '/api/agents/join-line', {})).body.token, made.body.token)
      assert.equal((await set.machines.lineFor(made.body.token))?.binder, 'test')
      assert.equal(await set.machines.isBrainLine(made.body.token), false)

      // Signed in, and in the Binder it's made for.
      assert.equal((await fetch(`${set.url}/api/agents/join-line`, { method: 'POST' })).status, 401)
      const zed = api(set.url, await signIn(set.url, 'zed'))
      assert.equal((await zed('POST', '/api/agents/join-line', {})).status, 403)
      assert.equal((await api(set.url, await signIn(set.url, 'ana'), 'other')('POST', '/api/agents/join-line', {})).status, 200)
    } finally {
      await set.close()
    }
  })

  it('chooses the first installed tool in the product’s order and makes an ordinary agent, owned by whoever made the line', async () => {
    const set = await setUp()
    try {
      const ana = api(set.url, await signIn(set.url, 'ana'))
      const { token } = (await ana('POST', '/api/agents/join-line', {})).body
      // Codex and Claude Code are both there: the order the product lists them in says Claude Code.
      const first = await join(set.url, { token, ...studio, tools: ['codex', 'claude', 'nonsense'] })
      assert.equal(first.status, 200)
      assert.deepEqual(Object.keys(first.body).sort(), ['agent', 'binder'], 'no models are lent for anyone but a hub admin')
      const { token: _t, ...shown } = first.body.agent
      assert.deepEqual(shown, { id: first.body.agent.id, name: 'Claude Code on Studio-Mac', tool: 'claude' })
      assert.match(first.body.agent.token, /^bnd_/)
      assert.deepEqual(first.body.binder, { id: 'test', name: 'Test' })

      const made = set.agents().find((a) => a.id === first.body.agent.id)!
      assert.deepEqual([made.owner, made.runsOn, made.provider, made.repos, made.binders], ['ana', 'Studio-Mac', 'claude', ['acme/web'], []])
      assert.deepEqual(JSON.parse(JSON.stringify(made.runner)), { tool: 'claude', access: 'full', timeoutMinutes: 60, worktrees: true, parallel: 3, workspace: '/Users/ana/code' })
      assert.deepEqual(set.agents('other'), [], 'only in the Binder the line was made in')
      assert.deepEqual(await set.auth.agentFor(first.body.agent.token), { id: made.id, space: 'test' })

      // Only Codex: its own agent, beside the first.
      const codex = await join(set.url, { token, ...studio, tools: ['codex'] })
      assert.equal(codex.body.agent.name, 'Codex on Studio-Mac')
      assert.equal(set.agents().find((a) => a.id === codex.body.agent.id)!.provider, 'openai')
      assert.notEqual(codex.body.agent.id, first.body.agent.id)
    } finally {
      await set.close()
    }
  })

  it('makes the agent the way the Agents page does, so everything there works for it', async () => {
    const set = await setUp()
    try {
      const ana = api(set.url, await signIn(set.url, 'ana'))
      const { token } = (await ana('POST', '/api/agents/join-line', {})).body
      const joined = (await join(set.url, { token, ...studio })).body.agent
      // Made by hand with the same fields, it has the same record.
      const byHand = (await ana('POST', '/api/agents', { name: 'By hand', provider: 'claude', repos: ['acme/web'], skills: [], binders: [], runsOn: 'Studio-Mac', runner: { tool: 'claude', access: 'full', timeoutMinutes: 60, worktrees: true, parallel: 3, workspace: '/Users/ana/code' } })).body.agent
      const shape = (id: string) => Object.keys(JSON.parse(JSON.stringify(set.agents().find((a) => a.id === id))!)).sort()
      assert.deepEqual(shape(joined.id), shape(byHand.id))

      // Renamed, changed, given a new token and revoked, by its owner as for any other.
      const renamed = await ana('PATCH', `/api/agents/${joined.id}`, { name: 'Studio helper', skills: ['tests'], runner: { tool: 'claude', access: 'edits', timeoutMinutes: 30, worktrees: true, parallel: 2 } })
      assert.equal(renamed.status, 200)
      assert.deepEqual([renamed.body.name, renamed.body.runner.access, renamed.body.runsOn], ['Studio helper', 'edits', 'Studio-Mac'])
      const fresh = await ana('POST', `/api/agents/${joined.id}/token`, {})
      assert.equal(fresh.status, 200)
      assert.equal(await set.auth.agentFor(joined.token), undefined, 'a new token replaces the one the line gave')
      assert.equal((await set.auth.agentFor(fresh.body.token))?.id, joined.id)
      // The owner’s own change keeps it the same agent when the line runs again.
      const again = await join(set.url, { token, ...studio })
      assert.equal(again.body.agent.id, joined.id)
      assert.equal(again.body.agent.name, 'Studio helper')
      assert.equal((await ana('DELETE', `/api/agents/${joined.id}`)).status, 200)
      assert.equal(await set.auth.agentFor(again.body.agent.token), undefined)
    } finally {
      await set.close()
    }
  })

  it('takes the same machine again for the same agent, with a fresh token, and no one else’s or another tool’s for it', async () => {
    const set = await setUp()
    try {
      const ana = api(set.url, await signIn(set.url, 'ana'))
      const anaOther = api(set.url, await signIn(set.url, 'ana'), 'other')
      const ben = api(set.url, await signIn(set.url, 'ben'))
      const line = async (who: typeof ana) => (await who('POST', '/api/agents/join-line', {})).body.token as string
      const first = (await join(set.url, { token: await line(ana), ...studio })).body.agent
      // The host's name in other capitals, or with its .local, is the same machine.
      const again = (await join(set.url, { token: await line(ana), ...studio, host: 'studio-mac' })).body.agent
      assert.equal(again.id, first.id)
      assert.notEqual(again.token, first.token)
      assert.equal(await set.auth.agentFor(first.token), undefined, 'the old token stops working')
      assert.equal((await set.auth.agentFor(again.token))?.id, first.id)
      assert.equal(set.agents().length, 1)

      // Someone else's machine with the same name is another agent, which can't take the name the first has.
      const bens = (await join(set.url, { token: await line(ben), ...studio })).body.agent
      assert.notEqual(bens.id, first.id)
      assert.equal(bens.name, 'Claude Code on Studio-Mac (2)')
      assert.equal(set.agents().find((a) => a.id === bens.id)!.owner, 'ben')
      // The same person in another Binder, another agent there.
      const elsewhere = (await join(set.url, { token: await line(anaOther), ...studio })).body
      assert.deepEqual([elsewhere.binder.id, elsewhere.agent.name], ['other', 'Claude Code on Studio-Mac'])
      assert.notEqual(elsewhere.agent.id, first.id)
      assert.equal(set.agents('other').length, 1)
      // A revoked agent is gone: the machine gets a new one.
      await ana('DELETE', `/api/agents/${first.id}`)
      const back = (await join(set.url, { token: await line(ana), ...studio })).body.agent
      assert.notEqual(back.id, first.id)
      assert.equal(back.name, 'Claude Code on Studio-Mac')
    } finally {
      await set.close()
    }
  })

  it('works in the repos the folder holds that the Binder’s own list allows, or all of them when it lists none', async () => {
    const set = await setUp()
    try {
      const ana = api(set.url, await signIn(set.url, 'ana'))
      const line = async () => (await ana('POST', '/api/agents/join-line', {})).body.token as string
      const repos = ['Acme/Web', 'acme/secret', 'not a repo', 'acme/web']
      const open = (await join(set.url, { token: await line(), ...studio, host: 'one', repos })).body.agent
      assert.deepEqual(set.agents().find((a) => a.id === open.id)!.repos, ['Acme/Web', 'acme/secret', 'acme/web'].filter((r, i, all) => all.indexOf(r) === i), 'none listed on the binder: the folder’s repos as they are')

      await set.spaces.get('test')!.hub.record({ kind: 'hub' }, { type: 'binder.put', binder: { id: 'b1', name: 'Server', repos: ['acme/web', 'acme/api'] } })
      const limited = (await join(set.url, { token: await line(), ...studio, host: 'two', repos })).body.agent
      assert.deepEqual(set.agents().find((a) => a.id === limited.id)!.repos, ['Acme/Web', 'acme/web'], 'only those the binder names, however they’re written')
      const none = (await join(set.url, { token: await line(), ...studio, host: 'three', repos: ['acme/secret'] })).body.agent
      assert.deepEqual(set.agents().find((a) => a.id === none.id)!.repos, [])
      const bare = (await join(set.url, { token: await line(), host: 'four', tools: ['claude'] })).body.agent
      assert.equal(set.agents().find((a) => a.id === bare.id)!.runner?.workspace, undefined, 'no folder said: the runner’s own')
    } finally {
      await set.close()
    }
  })

  it('also takes the machine’s models for a hub admin’s line, and says nothing of models for anyone else’s', async () => {
    const set = await setUp()
    try {
      const boss = api(set.url, await signIn(set.url, 'boss'))
      const ana = api(set.url, await signIn(set.url, 'ana'))
      const bossLine = (await boss('POST', '/api/agents/join-line', {})).body.token
      const first = await join(set.url, { token: bossLine, ...studio, host: 'Studio-Mac.local' })
      assert.equal(first.status, 200)
      assert.deepEqual([first.body.machine.name, first.body.machine.token.slice(0, 4)], ['Studio-Mac', 'bnw_'])
      assert.equal((await set.machines.who(first.body.machine.token))?.name, 'Studio-Mac')
      assert.equal(set.agents().find((a) => a.id === first.body.agent.id)!.owner, 'boss')
      assert.equal(set.machines.list()[0].addedBy, 'boss')

      // Again: the same machine, a fresh token, as the brain's own line does.
      const again = await join(set.url, { token: bossLine, ...studio, host: 'Studio-Mac.local' })
      assert.equal(again.body.machine.id, first.body.machine.id)
      assert.equal(await set.machines.who(first.body.machine.token), undefined)
      assert.equal(set.machines.list().length, 1)

      // Someone who isn't an admin: the agent, and nothing of models, though the host is the same.
      const anas = await join(set.url, { token: (await ana('POST', '/api/agents/join-line', {})).body.token, ...studio, host: 'Another-Mac' })
      assert.equal('machine' in anas.body || 'machineWhy' in anas.body, false)
      assert.equal(set.machines.list().length, 1)

      // A hub that takes no more machines still makes the agent, and says why the models aren't lent.
      for (let n = 0; n < 19; n++) await set.machines.add('boss', `box ${n}`)
      const full = await join(set.url, { token: bossLine, ...studio, host: 'one-too-many' })
      assert.equal(full.status, 200)
      assert.match(full.body.agent.token, /^bnd_/)
      assert.equal(full.body.machine, undefined)
      assert.equal(full.body.machineWhy, 'A hub takes up to 20 machines.')
    } finally {
      await set.close()
    }
  })

  it('turns a line away in plain words when it can’t be used, and never makes an agent then', async () => {
    const set = await setUp()
    try {
      const boss = api(set.url, await signIn(set.url, 'boss'))
      const ana = api(set.url, await signIn(set.url, 'ana'))
      const anaOther = api(set.url, await signIn(set.url, 'ana'), 'other')
      const refused = async (body: Record<string, unknown>, status: number, say: RegExp) => {
        const answer = await join(set.url, body)
        assert.equal(answer.status, status)
        assert.match(answer.body.error, say)
        assert.equal(set.agents().length + set.agents('other').length, 0, 'no agent was made')
      }
      await refused({ ...studio, token: 'bnj_nothing' }, 401, /run out or was replaced.*Agents page/)
      await refused({ ...studio, token: 'bnd_an-agents-token' }, 401, /run out or was replaced/)
      await refused({ ...studio }, 422, /can’t be used/)

      // One that lapsed: made yesterday, with its day over.
      const lapsed = 'bnj_lapsed'
      await set.kv.set(`machine-join:${createHash('sha256').update(lapsed).digest('hex')}`, JSON.stringify({ by: 'ana', binder: 'test', expiresAt: new Date(Date.now() - 1000).toISOString() }))
      await refused({ ...studio, token: lapsed }, 401, /run out or was replaced/)

      // The brain's line is for the brain's machines, and this one isn't for it.
      const brainLine = /(bnj_\S+)$/.exec((await boss('POST', '/api/brain/machines/command', {})).body.install)![1]
      await refused({ ...studio, token: brainLine }, 401, /Settings → Brain.*binders add --token/)
      const agentLine = (await ana('POST', '/api/agents/join-line', {})).body.token
      const brainJoin = await fetch(`${set.url}/api/brain/machines/join`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: agentLine, host: 'x' }) })
      assert.equal(brainJoin.status, 401)
      assert.match(((await brainJoin.json()) as { error: string }).error, /with binders join, not binders add/)
      assert.equal(set.machines.list().length, 0, 'an agent’s line never adds a machine of the brain’s')

      // No tool: what to install, and that the same line works again.
      for (const tools of [[], ['custom'], ['made-up']]) await refused({ ...studio, token: agentLine, tools }, 422, /None of the tools Binders works with is installed on this machine\. Install one \(Claude Code, Codex, OpenCode.*Copilot CLI.*\), then run the same line again\.$/)
      assert.equal((await join(set.url, { token: agentLine, ...studio })).status, 200, 'and it works once one is there')
      for (const agent of set.agents()) await ana('DELETE', `/api/agents/${agent.id}`)

      // Its maker left the Binder: the line they made is no one's to use.
      const leaving = (await ana('POST', '/api/agents/join-line', {})).body.token
      await set.spaces.removeMember('test', 'ana', true)
      const left = await join(set.url, { ...studio, token: leaving })
      assert.equal(left.status, 401)
      assert.match(left.body.error, /@ana isn’t in Test any more.*make a new one\.$/)
      assert.equal(set.agents().filter((a) => !a.revoked).length, 0)

      // The Binder it was made for was taken off the hub.
      const removed = (await anaOther('POST', '/api/agents/join-line', {})).body.token
      await set.spaces.remove('other', 'boss')
      const gone = await join(set.url, { ...studio, token: removed })
      assert.equal(gone.status, 401)
      assert.match(gone.body.error, /isn’t on this hub any more/)
    } finally {
      await set.close()
    }
  })

  it('limits how often the join address is tried, as the brain’s is', async () => {
    const set = await setUp()
    try {
      const answers: number[] = []
      for (let n = 0; n < 22; n++) answers.push((await join(set.url, { ...studio, token: 'bnj_guess' })).status)
      assert.deepEqual([answers.slice(0, 20).every((s) => s === 401), answers[20], answers[21]], [true, 429, 429])
    } finally {
      await set.close()
    }
  })

  it('is what the runner’s joinAgent asks, and the install scripts pass join through as they pass add', async () => {
    const set = await setUp()
    try {
      const ana = api(set.url, await signIn(set.url, 'ana'))
      const { token } = (await ana('POST', '/api/agents/join-line', {})).body
      const joined = await joinAgent(set.url, token, { host: 'studio-mac', tools: ['claude'], folder: '/code', repos: [] })
      assert.deepEqual([joined.agent.name, joined.binder, joined.machine], ['Claude Code on studio-mac', { id: 'test', name: 'Test' }, undefined])
      await assert.rejects(joinAgent(set.url, 'bnj_gone', { host: 'x', tools: ['claude'], folder: '/', repos: [] }), /run out or was replaced/)
      await assert.rejects(joinAgent(set.url, token, { host: 'x', tools: [], folder: '/', repos: [] }), /Install one/)

      assert.match(installer('http://hub.test'), /exec "\$DIR\/bin\/binders" "\$@"/)
      assert.match(windowsInstaller('http://hub.test'), /& \$Command @args/)
    } finally {
      await set.close()
    }
  })

  it('is what binders join sets up from a terminal: the agent the hub made, with its own token, and for an admin the machine too', async () => {
    const set = await setUp()
    const home = await mkdtemp(path(tmpdir(), 'binders-join-home-'))
    const folder = await mkdtemp(path(tmpdir(), 'binders-join-code-'))
    const before = process.env.BINDERS_HOME
    const logged = console.log
    const said: string[] = []
    const installed: Saved[] = []
    process.env.BINDERS_HOME = home
    console.log = (...lines: unknown[]) => void said.push(lines.join(' '))
    // The machine's own parts are stand-ins: no service is installed, and nothing here looks at this computer.
    const machine = (tools: string[]) => ({ install: async (s: Saved) => { installed.push(s) }, keepRunning: async () => undefined, look: async () => ({ tools: tools as never, repos: ['acme/web'] }), detect: async () => [{ url: 'http://127.0.0.1:11434/v1', kind: 'ollama', models: ['qwen3:14b'] }], disk: async () => ({ models: [], looked: [] }), host: () => 'studio-mac.local' })
    const run = (line: string, tools: string[]) => daemonCommand(['join', line, '--hub', set.url, '--workspace', folder], async () => ({ name: 'unused' }), async () => undefined, machine(tools))
    const tokenOf = async (s: Saved) => (await readFile(path(home, 'agents', `${s.name}.token`), 'utf8')).trim()
    try {
      const ana = api(set.url, await signIn(set.url, 'ana'))
      const boss = api(set.url, await signIn(set.url, 'boss'))
      assert.equal(await run((await ana('POST', '/api/agents/join-line', {})).body.token, ['codex', 'claude']), 0)
      assert.deepEqual(said, [
        'Looking at this machine', '  Agent tools: Codex, Claude Code', `  GitHub repos in ${folder}: acme/web`,
        'Binders chose Claude Code, the one it prefers of those installed here.',
        '✓ Claude Code on studio-mac, in Test, is running in the background.',
        '  binders list shows it · binders logs claude-code-on-studio-mac -f follows it · binders stop claude-code-on-studio-mac stops it',
        said[6],
      ].slice(0, said.length))
      // Its token, as saved, is the one the hub knows for the agent it made, and no machine's was taken.
      assert.equal((await set.auth.agentFor(await tokenOf(installed[0])))?.id, set.agents()[0].id)
      assert.deepEqual([installed.length, set.machines.list().length], [1, 0])

      // A hub admin's line: the same, and the machine's models too, under the machine's own token.
      said.length = 0
      installed.length = 0
      assert.equal(await run((await boss('POST', '/api/agents/join-line', {})).body.token, ['claude']), 0)
      assert.ok(said.includes('Binders chose Claude Code, as it’s installed here.'))
      assert.ok(said.includes('  Also lending this machine’s models to the hub: 1 found.'), said.join('\n'))
      assert.deepEqual(installed.map((s) => s.kind), [undefined, 'brain'])
      assert.equal((await set.machines.who(await tokenOf(installed[1])))?.name, 'studio-mac')
      assert.equal((await set.auth.agentFor(await tokenOf(installed[0])))?.id, set.agents().find((a) => a.owner === 'boss')!.id)
    } finally {
      console.log = logged
      if (before === undefined) delete process.env.BINDERS_HOME
      else process.env.BINDERS_HOME = before
      await set.close()
    }
  })
})
