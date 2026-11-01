import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Writable } from 'node:stream'
import Fastify from 'fastify'
import { makeLogger } from '../src/logger.ts'

function capture() {
  const lines: string[] = []
  const stream = new Writable({ write(chunk, _encoding, done) { lines.push(String(chunk)); done() } })
  return { lines, logger: makeLogger(stream, 'info') }
}

describe('what the hub logs', () => {
  it('leaves query strings out of requests: GitHub’s sign-in code and state are in them', async () => {
    const { lines, logger } = capture()
    const app = Fastify({ loggerInstance: logger })
    app.get('/auth/github/callback', async () => ({ ok: true }))
    await app.inject({ url: '/auth/github/callback?code=gho_secretcode&state=secretstate' })
    await app.close()
    const all = lines.join('')
    assert.match(all, /auth\/github\/callback/, 'the request is logged')
    assert.doesNotMatch(all, /secretcode|secretstate/)
  })

  it('holds back what’s secret, wherever a log line carries it', () => {
    const { lines, logger } = capture()
    logger.info({ token: 'ghs_abc', clientSecret: 'shh', headers: { authorization: 'Bearer abc', cookie: 'binders_session=abc' }, card: { token: 'nested' } }, 'something happened')
    const line = lines.join('')
    assert.match(line, /something happened/)
    assert.doesNotMatch(line, /ghs_abc|shh|Bearer abc|binders_session=abc|nested/)
  })

  it('keeps an error’s message and stack', () => {
    const { lines, logger } = capture()
    logger.error({ err: new Error('The log went away') }, 'Reading the change log failed')
    const line = JSON.parse(lines[0]) as { msg: string; err: { message: string; stack: string } }
    assert.equal(line.msg, 'Reading the change log failed')
    assert.equal(line.err.message, 'The log went away')
    assert.match(line.err.stack, /logger\.test/)
  })
})
