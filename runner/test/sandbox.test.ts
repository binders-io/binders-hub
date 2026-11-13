import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { splitToken } from '../src/sandbox.ts'

// The sandbox the hub keeps its machines in: a job is a clone and a runner started in it, and nothing else reaches in.
// What starts the runner here is a stand-in, so no hub is needed to see a machine be kept and taken away.

const root = mkdtempSync(join(tmpdir(), 'binders-sandbox-test-'))
const repo = join(root, 'repo')
const secret = 'test-secret'
const port = 4600 + Math.floor(Math.random() * 300)
const url = `http://127.0.0.1:${port}`
const stub = join(root, 'stub.mjs')
const started = join(root, 'started.json')
let sandbox: ChildProcess

const call = (path: string, init: RequestInit = {}) => fetch(`${url}${path}`, { ...init, headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json', ...(init.headers ?? {}) } })

async function until(check: () => boolean, ms = 15_000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (check()) return
    await new Promise((done) => setTimeout(done, 50))
  }
  throw new Error('It never happened.')
}

before(async () => {
  mkdirSync(repo)
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo })
  execFileSync('git', ['config', 'user.email', 'tests@binders.invalid'], { cwd: repo })
  execFileSync('git', ['config', 'user.name', 'Tests'], { cwd: repo })
  writeFileSync(join(repo, 'README.md'), '# A repo\n')
  execFileSync('git', ['add', '.'], { cwd: repo })
  execFileSync('git', ['commit', '-qm', 'Initial'], { cwd: repo })
  writeFileSync(stub, `import { writeFileSync } from 'node:fs'\nwriteFileSync(${JSON.stringify(started)}, JSON.stringify(process.argv.slice(2)))\nsetInterval(() => {}, 1000)\n`)
  sandbox = spawn(process.execPath, [join(import.meta.dirname, '..', 'src', 'main.ts'), 'sandbox', '--port', String(port), '--host', '127.0.0.1', '--root', join(root, 'machines'), '--secret', secret], {
    env: { ...process.env, BINDERS_SANDBOX_RUNNER: stub },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const seen: string[] = []
  sandbox.stdout!.on('data', (chunk: Buffer) => seen.push(chunk.toString('utf8')))
  sandbox.stderr!.on('data', (chunk: Buffer) => seen.push(chunk.toString('utf8')))
  await until(() => seen.join('').includes('Binders sandbox on'), 20_000)
})

after(() => {
  sandbox?.kill('SIGTERM')
})

describe('a sandbox of the hub’s own', () => {
  it('takes only the hub’s word, and says it is up to anyone who asks', async () => {
    const wrong = await fetch(`${url}/jobs`, { headers: { authorization: 'Bearer none' } })
    assert.equal(wrong.status, 401)
    const health = await fetch(`${url}/health`)
    assert.equal(health.status, 200, 'what the hub’s compose checks, which has no secret to give')
  })

  it('keeps a machine: its repo cloned, and the runner started in it with a token of its own', async () => {
    const answer = await call('/jobs', { method: 'POST', body: JSON.stringify({ id: 'agent-1', name: 'Ana', hub: 'http://hub.invalid', token: 'bnd_secret', clones: [{ url: `file://${repo}`, dir: 'repo' }] }) })
    assert.equal(answer.status, 202)
    const machine = join(root, 'machines', 'agent-1')
    await until(() => existsSync(join(machine, 'README.md')) && existsSync(started))
    const args = JSON.parse(readFileSync(started, 'utf8')) as string[]
    assert.equal(args[args.indexOf('--hub') + 1], 'http://hub.invalid')
    assert.equal(args[args.indexOf('--workspace') + 1], machine)
    assert.equal(args[args.indexOf('--name') + 1], 'Ana')
    const token = join(root, 'machines', 'agent-1.token')
    assert.equal(readFileSync(token, 'utf8'), 'bnd_secret')
    assert.equal(statSync(token).mode & 0o777, 0o600, 'only this process and the runner read it')
    const listed = await (await call('/jobs')).json() as { jobs: { id: string }[] }
    assert.deepEqual(listed.jobs.map((j) => j.id), ['agent-1'])
  })

  it('holds a folder of repos, each in a folder of its own, as a machine of someone’s does', async () => {
    const answer = await call('/jobs', { method: 'POST', body: JSON.stringify({ id: 'agent-3', name: 'Two repos', hub: 'http://hub.invalid', token: 'bnd_secret', clones: [{ url: `file://${repo}`, dir: 'one' }, { url: `file://${repo}`, dir: 'two' }] }) })
    assert.equal(answer.status, 202)
    const machine = join(root, 'machines', 'agent-3')
    await until(() => existsSync(join(machine, 'one', 'README.md')) && existsSync(join(machine, 'two', 'README.md')))
    assert.equal((await call('/jobs/agent-3', { method: 'DELETE' })).status, 204)
  })

  it('keeps a clone’s GitHub token out of its remote, where its git reads one the hub renews', async () => {
    const machine = join(root, 'machines', 'agent-1')
    assert.equal(execFileSync('git', ['-C', machine, 'remote', 'get-url', 'origin'], { encoding: 'utf8' }).trim(), `file://${repo}`)
    assert.match(execFileSync('git', ['-C', machine, 'config', '--local', '--get-all', 'credential.helper'], { encoding: 'utf8' }), /^\n.*agent-1\.git/, 'an empty helper first, so none of the machine’s answers before it')
    const renewed = await call('/jobs/agent-1/credentials', { method: 'PUT', body: JSON.stringify({ clones: [{ url: 'https://x-access-token:ghs_renewed1234567890@github.com/acme/web.git', dir: 'repo' }] }) })
    assert.equal(renewed.status, 204)
    const file = join(root, 'machines', 'agent-1.git', 'repo')
    assert.equal(readFileSync(file, 'utf8'), 'ghs_renewed1234567890')
    assert.equal(statSync(file).mode & 0o777, 0o600)
    // What git hands GitHub when it asks: the renewed token, read through the clone's own helper.
    const filled = execFileSync('git', ['-C', machine, 'credential', 'fill'], { input: 'protocol=https\nhost=github.com\n\n', encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1' } })
    assert.match(filled, /password=ghs_renewed1234567890/)
    assert.equal((await call('/jobs/nobody/credentials', { method: 'PUT', body: JSON.stringify({ clones: [{ url: 'https://github.com/a/b', dir: 'b' }] }) })).status, 404)
  })

  it('takes a machine away, and the runner with it', async () => {
    const answer = await call('/jobs/agent-1', { method: 'DELETE' })
    assert.equal(answer.status, 204)
    await until(() => false, 100).catch(() => undefined)
    const listed = await (await call('/jobs')).json() as { jobs: { id: string }[] }
    assert.deepEqual(listed.jobs, [])
    assert.equal((await call('/jobs/agent-1', { method: 'DELETE' })).status, 404)
    assert.equal(existsSync(join(root, 'machines', 'agent-1.git')), false, 'its GitHub tokens go with it')
  })

  it('says what a job is missing', async () => {
    const answer = await call('/jobs', { method: 'POST', body: JSON.stringify({ id: 'agent-2' }) })
    assert.equal(answer.status, 422)
    assert.match(await answer.text(), /needs the hub’s address/)
  })
})

describe('a clone’s address', () => {
  it('splits its token from it, and leaves one with none as it is', () => {
    assert.deepEqual(splitToken('https://x-access-token:ghs_abc@github.com/acme/web.git'), { url: 'https://github.com/acme/web.git', token: 'ghs_abc' })
    assert.deepEqual(splitToken('https://github.com/acme/web.git'), { url: 'https://github.com/acme/web.git' })
    assert.deepEqual(splitToken('file:///tmp/repo'), { url: 'file:///tmp/repo' })
  })
})
