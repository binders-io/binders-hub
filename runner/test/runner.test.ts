import { mkdtempSync } from 'node:fs'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { writeFile, mkdtemp, readFile, readdir, realpath, stat } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { parseDiff } from '../../shared/changeSet.ts'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
// Cards are always worked in worktrees: the tests' go in a folder of their own, never in ~/.binders.
process.env.BINDERS_WORKTREES_DIR = mkdtempSync(join(tmpdir(), 'binders-test-worktrees-'))
import type { AddressInfo } from 'node:net'
import { Actions } from '../../hub/src/actions.ts'
import { Auth } from '../../hub/src/auth.ts'
import { GitHubConnection } from '../../hub/src/githubConnection.ts'
import { Hub } from '../../hub/src/hub.ts'
import { MemoryKV } from '../../hub/src/kv.ts'
import { MemoryLog } from '../../hub/src/log.ts'
import { Sealer } from '../../hub/src/secrets.ts'
import { buildServer } from '../../hub/src/server.ts'
import { Spaces } from '../../hub/src/spaces.ts'
import { Webhooks } from '../../hub/src/webhooks.ts'
import { Runner, challengeFindings, debriefSections, findingReplies, reviewCheckout, worktreeDiff } from '../src/runner.ts'
import { StreamReader } from '../src/stream.ts'
import { until } from '../../hub/test/helpers.ts'

// The runner against a real hub, with a stand-in agent: a small script the runner starts as a custom command, which
// prints Claude Code's stream-json and uses Binders' MCP tools as an agent would. No real agent runs.

const standIn = `
import { Client } from '${join(import.meta.dirname, '../node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js')}'
import { StreamableHTTPClientTransport } from '${join(import.meta.dirname, '../node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js')}'
const mode = process.argv[2]
const client = new Client({ name: 'stand-in', version: '1' })
await client.connect(new StreamableHTTPClientTransport(new URL(process.env.BINDERS_URL + '/mcp'), { requestInit: { headers: { authorization: 'Bearer ' + process.env.BINDERS_TOKEN } } }))
const call = (name, args) => client.callTool({ name, arguments: args })
const say = (event) => console.log(JSON.stringify(event))
say({ type: 'system', subtype: 'init', session_id: 'session-1' })
say({ type: 'assistant', message: { content: [{ type: 'text', text: 'Reading the card.' }, { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'src/app.ts' } }] } })
say({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: '120 lines' }] } })
if (mode === 'slow') await new Promise((done) => setTimeout(done, 1500))
if (mode === 'silent') await new Promise((done) => setTimeout(done, 30000))
if (mode === 'where') (await import('node:fs')).writeFileSync(process.argv[3], process.cwd())
if (mode === 'github') {
  const { execFileSync } = await import('node:child_process')
  const { writeFileSync } = await import('node:fs')
  const filled = execFileSync('git', ['credential', 'fill'], { input: 'protocol=https\\nhost=github.com\\npath=acme/web.git\\n\\n' }).toString()
  const url = execFileSync('git', ['ls-remote', '--get-url', 'git@github.com:acme/web.git']).toString().trim()
  writeFileSync(process.argv[3], JSON.stringify({ gh: process.env.GH_TOKEN, filled, url }))
}
if (mode === 'ask' && process.env.BINDERS_RESUME !== '1') {
  await call('ask', { id: process.env.BINDERS_CARD, question: 'Which port?' })
} else if (mode !== 'quit') {
  say({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'npm test' } }] } })
  say({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't2', content: '✓ 3 passed' }] } })
  await call('complete_task', { id: process.env.BINDERS_CARD, summary: 'Done by the stand-in.' })
}
say({ type: 'result', total_cost_usd: 0.12, duration_ms: 90000, result: 'All done.', usage: { input_tokens: 100, output_tokens: 50 } })
await client.close()
if (mode === 'quit') process.exit(3)
`

async function setUp() {
  const hub = new Hub(new MemoryLog())
  await hub.start([{ type: 'binder.put', binder: { id: 'b1', name: 'Server' } }])
  const kv = new MemoryKV()
  const sealer = new Sealer('x')
  const github = new GitHubConnection(kv, sealer, { webUrl: 'http://unused', apiUrl: 'http://unused' })
  const auth = new Auth(kv, sealer, { github: () => undefined, allowed: () => ({ users: [], orgs: [] }), devLogin: () => true })
  const actions = new Actions(hub, github)
  const app = await buildServer(Spaces.of(kv, [{ info: { id: 'test', name: 'Test', members: [] }, space: { id: 'test', hub, actions, github, webhooks: new Webhooks(hub, actions) } }]), { auth }, { publicUrl: 'http://hub.test' })
  await app.listen({ port: 0, host: '127.0.0.1' })
  const url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`
  const dir = await mkdtemp(join(tmpdir(), 'binders-runner-'))
  const script = join(dir, 'stand-in.mjs')
  await writeFile(script, standIn)
  const agent = async (mode: string) => {
    const made = await actions.putAgent('you', { name: `Runner ${mode}`, runner: { tool: 'custom', access: 'full', timeoutMinutes: 1, worktrees: false, command: `node ${script} ${mode}` } })
    return { agent: made, token: await auth.issueAgentToken(made.id, 'test') }
  }
  const card = (title: string, meantFor: string) => actions.createCard({ kind: 'user', login: 'you' }, { binderId: 'b1', title, meantFor })
  return { hub, actions, url, dir, agent, card, issued: (id: string) => auth.issueAgentToken(id, 'test'), close: () => app.close() }
}

describe('the runner', () => {
  it('takes a card as soon as it’s there, runs the agent, and relays what it does', async () => {
    const { hub, url, dir, agent, card, close } = await setUp()
    const { agent: me, token } = await agent('finish')
    const runner = new Runner({ hubUrl: url, token, workspace: dir, machine: 'Test Mac', log: () => {}, waitSeconds: 5 })
    await runner.connect()
    assert.match(hub.state.agents.find((a) => a.id === me.id)!.runsOn!, /^Test Mac · /)
    const running = runner.start(true)
    await new Promise((done) => setTimeout(done, 300))
    assert.equal(hub.presence()[me.id]?.listening, true, 'listening while it waits')
    const made = await card('Add a health check', me.id)
    await running
    const after = hub.state.cards.find((c) => c.id === made.id)!
    assert.equal(after.stage, 'live')
    assert.deepEqual(after.activity.filter((a) => a.kind === 'step').map((a) => [a.tool, a.text, a.result]), [['Read', 'src/app.ts', '120 lines'], ['Bash', 'npm test', '✓ 3 passed']])
    assert.ok(after.activity.some((a) => a.kind === 'said' && a.text.includes('Reading the card.')))
    await close()
  })

  it('puts a card back, with why, when the agent stops without finishing it', async () => {
    const { hub, url, dir, agent, card, close } = await setUp()
    const { agent: me, token } = await agent('quit')
    const made = await card('Something hard', me.id)
    await new Runner({ hubUrl: url, token, workspace: dir, log: () => {}, waitSeconds: 5 }).start(true)
    const after = hub.state.cards.find((c) => c.id === made.id)!
    assert.equal(after.stage, 'ready')
    assert.equal(after.agentId, undefined)
    assert.match(after.activity.find((a) => a.kind === 'released')!.text, /exit code 3/)
    await close()
  })

  it('starts the agent again on its card when a person answers its question', async () => {
    const { hub, actions, url, dir, agent, card, close } = await setUp()
    const { agent: me, token } = await agent('ask')
    const made = await card('Pick a port', me.id)
    const runner = new Runner({ hubUrl: url, token, workspace: dir, log: () => {}, waitSeconds: 5 })
    await runner.start(true)
    assert.equal(hub.state.cards.find((c) => c.id === made.id)!.needsYou, 'Which port?', 'it waits for the answer, still holding the card')
    await actions.comment('you', made.id, 'Use 8080.')
    await runner.start(true)
    assert.equal(hub.state.cards.find((c) => c.id === made.id)!.stage, 'live')
    await close()
  })
})

describe('a stuck agent', () => {
  it('is stopped when it says nothing for too long, and its card says why', async () => {
    const { hub, actions, url, dir, card, issued, close } = await setUp()
    // Its model can't be reached, say: it goes quiet. A watchdog of about a second, for the test.
    const made = await actions.putAgent('you', { name: 'Quiet', runner: { tool: 'custom', access: 'full', timeoutMinutes: 1, idleMinutes: 0.02, worktrees: false, command: `node ${join(dir, 'stand-in.mjs')} silent` } })
    const job = await card('Never answered', made.id)
    const lines: string[] = []
    const started = Date.now()
    await new Runner({ hubUrl: url, token: await issued(made.id), workspace: dir, log: (line) => lines.push(line), waitSeconds: 1 }).start(true)
    assert.ok(Date.now() - started < 20_000, 'stopped long before its time limit')
    const after = hub.state.cards.find((c) => c.id === job.id)!
    assert.equal(after.stage, 'ready')
    assert.match(after.activity.find((a) => a.kind === 'released')!.text, /said nothing for 0\.02 minutes and was stopped as stuck/)
    assert.ok(lines.some((l) => l.includes('stopping it as stuck')))
    await close()
  })
})

describe('the runner and GitHub', () => {
  it('gives the agent a token for its card’s repo alone, in git and gh, and throws it away after', async () => {
    const { hub, actions, url, dir, issued, close } = await setUp()
    await hub.record({ kind: 'hub' }, { type: 'binder.put', binder: { id: 'b1', name: 'Server', repo: 'acme/web' } })
    actions.reach = { owner: async () => 'push', runToken: async (repo) => ({ token: `ghs_only_${repo.replace('/', '_')}`, expiresAt: new Date(Date.now() + 3600_000).toISOString() }), webUrl: 'https://github.com' }
    const seen = join(dir, 'seen.json')
    // Its workspace is the agent's own repo (not the project's): the token is for that.
    const workspace = await mkdtemp(join(tmpdir(), 'binders-own-'))
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: workspace })
    execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:acme/app.git'], { cwd: workspace })
    const made = await actions.putAgent('you', { name: 'Runner github', repos: ['acme/app'], runner: { tool: 'custom', access: 'full', timeoutMinutes: 1, worktrees: false, command: `node ${join(dir, 'stand-in.mjs')} github ${seen}` } })
    const card = await actions.createCard({ kind: 'user', login: 'you' }, { binderId: 'b1', title: 'Push a fix', meantFor: made.id })
    const tokenDirs = async () => (await readdir(tmpdir())).filter((name) => name.startsWith('binders-github-')).sort()
    const before = await tokenDirs()
    const lines: string[] = []
    await new Runner({ hubUrl: url, token: await issued(made.id), workspace, log: (line) => lines.push(line), waitSeconds: 5 }).start(true)
    assert.equal(hub.state.cards.find((c) => c.id === card.id)!.stage, 'live', lines.join('\n'))
    const got = JSON.parse(await readFile(seen, 'utf8')) as { gh: string; filled: string; url: string }
    assert.equal(got.gh, 'ghs_only_acme_app')
    assert.match(got.filled, /username=x-access-token\npassword=ghs_only_acme_app/)
    assert.equal(got.url, 'https://github.com/acme/web.git', 'SSH addresses go over HTTPS, with the token')
    assert.ok(lines.some((l) => l.includes('with a token for that repo alone')))
    assert.deepEqual(await tokenDirs(), before, 'its token file is gone')
    await close()
  })
})

describe('reading what an agent prints', () => {
  it('reads Codex’s events too', () => {
    const reader = new StreamReader()
    reader.line(JSON.stringify({ type: 'thread.started', thread_id: 'th1' }))
    reader.line(JSON.stringify({ type: 'item.completed', item: { type: 'command_execution', command: 'npm test', aggregated_output: 'ok\n', exit_code: 0 } }))
    reader.line(JSON.stringify({ type: 'item.completed', item: { type: 'file_change', changes: [{ path: 'src/a.ts', kind: 'update' }] } }))
    reader.line(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'Done.' } }))
    reader.line(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1200, cached_input_tokens: 800, output_tokens: 300 } }))
    reader.line('not json at all')
    const { steps, said } = reader.take(true)
    assert.deepEqual(steps, [{ tool: 'Bash', text: 'npm test', result: 'ok' }, { tool: 'Edit', text: 'src/a.ts' }])
    assert.deepEqual(said, ['Done.'])
    assert.equal(reader.summary.sessionId, 'th1')
    assert.equal(reader.summary.tokens, 1500, 'input and output tokens')
  })

  it('shows a tool’s plain-text output as it comes, as what it said', () => {
    const reader = new StreamReader()
    reader.line('\x1b[1m> Reading src/app.ts\x1b[0m')
    reader.line('')
    reader.line('Changed the port to 4400.')
    assert.deepEqual(reader.take(false).said, ['> Reading src/app.ts\nChanged the port to 4400.'])
    assert.deepEqual(reader.take(false).said, [], 'each line once')
    assert.equal(reader.summary.last, 'Changed the port to 4400.')
  })

  it('reads the tokens and cost Claude Code’s run used', () => {
    const reader = new StreamReader()
    reader.line(JSON.stringify({ type: 'result', total_cost_usd: 0.42, duration_ms: 120000, result: 'Done.', usage: { input_tokens: 10, output_tokens: 2000, cache_read_input_tokens: 40000, cache_creation_input_tokens: 5000 } }))
    assert.equal(reader.summary.tokens, 47010)
    assert.equal(reader.summary.cost, 0.42)
  })

  it('answers a chat about a note with an agent that has no Binders tools: the note goes in as a file and comes back', async () => {
    const { hub, actions, url, dir, issued, close } = await setUp()
    const script = join(dir, 'chat.mjs')
    await writeFile(script, `
import { appendFileSync } from 'node:fs'
const prompt = process.argv[2]
const file = /The note is in (\\S+)\\./.exec(prompt)[1]
appendFileSync(file, '- Added by the stand-in\\n')
console.log('Added a line to the note.')
`)
    await hub.submit('you', 'tab-1', [{ id: 'n', change: { type: 'note.put', note: { id: 'n1', title: 'Plan', binderId: 'b1', editedAt: 'now', editors: ['you'], text: '# Plan\n' } } }])
    const made = await actions.putAgent('you', { name: 'Talker', runner: { tool: 'custom', access: 'full', timeoutMinutes: 1, worktrees: false, command: `node ${script} {prompt}` } })
    await actions.say('you', 'n1', made.id, 'Add a line, please.')
    const runner = new Runner({ hubUrl: url, token: await issued(made.id), workspace: dir, log: () => {}, waitSeconds: 1 })
    await runner.connect()
    const found = await (runner as unknown as { call: (n: string, a: object) => Promise<Record<string, unknown>> }).call('wait_for_work', { timeout_seconds: 1, chats: true })
    await runner.chat(found as never)
    const chat = hub.state.chats.find((c) => c.noteId === 'n1')!
    assert.equal(chat.messages[chat.messages.length - 1].text, 'Added a line to the note.')
    assert.match(hub.state.notes.find((n) => n.id === 'n1')!.text, /- Added by the stand-in/)
    await close()
  })

  it('writes a card’s debrief with an agent that has no Binders tools: the diff in a folder, the sections come back a line at a time', async () => {
    const { hub, actions, url, dir, issued, close } = await setUp()
    const script = join(dir, 'debrief.mjs')
    await writeFile(script, `
import { appendFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
const prompt = process.argv[2]
const file = /add a line to (\\S+): one JSON object/.exec(prompt)[1]
const folder = /Its diff is in (\\S+), a file for each/.exec(prompt)?.[1]
const diff = folder && existsSync(folder) ? readdirSync(folder).map((name) => readFileSync(join(folder, name), 'utf8')).join('\\n') : ''
const points = [...prompt.split('Write the debrief as you go')[0].matchAll(/^\\d+\\. (.+)$/gm)].map((m) => m[1])
const mode = process.argv[3]
// Cut off at the output limit: always, or until told it was.
if (mode === 'cut' || (mode === 'cut-once' && !prompt.includes("cut off at the model's output limit"))) {
  console.error('Error: Incomplete response returned, reason: max_output_tokens')
  process.exit(1)
}
// As it goes: an area and the first point after the file, then the rest over the whole.
if (mode !== 'quit') {
  appendFileSync(file, JSON.stringify({ changes: [{ area: 'Server', what: diff.includes('+app.get') ? 'A /health route.' : 'Nothing seen.' }], against: points.slice(0, 1).map((point) => ({ point, mark: 'met', where: 'src/server.ts' })) }) + '\\n')
  appendFileSync(file, JSON.stringify({ does: 'Adds a health check.', against: points.slice(1).map((point) => ({ point, mark: 'met', where: 'src/server.ts' })), look_at: [], try_it: 'npm start, then open /health.', ...(prompt.includes('test_plan is a list of') ? { test_plan: [{ title: 'Health answers 200', point: points[0], steps: ['npm start', 'curl -i localhost:3000/health'], expect: 'HTTP 200.', risk: 'high' }] } : {}) }) + '\\n')
}
void writeFileSync
console.log('Done.')
`)
    const builder = await actions.putAgent('you', { name: 'Builder' })
    const made = await actions.createCard({ kind: 'user', login: 'you' }, { binderId: 'b1', title: 'Add a health check', doneWhen: '- GET /health answers 200\n- A test covers it', meantFor: builder.id })
    await actions.claim(builder.id, made.id)
    await actions.reportDiff(builder.id, made.id, { branch: 'binders/x', base: 'abc', diff: 'diff --git a/src/server.ts b/src/server.ts\n--- a/src/server.ts\n+++ b/src/server.ts\n@@ -1 +1,2 @@\n app\n+app.get(\'/health\')\n' })

    const writer = async (mode: string) => {
      const agent = await actions.putAgent('you', { name: `Writer ${mode}`, runner: { tool: 'custom', access: 'full', timeoutMinutes: 1, worktrees: false, command: `node ${script} {prompt} ${mode}` } })
      await actions.askDebrief('you', made.id, agent.id)
      const runner = new Runner({ hubUrl: url, token: await issued(agent.id), workspace: dir, log: () => {}, waitSeconds: 1 })
      await runner.connect()
      const found = await (runner as unknown as { call: (n: string, a: object) => Promise<Record<string, unknown>> }).call('wait_for_work', { timeout_seconds: 1, debriefs: true })
      assert.equal(found.kind, 'debrief')
      await runner.debrief(found as never)
      return hub.state.cards.find((c) => c.id === made.id)!.debrief!
    }

    const written = await writer('write')
    assert.equal(written.state, 'done', written.failed ?? '')
    assert.equal(written.source, 'worktree')
    assert.deepEqual(written.changes, [{ area: 'Server', what: 'A /health route.' }], 'the diff was in its folder, a file at a time')
    assert.deepEqual(written.against!.map((p) => [p.point, p.mark]), [['GET /health answers 200', 'met'], ['A test covers it', 'met']])
    assert.equal(written.tryIt, 'npm start, then open /health.')
    assert.deepEqual(written.testPlan?.map((t) => [t.id, t.title, t.point, t.steps.length, t.risk]), [['t1', 'Health answers 200', 'GET /health answers 200', 2, 'high']], 'its functional test plan, asked for and sent')

    // An agent that stops without writing one: the card says so, and keeps the last one.
    const quit = await writer('quit')
    assert.equal(quit.state, 'failed')
    assert.match(quit.failed!, /didn’t write the debrief’s sections/)
    assert.equal(quit.does, 'Adds a health check.')

    // Cut off by its model's output limit: tried once more, told so, and written.
    const retried = await writer('cut-once')
    assert.equal(retried.state, 'done', retried.failed ?? '')
    // Cut off twice: the card says what to change.
    const cut = await writer('cut')
    assert.equal(cut.state, 'failed')
    assert.match(cut.failed!, /output limit cut it off twice: its reasoning and its answer share that limit.*Pick a model with a larger output limit/)
    await close()
  })

  it('finds a debrief’s sections in what an agent printed', () => {
    const sections = { does: 'x', changes: [], against: [], look_at: [], try_it: 'y' }
    assert.deepEqual(debriefSections(JSON.stringify(sections)), sections)
    const planned = { ...sections, test_plan: [{ title: 'It loads', steps: ['Open it'], expect: 'It loads.' }] }
    assert.deepEqual(debriefSections(JSON.stringify(planned)), planned, 'with its test plan')
    assert.deepEqual(debriefSections([JSON.stringify({ changes: [{ area: 'a', what: 'b' }] }), JSON.stringify(planned)].join('\n'))?.test_plan, planned.test_plan, 'a line at a time')
    assert.deepEqual(debriefSections(`Here it is:\n\`\`\`json\n${JSON.stringify(sections, null, 2)}\n\`\`\`\nThat's all.`), sections)
    assert.equal(debriefSections('No JSON here.'), undefined)
  })

  it('works several cards at once when the agent may, each in a worktree of its own', async () => {
    const { hub, actions, url, dir, card, issued, close } = await setUp()
    // The workspace is a repo, reached through a link as macOS's /var is: each card still gets its own worktree.
    const repo = await mkdtemp(join(tmpdir(), 'binders-swarm-'))
    for (const args of [['init', '-q', '-b', 'main'], ['-c', 'user.name=t', '-c', 'user.email=t@binders.invalid', 'commit', '-q', '--allow-empty', '-m', 'start']]) execFileSync('git', args, { cwd: repo })
    const worktrees = await mkdtemp(join(tmpdir(), 'binders-worktrees-'))
    const script = join(dir, 'stand-in.mjs')
    const made = await actions.putAgent('you', { name: 'Swarm', runner: { tool: 'custom', access: 'full', timeoutMinutes: 1, worktrees: true, parallel: 3, command: `node ${script} slow` } })
    const first = await card('One', made.id)
    const second = await card('Two', made.id)
    const runner = new Runner({ hubUrl: url, token: await issued(made.id), workspace: repo, worktreesDir: worktrees, log: () => {}, waitSeconds: 1 })
    let both = false
    const watch = setInterval(() => {
      if (hub.state.cards.filter((c) => c.agentId === made.id && c.stage === 'working').length === 2) both = true
    }, 50)
    const running = runner.start()
    await until(() => [first.id, second.id].every((id) => hub.state.cards.find((c) => c.id === id)?.stage === 'live'), 15_000)
    clearInterval(watch)
    runner.stop()
    await running
    assert.equal(both, true, 'both cards were being worked at the same time')
    assert.equal((await readdir(worktrees)).length, 2, 'each in a worktree of its own')
    await close()
  })

  it('works a card in a folder of repos in worktrees of each, never in the repos themselves, even with worktrees turned off', async () => {
    const { hub, actions, url, dir, card, issued, close } = await setUp()
    const folder = await mkdtemp(join(tmpdir(), 'binders-folder-'))
    for (const name of ['web', 'api']) {
      execFileSync('mkdir', [join(folder, name)])
      for (const args of [['init', '-q', '-b', 'main'], ['-c', 'user.name=t', '-c', 'user.email=t@binders.invalid', 'commit', '-q', '--allow-empty', '-m', 'start']]) execFileSync('git', args, { cwd: join(folder, name) })
    }
    const worktrees = await mkdtemp(join(tmpdir(), 'binders-worktrees-'))
    const script = join(dir, 'stand-in.mjs')
    const made = await actions.putAgent('you', { name: 'Folder', runner: { tool: 'custom', access: 'full', timeoutMinutes: 1, worktrees: false, command: `node ${script}` } })
    const one = await card('In both repos', made.id)
    const runner = new Runner({ hubUrl: url, token: await issued(made.id), workspace: folder, worktreesDir: worktrees, log: () => {}, waitSeconds: 1 })
    const running = runner.start()
    await until(() => hub.state.cards.find((c) => c.id === one.id)?.stage === 'live', 15_000)
    runner.stop()
    await running
    const cardFolder = join(worktrees, `${folder.split('/').pop()}-${one.id}`)
    assert.deepEqual((await readdir(cardFolder)).sort(), ['api', 'web'], 'the card’s own folder, laid out as the workspace is')
    for (const name of ['web', 'api']) {
      assert.equal(execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: join(cardFolder, name) }).toString().trim(), `binders/${one.id}`, `${name} on the card’s branch`)
      assert.equal(execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: join(folder, name) }).toString().trim(), 'main', `the workspace’s own ${name} untouched`)
    }
    await close()
  })


  it('carries on in the worktree that already holds a card’s branch, as when two worktrees of one repo run agents', async () => {
    const { hub, actions, url, dir, card, issued, close } = await setUp()
    // A repo with a second worktree of it, each a workspace of its own.
    const repo = await mkdtemp(join(tmpdir(), 'binders-main-'))
    for (const args of [['init', '-q', '-b', 'main'], ['-c', 'user.name=t', '-c', 'user.email=t@binders.invalid', 'commit', '-q', '--allow-empty', '-m', 'start']]) execFileSync('git', args, { cwd: repo })
    const second = join(await mkdtemp(join(tmpdir(), 'binders-second-')), 'second')
    execFileSync('git', ['worktree', 'add', '-q', '-b', 'other', second], { cwd: repo })
    const worktrees = await mkdtemp(join(tmpdir(), 'binders-worktrees-'))
    const where = join(dir, 'where.txt')
    const made = await actions.putAgent('you', { name: 'Second', runner: { tool: 'custom', access: 'full', timeoutMinutes: 1, worktrees: true, command: `node ${join(dir, 'stand-in.mjs')} where ${where}` } })
    const job = await card('Carry on', made.id)
    // The first workspace's runner made the card's worktree before.
    const held = join(await mkdtemp(join(tmpdir(), 'binders-held-')), 'held')
    execFileSync('git', ['worktree', 'add', '-q', '-b', `binders/${job.id}`, held], { cwd: repo })
    const lines: string[] = []
    await new Runner({ hubUrl: url, token: await issued(made.id), workspace: second, worktreesDir: worktrees, log: (line) => lines.push(line), waitSeconds: 1 }).start(true)
    assert.equal(hub.state.cards.find((c) => c.id === job.id)?.stage, 'live', lines.join('\n'))
    assert.equal(await realpath(await readFile(where, 'utf8')), await realpath(held), 'it ran where the branch is')
    assert.deepEqual(await readdir(worktrees), [], 'no second worktree for it')
    await close()
  })

  it('starts a card waiting on one in review from that card’s branch', async () => {
    const { hub, actions, url, dir, card, issued, close } = await setUp()
    const repo = await mkdtemp(join(tmpdir(), 'binders-stack-'))
    const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@binders.invalid', ...args], { cwd: repo })
    git('init', '-q', '-b', 'main')
    git('commit', '-q', '--allow-empty', '-m', 'start')
    const worktrees = await mkdtemp(join(tmpdir(), 'binders-worktrees-'))
    const where = join(dir, 'where.txt')
    const made = await actions.putAgent('you', { name: 'Stacker', runner: { tool: 'custom', access: 'full', timeoutMinutes: 1, worktrees: true, command: `node ${join(dir, 'stand-in.mjs')} where ${where}` } })
    // The first card's work, on its branch, in review.
    const first = await card('Sign in', made.id)
    await hub.record({ kind: 'hub' }, { type: 'card.update', id: first.id, fields: { stage: 'review', meantFor: undefined } })
    git('checkout', '-q', '-b', `binders/${first.id}`)
    await writeFile(join(repo, 'signin.txt'), 'the first card’s work')
    git('add', '.')
    git('commit', '-q', '-m', 'sign in')
    git('checkout', '-q', 'main')
    const second = await actions.createCard({ kind: 'user', login: 'you' }, { binderId: 'b1', title: 'Link', meantFor: made.id, waitsFor: [first.id] })
    await new Runner({ hubUrl: url, token: await issued(made.id), workspace: repo, worktreesDir: worktrees, log: () => {}, waitSeconds: 1 }).start(true)
    assert.equal(hub.state.cards.find((c) => c.id === second.id)?.stage, 'live')
    const ran = await readFile(where, 'utf8')
    assert.equal(await readFile(join(ran, 'signin.txt'), 'utf8'), 'the first card’s work', 'it built on the first card’s branch')
    await close()
  })

  it('steers a running card: a person writes on it, the run stops, and it carries on with what they wrote', async () => {
    const { hub, actions, url, dir, card, issued, close } = await setUp()
    const script = join(dir, 'steer.mjs')
    const log = join(dir, 'prompts.txt')
    // First run: waits, as if working. Run after a person wrote: notes the prompt and finishes.
    await writeFile(script, `
import { appendFileSync } from 'node:fs'
const prompt = process.argv[2]
appendFileSync(${JSON.stringify(log)}, prompt + '\\n=====\\n')
if (!prompt.includes('a person wrote')) await new Promise((done) => setTimeout(done, 20000))
console.log('Done, with the right repo.')
`)
    const made = await actions.putAgent('you', { name: 'Steered', runner: { tool: 'custom', access: 'full', timeoutMinutes: 1, worktrees: false, command: `node ${script} {prompt}` } })
    const job = await card('Add the health check', made.id)
    const runner = new Runner({ hubUrl: url, token: await issued(made.id), workspace: dir, log: () => {}, waitSeconds: 1 })
    const running = runner.start(true)
    await until(() => hub.state.cards.find((c) => c.id === job.id)?.stage === 'working', 5000)
    await new Promise((done) => setTimeout(done, 500))
    await actions.comment('you', job.id, 'This is for the server repo, not the Mac app.')
    await running
    const prompts = (await (await import('node:fs/promises')).readFile(log, 'utf8')).split('=====').filter((p) => p.trim())
    assert.equal(prompts.length, 2, 'stopped and started again')
    assert.match(prompts[1], /the server repo, not the Mac app/)
    assert.equal(hub.state.cards.find((c) => c.id === job.id)?.stage, 'live')
    await close()
  })

})

describe('a Challenge', () => {
  it('reviews a card with an agent that has no Binders tools: the diff in a folder, never the author’s log, and the findings come back a line at a time', async () => {
    const { hub, actions, url, dir, issued, close } = await setUp()
    const script = join(dir, 'challenge.mjs')
    await writeFile(script, `
import { appendFileSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
const prompt = process.argv[2]
const file = /add a line to (\\S+) for each finding/.exec(prompt)[1]
const folder = /Its diff is in (\\S+), a file for each/.exec(prompt)[1]
// A file at a time, as it's told.
const diffs = readdirSync(folder).map((name) => readFileSync(join(folder, name), 'utf8'))
const line = /^ *(\\d+) \\+app\\.get/m.exec(diffs.join('\\n'))
if (process.argv[3] !== 'quit') {
  appendFileSync(file, JSON.stringify({ finding: { kind: 'done-when', file: 'src/server.ts', line: Number(line[1]), what: 'No test covers it.', confidence: 'confirmed', severity: 'medium', fix: null } }) + '\\n')
  appendFileSync(file, JSON.stringify({ summary: prompt.includes('SECRET') || diffs.join('').includes('SECRET') ? 'I saw the author’s log.' : 'One gap.' }) + '\\n')
}
console.log('Done.')
`)
    const builder = await actions.putAgent('you', { name: 'Builder' })
    const made = await actions.createCard({ kind: 'user', login: 'you' }, { binderId: 'b1', title: 'Add a health check', doneWhen: '- GET /health answers 200\n- A test covers it', meantFor: builder.id })
    await actions.claim(builder.id, made.id)
    await actions.progress(builder.id, made.id, { doing: 'SECRET-DOING', plan: [{ text: 'SECRET-PLAN', done: false }], steps: [{ tool: 'Edit', text: 'SECRET-STEP' }], said: 'SECRET-SAID' })
    await actions.reportDiff(builder.id, made.id, { branch: 'binders/x', base: 'abc', diff: 'diff --git a/src/server.ts b/src/server.ts\n--- a/src/server.ts\n+++ b/src/server.ts\n@@ -40 +40,2 @@\n app\n+app.get(\'/health\')\n' })

    const reviewer = async (mode: string) => {
      const agent = await actions.putAgent('you', { name: `Reviewer ${mode}`, runner: { tool: 'custom', access: 'full', timeoutMinutes: 1, worktrees: false, command: `node ${script} {prompt} ${mode}` } })
      await actions.askChallenge('you', made.id, agent.id)
      const runner = new Runner({ hubUrl: url, token: await issued(agent.id), workspace: dir, log: () => {}, waitSeconds: 1 })
      await runner.connect()
      const found = await (runner as unknown as { call: (n: string, a: object) => Promise<Record<string, unknown>> }).call('wait_for_work', { timeout_seconds: 1, challenges: true })
      assert.equal(found.kind, 'challenge')
      await runner.challenge(found as never)
      return hub.state.cards.find((c) => c.id === made.id)!.challenge!
    }

    const done = await reviewer('find')
    assert.equal(done.state, 'done', done.failed ?? '')
    assert.equal(done.summary, 'One gap.', 'the author’s log wasn’t in its prompt')
    assert.deepEqual(done.findings!.map((f) => [f.file, f.line, f.confidence, f.severity, f.fix]), [['src/server.ts', 41, 'confirmed', 'medium', undefined]], 'the line as numbered in the file')

    // A reviewer that stops without findings: the card says so, and keeps the last ones.
    const quit = await reviewer('quit')
    assert.equal(quit.state, 'failed')
    assert.match(quit.failed!, /didn’t write its findings/)
    assert.equal(quit.findings!.length, 1)
    await close()
  })

  it('finds the findings in what an agent printed, as send_challenge takes them', () => {
    const findings = { summary: 's', findings: [{ kind: 'bug', file: 'a.ts', line: '7', what: 'w', confidence: 'plausible', severity: 'low', fix: null }] }
    assert.deepEqual(challengeFindings(`Here:\n\`\`\`json\n${JSON.stringify(findings)}\n\`\`\``), { summary: 's', findings: [{ kind: 'bug', file: 'a.ts', line: 7, what: 'w', confidence: 'plausible', severity: 'low' }] })
    assert.deepEqual(challengeFindings('{"findings": []}'), { summary: '', findings: [] })
    assert.equal(challengeFindings('{"does": "a debrief"}'), undefined)
  })

  it('reads the author’s work in a checkout of its own, committed or not, without touching the author’s worktree', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'binders-runner-repo-'))
    const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' })
    git(workspace, 'init', '-q', '-b', 'main')
    git(workspace, 'config', 'user.email', 'test@binders.test')
    git(workspace, 'config', 'user.name', 'Test')
    await writeFile(join(workspace, 'app.ts'), 'one\n')
    git(workspace, 'add', '.')
    git(workspace, 'commit', '-q', '-m', 'start')
    const own = `${workspace}-card-1`
    git(workspace, 'worktree', 'add', '-q', '-B', 'binders/card-1', own)
    await writeFile(join(own, 'app.ts'), 'one\ntwo\n')
    git(own, 'commit', '-q', '-am', 'two')
    await writeFile(join(own, 'app.ts'), 'one\ntwo\nthree\n')
    await writeFile(join(own, 'new.ts'), 'fresh\n')
    await writeFile(join(own, 'staged.ts'), 'staged\n')
    git(own, 'add', 'staged.ts')
    const before = [git(own, 'status', '--porcelain'), git(own, 'rev-parse', 'HEAD'), git(workspace, 'branch', '--list')]

    const into = join(await mkdtemp(join(tmpdir(), 'binders-review-')), 'checkout')
    const checkout = await reviewCheckout(workspace, own, undefined, into)
    assert.equal(checkout?.dir, into)
    assert.equal(await readFile(join(into, 'app.ts'), 'utf8'), 'one\ntwo\nthree\n')
    assert.equal(await readFile(join(into, 'new.ts'), 'utf8'), 'fresh\n')
    assert.equal(await readFile(join(into, 'staged.ts'), 'utf8'), 'staged\n')
    assert.deepEqual([git(own, 'status', '--porcelain'), git(own, 'rev-parse', 'HEAD'), git(workspace, 'branch', '--list')], before, 'the author’s worktree, index and branches as they were')
    await checkout!.remove()
    await assert.rejects(stat(into))
    assert.doesNotMatch(git(workspace, 'worktree', 'list'), /checkout/)

    // A pull request from a repo that isn't the workspace's, and no worktree: nothing to check out.
    assert.equal(await reviewCheckout(workspace, join(workspace, 'nope'), { repo: 'acme/web', branch: 'x' }, `${into}-2`), undefined)
  })
})

describe('the author’s replies to a Challenge', () => {
  it('has an agent without Binders tools answer each finding once, from the findings in its prompt', async () => {
    const { hub, actions, url, dir, issued, close } = await setUp()
    const script = join(dir, 'replies.mjs')
    await writeFile(script, `
import { writeFileSync } from 'node:fs'

const prompt = process.argv[2]
const file = /Write your replies to (\\S+) as one JSON/.exec(prompt)[1]
const ids = [...prompt.matchAll(/^- (f\\d+) \\(/gm)].map((m) => m[1])
if (process.argv[3] !== 'quit') writeFileSync(file, JSON.stringify({ replies: ids.map((id, i) => ({ finding: id, verdict: i ? 'Disagree' : 'fixed', why: i ? 'It is read in src/status.ts.' : 'Added the test.' })) }))
console.log('Done.')
`)
    const builder = await actions.putAgent('you', { name: 'Builder', runner: { tool: 'custom', access: 'full', timeoutMinutes: 1, worktrees: false, command: `node ${script} {prompt} reply` } })
    const reviewer = await actions.putAgent('you', { name: 'Reviewer' })
    const made = await actions.createCard({ kind: 'user', login: 'you' }, { binderId: 'b1', title: 'Add a health check', doneWhen: '- GET /health answers 200', meantFor: builder.id })
    await actions.claim(builder.id, made.id)
    await actions.reportDiff(builder.id, made.id, { branch: 'binders/x', base: 'abc', diff: 'diff --git a/src/server.ts b/src/server.ts\n--- a/src/server.ts\n+++ b/src/server.ts\n@@ -40 +40,2 @@\n app\n+app.get(\'/health\')\n' })
    await actions.askChallenge('you', made.id, reviewer.id)
    await actions.sendChallenge(reviewer.id, made.id, { summary: 'Two.', findings: [
      { kind: 'done-when', file: 'src/server.ts', line: 41, what: 'No test covers it.', confidence: 'confirmed', severity: 'high' },
      { kind: 'bug', file: 'src/server.ts', line: 40, what: 'app is unused.', confidence: 'plausible', severity: 'low' },
    ] })
    const card = () => hub.state.cards.find((c) => c.id === made.id)!

    const answer = async (command: string) => {
      await actions.putAgent('you', { name: 'Builder', runner: { tool: 'custom', access: 'full', timeoutMinutes: 1, worktrees: false, command } }, builder.id)
      await actions.askReplies('you', made.id)
      const runner = new Runner({ hubUrl: url, token: await issued(builder.id), workspace: dir, log: () => {}, waitSeconds: 1 })
      await runner.connect()
      const found = await (runner as unknown as { call: (n: string, a: object) => Promise<Record<string, unknown>> }).call('wait_for_work', { timeout_seconds: 1, replies: true })
      assert.equal(found.kind, 'replies')
      await runner.replies(found as never)
      return card().challenge!
    }

    // One that stops without replies: the card says so, and the round may be asked for again.
    const quit = await answer(`node ${script} {prompt} quit`)
    assert.equal(quit.replies!.state, 'failed')
    assert.match(quit.replies!.failed!, /didn’t write its replies/)
    const done = await answer(`node ${script} {prompt} reply`)
    assert.equal(done.replies!.state, 'done', done.replies!.failed ?? '')
    assert.deepEqual(done.findings!.map((f) => [f.id, f.reply?.verdict, f.reply?.why]), [['f1', 'fixed', 'Added the test.'], ['f2', 'disagree', 'It is read in src/status.ts.']])
    await assert.rejects(actions.askReplies('you', made.id), /one round/)
    await close()
  })

  it('finds the replies in what an agent printed, as reply_to_findings takes them', () => {
    assert.deepEqual(findingReplies('Here:\n```json\n{"replies": [{"finding": "f1", "verdict": "Fixed", "why": "w"}]}\n```'), { replies: [{ finding: 'f1', verdict: 'fixed', why: 'w' }] })
    assert.equal(findingReplies('{"findings": []}'), undefined)
  })
})

describe('a card’s worktree diff', () => {
  it('has what the branch changed since it left the workspace, committed or not, and new files', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'binders-runner-repo-'))
    const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' })
    git(workspace, 'init', '-q', '-b', 'main')
    git(workspace, 'config', 'user.email', 'test@binders.test')
    git(workspace, 'config', 'user.name', 'Test')
    await writeFile(join(workspace, 'app.ts'), 'one\ntwo\n')
    git(workspace, 'add', '.')
    git(workspace, 'commit', '-q', '-m', 'start')
    const start = git(workspace, 'rev-parse', 'HEAD').trim()
    const dir = `${workspace}-card-1`
    git(workspace, 'worktree', 'add', '-q', '-B', 'binders/card-1', dir)

    // Committed on the card's branch, changed and not committed, and new.
    await writeFile(join(dir, 'app.ts'), 'one\n2\n')
    git(dir, 'commit', '-q', '-am', 'two is 2')
    await writeFile(join(dir, 'app.ts'), 'one\n2\nthree\n')
    await writeFile(join(dir, 'new.ts'), 'fresh\n')
    // The workspace goes on without it; the base stays where the branch left.
    await writeFile(join(workspace, 'other.ts'), 'elsewhere\n')
    git(workspace, 'add', '.')
    git(workspace, 'commit', '-q', '-m', 'meanwhile')

    const found = await worktreeDiff(dir, workspace)
    assert.equal(found?.branch, 'binders/card-1')
    assert.equal(found?.base, start)
    const { files, cut } = parseDiff(found!.diff)
    assert.equal(cut, false)
    assert.deepEqual(files.map((f) => [f.path, f.added, f.removed]), [['app.ts', 2, 1], ['new.ts', 1, 0]])
    assert.deepEqual(files[0].lines.filter((l) => l.kind !== ' ' && l.kind !== '@').map((l) => l.kind + l.text), ['-two', '+2', '+three'])
  })
})

describe('a repo brief', () => {
  it('is written from a checkout of the repo’s default branch, and goes at the top of the next card’s prompt there', async () => {
    const { hub, actions, url, dir, issued, close } = await setUp()
    // The repo, as a clone with GitHub as its origin (never reached: nothing here fetches from it).
    const clone = await mkdtemp(join(tmpdir(), 'binders-scribe-clone-'))
    const git = (...args: string[]) => execFileSync('git', args, { cwd: clone, stdio: 'pipe' }).toString().trim()
    git('init', '-q', '-b', 'main')
    await writeFile(join(clone, 'README.md'), '# Web\n')
    git('add', '.')
    git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'start')
    git('remote', 'add', 'origin', 'git@github.invalid:acme/web.git')
    const head = git('rev-parse', 'HEAD')
    await hub.submit('you', 'tab-1', [{ id: 'r', change: { type: 'binder.put', binder: { id: 'b1', name: 'Server', repo: 'acme/web' } } }])

    const script = join(dir, 'scribe.mjs')
    const prompts = join(dir, 'prompts.txt')
    await writeFile(script, `
import { appendFileSync, existsSync, writeFileSync } from 'node:fs'
const prompt = process.argv[2]
appendFileSync(${JSON.stringify(prompts)}, prompt + '\\n=====\\n')
const file = /Write the brief in Markdown to (\\S+), at most/.exec(prompt)?.[1]
if (file) {
  const dir = /checked out in (\\S+), at/.exec(prompt)[1]
  const sections = ['What it is', 'Map', 'Rules it keeps', 'Build, test, run', 'Where it breaks', 'Conventions', 'Reviewing a change here']
  writeFileSync(file, sections.map((s) => '## ' + s + '\\n' + (s === 'Map' ? (existsSync(dir + '/README.md') ? 'README.md: what it is. BRIEF-MARK' : 'no readme') : 'Something specific about ' + s + '.')).join('\\n\\n'))
}
console.log('Done.')
`)
    const scribe = await actions.putAgent('you', { name: 'Scribe', repos: ['acme/web'], runner: { tool: 'custom', access: 'full', timeoutMinutes: 1, worktrees: false, command: `node ${script} {prompt}` } })
    const runner = new Runner({ hubUrl: url, token: await issued(scribe.id), workspace: clone, log: () => {}, waitSeconds: 1 })
    await runner.connect()
    const call = (runner as unknown as { call: (n: string, a: object) => Promise<Record<string, unknown>> }).call.bind(runner)

    // None yet: working a card there asks this agent to write it.
    const first = await actions.createCard({ kind: 'user', login: 'you' }, { binderId: 'b1', title: 'Phone view', meantFor: scribe.id })
    await runner.start(true)
    assert.equal(hub.state.cards.find((c) => c.id === first.id)!.stage, 'live', 'the card itself is done')
    await until(() => hub.state.briefs?.[0]?.ask?.state === 'asked')
    const job = await call('wait_for_work', { timeout_seconds: 1, briefs: true, cards: false })
    assert.equal(job.kind, 'brief')
    await runner.brief(job as never)
    const written = hub.state.briefs![0]
    assert.equal(written.ask, undefined, written.ask?.failed ?? '')
    assert.equal(written.sha, head, 'from the default branch’s commit')
    const note = hub.state.notes.find((n) => n.id === written.noteId)!
    assert.match(note.text, /README\.md: what it is\. BRIEF-MARK/, 'read in a checkout with the repo in it, and kept as a note')
    // A note of the team's in the repo's folder goes to the next card with the brief.
    await hub.submit('you', 'tab-1', [{ id: 'doc', change: { type: 'note.put', note: { id: 'doc-1', title: 'Deploys', binderId: 'b1', folderId: note.folderId, editedAt: new Date().toISOString(), editors: ['you'], text: '# Deploys\nDOC-MARK: every test runs first.' } } }])
    assert.doesNotMatch(git('worktree', 'list'), /binders-brief-/, 'its checkout is gone')

    // The next card there starts with it.
    const second = await actions.createCard({ kind: 'user', login: 'you' }, { binderId: 'b1', title: 'Dark mode', meantFor: scribe.id })
    await runner.start(true)
    const cardPrompt = (await readFile(prompts, 'utf8')).split('=====').filter((p) => p.includes('Dark mode'))[0]
    assert.match(cardPrompt, /<repo-brief repo="acme\/web">[\s\S]*BRIEF-MARK[\s\S]*<\/repo-brief>/)
    assert.match(cardPrompt, /Where it and the code disagree, the code is right/)
    assert.match(cardPrompt, /<repo-doc title="Deploys">[\s\S]*DOC-MARK/)
    assert.ok(hub.state.cards.find((c) => c.id === second.id))
    await close()
  })
})

describe('restarting a runner from the Agents page', () => {
  it('stops what it runs, puts its card back with why, and stops to be started again; one started by hand carries on', async () => {
    const { hub, actions, dir, agent, card, url, close } = await setUp()
    const { agent: made, token } = await agent('silent')
    const file = join(dir, 'binders-runner.mjs')
    await writeFile(file, '// the runner as installed')
    const lines: string[] = []
    const runner = new Runner({ hubUrl: url, token, workspace: dir, log: (line) => lines.push(line), waitSeconds: 1, selfUpdate: file })
    const running = runner.start()
    // A restart asked before it started is left be.
    await actions.restartRunner('you', made.id)
    const job = await card('Long one', made.id)
    await until(() => hub.state.cards.find((c) => c.id === job.id)?.stage === 'working', 8000)
    await actions.restartRunner('you', made.id)
    await running
    assert.equal(runner.updated, true, 'it stopped to be started again')
    const back = hub.state.cards.find((c) => c.id === job.id)!
    assert.equal(back.stage, 'ready')
    assert.match(back.activity.at(-1)!.text, /restarted by you/)

    // Started by hand: it can't start itself again, so it says so and carries on.
    const byHand = new Runner({ hubUrl: url, token, workspace: dir, log: (line) => lines.push(line), waitSeconds: 1 })
    const handRun = byHand.start()
    await new Promise((done) => setTimeout(done, 1500))
    await actions.restartRunner('you', made.id)
    await until(() => lines.some((l) => /started by hand/.test(l)), 8000)
    assert.equal(byHand.updated, false)
    byHand.stop()
    await handRun
    await close()
  })
})
