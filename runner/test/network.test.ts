import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createServer, type AddressInfo } from 'node:net'
import { nodeNetwork, reasonOf, serviceEnv, settleNetwork, workerCommand } from '../src/network.ts'

const reads = new Set(['--use-system-ca'])
const older = new Set<string>()

describe('how a runner gets out of a managed network', () => {
  it('starts its worker with the system’s certificates, where this Node can read them', () => {
    assert.deepEqual(workerCommand('/r.mjs', ['--hub', 'h'], {}, reads).args, ['--use-system-ca', '/r.mjs', '--hub', 'h'])
    assert.deepEqual(workerCommand('/r.mjs', ['--hub', 'h'], {}, older).args, ['/r.mjs', '--hub', 'h'], 'an older Node refuses the flag, so it isn’t given one')
  })

  it('the flag really reaches the worker, which is what does the talking', { skip: !process.allowedNodeEnvironmentFlags.has('--use-system-ca') }, async () => {
    const worker = workerCommand('-p', ['process.execArgv.join()'])
    const child = spawn(process.execPath, worker.args, { env: worker.env })
    let said = ''
    child.stdout.on('data', (data) => { said += data })
    await new Promise((done) => child.on('exit', done))
    assert.match(said, /--use-system-ca/)
  })

  it('has fetch follow a proxy only when one is set, and leaves a person’s own choice alone', () => {
    assert.equal(nodeNetwork({}, reads).env.NODE_USE_ENV_PROXY, undefined)
    assert.equal(nodeNetwork({ HTTPS_PROXY: 'http://p:8080' }, reads).env.NODE_USE_ENV_PROXY, '1')
    assert.equal(nodeNetwork({ https_proxy: 'http://p:8080' }, reads).env.NODE_USE_ENV_PROXY, '1')
    assert.equal(nodeNetwork({ HTTPS_PROXY: 'http://p:8080', NODE_USE_ENV_PROXY: '0' }, reads).env.NODE_USE_ENV_PROXY, undefined)
  })

  it('keeps the proxy switch it added from its agents, and one a person set stays', () => {
    const added: NodeJS.ProcessEnv = { HTTPS_PROXY: 'http://p:8080', ...nodeNetwork({ HTTPS_PROXY: 'http://p:8080' }, reads).env }
    settleNetwork(added)
    assert.deepEqual(added, { HTTPS_PROXY: 'http://p:8080' })
    const own: NodeJS.ProcessEnv = { NODE_USE_ENV_PROXY: '1' }
    settleNetwork(own)
    assert.equal(own.NODE_USE_ENV_PROXY, '1')
  })

  it('carries a shell’s proxy and certificate settings to a service, and nothing else', () => {
    assert.deepEqual(serviceEnv({ HTTPS_PROXY: 'http://p:8080', no_proxy: 'localhost', NODE_EXTRA_CA_CERTS: '/ca.pem', BINDERS_TOKEN: 'bnd_x', SECRET: 'x', HTTP_PROXY: '' }), { HTTPS_PROXY: 'http://p:8080', no_proxy: 'localhost', NODE_EXTRA_CA_CERTS: '/ca.pem' })
  })
})

describe('saying why something couldn’t be reached', () => {
  const failed = (cause: object) => Object.assign(new TypeError('fetch failed'), { cause })

  it('says what fetch keeps to itself, from a real failure', async () => {
    const free = createServer().listen(0, '127.0.0.1')
    await once(free, 'listening')
    const { port } = free.address() as AddressInfo
    free.close()
    await once(free, 'close')
    const error = await fetch(`http://127.0.0.1:${port}/`).catch((e: unknown) => e)
    assert.match(reasonOf(error, {}), /^fetch failed \(ECONNREFUSED/)
  })

  it('says what to do about a certificate this machine doesn’t trust', () => {
    const error = failed(Object.assign(new Error('self-signed certificate in certificate chain'), { code: 'SELF_SIGNED_CERT_IN_CHAIN' }))
    const told = reasonOf(error, {}, 'v24.1.0', reads)
    assert.match(told, /^fetch failed \(SELF_SIGNED_CERT_IN_CHAIN: self-signed/)
    assert.match(told, /certificate store/)
    assert.match(reasonOf(error, {}, 'v20.11.0', older), /Node v20\.11\.0 can’t read/)
  })

  it('says when a proxy is set on a Node that can’t use one, and when one might be needed', () => {
    const error = failed(Object.assign(new Error('getaddrinfo ENOTFOUND hub'), { code: 'ENOTFOUND' }))
    assert.match(reasonOf(error, { HTTPS_PROXY: 'http://p' }, 'v23.11.0', reads), /Node v23\.11\.0 can’t use one/)
    assert.doesNotMatch(reasonOf(error, { HTTPS_PROXY: 'http://p' }, 'v24.1.0', reads), /can’t use one/)
    assert.match(reasonOf(error, {}, 'v24.1.0', reads), /set HTTPS_PROXY/)
  })

  it('finds the cause under several addresses, and leaves a plain error as it is', () => {
    const many = failed(Object.assign(new AggregateError([Object.assign(new Error('connect ETIMEDOUT 1.2.3.4:443'), { code: 'ETIMEDOUT' })]), { code: 'ETIMEDOUT' }))
    assert.match(reasonOf(many, { HTTPS_PROXY: 'http://p' }, 'v24.1.0', reads), /ETIMEDOUT/)
    assert.equal(reasonOf(new Error('This hub doesn’t know that token.'), {}), 'This hub doesn’t know that token.')
    assert.equal(reasonOf('odd', {}), 'odd')
  })
})
