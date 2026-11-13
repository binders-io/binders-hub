import './tidy.ts'
import { mkdtempSync } from 'node:fs'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
import { BrainSettingsStore } from '../../hub/src/brain/settings.ts'
import { EndpointAgents } from '../../hub/src/agent/endpoint.ts'
import { Runner } from '../src/runner.ts'
import { command, eventLine, fitted, hubModel, inside, machineModel, reminder, repoTools, work, workRules } from '../src/harness.ts'
import { hideSecrets, StreamReader } from '../src/stream.ts'
import type { LoopTurn, Step, StepModel, Tool } from '../../shared/agent.ts'

// The runner's own files (its sessions, its held runs) go in a home of the tests' own.
process.env.BINDERS_HOME ??= mkdtempSync(join(tmpdir(), 'binders-home-'))

/** A small repo of its own, in a folder that's removed afterwards. */
async function repo() {
  const dir = await mkdtemp(join(tmpdir(), 'binders-work-'))
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' })
  git('init', '-q')
  git('config', 'user.email', 'test@example.com')
  git('config', 'user.name', 'Test')
  await mkdir(join(dir, 'src'))
  await writeFile(join(dir, 'src', 'header.ts'), 'export const title = "Hello"\nexport const color = "blue"\nexport const size = 12\n')
  await writeFile(join(dir, 'README.md'), '# Site\n\nThe header is blue.\n')
  await writeFile(join(dir, '.gitignore'), 'ignored.txt\n')
  await writeFile(join(dir, 'ignored.txt'), 'not for git\n')
  git('add', '-A')
  git('commit', '-q', '-m', 'first')
  return { dir, git, remove: () => rm(dir, { recursive: true, force: true }) }
}

const tool = (tools: Tool[], name: string) => {
  const found = tools.find((t) => t.spec.name === name)
  if (!found) throw new Error(`no tool ${name}`)
  return (input: unknown) => found.run(input)
}

const call = (id: string, name: string, input: unknown = {}) => ({ id, name, input })
const says = (text: string): Step => ({ text, calls: [], stop: 'end', usage: { in: 10, out: 5 } })
const wants = (...calls: ReturnType<typeof call>[]): Step => ({ text: '', calls, stop: 'tools', usage: { in: 100, out: 20 } })
const scripted = (...steps: Step[]): StepModel => {
  let n = 0
  return { label: 'scripted', step: async () => steps[Math.min(n++, steps.length - 1)] }
}

describe('a place inside the repo', () => {
  it('is any path under it, there yet or not, and nothing that leads out', async () => {
    const { dir, remove } = await repo()
    const outside = await mkdtemp(join(tmpdir(), 'binders-out-'))
    try {
      await symlink(outside, join(dir, 'way-out'))
      assert.ok((await inside(dir, 'src/header.ts')).endsWith(join('src', 'header.ts')))
      assert.ok((await inside(dir, 'src/new/deep/file.ts')).endsWith(join('src', 'new', 'deep', 'file.ts')))
      await assert.rejects(() => inside(dir, '../elsewhere.txt'), /outside the repo/)
      await assert.rejects(() => inside(dir, '/etc/passwd'), /outside the repo/)
      await assert.rejects(() => inside(dir, 'way-out/secret.txt'), /leads outside the repo/)
    } finally {
      await remove()
      await rm(outside, { recursive: true, force: true })
    }
  })
})

describe('the tools for a repo', () => {
  it('reads a file with its line numbers, a part at a time, and says what isn’t there to read', async () => {
    const { dir, remove } = await repo()
    try {
      const read = tool(repoTools(dir, 'edits'), 'read_file')
      assert.equal(await read({ path: 'src/header.ts' }), '1\texport const title = "Hello"\n2\texport const color = "blue"\n3\texport const size = 12\n4\t')
      assert.equal(await read({ path: 'src/header.ts', from: 2, lines: 1 }), '2\texport const color = "blue"\n(4 lines in all. The next starts at 3.)')
      await assert.rejects(() => read({ path: 'src/missing.ts' }), /There is no file src\/missing\.ts/)
      await assert.rejects(() => read({ path: 'src' }), /is a folder/)
      await writeFile(join(dir, 'blob.bin'), Buffer.from([1, 2, 0, 3]))
      await assert.rejects(() => read({ path: 'blob.bin' }), /isn’t text/)
      await assert.rejects(() => read({ path: '../outside.txt' }), /outside the repo/)
    } finally {
      await remove()
    }
  })

  it('lists what git tracks and what’s new, not what it ignores, and finds lines by a pattern', async () => {
    const { dir, remove } = await repo()
    try {
      await writeFile(join(dir, 'src', 'fresh.ts'), 'export const fresh = true\n')
      const tools = repoTools(dir, 'edits')
      assert.deepEqual((await tool(tools, 'list_files')({})).split('\n').sort(), ['.gitignore', 'README.md', 'src/fresh.ts', 'src/header.ts'])
      assert.deepEqual((await tool(tools, 'list_files')({ path: 'src' })).split('\n').sort(), ['src/fresh.ts', 'src/header.ts'])
      assert.equal(await tool(tools, 'search')({ pattern: 'blue' }), 'README.md:3:The header is blue.\nsrc/header.ts:2:export const color = "blue"')
      assert.equal(await tool(tools, 'search')({ pattern: 'col(o|ou)r', path: 'src' }), 'src/header.ts:2:export const color = "blue"')
      assert.equal(await tool(tools, 'search')({ pattern: 'purple' }), 'Nothing matches.')
      await assert.rejects(() => tool(tools, 'search')({ pattern: '' }), /Say what to look for/)
    } finally {
      await remove()
    }
  })

  it('changes exact text that’s there once, and says why when it can’t', async () => {
    const { dir, remove } = await repo()
    try {
      const edit = tool(repoTools(dir, 'edits'), 'edit_file')
      assert.equal(await edit({ path: 'src/header.ts', old: 'color = "blue"', new: 'color = "$&green"' }), 'Changed src/header.ts.')
      assert.match(await readFile(join(dir, 'src', 'header.ts'), 'utf8'), /color = "\$&green"\n/, 'the new text goes in as written')
      await assert.rejects(() => edit({ path: 'src/header.ts', old: 'color = "red"', new: 'x' }), /isn’t in the file as you gave it/)
      await assert.rejects(() => edit({ path: 'src/header.ts', old: 'export const', new: 'const' }), /is in the file 3 times/)
      assert.equal(await edit({ path: 'src/header.ts', old: 'export const', new: 'const', all: true }), 'Changed src/header.ts in 3 places.')
      assert.ok(!(await readFile(join(dir, 'src', 'header.ts'), 'utf8')).includes('export'))
      await assert.rejects(() => edit({ path: 'src/none.ts', old: 'a', new: 'b' }), /There is no file/)
      await assert.rejects(() => edit({ path: 'src/header.ts', old: '', new: 'b' }), /To make a new file, use write_file/)
    } finally {
      await remove()
    }
  })

  it('writes a new file with the folders on its way, writes over one, and leaves git’s own files alone', async () => {
    const { dir, remove } = await repo()
    try {
      const write = tool(repoTools(dir, 'edits'), 'write_file')
      assert.equal(await write({ path: 'docs/guide/start.md', content: '# Start\n' }), 'Made docs/guide/start.md.')
      assert.equal(await readFile(join(dir, 'docs', 'guide', 'start.md'), 'utf8'), '# Start\n')
      assert.equal(await write({ path: 'README.md', content: '# New\n' }), 'Wrote over README.md.')
      await assert.rejects(() => write({ path: '.git/config', content: 'x' }), /Git’s own files/)
      await assert.rejects(() => write({ path: '../escape.txt', content: 'x' }), /outside the repo/)
    } finally {
      await remove()
    }
  })

  it('runs a command only with full access, says how it ended, and stops one that takes too long', async () => {
    const { dir, remove } = await repo()
    try {
      assert.equal(repoTools(dir, 'edits').some((t) => t.spec.name === 'run'), false)
      const run = tool(repoTools(dir, 'full', { ...process.env, BINDERS_TOKEN: 'bnd_secret-token' }), 'run')
      assert.equal(await run({ command: 'echo hello && ls src' }), 'It ended with 0.\nhello\nheader.ts')
      assert.match(await run({ command: 'echo oops >&2; exit 3' }), /^It ended with 3\.\noops$/)
      assert.match(await run({ command: 'sleep 5', timeout_seconds: 1 }), /^It was stopped after 1 seconds\./)
      assert.equal(await run({ command: 'echo "token:[$BINDERS_TOKEN]"' }), 'It ended with 0.\ntoken:[]', 'what the model runs doesn’t get the agent’s token')
      await assert.rejects(() => run({ command: '   ' }), /Say what to run/)
    } finally {
      await remove()
    }
  })

  it('cuts a long printout to its end', async () => {
    const { dir, remove } = await repo()
    try {
      const ran = await command('for i in $(seq 1 400); do echo "line $i of the output"; done', dir, { ms: 10_000, most: 500 })
      assert.equal(ran.code, 0)
      assert.match(ran.out, /^\(Its first \d+ characters were left out\.\)\n/)
      assert.ok(ran.out.trimEnd().endsWith('line 400 of the output'))
    } finally {
      await remove()
    }
  })
})

describe('the conversation, as it’s sent', () => {
  const toolTurn = (text: string): LoopTurn => ({ role: 'tool', results: [{ id: 'c', name: 'read_file', text }] })

  it('is sent whole while it fits', () => {
    const turns: LoopTurn[] = [{ role: 'user', text: 'Go' }, toolTurn('x'.repeat(1000))]
    assert.equal(fitted(turns, 5000), turns)
  })

  it('has what older tools returned cut to its first lines once it has grown past what’s sent, and the last turns left whole', () => {
    const turns: LoopTurn[] = [{ role: 'user', text: 'Go' }, ...Array.from({ length: 12 }, (_x, i) => toolTurn(`${i}:${'x'.repeat(2000)}`))]
    const sent = fitted(turns, 12_000)
    const texts = sent.flatMap((turn) => (turn.role === 'tool' ? [turn.results[0].text] : []))
    assert.match(texts[0], /^0:x{298}\n\(The rest of what this returned was left out/)
    assert.equal(texts.at(-1), `11:${'x'.repeat(2000)}`)
    assert.equal(texts.slice(-8).every((text) => text.length === text.indexOf(':') + 1 + 2000), true)
    assert.equal((turns[1] as Extract<LoopTurn, { role: 'tool' }>).results[0].text.length, 2002, 'the conversation itself isn’t changed')
  })
})

describe('what it prints', () => {
  it('is the events the runner reads: what it said, each tool with what it was run on, and what came back', () => {
    const reader = new StreamReader()
    const hub = new Set(['complete_task'])
    for (const event of [
      { type: 'said' as const, text: 'Let me look at the header.' },
      { type: 'call' as const, call: call('c1', 'read_file', { path: 'src/header.ts' }) },
      { type: 'result' as const, result: { id: 'c1', name: 'read_file', text: '1\texport const title = "Hello"' } },
      { type: 'call' as const, call: call('c2', 'run', { command: 'npm test' }) },
      { type: 'result' as const, result: { id: 'c2', name: 'run', text: 'It ended with 1.', failed: true } },
      { type: 'call' as const, call: call('c3', 'complete_task', { id: 'card-1', summary: 'Done' }) },
      { type: 'result' as const, result: { id: 'c3', name: 'complete_task', text: 'ok' } },
    ]) reader.line(eventLine(event, hub)!)
    const reading = reader.take()
    assert.deepEqual(reading.said, ['Let me look at the header.'])
    assert.deepEqual(reading.steps, [{ tool: 'Read', text: 'src/header.ts', result: '1\texport const title = "Hello"' }, { tool: 'Bash', text: 'npm test', result: 'Failed: It ended with 1.' }], 'its calls to the hub’s own tools aren’t steps: the card shows those already')
    assert.equal(eventLine({ type: 'said', text: '   ' }, hub), undefined)
  })
})

describe('a run', () => {
  const hub = (done: string[]): { instructions: string; tools: Tool[] } => ({ instructions: 'How to work: finish with complete_task.', tools: [{ spec: { name: 'complete_task', description: 'Finishes a card.', input: { type: 'object', properties: {} } }, run: async (input) => { done.push(JSON.stringify(input)); return 'Completed.' } }] })

  it('works in the repo with its tools until the model is done, and ends well', async () => {
    const { dir, remove } = await repo()
    try {
      const done: string[] = []
      const printed: string[] = []
      const asked: { system: string; ask: string; tools: string[] }[] = []
      const steps = [wants(call('c1', 'read_file', { path: 'src/header.ts' })), wants(call('c2', 'edit_file', { path: 'src/header.ts', old: '"blue"', new: '"green"' })), wants(call('c3', 'run', { command: 'git add -A && git commit -q -m "The header is green" && git log --oneline | head -1' })), wants(call('c4', 'complete_task', { id: 'card-1', summary: 'The header is green.' })), says('The header is green now, and committed.')]
      let n = 0
      const model: StepModel = { label: 'scripted', step: async (input) => { asked.push({ system: input.system, ask: (input.turns[0] as Extract<LoopTurn, { role: 'user' }>).text, tools: input.tools.map((t) => t.name) }); return steps[Math.min(n++, steps.length - 1)] } }
      const code = await work({ dir, hubUrl: 'http://unused', token: 'bnd_x', access: 'full', prompt: 'Make the header green.', print: (line) => printed.push(line), model, hub: hub(done) })
      assert.equal(code, 0)
      assert.match(await readFile(join(dir, 'src', 'header.ts'), 'utf8'), /color = "green"/)
      assert.match(execFileSync('git', ['log', '--oneline'], { cwd: dir }).toString(), /The header is green/)
      assert.deepEqual(done, ['{"id":"card-1","summary":"The header is green."}'])
      assert.equal(asked[0].ask, 'Make the header green.')
      assert.ok(asked[0].system.startsWith('How to work: finish with complete_task.\n\n'))
      assert.ok(asked[0].system.includes(workRules(true)))
      assert.deepEqual(asked[0].tools, ['read_file', 'list_files', 'search', 'edit_file', 'write_file', 'run', 'complete_task'])

      const reader = new StreamReader()
      for (const line of printed) reader.line(line)
      assert.deepEqual(reader.take(true).steps.map((s) => s.tool), ['Read', 'Edit', 'Bash'])
      const reading = reader.summary
      assert.equal(reading.sessionId, undefined, 'no session is named: each run starts from the card')
      assert.equal(reading.reply, 'The header is green now, and committed.')
      assert.ok(!reading.failed)
      assert.equal(reading.tokens, 4 * 120 + 15)
      assert.equal(JSON.parse(printed[0]).permissionMode, 'bypassPermissions')
    } finally {
      await remove()
    }
  })

  it('has no way to run a command with less than full access, and says so to the model', async () => {
    const { dir, remove } = await repo()
    try {
      const systems: string[] = []
      const model: StepModel = { label: 'scripted', step: async (input) => { systems.push(input.system); return input.turns.length === 1 ? wants(call('c1', 'run', { command: 'rm -rf .' })) : says('I can’t run that here.') } }
      const printed: string[] = []
      assert.equal(await work({ dir, hubUrl: 'http://unused', token: 'bnd_x', access: 'edits', prompt: 'Clean up.', print: (line) => printed.push(line), model, hub: hub([]) }), 0)
      assert.match(systems[0], /You can’t run commands here\./)
      assert.match(printed.join('\n'), /There is no tool called run/)
      assert.equal(JSON.parse(printed[0]).permissionMode, 'acceptEdits')
      assert.ok((await readFile(join(dir, 'README.md'), 'utf8')).length > 0, 'nothing was run')
    } finally {
      await remove()
    }
  })

  it('ends badly, saying why, when it runs out of room or its model can’t be asked', async () => {
    const { dir, remove } = await repo()
    try {
      const printed: string[] = []
      const looping = scripted(wants(call('c1', 'list_files')))
      assert.equal(await work({ dir, hubUrl: 'http://unused', token: 'bnd_x', access: 'edits', prompt: 'Go.', print: (line) => printed.push(line), model: looping, hub: hub([]), limits: { steps: 2 } }), 1)
      const last = JSON.parse(printed.at(-1)!) as { is_error: boolean; result: string }
      assert.equal(last.is_error, true)
      assert.match(last.result, /It ran out of room before it finished\./)

      const failing: StepModel = { label: 'down', step: async () => { throw new Error('gpt-deploy at acme.openai.azure.com answered 401.') } }
      const lines: string[] = []
      assert.equal(await work({ dir, hubUrl: 'http://unused', token: 'bnd_x', access: 'edits', prompt: 'Go.', print: (line) => lines.push(line), model: failing, hub: hub([]) }), 1)
      const reader = new StreamReader()
      for (const line of lines) reader.line(line)
      assert.equal(reader.summary.failed, true)
      assert.equal(reader.summary.error, 'gpt-deploy at acme.openai.azure.com answered 401.')
    } finally {
      await remove()
    }
  })
})

describe('the agent’s model, by way of the hub', () => {
  const answering = (answers: { status: number; body: unknown }[]) => {
    const seen: { url: string; auth?: string; body: { system: string; turns: unknown[]; tools: unknown[] } }[] = []
    const send = (async (url: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(url), auth: (init?.headers as Record<string, string>)?.authorization, body: JSON.parse(String(init?.body)) })
      const next = answers[Math.min(seen.length - 1, answers.length - 1)]
      return new Response(JSON.stringify(next.body), { status: next.status, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch
    return { seen, send }
  }
  const input = { system: 'Work.', turns: [{ role: 'user' as const, text: 'Go' }], tools: [] }

  it('asks the hub with the agent’s token, and gives back the step', async () => {
    const { seen, send } = answering([{ status: 200, body: says('Done.') }])
    assert.deepEqual(await hubModel('http://hub.test/', 'bnd_token', send).step(input), says('Done.'))
    assert.deepEqual({ url: seen[0].url, auth: seen[0].auth, system: seen[0].body.system }, { url: 'http://hub.test/api/agent/step', auth: 'Bearer bnd_token', system: 'Work.' })
  })

  it('says what the hub said when the model couldn’t be asked, and doesn’t ask again for what won’t change', async () => {
    const { seen, send } = answering([{ status: 502, body: { error: 'gpt-deploy at acme.openai.azure.com refused the hub’s key.' } }])
    await assert.rejects(() => hubModel('http://hub.test', 'bnd_token', send).step(input), /refused the hub’s key/)
    assert.equal(seen.length, 1)
    const gone = answering([{ status: 401, body: { error: 'This hub doesn’t know that token.' } }])
    await assert.rejects(() => hubModel('http://hub.test', 'bnd_token', gone.send).step(input), /doesn’t know that token/)
    assert.equal(gone.seen.length, 1)
  })
})

describe('the agent’s model, on its own machine', () => {
  const server = (answers: { status: number; body: unknown }[]) => {
    const seen: { url: string; auth?: string; apiKey?: string; body: { model: string; messages: { role: string; content?: string }[]; tools?: unknown[] } }[] = []
    const send = (async (url: string | URL | Request, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>
      seen.push({ url: String(url), auth: headers.authorization, apiKey: headers['api-key'], body: JSON.parse(String(init?.body)) })
      const next = answers[Math.min(seen.length - 1, answers.length - 1)]
      return new Response(typeof next.body === 'string' ? next.body : JSON.stringify(next.body), { status: next.status, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch
    return { seen, send }
  }
  const calls = { choices: [{ message: { content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{"path":"src/header.ts"}' } }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 40, completion_tokens: 8 } }
  const input = { system: 'Work.', turns: [{ role: 'user' as const, text: 'Go' }], tools: [{ name: 'read_file', description: 'Reads.', input: { type: 'object', properties: {} } }] }

  it('is asked from here at the address given, over http too, with no key when the machine has none', async () => {
    const { seen, send } = server([{ status: 200, body: calls }])
    const model = machineModel('http://127.0.0.1:8000', 'DeepSeek-Deploy', undefined, send)
    assert.deepEqual(await model.step(input), { text: '', calls: [{ id: 'c1', name: 'read_file', input: { path: 'src/header.ts' } }], stop: 'tools', usage: { in: 40, out: 8 } })
    assert.equal(seen[0].url, 'http://127.0.0.1:8000/chat/completions')
    assert.equal(seen[0].auth, undefined)
    assert.equal(seen[0].body.model, 'DeepSeek-Deploy')
    assert.deepEqual(seen[0].body.messages.map((m) => [m.role, m.content]), [['system', 'Work.'], ['user', 'Go']])
    assert.equal(model.label, 'DeepSeek-Deploy at 127.0.0.1:8000, from this machine')
  })

  it('sends the machine’s own key both ways a server may want it', async () => {
    const { seen, send } = server([{ status: 200, body: calls }])
    await machineModel('http://localhost:1234/v1', 'local-model', 'machine-key', send).step(input)
    assert.equal(seen[0].url, 'http://localhost:1234/v1/chat/completions')
    assert.deepEqual([seen[0].auth, seen[0].apiKey], ['Bearer machine-key', 'machine-key'])
  })

  it('tries the address with /v1 when the server has nothing at it as given, and stays there', async () => {
    const { seen, send } = server([{ status: 404, body: { error: 'Resource not found' } }, { status: 200, body: calls }, { status: 200, body: calls }])
    const model = machineModel('http://127.0.0.1:8000/', 'DeepSeek-Deploy', undefined, send)
    await model.step(input)
    await model.step(input)
    assert.deepEqual(seen.map((s) => s.url), ['http://127.0.0.1:8000/chat/completions', 'http://127.0.0.1:8000/v1/chat/completions', 'http://127.0.0.1:8000/v1/chat/completions'])
  })

  it('asks a busy server again, and says in words what a server that won’t do it said', async () => {
    const busy = server([{ status: 429, body: {} }, { status: 503, body: {} }, { status: 200, body: calls }])
    assert.equal((await machineModel('http://127.0.0.1:8000/v1', 'm', undefined, busy.send, [1, 1, 1]).step(input)).stop, 'tools')
    assert.equal(busy.seen.length, 3)

    const noKey = server([{ status: 401, body: { error: { message: 'Access denied due to invalid subscription key.' } } }])
    await assert.rejects(() => machineModel('http://127.0.0.1:8000/v1', 'm', undefined, noKey.send).step(input), /refused the request \(401\): it wants a key, which goes in BINDERS_MODEL_KEY on this machine\. It said: .*invalid subscription key/)
    assert.equal(noKey.seen.length, 1, 'not asked again for what won’t change')

    const noModel = server([{ status: 404, body: { error: { message: 'The API deployment for this resource does not exist.' } } }])
    await assert.rejects(() => machineModel('http://127.0.0.1:8000/v1', 'gone', undefined, noModel.send).step(input), /has no model or deployment called gone, or no chat API at that address\. It said: .*does not exist/)

    const down = (async () => { throw new Error('connect ECONNREFUSED 127.0.0.1:8000') }) as unknown as typeof fetch
    await assert.rejects(() => machineModel('http://127.0.0.1:8000', 'm', undefined, down, []).step(input), /couldn’t be reached from this machine: connect ECONNREFUSED 127\.0\.0\.1:8000\. Is its server running here\?/)
  })
})

// The whole of it: a real hub, a real runner, and a stand-in for the model's server. The runner takes a card and starts
// its own file in its work mode; that asks the hub for each step; the hub asks the model's server with the key it keeps.

/** A stand-in for a server that speaks OpenAI's chat API: it answers each request with what `play` says. */
async function modelServer(play: (body: { messages: { role: string; content?: string | null }[]; tools?: { function: { name: string } }[] }) => { text?: string; calls?: { name: string; input: unknown }[] }) {
  const seen: { auth?: string; body: { messages: { role: string; content?: string | null }[]; tools?: { function: { name: string } }[] } }[] = []
  const server = createServer((request, response) => {
    let raw = ''
    request.on('data', (chunk) => { raw += chunk })
    request.on('end', () => {
      const body = JSON.parse(raw || '{}') as (typeof seen)[number]['body']
      seen.push({ auth: request.headers.authorization, body })
      const said = play(body)
      const calls = (said.calls ?? []).map((c, i) => ({ id: `call-${seen.length}-${i}`, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.input) } }))
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ choices: [{ message: { content: said.text ?? null, ...(calls.length ? { tool_calls: calls } : {}) }, finish_reason: calls.length ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 50, completion_tokens: 10 } }))
    })
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/openai/v1`, seen, close: () => new Promise<void>((done) => server.close(() => done())) }
}

describe('Binders’ own agent on a machine, with a real hub and a real runner', { skip: process.platform === 'win32' ? 'the stand-in repo is made with a shell' : false }, () => {
  /** A hub, a repo, a stand-in model server and a card; the runner takes the card and the agent works it. */
  async function workACard(where: 'hub' | 'machine') {
    const { dir, remove } = await repo()
    const hub = new Hub(new MemoryLog())
    await hub.start([{ type: 'binder.put', binder: { id: 'b1', name: 'Site' } }])
    const kv = new MemoryKV()
    const sealer = new Sealer('x')
    const github = new GitHubConnection(kv, sealer, { webUrl: 'http://unused', apiUrl: 'http://unused' })
    const auth = new Auth(kv, sealer, { github: () => undefined, allowed: () => ({ users: [], orgs: [] }), devLogin: () => true })
    const actions = new Actions(hub, github)
    const settings = await new BrainSettingsStore(new MemoryKV(), sealer, {}).load()
    // Not started: nothing here is a model with no machine. It's the hub's side of an agent's model all the same. With
    // the model on the machine, the hub has no part in it, and isn't given the means.
    const endpoints = where === 'hub' ? new EndpointAgents({ hub, actions, kv: new MemoryKV(), sealer, brain: settings, reach: { thisMachineToo: true } }) : undefined
    const app = await buildServer(Spaces.of(kv, [{ info: { id: 'test', name: 'Test', members: [] }, space: { id: 'test', hub, actions, github, webhooks: new Webhooks(hub, actions), ...(endpoints ? { endpoints } : {}) } }]), { auth, brain: settings }, { publicUrl: 'http://hub.test' })
    await app.listen({ port: 0, host: '127.0.0.1' })
    const url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`

    let cardId = ''
    // What a model would do with the card, a step at a time: read it, look at the file, change it, check, finish.
    const script = (n: number) => [
      { calls: [{ name: 'get_task', input: { id: cardId } }] },
      { text: 'The colour is set in src/header.ts.', calls: [{ name: 'read_file', input: { path: 'src/header.ts' } }] },
      { calls: [{ name: 'edit_file', input: { path: 'src/header.ts', old: '"blue"', new: '"green"' } }] },
      { calls: [{ name: 'run', input: { command: 'grep -c green src/header.ts && git commit -qam "The header is green"' } }] },
      { calls: [{ name: 'complete_task', input: { id: cardId, summary: 'The header is green.' } }] },
      { text: 'The header is green now.' },
    ][n] ?? { text: 'Done.' }
    const server = await modelServer((body) => (body.tools?.length === 1 && body.tools[0].function.name === 'ready' ? { calls: [{ name: 'ready', input: {} }] } : script(body.messages.filter((m) => m.role === 'assistant').length)))
    const close = async () => {
      await server.close()
      await app.close()
      await remove()
    }
    try {
      const runner = { tool: 'binders' as const, access: 'full' as const, timeoutMinutes: 2, worktrees: false }
      const me = where === 'hub'
        ? await actions.putAgent('you', { name: 'Own agent', runner, endpoint: { kind: 'openai', baseUrl: server.url, model: 'gpt-deploy', takes: { cards: true, chats: true, debriefs: true, challenges: true } } })
        : await actions.putAgent('you', { name: 'Own agent', runner: { ...runner, modelUrl: server.url, model: 'gpt-deploy' } })
      await endpoints?.setKey(me.id, 'the-hubs-key')
      const token = await auth.issueAgentToken(me.id, 'test')
      const made = await actions.createCard({ kind: 'user', login: 'you' }, { binderId: 'b1', title: 'Make the header green', meantFor: me.id })
      cardId = made.id

      await new Runner({ hubUrl: url, token, workspace: dir, log: () => {}, waitSeconds: 5 }).start(true)

      const after = hub.state.cards.find((c) => c.id === made.id)!
      assert.equal(after.stage, 'live', after.activity.map((a) => `${a.kind}: ${'text' in a ? a.text : ''}`).join(' | '))
      // A card is worked in a worktree of its own, on a branch of its own: the change is committed there.
      const git = (...args: string[]) => execFileSync('git', args, { cwd: dir }).toString()
      const commit = git('log', '--all', '--format=%H', '--grep=The header is green').trim().split('\n')[0]
      assert.ok(commit, `its commit is in the repo: ${git('log', '--all', '--oneline')}`)
      assert.match(git('show', `${commit}:src/header.ts`), /color = "green"/)
      assert.match(await readFile(join(dir, 'src', 'header.ts'), 'utf8'), /color = "blue"/, 'the folder the runner was started in is left as it was')
      assert.ok(after.activity.some((a) => a.kind === 'completed' && /The header is green\./.test(a.text ?? '')))
      // What it did in the repo shows on the card as it would for any agent; its calls to the hub's own tools don't.
      assert.deepEqual(after.activity.filter((a) => a.kind === 'step').map((a) => [a.tool, a.text]), [['Read', 'src/header.ts'], ['Edit', 'src/header.ts'], ['Bash', 'grep -c green src/header.ts && git commit -qam "The header is green"']])
      assert.ok(after.activity.some((a) => a.kind === 'said' && a.text.includes('The colour is set in src/header.ts.')))
      const last = server.seen.at(-1)!.body
      assert.ok(last.messages.some((m) => m.role === 'tool' && /^1$/m.test(m.content ?? '')), 'it was given what its command printed')
      assert.ok(last.tools!.some((t) => t.function.name === 'run') && last.tools!.some((t) => t.function.name === 'complete_task'))
      assert.ok(!JSON.stringify(server.seen).includes(token), 'the agent’s token never reaches the model')
      return { server, close }
    } catch (err) {
      await close()
      throw err
    }
  }

  it('takes a card, changes the repo with a model the hub reaches for it, and finishes the card', async () => {
    const { server, close } = await workACard('hub')
    try {
      // The model's server was only ever asked by the hub, with the key the hub keeps: never with the agent's token.
      assert.ok(server.seen.length >= 6)
      assert.ok(server.seen.every((s) => s.auth === 'Bearer the-hubs-key'))
    } finally {
      await close()
    }
  })

  it('does the same with a model on its own machine, which the runner asks itself: no key, and nothing by way of the hub', async () => {
    const { server, close } = await workACard('machine')
    try {
      // Six steps and no more: the hub never asked whether it calls tools, as the hub has no part in it.
      assert.equal(server.seen.length, 6)
      assert.ok(server.seen.every((s) => s.auth === undefined), 'no key is sent when the machine has none')
    } finally {
      await close()
    }
  })
})

describe('a run of Binders’ own agent that answers without a tool', () => {
  const getTask = (card: { stage: string; needs_you?: unknown }): Tool => ({ spec: { name: 'get_task', description: '', input: {} }, run: async () => JSON.stringify(card) })
  it('is reminded once while its card is still working, and not when it’s done or waiting on a person', async () => {
    const working = reminder([getTask({ stage: 'working' })], 'card-1')!
    assert.match(await working('Let me look.') ?? '', /isn’t finished/)
    assert.equal(await working('Let me look again.'), undefined, 'once')
    assert.equal(await reminder([getTask({ stage: 'review' })], 'card-1')!('Done.'), undefined)
    assert.equal(await reminder([getTask({ stage: 'working', needs_you: { question: 'Which?' } })], 'card-1')!('Asked.'), undefined)
    assert.equal(reminder([getTask({ stage: 'working' })], undefined), undefined, 'no card, no reminder')
  })
})

describe('what goes on a card', () => {
  it('has the secrets an agent wrote hidden, and still says what was done', () => {
    const app = 'ghs_5552670_eyJhbGciOiJFUzI1NiIsInR5cCI6IkpXVCJ9'
    assert.equal(hideSecrets(`git ls-remote https://x-access-token:${app}@github.com/acme/web.git`), 'git ls-remote https://…@github.com/acme/web.git')
    assert.equal(hideSecrets(`TLS="x-access-token:${app}"`), 'TLS="x-access-token:ghs_…"')
    assert.equal(hideSecrets('curl -H "Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345"'), 'curl -H "Authorization: Bearer …"')
    assert.equal(hideSecrets('export GITHUB_TOKEN=github_pat_11ABCDEFG0123456789_abcdef'), 'export GITHUB_TOKEN=github_pat_…')
    assert.equal(hideSecrets('curl -H "Authorization: Bearer $GITHUB_TOKEN" https://api.github.com'), 'curl -H "Authorization: Bearer $GITHUB_TOKEN" https://api.github.com')
    const reader = new StreamReader()
    reader.line(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: `The token is ${app}.` }] } }))
    assert.deepEqual(reader.take(true).said.map((s) => s.includes(app)), [false])
  })
})
