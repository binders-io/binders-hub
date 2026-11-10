import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { mkdtemp, mkdir, readdir, readFile, stat, writeFile, chmod } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { daemonCommand, reposHere, subcommands, usage, type Ports, type Saved } from '../src/daemon.ts'
import { toolFolders, toolsHere } from '../src/engines.ts'
import { joinAgent } from '../src/brain.ts'
import { findable, preferred } from '../../shared/agents.ts'

// `binders join`: what it finds on a machine, what it asks the hub, and what it sets up and says. Nothing here looks at
// the machine it runs on or installs a service: the tools, repos, servers and service are stand-ins, in a home of their
// own, and the hub is a small server that answers as the real one does.

/** What the hub is asked and answers, for a test to set. */
function standInHub() {
  const asked: { path: string; body: Record<string, any> }[] = []
  const reply = { status: 200, body: {} as Record<string, unknown> }
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      asked.push({ path: request.url ?? '', body: JSON.parse(Buffer.concat(chunks).toString() || '{}') })
      response.writeHead(reply.status, { 'content-type': 'application/json' })
      response.end(JSON.stringify(reply.body))
    })
  })
  return new Promise<{ url: string; asked: typeof asked; reply: typeof reply; close: () => Promise<void> }>((done) => server.listen(0, '127.0.0.1', () => done({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, asked, reply, close: () => new Promise<void>((end) => server.close(() => end())) })))
}

const claudeAnswer = { agent: { id: 'agent-1', name: 'Claude Code on studio-mac', tool: 'claude', token: 'bnd_agent-token' }, binder: { id: 'test', name: 'Acme' } }

/** The machine's parts as stand-ins: what's on it, and the services it would have installed. */
function standIns(found: { tools?: string[]; repos?: string[] } = {}) {
  const installed: Saved[] = []
  const looked: string[] = []
  const ports: Partial<Ports> = {
    install: async (s) => { installed.push(s) },
    keepRunning: async () => undefined,
    look: async (folder) => { looked.push(folder); return { tools: (found.tools ?? ['codex', 'claude']) as never, repos: found.repos ?? ['acme/web', 'acme/api'] } },
    detect: async () => [{ url: 'http://127.0.0.1:11434/v1', kind: 'ollama', models: ['qwen3:14b', 'nomic-embed-text'] }, { url: 'say:', kind: 'say', models: ['Alex', 'Samantha', 'Daniel'] }],
    disk: async () => ({ models: [], looked: [] }),
    host: () => 'studio-mac.local',
  }
  return { ports, installed, looked }
}

describe('binders join', () => {
  let home: string
  let folder: string
  let hub: Awaited<ReturnType<typeof standInHub>>
  let said: string[]
  const logged = console.log
  const before = process.env.BINDERS_HOME

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'binders-join-home-'))
    folder = await mkdtemp(join(tmpdir(), 'binders-join-code-'))
    process.env.BINDERS_HOME = home
    hub = await standInHub()
    said = []
    console.log = (...lines: unknown[]) => void said.push(lines.join(' '))
  })

  afterEach(async () => {
    console.log = logged
    if (before === undefined) delete process.env.BINDERS_HOME
    else process.env.BINDERS_HOME = before
    await hub.close()
  })

  const run = (args: string[], ports: Partial<Ports>) => daemonCommand(args, async () => ({ name: 'Builder', id: 'agent-9' }), async () => undefined, ports)
  const saved = async () => (await Promise.all((await readdir(join(home, 'agents'))).filter((n) => n.endsWith('.json')).map(async (n) => JSON.parse(await readFile(join(home, 'agents', n), 'utf8')) as Saved))).sort((a, b) => a.name.localeCompare(b.name))

  it('looks at the machine, asks the hub, sets the agent up as binders add does, and says what it did', async () => {
    hub.reply.body = claudeAnswer
    const here = standIns()
    assert.equal(await run(['join', 'bnj_line', '--hub', hub.url, '--workspace', folder], here.ports), 0)

    // What it asks: the line, the host, every tool it found, the folder and its repos. No sign-in, no token header.
    assert.deepEqual(hub.asked, [{ path: '/api/machines/join', body: { token: 'bnj_line', host: 'studio-mac.local', tools: ['codex', 'claude'], folder, repos: ['acme/web', 'acme/api'] } }])
    assert.deepEqual(here.looked, [folder])

    // What it sets up: one service for the agent, named for it, with the token kept in a file of its own.
    assert.deepEqual(here.installed.map((s) => [s.name, s.agent, s.agentId, s.hub, s.workspace, s.kind]), [['claude-code-on-studio-mac', 'Claude Code on studio-mac', 'agent-1', hub.url, folder, undefined]])
    assert.equal(await readFile(join(home, 'agents', 'claude-code-on-studio-mac.token'), 'utf8'), 'bnd_agent-token')
    assert.equal((await stat(join(home, 'agents', 'claude-code-on-studio-mac.token'))).mode & 0o777, 0o600)
    assert.deepEqual((await saved()).map((s) => s.name), ['claude-code-on-studio-mac'])

    // What it says, in order: what it found, what was chosen and why, the agent and its Binder, and the three commands.
    assert.deepEqual(said.filter((line) => !/^  Warning/.test(line)), [
      'Looking at this machine',
      '  Agent tools: Codex, Claude Code',
      `  GitHub repos in ${folder}: acme/web, acme/api`,
      'Binders chose Claude Code, the one it prefers of those installed here.',
      '✓ Claude Code on studio-mac, in Acme, is running in the background.',
      '  binders list shows it · binders logs claude-code-on-studio-mac -f follows it · binders stop claude-code-on-studio-mac stops it',
    ])
  })

  it('says as it’s installed here when there is only the one tool, and warns when the folder has no repo', async () => {
    hub.reply.body = claudeAnswer
    const here = standIns({ tools: ['claude'], repos: [] })
    assert.equal(await run(['join', 'bnj_line', '--hub', hub.url, '--workspace', folder], here.ports), 0)
    assert.ok(said.includes('Binders chose Claude Code, as it’s installed here.'), said.join('\n'))
    assert.ok(said.includes(`  No GitHub repos in ${folder}.`))
    assert.ok(said.some((line) => /^  Warning: .* isn’t a git repo and has no repo in it/.test(line)))
  })

  it('lends the machine’s models too when the hub sends a token for them, saying how many it found', async () => {
    hub.reply.body = { ...claudeAnswer, machine: { id: 'm-1', name: 'studio-mac', token: 'bnw_machine-token' } }
    const here = standIns()
    assert.equal(await run(['join', 'bnj_line', '--hub', hub.url, '--workspace', folder, '--serve', 'http://127.0.0.1:9000/v1'], here.ports), 0)
    // Two services: the agent's, and the machine's, as binders add --token bnj_… sets it up (no workspace, its servers).
    assert.deepEqual(here.installed.map((s) => [s.name, s.agentId, s.kind, s.serve]), [['claude-code-on-studio-mac', 'agent-1', undefined, undefined], ['studio-mac', 'm-1', 'brain', ['http://127.0.0.1:9000/v1']]])
    assert.equal(await readFile(join(home, 'agents', 'studio-mac.token'), 'utf8'), 'bnw_machine-token')
    // Voices aren't models: two found, as the two on the Ollama server.
    assert.equal(said.filter((line) => /models/.test(line)).join('\n'), '  Also lending this machine’s models to the hub: 2 found.')
    assert.equal(said.indexOf('  Also lending this machine’s models to the hub: 2 found.'), said.length - 1, 'right after the commands')
  })

  it('says why the models aren’t lent when the hub couldn’t take the machine, and still sets the agent up', async () => {
    hub.reply.body = { ...claudeAnswer, machineWhy: 'A hub takes up to 20 machines.' }
    const here = standIns()
    assert.equal(await run(['join', 'bnj_line', '--hub', hub.url, '--workspace', folder], here.ports), 0)
    assert.equal(here.installed.length, 1)
    assert.ok(said.includes('  This machine’s models aren’t lent to the hub: A hub takes up to 20 machines.'))
  })

  it('on the same machine again is the same service with the new token, not a second one', async () => {
    hub.reply.body = { ...claudeAnswer, machine: { id: 'm-1', name: 'studio-mac', token: 'bnw_one' } }
    const first = standIns()
    await run(['join', 'bnj_line', '--hub', hub.url, '--workspace', folder], first.ports)
    hub.reply.body = { ...claudeAnswer, agent: { ...claudeAnswer.agent, token: 'bnd_fresh' }, machine: { id: 'm-1', name: 'studio-mac', token: 'bnw_two' } }
    said.length = 0
    await run(['join', 'bnj_line', '--hub', hub.url, '--workspace', folder], standIns().ports)
    assert.deepEqual((await saved()).map((s) => s.name), ['claude-code-on-studio-mac', 'studio-mac'])
    assert.equal(await readFile(join(home, 'agents', 'claude-code-on-studio-mac.token'), 'utf8'), 'bnd_fresh')
    assert.equal(await readFile(join(home, 'agents', 'studio-mac.token'), 'utf8'), 'bnw_two')
    assert.ok(said.includes('✓ Claude Code on studio-mac, in Acme, is running in the background again.'), said.join('\n'))
  })

  it('stops at once with no agent tool, naming the ones it looked for, without asking the hub or setting anything up', async () => {
    const here = standIns({ tools: [] })
    assert.equal(await run(['join', 'bnj_line', '--hub', hub.url, '--workspace', folder], here.ports), 1)
    assert.deepEqual(hub.asked, [])
    assert.deepEqual(here.installed, [])
    assert.equal(said[0], 'No agent tool found on this machine.')
    for (const tool of findable) assert.ok(said[1].includes(`${tool.name} (${tool.command})`), said[1])
    assert.equal(said[2], '  Install one of them, then run the same line again: that’s all it takes.')
    assert.equal(said.length, 3)
    await assert.rejects(readdir(join(home, 'agents')), 'nothing was saved')
  })

  it('gives the hub’s own words when it turns the line away, and sets nothing up', async () => {
    hub.reply.status = 401
    hub.reply.body = { error: 'That line has run out or was replaced. Make a new one on the Agents page: Add a machine.' }
    const here = standIns()
    await assert.rejects(run(['join', 'bnj_line', '--hub', hub.url, '--workspace', folder], here.ports), /That line has run out or was replaced\. Make a new one on the Agents page: Add a machine\./)
    assert.deepEqual(here.installed, [])
    await assert.rejects(joinAgent('http://127.0.0.1:9', 'bnj_x', { host: 'h', tools: ['claude'], folder, repos: [] }), /Couldn’t reach the hub at http:\/\/127\.0\.0\.1:9\./)
    hub.reply.status = 200
    hub.reply.body = { agent: { id: 'a', name: 'A', tool: 'claude', token: 'not-a-token' } }
    await assert.rejects(joinAgent(hub.url, 'bnj_x', { host: 'h', tools: ['claude'], folder, repos: [] }), /The hub answered 200\./)
  })

  it('needs the line, the hub and a folder, and is one of the commands binders knows', async () => {
    const here = standIns()
    await assert.rejects(run(['join', '--hub', hub.url], here.ports), /binders join needs the line from the Agents page/)
    await assert.rejects(run(['join', 'bnd_an-agents-token', '--hub', hub.url], here.ports), /binders join needs the line from the Agents page/)
    const savedHub = process.env.BINDERS_URL
    delete process.env.BINDERS_URL
    await assert.rejects(run(['join', 'bnj_line'], here.ports), /binders join needs the hub/)
    if (savedHub !== undefined) process.env.BINDERS_URL = savedHub
    await assert.rejects(run(['join', 'bnj_line', '--hub', hub.url, '--workspace', join(folder, 'nowhere')], here.ports), /isn’t a folder/)
    assert.deepEqual(hub.asked, [])
    assert.ok(subcommands.has('join'))
    assert.match(usage, /binders join bnj_…/)
  })

  it('leaves binders add as it was: an agent’s token, and the brain’s own line', async () => {
    // An agent's token: who the hub says it is, then the same service as before.
    const agent = standIns()
    assert.equal(await run(['add', '--token', 'bnd_by-hand', '--hub', hub.url, '--workspace', folder], agent.ports), 0)
    assert.deepEqual(agent.installed.map((s) => [s.name, s.agent, s.agentId, s.kind]), [['builder', 'Builder', 'agent-9', undefined]])
    assert.deepEqual(said.slice(0, 2), [`✓ Builder is running in the background, in ${folder}.`, '  binders list · binders logs builder -f · binders restart builder · binders remove builder'])
    assert.match(said[2], /^  Warning: .* isn’t a git repo/)

    // The line from Settings → Brain: this machine joins as a machine of the hub's, and lends its models.
    hub.reply.body = { id: 'm-7', name: 'studio-mac', token: 'bnw_brain' }
    said.length = 0
    const brain = standIns()
    assert.equal(await run(['add', '--token', 'bnj_brain-line', '--hub', hub.url], brain.ports), 0)
    assert.equal(hub.asked.at(-1)!.path, '/api/brain/machines/join')
    assert.deepEqual(brain.installed.map((s) => [s.name, s.agentId, s.kind]), [['studio-mac', 'm-7', 'brain']])
    assert.equal(said[0], '✓ studio-mac is serving this machine’s models to the hub, in the background.')
    assert.ok(said.some((line) => /Ollama on :11434: qwen3:14b, nomic-embed-text/.test(line)))
    assert.ok(said.includes('  binders list · binders logs studio-mac -f · binders restart studio-mac · binders remove studio-mac'))
  })
})

describe('what it finds on the machine', () => {
  it('lists the agent tools installed, in the product’s order of preference, and only runnable programs', async () => {
    const bin = await mkdtemp(join(tmpdir(), 'binders-join-bin-'))
    const make = async (name: string, mode: number) => {
      await writeFile(join(bin, name), '#!/bin/sh\n')
      await chmod(join(bin, name), mode)
    }
    await make('codex', 0o755)
    await make('claude', 0o755)
    await make('gemini', 0o644)
    await mkdir(join(bin, 'amp'))
    const folders = () => [join(bin, 'not-there'), bin]
    assert.deepEqual(toolsHere(folders, false), ['claude', 'codex'], 'Claude Code before Codex, whatever order they were put there in; not a file that can’t run, nor a folder')
    assert.deepEqual(toolsHere(() => [mkdtempSync(join(tmpdir(), 'binders-join-empty-'))], false), [])
    assert.deepEqual(preferred(['codex', 'claude'])?.id, 'claude')
    assert.equal(preferred(['custom', 'made-up']), undefined)
    assert.ok(!findable.some((t) => t.id === 'custom'), 'a command of the person’s own isn’t looked for')

    // On Windows, the file its installer makes: claude.cmd, not a bare claude.
    const win = await mkdtemp(join(tmpdir(), 'binders-join-win-'))
    await writeFile(join(win, 'claude'), '')
    assert.deepEqual(toolsHere(() => [win], true), [])
    await writeFile(join(win, 'codex.cmd'), '')
    assert.deepEqual(toolsHere(() => [win], true), ['codex'])
  })

  it('looks on the PATH first, then where installers put tools when they leave the PATH alone', () => {
    const places = toolFolders('claude', '/one:/two::/three', '/home/u', false)
    assert.deepEqual(places.slice(0, 3), ['/one', '/two', '/three'])
    for (const usual of ['/home/u/.claude/bin', '/home/u/.local/bin', '/opt/homebrew/bin', '/usr/local/bin', '/home/u/.bun/bin']) assert.ok(places.includes(usual), usual)
    assert.ok(toolFolders('claude', '', '/home/u', true, '/home/u/AppData/Roaming').includes('/home/u/AppData/Roaming/npm'))
  })

  it('finds the GitHub repos a folder holds: itself, or the ones directly inside it', async () => {
    const git = (dir: string, ...args: string[]) => execFileSync('git', ['-C', dir, ...args], { stdio: 'ignore' })
    const repo = async (parent: string, name: string, origin?: string) => {
      const dir = join(parent, name)
      await mkdir(dir, { recursive: true })
      git(dir, 'init', '-q')
      if (origin) git(dir, 'remote', 'add', 'origin', origin)
      return dir
    }
    const code = await mkdtemp(join(tmpdir(), 'binders-join-repos-'))
    await repo(code, 'web', 'https://github.com/acme/web.git')
    await repo(code, 'api', 'git@github.com:acme/api.git')
    await repo(code, 'local')
    await repo(code, '.hidden', 'https://github.com/acme/hidden.git')
    await mkdir(join(code, 'notes'))
    assert.deepEqual((await reposHere(code)).sort(), ['acme/api', 'acme/web'], 'by their origins; not one with none, a dot folder or a plain folder')
    assert.deepEqual(await reposHere(join(code, 'web')), ['acme/web'], 'a repo is itself')
    await mkdir(join(code, 'web', 'src'))
    assert.deepEqual(await reposHere(join(code, 'web', 'src')), ['acme/web'], 'a folder in a repo is that repo’s')
    assert.deepEqual(await reposHere(join(code, 'notes')), [])
    assert.deepEqual(await reposHere(join(code, 'nowhere')), [])
  })
})
