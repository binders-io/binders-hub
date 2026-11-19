import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { appOpenIn, whileAppOpen, type Child } from '../src/app.ts'

/** A runner that ends when it's asked to, or when the test ends it, and says what it was asked. */
function fakeRunner() {
  const asked: string[] = []
  let end = (_code: number) => {}
  const child: Child = {
    kill: (signal) => {
      asked.push(signal)
      end(0)
    },
    exited: new Promise((done) => { end = done }),
  }
  return { child, asked, end: (code: number) => end(code) }
}

describe('an agent kept to the Binders app', () => {
  it('counts the app as people open it, not the server AI tools start from it', () => {
    assert.equal(appOpenIn('/usr/sbin/cfprefsd agent\n/Applications/Binders.app/Contents/MacOS/Binders\n'), true)
    assert.equal(appOpenIn('/Users/someone/Applications/Binders.app/Contents/MacOS/Binders'), true)
    assert.equal(appOpenIn('/Applications/Binders.app/Contents/MacOS/Binders --mcp\n'), false)
    assert.equal(appOpenIn('/Applications/Claude.app/Contents/Helpers/disclaimer --pgroup -- /Applications/Binders.app/Contents/MacOS/Binders --mcp'), false)
    assert.equal(appOpenIn('/Applications/Binders Helper.app/Contents/MacOS/Binders Helper\n'), false)
    assert.equal(appOpenIn(''), false)
  })

  it('waits for the app, runs the runner while it’s open, stops it when it quits, and waits again', async () => {
    // Closed, open, open, then quit; then it stays closed until the service is stopped.
    const states = [false, true, true, false]
    const open = async () => states.shift() ?? false
    const runners: ReturnType<typeof fakeRunner>[] = []
    const lines: string[] = []
    const signals = new EventEmitter()
    const ended = whileAppOpen(['--hub', 'https://hub.test'], {
      open,
      start: (args) => {
        assert.deepEqual(args, ['--hub', 'https://hub.test'])
        const runner = fakeRunner()
        runners.push(runner)
        return runner.child
      },
      every: 1,
      log: (line) => lines.push(line),
      signals,
    })
    while (lines.filter((l) => l.startsWith('Waiting')).length < 2) await new Promise((done) => setTimeout(done, 1))
    assert.equal(runners.length, 1)
    assert.deepEqual(runners[0].asked, ['SIGTERM'], 'asked to stop as its service stopping does: cards kept running carry on')
    signals.emit('SIGTERM')
    assert.equal(await ended, 0)
    assert.deepEqual(lines, ['Waiting for the Binders app to open.', 'The Binders app is open: starting.', 'The Binders app quit: stopping until it opens again.', 'Waiting for the Binders app to open.'])
    assert.equal(signals.listenerCount('SIGTERM'), 0)
  })

  it('passes Ctrl-C on to the runner, and ends with the runner when it ends by itself', async () => {
    const signals = new EventEmitter()
    const first = fakeRunner()
    const stopped = whileAppOpen([], { open: async () => true, start: () => first.child, every: 1, log: () => {}, signals })
    await new Promise((done) => setTimeout(done, 5))
    signals.emit('SIGINT')
    assert.equal(await stopped, 0)
    assert.deepEqual(first.asked, ['SIGINT'], 'its cards go back, as with Ctrl-C')

    const second = fakeRunner()
    const crashed = whileAppOpen([], { open: async () => true, start: () => second.child, every: 1, log: () => {}, signals: new EventEmitter() })
    await new Promise((done) => setTimeout(done, 5))
    second.end(1)
    assert.equal(await crashed, 1, 'for its service to start again')
    assert.deepEqual(second.asked, [])
  })
})
