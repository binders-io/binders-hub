import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Hub } from '../src/hub.ts'
import { MemoryKV } from '../src/kv.ts'
import { MemoryLog } from '../src/log.ts'
import { Sealer } from '../src/secrets.ts'
import { Inbox } from '../src/listen/inbox.ts'
import { FeedReader, feedMostBytes, getText, type Got } from '../src/listen/reader.ts'
import { seed } from './helpers.ts'

const feed = (...ids: string[]) => JSON.stringify({ version: 'https://jsonfeed.org/version/1.1', title: 'Status', items: ids.map((id) => ({ id, title: `Incident ${id}`, content_text: `Words of ${id}.`, url: `https://status.example.com/${id}` })) })

async function setUp(mode: 'on' | 'watch' | 'off' = 'on') {
  const hub = new Hub(new MemoryLog())
  await hub.start(seed())
  const kv = new MemoryKV()
  let now = Date.parse('2026-11-10T09:00:00.000Z')
  const clock = () => now
  const inbox = new Inbox({ hub, kv, sealer: new Sealer('test-secret'), member: () => false, now: clock })
  const { listener } = await inbox.put('maya', undefined, { kind: 'feed', name: 'Status page', url: 'https://status.example.com/feed.json', everyMinutes: 15, mode })
  const asked: { etag?: string; modified?: string }[] = []
  let answer: () => Got | Promise<Got> = () => ({ status: 200, body: feed() })
  const reader = new FeedReader({ hub, inbox, kv, now: clock, get: async (_address, last) => { asked.push({ ...last }); return answer() } })
  const titles = async () => (await inbox.feed()).map((o) => o.title)
  return { hub, inbox, reader, listener, asked, titles, answers: (next: typeof answer) => { answer = next }, later: (minutes: number) => { now += minutes * 60_000 }, failing: () => inbox.listener(listener.id)?.failing }
}

describe('a feed the hub asks', () => {
  it('starts where the feed is: what was already there is left alone, and what comes after is filed', async () => {
    const set = await setUp()
    set.answers(() => ({ status: 200, body: feed('2', '1') }))
    await set.reader.look()
    assert.deepEqual(await set.titles(), [], 'nothing from before anyone was listening')
    set.later(15)
    set.answers(() => ({ status: 200, body: feed('4', '3', '2', '1') }))
    await set.reader.look()
    assert.deepEqual(await set.titles(), ['Incident 4', 'Incident 3'], 'newest first in the list, filed oldest first')
    assert.equal(set.hub.state.notes.filter((n) => n.from?.listener === set.listener.id).length, 2)
    assert.equal(set.hub.state.notes.find((n) => n.title === 'Incident 3')!.from!.strength, 'outside')
  })

  it('reads only when it’s due, and one look at a time', async () => {
    const set = await setUp()
    await set.reader.look()
    set.later(14)
    await set.reader.look()
    assert.equal(set.asked.length, 1)
    set.later(1)
    await Promise.all([set.reader.look(), set.reader.look()])
    assert.equal(set.asked.length, 2)
  })

  it('says what the feed last said of itself, and takes "nothing new" for an answer', async () => {
    const set = await setUp()
    set.answers(() => ({ status: 200, body: feed('1'), etag: '"v1"', modified: 'Mon, 09 Nov 2026 14:05:00 GMT' }))
    await set.reader.look()
    set.later(15)
    set.answers(() => ({ status: 304, body: '' }))
    await set.reader.look()
    assert.deepEqual(set.asked, [{ etag: undefined, modified: undefined }, { etag: '"v1"', modified: 'Mon, 09 Nov 2026 14:05:00 GMT' }])
    set.later(15)
    await set.reader.look()
    assert.deepEqual(set.asked[2], { etag: '"v1"', modified: 'Mon, 09 Nov 2026 14:05:00 GMT' }, 'still what the last full read gave')
    assert.equal(set.failing(), undefined)
  })

  it('says on the listener why it can’t be read, once, and stops saying so when it can', async () => {
    const set = await setUp()
    const why = async (answer: () => Got | Promise<Got>) => {
      set.answers(answer)
      set.later(15)
      await set.reader.look()
      return set.failing()
    }
    assert.equal(await why(() => ({ status: 500, body: 'oops' })), 'status.example.com answered 500.')
    const version = set.hub.version
    assert.equal(await why(() => ({ status: 500, body: 'oops' })), 'status.example.com answered 500.')
    assert.equal(set.hub.version, version, 'the same trouble isn’t written again')
    assert.equal(await why(() => ({ status: 301, body: '' })), 'status.example.com says the feed has moved. Paste its new address.')
    assert.equal(await why(() => ({ status: 200, body: '<html>Sign in</html>' })), 'That address doesn’t read as a feed (RSS, Atom or JSON Feed).')
    assert.equal(await why(() => { throw new Error('Couldn’t find status.example.com.') }), 'Couldn’t find status.example.com.')
    assert.equal(await why(() => ({ status: 200, body: feed('1') })), undefined)
  })

  it('still starts where the feed is when its first reads failed', async () => {
    const set = await setUp()
    set.answers(() => ({ status: 503, body: '' }))
    await set.reader.look()
    set.later(15)
    set.answers(() => ({ status: 200, body: feed('2', '1') }))
    await set.reader.look()
    assert.deepEqual(await set.titles(), [])
    set.later(15)
    set.answers(() => ({ status: 200, body: feed('3', '2', '1') }))
    await set.reader.look()
    assert.deepEqual(await set.titles(), ['Incident 3'])
  })

  it('only says what it would file while it watches, and reads nothing when off', async () => {
    const watching = await setUp('watch')
    await watching.reader.look()
    watching.later(15)
    watching.answers(() => ({ status: 200, body: feed('1') }))
    await watching.reader.look()
    assert.deepEqual((await watching.inbox.feed()).map((o) => o.did), ['would-note'])
    assert.equal(watching.hub.state.notes.some((n) => n.from), false)

    const off = await setUp('off')
    await off.reader.look()
    assert.equal(off.asked.length, 0)
  })

  it('starts again from where a new address is', async () => {
    const set = await setUp()
    set.answers(() => ({ status: 200, body: feed('1'), etag: '"old"' }))
    await set.reader.look()
    await set.inbox.put('maya', set.listener.id, { url: 'https://other.example.com/feed.json' })
    set.answers(() => ({ status: 200, body: feed('9', '8') }))
    await set.reader.look()
    assert.deepEqual(set.asked[1], { etag: undefined, modified: undefined }, 'the old feed’s mark isn’t sent to the new one, and it’s read at once')
    assert.deepEqual(await set.titles(), [])
  })
})

describe('reading an address', () => {
  async function serve(handle: (headers: Record<string, string | string[] | undefined>) => { status: number; body: string; headers?: Record<string, string> }) {
    const seen: Record<string, string | string[] | undefined>[] = []
    const server = createServer((request, response) => {
      seen.push(request.headers)
      const answer = handle(request.headers)
      response.writeHead(answer.status, answer.headers ?? {})
      response.end(answer.body)
    })
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
    return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/feed`, seen, close: () => server.close() }
  }

  it('gives the body with what the address says of it, and sends back what it was told last time', async () => {
    const server = await serve((headers) => (headers['if-none-match'] === '"v1"' ? { status: 304, body: '' } : { status: 200, body: 'hello', headers: { etag: '"v1"', 'last-modified': 'Mon, 09 Nov 2026 14:05:00 GMT' } }))
    try {
      const first = await getText(server.url, {}, { thisMachineToo: true })
      assert.deepEqual(first, { status: 200, body: 'hello', etag: '"v1"', modified: 'Mon, 09 Nov 2026 14:05:00 GMT' })
      const again = await getText(server.url, { etag: first.etag, modified: first.modified }, { thisMachineToo: true })
      assert.equal(again.status, 304)
      assert.equal(server.seen[1]['if-modified-since'], 'Mon, 09 Nov 2026 14:05:00 GMT')
    } finally {
      server.close()
    }
  })

  it('doesn’t follow a redirect, and stops reading past its size', async () => {
    const moved = await serve(() => ({ status: 302, body: '', headers: { location: 'http://127.0.0.1:9/elsewhere' } }))
    const huge = await serve(() => ({ status: 200, body: 'x'.repeat(feedMostBytes + 10) }))
    try {
      assert.equal((await getText(moved.url, {}, { thisMachineToo: true })).status, 302)
      await assert.rejects(() => getText(huge.url, {}, { thisMachineToo: true }), /larger than the hub reads/)
    } finally {
      moved.close()
      huge.close()
    }
  })

  it('refuses an address on the hub’s own network, and says when nothing answers', async () => {
    await assert.rejects(() => getText('https://localhost/feed', {}, { timeoutMs: 2000 }), /Couldn’t (reach|find) localhost\.|refused/)
    await assert.rejects(() => getText('http://127.0.0.1:9/feed', {}, { thisMachineToo: true, timeoutMs: 2000 }), /refused the connection|Couldn’t reach/)
  })
})
