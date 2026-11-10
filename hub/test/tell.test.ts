import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { setTimeout as sleep } from 'node:timers/promises'
import { Actions } from '../src/actions.ts'
import { Auth } from '../src/auth.ts'
import { GitHubConnection } from '../src/githubConnection.ts'
import { Hub } from '../src/hub.ts'
import { MemoryKV } from '../src/kv.ts'
import { MemoryLog } from '../src/log.ts'
import { makeLogger } from '../src/logger.ts'
import { Sealer } from '../src/secrets.ts'
import { buildServer } from '../src/server.ts'
import { Spaces, type Space } from '../src/spaces.ts'
import { mostPerPass, onThisNetwork, postJson, refusal, safeLookup, Teller, tryAgainAfter, type Reach } from '../src/tell.ts'
import { Webhooks } from '../src/webhooks.ts'
import { until } from './helpers.ts'
import type { Change } from '../../shared/state.ts'
import type { Agent, Card, ChangeSet, PullRequest } from '../../shared/work.ts'

// A Binder tells a channel what starts waiting: once for each row, with its words and its link, not what was waiting
// before the address was set, held back and tried again when the channel fails, and only to addresses out on the
// internet. The hub's own people see what waits across their Binders.

const at = '2026-11-09T10:00:00.000Z'
const you = { kind: 'user' as const, login: 'ana' }
const secret = 'T0SECRET/B0SECRET/xyzKEY123'
const agent = (id: string, owner: string): Agent => ({ id, name: `Agent ${id}`, provider: 'other', owner, repos: [], binders: [], skills: [], createdAt: at })
const card = (id: string, extra: Partial<Card> = {}): Card => ({ id, binderId: 'b1', title: `Card ${id}`, brief: '', doneWhen: '', size: 'M', stage: 'ready', createdAt: at, createdBy: 'ana', updatedAt: at, waitsFor: [], activity: [], ...extra })
/** A card an agent stopped to ask about. */
const question = (id: string, agentId: string, extra: Partial<Card> = {}) => card(id, { stage: 'blocked', agentId, needsYou: 'Which one?', createdBy: 'hub', ...extra })
const pull = (number: number): PullRequest => ({ id: `acme/web#${number}`, repo: 'acme/web', number, title: `Pull ${number}`, branch: `b${number}`, url: '', state: 'open', cardId: `c${number}`, checks: [], files: [] })
const changeSet = (id: string, number: number): ChangeSet => ({ id, binderId: 'b1', number, title: 'Login fixes', summary: '', state: 'review', prIds: ['acme/web#1', 'acme/web#2'], noteIds: [] })

interface Posted {
  path: string
  body: Record<string, unknown>
}

/** A channel on this machine: keeps what it's sent, and answers as it's told to. */
async function standIn() {
  const posted: Posted[] = []
  const answer = { status: 200, body: 'ok', delayMs: 0, location: undefined as string | undefined }
  const server: Server = createServer((request: IncomingMessage, response) => {
    let text = ''
    request.on('data', (chunk) => (text += chunk))
    request.on('end', () => {
      const send = () => {
        response.writeHead(answer.status, answer.location ? { location: answer.location } : {})
        response.end(answer.body)
      }
      // A post that never got an answer is still a post that arrived.
      posted.push({ path: request.url ?? '', body: JSON.parse(text || '{}') })
      if (answer.delayMs) setTimeout(send, answer.delayMs)
      else send()
    })
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/services/${secret}`
  return { url, posted, answer, texts: () => posted.map((p) => String(p.body.text)), close: () => { server.closeAllConnections(); server.close() } }
}

/** A Binder's hub with agents, and a teller on a clock the test moves. */
async function setUp(options: { every?: number; several?: boolean; reach?: Reach; name?: string; kv?: MemoryKV; seed?: Change[] } = {}) {
  const hub = new Hub(new MemoryLog())
  await hub.start([{ type: 'binder.put', binder: { id: 'b1', name: 'Web' } }, { type: 'agent.put', agent: agent('mine', 'ana') }, { type: 'agent.put', agent: agent('theirs', 'ben') }, ...(options.seed ?? [])])
  const kv = options.kv ?? new MemoryKV()
  const sealer = new Sealer('test-secret')
  const clock = { now: Date.parse(at) }
  const reach = options.reach ?? { thisMachineToo: true }
  const make = () => new Teller(kv, sealer, 'acme', { state: () => hub.state, name: () => options.name ?? 'Acme', several: () => !!options.several, base: 'http://hub.test/acme', reach, now: () => clock.now, everyMs: options.every ?? 3_600_000 })
  const tell = make()
  await tell.load()
  const put = (change: Change) => hub.record(you, change)
  const minute = (minutes: number) => { clock.now += minutes * 60_000 }
  return { hub, kv, sealer, tell, make, put, clock, minute, reach }
}

describe('where the hub will post', () => {
  it('takes an address out on the internet over https', () => {
    assert.equal(refusal('https://hooks.slack.com/services/T0/B0/xyz'), undefined)
    assert.equal(refusal('https://example.com:8443/hook?key=1'), undefined)
    assert.equal(refusal('https://8.8.8.8/hook'), undefined)
  })

  it('says so in words when it isn’t an address, or isn’t https, or carries a password', () => {
    assert.match(refusal('hooks.slack.com/services/x')!, /isn’t a web address/)
    assert.match(refusal('http://hooks.slack.com/services/x')!, /https:\/\//)
    assert.match(refusal('ftp://hooks.slack.com/x')!, /https:\/\//)
    assert.match(refusal('https://me:pw@hooks.slack.com/x')!, /name or password/)
  })

  it('refuses this machine and every private or shared network, however it’s written', () => {
    const own = [
      'https://localhost/x', 'https://localhost./x', 'https://app.localhost/x', 'https://127.0.0.1/x', 'https://127.1.2.3/x', 'https://2130706433/x', 'https://[::1]/x',
      'https://10.0.0.5/x', 'https://172.16.0.1/x', 'https://172.31.255.255/x', 'https://192.168.1.10/x', 'https://100.64.0.2/x', 'https://169.254.169.254/latest',
      'https://0.0.0.0/x', 'https://[::]/x', 'https://[::ffff:10.0.0.1]/x', 'https://[::ffff:127.0.0.1]/x', 'https://[fd00::1]/x', 'https://[fe80::1]/x',
      'https://printer.local/x', 'https://nas.lan/x', 'https://db.internal/x', 'https://intranet/x', 'https://224.0.0.1/x',
    ]
    for (const address of own) assert.match(refusal(address)!, /own network/, address)
    // 172.32 is outside 172.16/12.
    assert.equal(refusal('https://172.32.0.1/x'), undefined)
  })

  it('names the host in the refusal, never the rest of the address', () => {
    const why = refusal(`https://10.0.0.5/services/${secret}`)!
    assert.match(why, /10\.0\.0\.5/)
    assert.ok(!why.includes(secret))
  })

  it('lets a test’s stand-in through, over http, and nothing else it shouldn’t', () => {
    assert.equal(refusal('http://127.0.0.1:4000/x', { thisMachineToo: true }), undefined)
    assert.equal(refusal('https://localhost/x', { thisMachineToo: true }), undefined)
    assert.match(refusal('ftp://127.0.0.1/x', { thisMachineToo: true })!, /https:\/\//)
    assert.match(refusal('http://127.0.0.1:4000/x')!, /https:\/\//)
  })

  it('tells this network in an address’s other spellings', () => {
    assert.equal(onThisNetwork('[::ffff:a00:1]'), true)
    assert.equal(onThisNetwork('::ffff:192.168.0.1'), true)
    assert.equal(onThisNetwork('::ffff:808:808'), false)
    assert.equal(onThisNetwork('2606:4700:4700::1111'), false)
  })

  it('refuses a name that points at this machine, when it connects', async () => {
    // localhost comes from the machine's own hosts file, so this asks no one.
    const refused = await new Promise<Error | null>((done) => safeLookup('localhost', {}, (error) => done(error)))
    assert.match(refused?.message ?? '', /localhost points at this hub’s own network/)
    const all = await new Promise<Error | null>((done) => safeLookup('localhost', { all: true }, (error) => done(error)))
    assert.ok(all)
    await assert.rejects(postJson('https://localhost:9/hook', { text: 'x' }), /points at this hub’s own network/)
  })
})

describe('telling a channel', () => {
  it('posts a row that starts waiting, once, with its words and a link that opens it', async () => {
    const channel = await standIn()
    const { tell, put } = await setUp()
    await tell.configure(channel.url)
    await put({ type: 'card.put', card: question('q1', 'mine', { title: 'Pick a login flow' }) })
    await tell.pass()
    assert.equal(channel.posted.length, 1)
    assert.equal(channel.posted[0].path, `/services/${secret}`)
    assert.equal(channel.posted[0].body.text, 'Pick a login flow: Agent mine asks: Which one? (for ana) http://hub.test/acme/#/work/q1')
    assert.equal(channel.posted[0].body.kind, 'question')
    assert.equal(channel.posted[0].body.binder, 'Acme')
    assert.equal(channel.posted[0].body.url, 'http://hub.test/acme/#/work/q1')
    assert.equal(channel.posted[0].body.for, 'ana')
    // Nothing new, so nothing more.
    await tell.pass()
    await tell.pass()
    assert.equal(channel.posted.length, 1)
    channel.close()
  })

  it('looks on its own while it’s started, and stops when it’s stopped', async () => {
    const channel = await standIn()
    const { tell, put } = await setUp({ every: 30 })
    await tell.configure(channel.url)
    tell.start()
    await put({ type: 'card.put', card: question('q1', 'mine') })
    await until(() => channel.posted.length === 1)
    tell.stop()
    await put({ type: 'card.put', card: question('q2', 'mine') })
    await sleep(120)
    assert.equal(channel.posted.length, 1)
    channel.close()
  })

  it('doesn’t post what was waiting when the address was set, and posts what comes after', async () => {
    const channel = await standIn()
    const { tell, put } = await setUp({ seed: [{ type: 'card.put', card: question('old', 'mine') }] })
    await tell.configure(channel.url)
    await tell.pass()
    assert.equal(channel.posted.length, 0)
    await put({ type: 'card.put', card: question('new', 'theirs', { title: 'Fresh' }) })
    await tell.pass()
    assert.deepEqual(channel.texts(), ['Fresh: Agent theirs asks: Which one? (for ben) http://hub.test/acme/#/work/new'])
    channel.close()
  })

  it('doesn’t post what was waiting when the hub started, from the address it kept', async () => {
    const channel = await standIn()
    const kv = new MemoryKV()
    const first = await setUp({ kv })
    await first.tell.configure(channel.url)
    // The hub stops and starts again, with a row already waiting.
    const again = await setUp({ kv, seed: [{ type: 'card.put', card: question('before', 'mine') }] })
    await again.tell.load()
    assert.equal(again.tell.set, true)
    again.tell.start()
    await again.tell.pass()
    assert.equal(channel.posted.length, 0)
    await again.put({ type: 'card.put', card: question('after', 'mine') })
    await again.tell.pass()
    assert.equal(channel.posted.length, 1)
    again.tell.stop()
    channel.close()
  })

  it('puts the Binder’s name first when the hub has several, and not when it has one', async () => {
    const channel = await standIn()
    const one = await setUp({ name: 'Acme' })
    await one.tell.configure(channel.url)
    await one.put({ type: 'card.put', card: question('q1', 'mine') })
    await one.tell.pass()
    assert.ok(channel.texts()[0].startsWith('Card q1:'))
    const several = await setUp({ several: true, name: 'Acme <Ops> & Co' })
    await several.tell.configure(channel.url)
    await several.put({ type: 'card.put', card: question('q2', 'mine') })
    await several.tell.pass()
    assert.ok(channel.texts()[1].startsWith('Acme &lt;Ops&gt; &amp; Co: Card q2:'), channel.texts()[1])
    assert.equal(channel.posted[1].body.binder, 'Acme <Ops> & Co')
    channel.close()
  })

  it('says who a row is for in words, when it’s for one person who isn’t everyone', async () => {
    const channel = await standIn()
    const { tell, put } = await setUp({ seed: [{ type: 'note.put', note: { id: 'n1', title: 'Plan', binderId: 'b1', editedAt: at, editors: ['ana'], text: '# Plan\n' } as never }, { type: 'note.lock', id: 'n1', locked: { by: 'cleo', at } }] })
    await tell.configure(channel.url)
    // A question: its agent's owner. A permission: the owner of the agent that asks. A card nobody made but the hub, with an agent no one owns: anyone.
    await put({ type: 'card.put', card: question('q1', 'theirs') })
    await put({ type: 'card.put', card: card('p1', { stage: 'working', agentId: 'theirs', permission: { request: 'r1', agent: 'theirs', tool: 'Bash', what: 'npm test', at } as never }) })
    await put({ type: 'card.put', card: question('q2', 'ghost', { createdBy: 'ana' }) })
    await put({ type: 'card.put', card: question('q3', 'ghost') })
    // A change to a note someone locked: the one who locked it.
    await put({ type: 'noteProposal.put', proposal: { id: 'np1', noteId: 'n1', binderId: 'b1', by: 'theirs', at, why: 'Tighter', base: '# Plan\n', text: '# Plan!\n', state: 'open', comments: [] } as never })
    await tell.pass()
    const text = (id: string) => channel.posted.find((p) => String(p.body.url).endsWith(`/${id}`))!.body
    assert.match(String(text('q1').text), /\(for ben\)/)
    assert.match(String(text('p1').text), /Agent theirs asks to use Bash: npm test \(for ben\)/)
    assert.match(String(text('q2').text), /\(for ana\)/)
    assert.ok(!String(text('q3').text).includes('(for'))
    assert.equal(text('q3').for, undefined)
    const change = channel.posted.find((p) => String(p.body.url).endsWith('/notes/n1'))!.body
    assert.equal(change.text, 'Plan: Agent theirs proposes a change: Tighter (for cleo) http://hub.test/acme/#/notes/n1')
    channel.close()
  })

  it('posts a change set to approve, linking its page', async () => {
    const channel = await standIn()
    const { tell, put } = await setUp()
    await tell.configure(channel.url)
    await put({ type: 'pr.put', pull: pull(1) })
    await put({ type: 'pr.put', pull: pull(2) })
    await put({ type: 'set.put', set: changeSet('cs1', 7) })
    await tell.pass()
    assert.deepEqual(channel.texts(), ['Change set #7: Login fixes: 2 pull requests to approve http://hub.test/acme/#/changes/cs1'])
    assert.equal(channel.posted[0].body.kind, 'changeSet')
    channel.close()
  })

  it('leaves the angle brackets of a title as text, so a card can’t call a whole channel', async () => {
    const channel = await standIn()
    const { tell, put } = await setUp()
    await tell.configure(channel.url)
    await put({ type: 'card.put', card: question('q1', 'mine', { title: '<!channel> look', needsYou: 'See <https://evil.test|here> & there' }) })
    await tell.pass()
    const text = channel.texts()[0]
    assert.ok(!text.includes('<'), text)
    assert.ok(text.startsWith('&lt;!channel&gt; look: Agent mine asks: See &lt;https://evil.test|here&gt; &amp; there'))
    channel.close()
  })

  it('is told again about a row that stopped waiting and then waits again', async () => {
    const channel = await standIn()
    const { tell, put } = await setUp()
    await tell.configure(channel.url)
    await put({ type: 'card.put', card: question('q1', 'mine') })
    await tell.pass()
    await put({ type: 'card.update', id: 'q1', fields: { stage: 'ready', needsYou: undefined } })
    await tell.pass()
    await put({ type: 'card.update', id: 'q1', fields: { stage: 'blocked', needsYou: 'Again?' } })
    await tell.pass()
    assert.equal(channel.posted.length, 2)
    assert.match(channel.texts()[1], /Again\?/)
    channel.close()
  })

  it('posts at most ten rows in a pass, and one more that says how many others', async () => {
    const channel = await standIn()
    const { tell, put } = await setUp({ several: true })
    await tell.configure(channel.url)
    for (let i = 1; i <= mostPerPass + 3; i++) await put({ type: 'card.put', card: question(`q${String(i).padStart(2, '0')}`, 'mine') })
    await tell.pass()
    assert.equal(channel.posted.length, mostPerPass + 1)
    assert.equal(channel.posted.filter((p) => p.body.kind === 'question').length, mostPerPass)
    assert.equal(channel.texts().at(-1), 'Acme: 3 other things are waiting too. http://hub.test/acme/#/home')
    assert.equal(channel.posted.at(-1)!.body.kind, 'more')
    assert.equal(channel.posted.at(-1)!.body.count, 3)
    // The others are counted as told: nothing follows.
    await tell.pass()
    assert.equal(channel.posted.length, mostPerPass + 1)
    channel.close()
  })

  it('says “one other thing is” for one', async () => {
    const channel = await standIn()
    const { tell, put } = await setUp()
    await tell.configure(channel.url)
    for (let i = 1; i <= mostPerPass + 1; i++) await put({ type: 'card.put', card: question(`q${i}`, 'mine') })
    await tell.pass()
    assert.equal(channel.texts().at(-1), '1 other thing is waiting too. http://hub.test/acme/#/home')
    channel.close()
  })
})

describe('when the channel fails', () => {
  it('keeps what it answered, waits a minute, then five, then thirty, and loses no row', async () => {
    const channel = await standIn()
    channel.answer.status = 404
    channel.answer.body = 'no_service'
    const { tell, put, minute } = await setUp()
    await tell.configure(channel.url)
    await put({ type: 'card.put', card: question('q1', 'mine') })
    await put({ type: 'card.put', card: question('q2', 'mine') })
    await tell.pass()
    // The first post failed, so the second wasn't tried.
    assert.equal(channel.posted.length, 1)
    assert.deepEqual([tell.status().last?.ok, tell.status().last?.answered], [false, 'It answered 404: no_service.'])
    assert.ok(tell.status().retryAt)

    // Not before the minute is up.
    minute(0.9)
    await tell.pass()
    assert.equal(channel.posted.length, 1)
    minute(0.2)
    await tell.pass()
    assert.equal(channel.posted.length, 2)
    // The second failure: five minutes.
    minute(4.9)
    await tell.pass()
    assert.equal(channel.posted.length, 2)
    minute(0.2)
    await tell.pass()
    assert.equal(channel.posted.length, 3)
    // The third and every one after: thirty.
    minute(29.9)
    await tell.pass()
    assert.equal(channel.posted.length, 3)
    minute(0.2)
    await tell.pass()
    assert.equal(channel.posted.length, 4)
    minute(29.9)
    await tell.pass()
    assert.equal(channel.posted.length, 4)
    assert.deepEqual(tryAgainAfter, [60_000, 300_000, 1_800_000])

    // It works again: the rows that waited all the while are posted, and the wait is over.
    channel.answer.status = 200
    channel.answer.body = 'ok'
    minute(0.2)
    await tell.pass()
    const sent = channel.texts().slice(4)
    assert.equal(sent.length, 2)
    assert.ok(sent[0].includes('Card q1') && sent[1].includes('Card q2'))
    assert.deepEqual([tell.status().last?.ok, tell.status().last?.answered], [true, 'It answered 200: ok.'])
    assert.equal(tell.status().retryAt, undefined)
    await put({ type: 'card.put', card: question('q3', 'mine') })
    await tell.pass()
    assert.equal(channel.posted.length, 7)
    channel.close()
  })

  it('doesn’t post a row that stopped waiting while the channel was down', async () => {
    const channel = await standIn()
    channel.answer.status = 500
    const { tell, put, minute } = await setUp()
    await tell.configure(channel.url)
    await put({ type: 'card.put', card: question('gone', 'mine') })
    await put({ type: 'card.put', card: question('stays', 'mine') })
    await tell.pass()
    await put({ type: 'card.update', id: 'gone', fields: { stage: 'ready', needsYou: undefined } })
    channel.answer.status = 200
    minute(2)
    await tell.pass()
    assert.equal(channel.posted.filter((p) => String(p.body.url).endsWith('/gone')).length, 1, 'only the try that failed')
    assert.equal(channel.posted.filter((p) => String(p.body.url).endsWith('/stays')).length, 1)
    assert.equal(tell.status().last?.ok, true)
    channel.close()
  })

  it('says why when the address can’t be reached at all', async () => {
    const channel = await standIn()
    const { tell, put } = await setUp()
    await tell.configure(channel.url)
    channel.close()
    await put({ type: 'card.put', card: question('q1', 'mine') })
    await tell.pass()
    const last = tell.status().last!
    assert.equal(last.ok, false)
    assert.match(last.answered, /127\.0\.0\.1 refused the connection\./)
    assert.ok(!last.answered.includes(secret))
  })

  it('gives up on a post after its limit', async () => {
    const channel = await standIn()
    channel.answer.delayMs = 1500
    const { tell, put } = await setUp({ reach: { thisMachineToo: true, timeoutMs: 150 } })
    await tell.configure(channel.url)
    await put({ type: 'card.put', card: question('q1', 'mine') })
    const began = Date.now()
    await tell.pass()
    assert.ok(Date.now() - began < 1200, 'it didn’t wait for the answer')
    assert.equal(tell.status().last?.ok, false)
    assert.match(tell.status().last!.answered, /didn’t answer within 1 second\./)
    channel.close()
  })

  it('doesn’t follow a redirect, and says so', async () => {
    const elsewhere = await standIn()
    const channel = await standIn()
    channel.answer.status = 302
    channel.answer.location = elsewhere.url
    const { tell, put } = await setUp()
    await tell.configure(channel.url)
    await put({ type: 'card.put', card: question('q1', 'mine') })
    await tell.pass()
    assert.equal(channel.posted.length, 1)
    assert.equal(elsewhere.posted.length, 0, 'nothing was sent where it pointed')
    assert.equal(tell.status().last?.ok, false)
    assert.match(tell.status().last!.answered, /302.*doesn’t follow/)
    channel.close()
    elsewhere.close()
  })

  it('checks the address again before each post, and posts nothing to one that isn’t allowed now', async () => {
    const channel = await standIn()
    const reach: Reach = { thisMachineToo: true }
    const { tell, put } = await setUp({ reach })
    await tell.configure(channel.url)
    // The rule changes after the address was accepted (as a name that has come to point at the network would).
    reach.thisMachineToo = false
    await put({ type: 'card.put', card: question('q1', 'mine') })
    await tell.pass()
    assert.equal(channel.posted.length, 0)
    assert.equal(tell.status().last?.ok, false)
    assert.match(tell.status().last!.answered, /https:\/\//)
    assert.ok(!tell.status().last!.answered.includes(secret))
    channel.close()
  })
})

describe('the address', () => {
  it('is kept sealed, comes back after a restart, and is never in how it stands', async () => {
    const channel = await standIn()
    const kv = new MemoryKV()
    const { tell, kv: store, make } = await setUp({ kv })
    const status = await tell.configure(channel.url)
    assert.deepEqual([status.set, status.host], [true, new URL(channel.url).host])
    assert.ok(!JSON.stringify(status).includes(secret))
    // What's kept holds the host beside the sealed address, and nothing of the path.
    const kept = (await store.get('tell:acme:settings'))!
    assert.ok(!kept.includes(secret) && !kept.includes('/services'))
    assert.equal(JSON.parse(kept).host, new URL(channel.url).host)
    const again = make()
    await again.load()
    assert.equal(again.set, true)
    await again.test()
    assert.equal(channel.posted.length, 1)
    assert.ok(!JSON.stringify(again.status()).includes(secret))
    channel.close()
  })

  it('is as good as none when what’s kept can’t be opened', async () => {
    const kv = new MemoryKV()
    await kv.set('tell:acme:settings', JSON.stringify({ sealed: 'not sealed by this hub', host: 'x.test' }))
    const { tell } = await setUp({ kv })
    assert.equal(tell.set, false)
  })

  it('is refused, with the reason, when it isn’t allowed, and the old one stays', async () => {
    const channel = await standIn()
    const { tell } = await setUp({ reach: {} })
    await assert.rejects(tell.configure('http://hooks.slack.com/x'), /https:\/\//)
    await assert.rejects(tell.configure('https://192.168.1.4/x'), /own network/)
    await assert.rejects(tell.configure('  '), /Paste the channel/)
    assert.equal(tell.set, false)
    channel.close()
  })

  it('stops being told when it’s forgotten, and forgets what was kept', async () => {
    const channel = await standIn()
    const { tell, put, kv } = await setUp()
    await tell.configure(channel.url)
    await tell.forget()
    assert.deepEqual(tell.status(), { set: false, host: undefined, last: undefined, retryAt: undefined })
    assert.equal(await kv.get('tell:acme:settings'), undefined)
    await put({ type: 'card.put', card: question('q1', 'mine') })
    await tell.pass()
    assert.equal(channel.posted.length, 0)
    channel.close()
  })

  it('doesn’t tell the rows that came before a new address', async () => {
    const one = await standIn()
    const two = await standIn()
    const { tell, put } = await setUp()
    await tell.configure(one.url)
    await put({ type: 'card.put', card: question('q1', 'mine') })
    await tell.configure(two.url)
    await tell.pass()
    assert.equal(one.posted.length + two.posted.length, 0)
    one.close()
    two.close()
  })

  it('sends a test that says what it is, and clears the wait after a failure when it works', async () => {
    const channel = await standIn()
    const { tell, put, minute } = await setUp({ several: true })
    await tell.configure(channel.url)
    channel.answer.status = 500
    await put({ type: 'card.put', card: question('q1', 'mine') })
    await tell.pass()
    assert.ok(tell.status().retryAt)
    channel.answer.status = 200
    const done = await tell.test()
    assert.deepEqual(done, { ok: true, answered: 'It answered 200: ok.' })
    assert.equal(channel.texts().at(-1), 'Acme: This is a test from Binders. When something starts waiting here, it’s posted to this channel. http://hub.test/acme/#/home')
    assert.equal(tell.status().retryAt, undefined)
    minute(0)
    await tell.pass()
    assert.equal(channel.posted.filter((p) => p.body.kind === 'question').length, 2, 'the row that failed goes now')
    channel.close()
  })

  it('has a failed test change nothing about when the rows are tried', async () => {
    const channel = await standIn()
    const { tell } = await setUp()
    await tell.configure(channel.url)
    channel.answer.status = 500
    const done = await tell.test()
    assert.equal(done.ok, false)
    assert.equal(tell.status().retryAt, undefined)
    assert.equal(tell.status().last?.ok, false)
    channel.close()
  })
})

/** A hub of two Binders (acme, beta) with a third (gamma) the person isn't in, each with a teller, and a server in front. */
async function hubOf(options: { reach?: Reach } = {}) {
  const kv = new MemoryKV()
  const sealer = new Sealer('test-secret')
  const auth = new Auth(kv, sealer, { github: () => undefined, allowed: () => ({ users: [], orgs: [] }), devLogin: () => true })
  const tellers = new Map<string, Teller>()
  const make = async (id: string): Promise<Space> => {
    const github = new GitHubConnection(new MemoryKV(), sealer, { webUrl: 'http://unused', apiUrl: 'http://unused' }, { webhookSecret: `shh-${id}` }, id)
    const hub = new Hub(new MemoryLog())
    await hub.start([{ type: 'binder.put', binder: { id: 'b1', name: 'Web' } }, { type: 'agent.put', agent: agent('mine', 'ana') }, { type: 'agent.put', agent: agent('theirs', 'ben') }])
    const actions = new Actions(hub, github)
    const tell = new Teller(new MemoryKV(), sealer, id, { state: () => hub.state, name: () => id, several: () => true, base: `http://hub.test/${id}`, reach: options.reach ?? { thisMachineToo: true }, everyMs: 3_600_000 })
    tellers.set(id, tell)
    return { id, hub, actions, github, webhooks: new Webhooks(hub, actions), tell, stop: async () => tell.stop() }
  }
  const spaces = await new Spaces(kv, make).load({ id: 'acme', name: 'Acme', members: [{ login: 'ana', role: 'owner' }, { login: 'ben', role: 'member' }] })
  await spaces.create({ id: 'beta', name: 'Beta', owner: 'ana' }, 'ana')
  await spaces.setMember('beta', 'ben', 'member', true)
  await spaces.create({ id: 'gamma', name: 'Gamma', owner: 'ben' }, 'ben')
  const lines: string[] = []
  const app = await buildServer(spaces, { auth }, { publicUrl: 'http://hub.test', admins: ['root'], logRequests: true, logger: makeLogger({ write: (line: string) => void lines.push(line) }, 'info') })
  await app.listen({ port: 0, host: '127.0.0.1' })
  const url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`
  const as = async (login: string, space = 'acme') => {
    const signedIn = await fetch(`${url}/auth/dev`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-binders': '1' }, body: JSON.stringify({ login }) })
    const cookie = /binders_session=[^;]+/.exec(signedIn.headers.get('set-cookie') ?? '')![0]
    return async (method: string, path: string, body?: unknown) => {
      const response = await fetch(`${url}${path}`, { method, headers: { cookie, 'x-binders': '1', 'x-binders-space': space, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined })
      const text = await response.text()
      return { status: response.status, body: text ? JSON.parse(text) : undefined }
    }
  }
  const put = (id: string, change: Change) => spaces.get(id)!.hub.record(you, change)
  return { spaces, as, put, lines, tellers, close: () => app.close() }
}

describe('/api/tell', () => {
  it('lets owners and admins set, try and stop it, the hub’s admins not unless the Binder has no owner, and members only see how it stands', async () => {
    const channel = await standIn()
    const { as, lines, close } = await hubOf()
    const ana = await as('ana')
    const ben = await as('ben')
    const root = await as('root')

    assert.deepEqual((await ben('GET', '/api/tell')).body, { set: false, mayManage: false })
    assert.equal((await ben('PUT', '/api/tell', { url: channel.url })).status, 422)
    assert.match((await ben('PUT', '/api/tell', { url: channel.url })).body.error, /Only this binder’s owners and admins change a channel/)
    assert.equal((await ben('POST', '/api/tell/test')).status, 422)
    assert.equal((await ben('DELETE', '/api/tell')).status, 422)

    const set = await ana('PUT', '/api/tell', { url: channel.url })
    assert.equal(set.status, 200)
    assert.deepEqual([set.body.set, set.body.host, set.body.mayManage], [true, new URL(channel.url).host, true])
    assert.ok(!JSON.stringify(set.body).includes(secret))

    // A member sees that one is set and its host, never the address.
    const seen = await ben('GET', '/api/tell')
    assert.deepEqual([seen.body.set, seen.body.host, seen.body.mayManage], [true, new URL(channel.url).host, false])
    assert.ok(!JSON.stringify(seen.body).includes(secret))
    assert.ok(!JSON.stringify((await ana('GET', '/api/tell')).body).includes(secret))

    const tried = await ana('POST', '/api/tell/test')
    assert.deepEqual(tried.body, { ok: true, answered: 'It answered 200: ok.' })
    assert.equal(channel.posted.length, 1)
    assert.equal((await root('POST', '/api/tell/test')).status, 403, 'the hub’s admin isn’t in this Binder, which has an owner')
    assert.equal(channel.posted.length, 1)
    const after = await ben('GET', '/api/tell')
    assert.equal(after.body.last.ok, true)
    assert.equal(after.body.last.answered, 'It answered 200: ok.')

    assert.equal((await root('PUT', '/api/tell', { url: channel.url })).status, 403, 'nor set it')
    assert.equal((await ana('DELETE', '/api/tell')).status, 200)
    assert.deepEqual((await ben('GET', '/api/tell')).body, { set: false, mayManage: false })
    assert.deepEqual((await ana('POST', '/api/tell/test')).body, { ok: false, answered: 'No address is set yet.' })
    assert.ok(!lines.join('\n').includes(secret), 'the address is nowhere in the log')
    channel.close()
    await close()
  })

  it('refuses an address the hub won’t post to, saying why, and keeps the one it had', async () => {
    const channel = await standIn()
    const { as, close } = await hubOf({ reach: {} })
    const ana = await as('ana')
    const refused = async (url: unknown) => (await ana('PUT', '/api/tell', { url }))
    assert.match((await refused('http://hooks.slack.com/services/x')).body.error, /https:\/\//)
    assert.match((await refused('https://127.0.0.1/hook')).body.error, /own network/)
    assert.match((await refused('https://192.168.1.2/hook')).body.error, /own network/)
    assert.match((await refused('https://localhost/hook')).body.error, /own network/)
    assert.match((await refused('not an address')).body.error, /isn’t a web address/)
    assert.equal((await refused(42)).status, 422)
    assert.equal((await ana('PUT', '/api/tell', {})).status, 422)
    assert.equal((await ana('PUT', '/api/tell')).status, 422)
    assert.deepEqual((await ana('GET', '/api/tell')).body, { set: false, mayManage: true })
    channel.close()
    await close()
  })

  it('tells a Binder’s channel what starts waiting there, not another Binder’s', async () => {
    const channel = await standIn()
    const { as, put, tellers, close } = await hubOf()
    const ana = await as('ana')
    await ana('PUT', '/api/tell', { url: channel.url })
    await put('beta', { type: 'card.put', card: question('elsewhere', 'mine') })
    await put('acme', { type: 'card.put', card: question('here', 'mine') })
    await tellers.get('acme')!.pass()
    await tellers.get('beta')!.pass()
    assert.deepEqual(channel.texts(), ['acme: Card here: Agent mine asks: Which one? (for ana) http://hub.test/acme/#/work/here'])
    channel.close()
    await close()
  })
})

describe('/api/me/waiting', () => {
  it('counts what waits for a person, or for anyone, in each Binder they’re in', async () => {
    const { as, put, close } = await hubOf()
    await put('acme', { type: 'card.put', card: question('for-ana', 'mine') })
    await put('acme', { type: 'card.put', card: question('for-ben', 'theirs') })
    await put('acme', { type: 'card.put', card: card('stopped', { stage: 'blocked', needsYou: 'Stopped twice', stopped: { why: 'Signed out', at, times: 2 }, createdBy: 'hub' } as never) })
    await put('beta', { type: 'pr.put', pull: pull(1) })
    await put('beta', { type: 'pr.put', pull: pull(2) })
    await put('beta', { type: 'set.put', set: changeSet('cs1', 1) })
    await put('gamma', { type: 'card.put', card: question('hidden', 'theirs') })

    const ana = await (await as('ana'))('GET', '/api/me/waiting')
    const counts = Object.fromEntries(ana.body.binders.map((b: { id: string; count: number }) => [b.id, b.count]))
    // Acme: the question for her and the stopped card, not the one for ben. Beta: the change set. Gamma: not hers.
    assert.equal(counts.acme, 2)
    assert.equal(counts.beta, 1)
    assert.equal('gamma' in counts, false)
    assert.deepEqual(ana.body.binders.find((b: { id: string }) => b.id === 'beta'), { id: 'beta', name: 'Beta', count: 1 })

    const ben = (await (await as('ben'))('GET', '/api/me/waiting')).body.binders
    assert.equal(ben.find((b: { id: string }) => b.id === 'acme').count, 2)
    assert.equal(ben.find((b: { id: string }) => b.id === 'gamma').count, 1)
    await close()
  })

  it('doesn’t list the Binders a hub admin may open but isn’t in', async () => {
    const { as, put, close } = await hubOf()
    await put('acme', { type: 'card.put', card: question('q', 'mine') })
    const root = (await (await as('root'))('GET', '/api/me/waiting')).body.binders
    assert.ok(!root.some((b: { id: string }) => ['acme', 'beta', 'gamma'].includes(b.id)))
    await close()
  })
})
