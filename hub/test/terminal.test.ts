import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'
import { execFileSync } from 'node:child_process'
import WebSocket from 'ws'
import { Actions } from '../src/actions.ts'
import { Auth } from '../src/auth.ts'
import { GitHubConnection } from '../src/githubConnection.ts'
import { Hub } from '../src/hub.ts'
import { MemoryKV } from '../src/kv.ts'
import { MemoryLog } from '../src/log.ts'
import { Sealer } from '../src/secrets.ts'
import { buildServer } from '../src/server.ts'
import { Webhooks } from '../src/webhooks.ts'
import { IssuesSaver } from '../src/savers/issues.ts'
import { Terminals } from '../../runner/src/terminal.ts'
import type { ToViewer } from '../../shared/terminal.ts'
import { oneSpace, seed, tempDir, until } from './helpers.ts'

async function setUp() {
  const hub = new Hub(new MemoryLog())
  await hub.start(seed())
  const kv = new MemoryKV()
  const sealer = new Sealer('test-secret')
  const github = new GitHubConnection(kv, sealer, { webUrl: 'http://unused', apiUrl: 'http://unused' }, {})
  const auth = new Auth(kv, sealer, { github: () => github.signIn(), allowed: () => ({ users: [], orgs: [] }), devLogin: () => true })
  const actions = new Actions(hub, github)
  const issues = new IssuesSaver(hub, github, { quietMs: 20 })
  const app = await buildServer(oneSpace(kv, { hub, actions, webhooks: new Webhooks(hub, actions, issues), github, issues }), { auth }, { publicUrl: 'http://hub.test' })
  await app.listen({ port: 0, host: '127.0.0.1' })
  const url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`
  const signIn = async (login: string) => {
    const response = await fetch(`${url}/auth/dev`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-binders': '1' }, body: JSON.stringify({ login }) })
    return /binders_session=[^;]+/.exec(response.headers.get('set-cookie') ?? '')![0]
  }
  return { url, signIn, close: () => app.close() }
}

/** The web app's side of a terminal: what the hub sent, as one screen of text, and each message. */
function viewer(url: string, cookie: string, query: string, origin = 'http://hub.test') {
  const socket = new WebSocket(`${url.replace(/^http/, 'ws')}/api/terminal?${query}`, { headers: { cookie, origin } })
  const got: ToViewer[] = []
  socket.on('message', (raw) => got.push(JSON.parse(String(raw)) as ToViewer))
  const screen = () => got.map((m) => (m.type === 'output' || m.type === 'replay' ? m.data : '')).join('')
  const send = (message: unknown) => socket.send(JSON.stringify(message))
  return { socket, got, screen, send, opened: new Promise((done) => socket.once('open', done)) }
}

// The runner's terminals need python3 on its machine; without it here, there's nothing to try.
const python = (() => {
  try {
    execFileSync('python3', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()

describe('agents’ terminals', () => {
  it('opens the agent’s tool on its runner for its owner alone, passes typing both ways, and opens it again as it was', { skip: python ? false : 'no python3 here' }, async () => {
    const { url, signIn, close } = await setUp()
    const you = await signIn('you')
    const made = await (await fetch(`${url}/api/agents`, { method: 'POST', headers: { cookie: you, 'x-binders': '1', 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Builder' }) })).json() as { agent: { id: string }; token: string }
    const id = made.agent.id
    const list = async (cookie = you) => (await fetch(`${url}/api/agents/${id}/terminals`, { headers: { cookie } })).json() as Promise<{ online?: boolean; sessions?: { sid: string }[]; error?: string }>

    assert.equal((await list()).online, false, 'no runner linked yet')
    const dir = await tempDir('terminal')
    // A stand-in for the agent's tool: a shell that answers what's typed.
    const runner = new Terminals({
      hubUrl: url, token: made.token, version: 'test', log: () => {},
      start: async () => ({ command: 'sh', args: ['-c', 'printf "ready\\n"; read line; echo "got $line"; read rest; stty size; read z'], cwd: dir, env: {}, tool: 'Stand-in' }),
    })
    runner.start()
    await until(async () => (await list()).online === true)

    const first = viewer(url, you, `agent=${id}&cols=90&rows=20`)
    await until(() => first.screen().includes('ready'))
    const ready = first.got.find((m) => m.type === 'ready')
    assert.ok(ready && ready.type === 'ready' && ready.session.tool === 'Stand-in' && ready.session.by === 'you')
    first.send({ type: 'input', data: 'hello\r' })
    await until(() => first.screen().includes('got hello'))
    const sessions = (await list()).sessions ?? []
    assert.equal(sessions.length, 1)

    // Opened again (another tab, or after a reload): what it wrote so far, then on as before.
    first.socket.close()
    const again = viewer(url, you, `agent=${id}&sid=${sessions[0].sid}&cols=90&rows=20`)
    await until(() => again.got.some((m) => m.type === 'replay' && m.data.includes('got hello')))

    // Renamed: kept on the runner, so every tab and the sidebar show it; the owner's live link hears of it.
    const live = new WebSocket(`${url.replace(/^http/, 'ws')}/api/live`, { headers: { cookie: you } })
    const heard: { type: string; agentId?: string; sessions?: { name?: string }[] }[] = []
    live.on('message', (raw) => heard.push(JSON.parse(String(raw))))
    await until(() => heard.some((m) => m.type === 'terminals' && m.agentId === id && m.sessions?.length === 1))
    again.send({ type: 'rename', name: '  Fixing   the login  ' })
    await until(async () => ((await list()).sessions?.[0] as { name?: string } | undefined)?.name === 'Fixing the login')
    await until(() => again.got.some((m) => m.type === 'session' && m.session.name === 'Fixing the login'))
    await until(() => heard.some((m) => m.type === 'terminals' && m.sessions?.[0]?.name === 'Fixing the login'))
    live.close()

    // The window resized: the tool's terminal is that size.
    again.send({ type: 'resize', cols: 101, rows: 31 })
    await new Promise((done) => setTimeout(done, 100))
    again.send({ type: 'input', data: 'x\r' })
    await until(() => again.screen().includes('31 101'))

    // Not its owner, or not from the hub's own pages: refused.
    const other = await signIn('other')
    assert.match((await list(other)).error ?? '', /Only Builder’s owner, @you/)
    const stranger = viewer(url, other, `agent=${id}&sid=${sessions[0].sid}`)
    await until(() => stranger.got.some((m) => m.type === 'error'))
    const elsewhere = viewer(url, you, `agent=${id}&sid=${sessions[0].sid}`, 'https://evil.test')
    await until(() => elsewhere.got.some((m) => m.type === 'error' && /hub’s own pages/.test(m.text)))
    assert.ok(!stranger.screen().includes('got hello') && !elsewhere.screen().includes('got hello'))

    // Ended from the web app: its tool stops, and it's gone from the list.
    again.send({ type: 'end' })
    await until(() => again.got.some((m) => m.type === 'exit'))
    await until(async () => ((await list()).sessions ?? []).length === 0)

    runner.stop()
    await until(async () => (await list()).online === false)
    await close()
  })
})
