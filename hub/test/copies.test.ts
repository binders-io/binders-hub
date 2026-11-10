import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { readdir, readFile, rm, writeFile } from 'node:fs/promises'
import net from 'node:net'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { gunzipSync, gzipSync } from 'node:zlib'
import { Actions } from '../src/actions.ts'
import { Auth } from '../src/auth.ts'
import { CopyKeeper, copiesBranch, makeCopy, pausedState, readCopy } from '../src/copies.ts'
import { GitHubConnection } from '../src/githubConnection.ts'
import { Hub } from '../src/hub.ts'
import { JiraConnection } from '../src/jira.ts'
import { MemoryKV } from '../src/kv.ts'
import { MemoryLog } from '../src/log.ts'
import { Sealer } from '../src/secrets.ts'
import { IssuesSaver } from '../src/savers/issues.ts'
import { ReviewsSaver } from '../src/savers/reviews.ts'
import { StateFile, writeSaved } from '../src/kept.ts'
import { buildServer } from '../src/server.ts'
import { Spaces, type Member, type Space, type SpaceInfo } from '../src/spaces.ts'
import { Teller } from '../src/tell.ts'
import { Webhooks } from '../src/webhooks.ts'
import { applyChanges, changesTo, load, save, type NoteDoc } from '../../shared/noteDoc.ts'
import { titleOf } from '../../shared/notes.ts'
import type { Change } from '../../shared/state.ts'
import type { Agent, Card } from '../../shared/work.ts'
import { fakeGitHub, note, tempDir, until } from './helpers.ts'

const run = promisify(execFile)
const author = { name: 'Test Hub', email: 'hub@binders.invalid' }

// A Binder's copy: one file of its whole state and its notes' documents, to download, to keep a week of, to push to
// GitHub and to start a new Binder from.

/** Everything the test hub is given that must never reach a copy. */
const secrets = {
  hub: 'SECRET-hub-sealer-1',
  githubClient: 'SECRET-github-client-2',
  githubToken: 'SECRET-github-token-3',
  githubHook: 'SECRET-github-hook-4',
  jiraToken: 'SECRET-jira-token-5',
  channel: 'SECRET-channel-6',
  personGitHub: 'SECRET-person-github-7',
}

const at = '2026-11-09T10:00:00.000Z'
const agentOf = (id: string, name: string): Agent => ({ id, name, owner: 'ana', provider: 'claude-code', binders: [], repos: ['acme/app'], skills: [], createdAt: at, lastSeen: at } as unknown as Agent)
const cardOf = (id: string, title: string, fields: Partial<Card> = {}): Card => ({ id, title, binderId: 'b1', brief: 'Do it.', doneWhen: 'It works.', size: 'M', stage: 'ready', waitsFor: [], activity: [], createdAt: at, createdBy: 'ana', updatedAt: at, ...fields } as Card)

/** The Binder every test starts from: all its switches on, so that a copy has something to turn off. */
const acmeSeed = (): Change[] => [
  { type: 'binder.put', binder: { id: 'b1', name: 'Acme', repo: 'acme/app', notes: true, issues: true, reviewComments: true, copies: true } },
  { type: 'folder.put', folder: { id: 'f1', binderId: 'b1', name: 'Planning' } },
  { type: 'note.put', note: note('n1', 'First note', { folderId: 'f1' }) },
  { type: 'note.put', note: note('n2', 'Second note') },
  { type: 'agent.put', agent: agentOf('a1', 'Sonnet') } as Change,
  { type: 'card.put', card: cardOf('c1', 'Fix the login') } as Change,
  { type: 'set.put', set: { id: 's1', number: 1, binderId: 'b1', title: 'Login', prIds: [], cardIds: ['c1'] } } as unknown as Change,
]

/** Someone with a note open: its document as the hub had it, and what they type into it. */
function opened(hub: Hub, noteId = 'n1') {
  let doc: NoteDoc = load(save(hub.noteDoc(noteId)!))
  return {
    type(text: string) {
      const changes = changesTo(doc, text)
      doc = applyChanges(doc, changes)
      return { type: 'note.edit' as const, id: noteId, text, title: titleOf(text), by: 'ana', at: new Date().toISOString(), changes }
    },
  }
}

async function setUp(options: { members?: Member[]; breaks?: string } = {}) {
  const root = await tempDir('copies')
  const kv = new MemoryKV()
  const sealer = new Sealer(secrets.hub)
  const auth = new Auth(kv, sealer, { github: () => undefined, allowed: () => ({ users: [], orgs: [] }), devLogin: () => true })
  const members: Member[] = options.members ?? [{ login: 'ana', role: 'owner' }, { login: 'bo', role: 'admin' }, { login: 'cy', role: 'member' }, { login: 'di', role: 'reader' }]
  const dirOf = (id: string) => join(root, 'binders', id)
  const files: StateFile[] = []
  let jira: JiraConnection | undefined
  // As the hub proper starts a Binder: from what's saved in its folder, then saving there.
  const make = async (id: string, info: SpaceInfo): Promise<Space> => {
    if (info.name === options.breaks) throw new Error('This Binder can’t start.')
    const stateFile = new StateFile(join(dirOf(id), 'state.json'), 60_000)
    files.push(stateFile)
    const hub = new Hub(new MemoryLog())
    hub.lockManager = (login) => spaces.mayManage(id, login, spaces.hubAdmin(login))
    await hub.start(id === 'acme' ? acmeSeed() : [{ type: 'binder.put', binder: { id: 'main', name: info.name } }], await stateFile.read(), await stateFile.readDocs())
    await stateFile.follow(hub)
    const kept = new MemoryKV()
    const manual = id === 'acme' ? { clientId: 'cid', clientSecret: secrets.githubClient, token: secrets.githubToken, webhookSecret: secrets.githubHook } : { webhookSecret: `shh-${id}` }
    const github = new GitHubConnection(kept, sealer, { webUrl: 'http://unused', apiUrl: 'http://unused' }, manual, id)
    const actions = new Actions(hub, github)
    if (id === 'acme') {
      jira = new JiraConnection(kept, sealer, id)
      await jira.configure({ baseUrl: 'https://jira.example.test', email: 'bot@example.test', token: secrets.jiraToken, project: 'APP' })
      const tell = new Teller(kept, sealer, id, { state: () => hub.state, name: () => 'Acme', several: () => true, base: 'http://hub.test/acme', reach: { thisMachineToo: true } })
      await tell.configure(`https://hooks.example.test/services/${secrets.channel}`)
    }
    const copies = new CopyKeeper({ dir: join(dirOf(id), 'copies'), hub, of: () => ({ id, name: spaces.info(id)?.name ?? id, people: spaces.info(id)?.members ?? [] }), author })
    return { id, hub, actions, github, webhooks: new Webhooks(hub, actions), copies }
  }
  const spaces = await new Spaces(kv, make).load({ id: 'acme', name: 'Acme', members })
  spaces.dirOf = dirOf
  const app = await buildServer(spaces, { auth }, { publicUrl: 'http://hub.test', admins: ['root'] })
  await app.listen({ port: 0, host: '127.0.0.1' })
  const url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`
  const as = async (login: string, space?: string) => {
    const signedIn = await fetch(`${url}/auth/dev`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-binders': '1' }, body: JSON.stringify({ login }) })
    const cookie = /binders_session=[^;]+/.exec(signedIn.headers.get('set-cookie') ?? '')![0]
    const headers = { cookie, 'x-binders': '1', ...(space ? { 'x-binders-space': space } : {}) }
    const call = async (method: string, path: string, body?: unknown) => {
      const response = await fetch(`${url}${path}`, { method, headers: { ...headers, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined })
      const text = await response.text()
      return { status: response.status, body: text ? JSON.parse(text) : undefined }
    }
    const download = async (id: string) => {
      const response = await fetch(`${url}/api/spaces/${id}/copy`, { headers })
      const bytes = Buffer.from(await response.arrayBuffer())
      const refused = response.status === 200 ? undefined : (JSON.parse(bytes.toString()) as { error: string })
      return { status: response.status, headers: response.headers, bytes, error: refused?.error }
    }
    const upload = async (name: string | undefined, bytes: Buffer | string, type = 'application/gzip') => {
      const response = await fetch(`${url}/api/hub/binders/from-copy${name === undefined ? '' : `?name=${encodeURIComponent(name)}`}`, { method: 'POST', headers: { ...headers, 'content-type': type }, body: bytes })
      const text = await response.text()
      return { status: response.status, body: text ? JSON.parse(text) : undefined }
    }
    return { call, download, upload }
  }
  const token = await auth.issueAgentToken('a1', 'acme')
  const person = (await auth.issuePersonToken({ login: 'ana', name: 'Ana' }, 'mac', secrets.personGitHub, 'acme')).token
  const given = [...Object.values(secrets), token, person, (await jira!.secret())!]
  const close = async () => {
    await app.close()
    for (const file of files) await file.stop()
    await rm(root, { recursive: true, force: true })
  }
  return { spaces, as, auth, close, root, url, dirOf, token, given, acme: () => spaces.get('acme')! }
}

/** The folders of the hub's team Binders (each person's own Binder has one too). */
const teamFolders = async (root: string) => (await readdir(join(root, 'binders'))).filter((name) => !name.startsWith('~'))

/** Gives acme a note typed into (so it has a document), as the hub holds a note someone has edited. */
async function editNote(hub: Hub, text: string) {
  await hub.submit('ana', 'tab-1', [{ id: `e${hub.version}`, change: opened(hub).type(text) }])
}

const unpack = (bytes: Buffer) => JSON.parse(gunzipSync(bytes).toString('utf8')) as { copy: Record<string, any>; state: Record<string, any>; docs: Record<string, string> }
const turnedAway = (answer: { status: number; error?: string; body?: { error?: string } }) => answer.status === 422 && /^(Only|No such Binder)/.test(answer.error ?? answer.body?.error ?? '')

describe('downloading a Binder’s copy', () => {
  it('gives its owners and admins one gzip file of JSON, named for the Binder and the day, and says so in its history', async () => {
    const { as, acme, close } = await setUp()
    await editNote(acme().hub, '# First note\n\nTyped by someone.\n')
    const version = acme().hub.version
    const owner = await as('ana')
    const got = await owner.download('acme')
    assert.equal(got.status, 200)
    assert.match(got.headers.get('content-disposition') ?? '', /^attachment; filename="acme-\d{4}-\d\d-\d\d\.binder-copy\.json\.gz"$/)
    assert.match(got.headers.get('content-type') ?? '', /^application\/gzip/)
    const file = unpack(got.bytes)
    assert.equal(file.copy.format, 1)
    assert.deepEqual(file.copy.binder, { id: 'acme', name: 'Acme' })
    assert.equal(file.copy.version, version)
    assert.deepEqual(file.copy.counts, { notes: 2, cards: 1, changeSets: 1, agents: 1 })
    assert.deepEqual(file.copy.people, [{ login: 'ana', role: 'owner' }, { login: 'bo', role: 'admin' }, { login: 'cy', role: 'member' }, { login: 'di', role: 'reader' }])
    assert.ok(Date.parse(file.copy.madeAt) > 0)
    assert.deepEqual(Object.keys(file.docs), ['n1'], 'the note that was typed into has its document, and the other is made again from its text')
    assert.equal(file.state.notes.find((n: { id: string }) => n.id === 'n1').text, '# First note\n\nTyped by someone.\n')
    assert.ok(acme().hub.state.history!.some((line) => line.text === '@ana downloaded a copy of this Binder.'))
    // An admin takes one too.
    assert.equal((await (await as('bo')).download('acme')).status, 200)
    await close()
  })

  it('is refused to members and readers, to people outside the Binder, and to a hub admin while it has an owner', async () => {
    const { as, acme, close } = await setUp()
    const before = acme().hub.version
    for (const who of ['cy', 'di']) {
      const got = await (await as(who)).download('acme')
      assert.ok(turnedAway(got), `${who}: ${got.status} ${got.error}`)
      assert.match(got.error!, /Only the Binder’s owners and admins can download a copy/)
    }
    for (const who of ['eve', 'root']) {
      const got = await (await as(who)).download('acme')
      assert.equal(got.status, 422, who)
      assert.equal(got.error, 'No such Binder.', who)
    }
    assert.equal(acme().hub.version, before, 'nothing was noted: no copy was made')
    await close()
  })
})

describe('a new Binder from a copy', () => {
  it('has the same notes (text and documents), cards, change sets and history, and a note in it can be edited', async () => {
    const { spaces, as, acme, close } = await setUp()
    await editNote(acme().hub, '# First note\n\nTyped by someone.\nAnd more.\n')
    await acme().hub.record({ kind: 'user', login: 'ana' }, { type: 'history.add', lines: [{ at, by: 'ana', text: 'Wrote the first note.' }] })
    const copy = (await (await as('ana')).download('acme')).bytes
    // As the hub had it when the copy was made, before the line saying it was downloaded.
    const state = acme().hub.state
    const wanted = { notes: structuredClone(state.notes), folders: structuredClone(state.folders), cards: structuredClone(state.cards), changeSets: structuredClone(state.changeSets), history: structuredClone(state.history!.slice(0, -1)) }
    const doc = save(acme().hub.noteDoc('n1')!)

    const root = await as('root')
    const made = await root.upload('Acme again', copy)
    assert.equal(made.status, 200, JSON.stringify(made.body))
    assert.deepEqual(made.body.created, { id: 'acme-again', name: 'Acme again' })
    assert.ok(made.body.binders.some((b: { id: string; owners: string[] }) => b.id === 'acme-again' && b.owners.join() === 'root'), 'the answer lists it, owned by the one who made it')
    assert.deepEqual(spaces.info('acme-again')!.members, [{ login: 'root', role: 'owner' }])

    const there = spaces.get('acme-again')!.hub
    assert.deepEqual(there.state.notes, wanted.notes)
    assert.deepEqual(there.state.folders, wanted.folders)
    assert.deepEqual(there.state.changeSets, wanted.changeSets)
    // Its cards are as they were: pausing a Binder leaves its board alone.
    assert.deepEqual(there.state.cards, wanted.cards)
    assert.deepEqual(there.state.history!.slice(0, wanted.history.length), wanted.history)
    const made1 = there.state.history!.slice(wanted.history.length)
    assert.equal(made1.length, 1)
    assert.match(made1[0].text, /^Made from a copy of “Acme” taken \d{1,2} [A-Z][a-z]+ \d{4}, by @root\. It doesn’t write to GitHub until that’s turned on in Settings\.$/)
    assert.equal(made1[0].by, 'root')
    assert.deepEqual(save(there.noteDoc('n1')!), doc, 'the note’s document is as it was')
    // The copy's own notebook id stays: only the space is new.
    assert.equal(there.state.binders[0].id, 'b1')
    assert.equal(there.state.binders[0].name, 'Acme again')

    // A note in it can be edited, by someone who has it open, and from the web.
    await there.submit('root', 'tab-9', [{ id: 'x1', change: opened(there).type('# First note\n\nTyped by someone.\nAnd more.\nAnd more again.\n') }])
    assert.equal(there.state.notes.find((n) => n.id === 'n1')!.text, '# First note\n\nTyped by someone.\nAnd more.\nAnd more again.\n')
    const inIt = await as('root', 'acme-again')
    const edit = await inIt.call('POST', '/api/changes', { client: 'tab-1234', changes: [{ id: 'e2', change: { type: 'note.edit', id: 'n2', text: '# Second note\n\nEdited here.\n', title: 'Second note', by: 'root', at: new Date().toISOString() } }] })
    assert.equal(edit.status, 200, JSON.stringify(edit.body))
    assert.match(there.state.notes.find((n) => n.id === 'n2')!.text, /Edited here/)
    assert.equal(spaces.info('acme-again')!.name, 'Acme again', 'its name isn’t put back to the copy’s by that change')
    // The original is untouched.
    assert.equal(acme().hub.state.notes.find((n) => n.id === 'n2')!.text, '# Second note\n')
    await close()
  })

  it('writes nothing to GitHub, and its agents can’t connect', async () => {
    const { spaces, as, acme, auth, token, close } = await setUp()
    const copy = (await (await as('ana')).download('acme')).bytes
    const made = await (await as('root')).upload('Paused', copy)
    assert.equal(made.status, 200)
    const there = spaces.get('paused')!.hub
    const [binder] = there.state.binders
    assert.equal(binder.repo, 'acme/app', 'its repo stays named, so its cards still link to their pull requests')
    for (const field of ['notes', 'issues', 'reviewComments', 'copies'] as const) assert.equal(binder[field], false, field)
    assert.ok(there.state.agents.length > 0 && there.state.agents.every((a) => a.revoked), 'every agent is revoked')
    assert.ok(acme().hub.state.agents.every((a) => !a.revoked) && acme().hub.state.binders[0].issues === true, 'the original keeps its own')
    // An agent's token is for the Binder it was made in, and its agent is revoked in this one.
    assert.deepEqual(await auth.agentFor(token), { id: 'a1', space: 'acme' })
    assert.equal(there.state.agents.find((a) => a.id === 'a1' && !a.revoked), undefined)

    // Its savers have nothing to say to GitHub: a card on it makes no issue and no review, and the same card in a Binder
    // that has its switches on does.
    const github = await fakeGitHub()
    const connection = new GitHubConnection(new MemoryKV(), new Sealer('x'), { webUrl: github.url, apiUrl: github.url }, { clientId: 'id', clientSecret: 's', token: 'ghs_server' })
    const saversOn = (hub: Hub) => {
      const issues = new IssuesSaver(hub, connection, { quietMs: 10 })
      issues.start()
      const reviews = new ReviewsSaver(hub, connection, { publicUrl: 'http://hub.test' })
      reviews.start()
      return async () => { await issues.stop(); await reviews.stop() }
    }
    const stopPaused = saversOn(there)
    await there.record({ kind: 'user', login: 'root' }, { type: 'card.put', card: cardOf('c2', 'A card in the paused Binder') } as Change)
    const control = new Hub(new MemoryLog())
    await control.start([{ type: 'binder.put', binder: { id: 'b1', name: 'Control', repo: 'acme/app' } }])
    const stopControl = saversOn(control)
    await control.record({ kind: 'user', login: 'root' }, { type: 'card.put', card: cardOf('c2', 'A card in a Binder with its switches on') } as Change)
    await until(() => github.calls.some((c) => c.method === 'POST' && c.path === '/repos/acme/app/issues'))
    await new Promise((done) => setTimeout(done, 150))
    assert.equal(github.calls.filter((c) => c.method === 'POST' && c.path === '/repos/acme/app/issues').length, 1, 'one issue, for the control alone')
    assert.ok(control.state.cards.find((c) => c.id === 'c2')!.issue?.number)
    assert.equal(there.state.cards.find((c) => c.id === 'c2')!.issue, undefined)
    await stopPaused()
    await stopControl()
    await github.close()
    // And it doesn’t push its copies either.
    let asked = 0
    const keeper = new CopyKeeper({ dir: join(await tempDir('paused-copies'), 'copies'), hub: there, of: () => ({ id: 'paused', name: 'Paused', people: [] }), author, pushTo: async () => { asked++; return undefined } })
    await keeper.tick(new Date(2026, 10, 10, 4, 0))
    assert.equal(asked, 0)
    await close()
  })

  it('starts by the path a hub takes with an empty log and a saved state, so it starts again from what it saved', async () => {
    const { spaces, as, acme, dirOf, close } = await setUp()
    await editNote(acme().hub, '# First note\n\nTyped by someone.\n')
    const copy = (await (await as('ana')).download('acme')).bytes
    await (await as('root')).upload('Second life', copy)
    const dir = dirOf('second-life')
    assert.deepEqual((await readdir(join(dir, 'note-docs'))).sort(), ['.saved', 'n1.automerge'])
    const saved = JSON.parse(await readFile(join(dir, 'state.json'), 'utf8'))
    assert.equal(typeof saved.version, 'number')
    assert.equal(saved.state.binders[0].copies, false)
    assert.ok(saved.state.agents.every((a: { revoked?: boolean }) => a.revoked))
    // Stopped and started again from what it saved, as a hub restart does.
    const first = spaces.get('second-life')!.hub
    const file = new StateFile(join(dir, 'state.json'))
    const again = new Hub(new MemoryLog())
    await again.start(undefined, await file.read(), await file.readDocs())
    assert.equal(again.state.notes.find((n) => n.id === 'n1')!.text, first.state.notes.find((n) => n.id === 'n1')!.text)
    await close()
  })

  it('is the hub admins’ alone to start, and a hub admin who only reads the Binder they’re in may', async () => {
    const { spaces, as, close } = await setUp({ members: [{ login: 'ana', role: 'owner' }, { login: 'root', role: 'reader' }] })
    const copy = (await (await as('ana')).download('acme')).bytes
    const listed = spaces.list().length
    const owner = await (await as('ana')).upload('Not allowed', copy)
    assert.equal(owner.status, 422)
    assert.match(owner.body.error, /^Only the hub’s admins start a Binder from a copy/)
    assert.equal(spaces.list().length, listed, 'no Binder was made')
    assert.equal(spaces.info('not-allowed'), undefined)
    // The hub's admin, who is a reader of the Binder the hub would open for them.
    assert.equal((await (await as('root')).download('acme')).status, 422, 'a reader doesn’t download')
    const answer = await (await as('root')).upload('Allowed', copy)
    assert.equal(answer.status, 200, JSON.stringify(answer.body))
    await close()
  })

  it('is refused in words before anything is made: not a copy, a format it doesn’t know, too large, no name', async () => {
    const { spaces, as, root, close } = await setUp()
    const copy = (await (await as('ana')).download('acme')).bytes
    const admin = await as('root')
    // Everyone's own Binder is made when they first ask for anything: counted from then.
    await admin.call('GET', '/api/spaces')
    const listed = spaces.list().length
    const wrong = (file: unknown) => gzipSync(JSON.stringify(file))
    const good = unpack(copy)
    const tries: [string, Promise<{ status: number; body: { error: string } }>, number, RegExp][] = [
      ['plain text', admin.upload('Tries', 'hello'), 422, /isn’t a Binders copy/],
      ['text that’s gzipped', admin.upload('Tries', gzipSync('hello')), 422, /isn’t a Binders copy/],
      ['JSON that isn’t a copy', admin.upload('Tries', wrong({ hello: 'there' })), 422, /isn’t a Binders copy/],
      ['a format from the future', admin.upload('Tries', wrong({ ...good, copy: { ...good.copy, format: 2 } })), 422, /format this hub doesn’t know \(2\)/],
      ['a state that isn’t one', admin.upload('Tries', wrong({ ...good, state: 'nope' })), 422, /damaged/],
      ['notes without ids', admin.upload('Tries', wrong({ ...good, state: { ...good.state, notes: [{ title: 'x' }] } })), 422, /damaged: its notes/],
      ['documents that aren’t text', admin.upload('Tries', wrong({ ...good, docs: { n1: 5 } })), 422, /damaged/],
      ['no name', admin.upload(undefined, copy), 422, /Give the new Binder a name/],
      ['a blank name', admin.upload('   ', copy), 422, /Give the new Binder a name/],
      ['no file', admin.upload('Tries', ''), 422, /Send the copy/],
    ]
    for (const [what, answer, status, words] of tries) {
      const got = await answer
      assert.equal(got.status, status, what)
      assert.match(got.body.error, words, what)
    }
    assert.equal(spaces.list().length, listed, 'no Binder was left behind')
    assert.deepEqual(await teamFolders(root), ['acme'], 'nor a folder')
    assert.equal(spaces.info('tries'), undefined)
    await close()
  })

  it('turns away a file over 200 MB by what the request says, before reading any of it', async () => {
    const { url, close } = await setUp()
    const signedIn = await fetch(`${url}/auth/dev`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-binders': '1' }, body: JSON.stringify({ login: 'root' }) })
    const cookie = /binders_session=[^;]+/.exec(signedIn.headers.get('set-cookie') ?? '')![0]
    // The request says it's 210 MB and sends none of it: the answer comes at once, as it does to a browser that's still sending.
    const answer = await new Promise<{ status: number; text: string }>((done, fail) => {
      const socket = net.connect(Number(new URL(url).port), '127.0.0.1')
      let raw = ''
      socket.on('error', fail)
      socket.on('data', (chunk) => {
        raw += chunk
        const [head, body = ''] = raw.split('\r\n\r\n')
        if (body.endsWith('}')) {
          socket.destroy()
          done({ status: Number(/^HTTP\/1\.1 (\d+)/.exec(head)![1]), text: body })
        }
      })
      socket.write(`POST /api/hub/binders/from-copy?name=Huge HTTP/1.1\r\nhost: hub.test\r\ncookie: ${cookie}\r\nx-binders: 1\r\ncontent-type: application/gzip\r\ncontent-length: ${210 * 1024 * 1024}\r\n\r\n`)
    })
    assert.equal(answer.status, 413)
    assert.equal(JSON.parse(answer.text).error, 'That file is bigger than 200 MB, the most a copy can be.')
    await close()
  })

  it('leaves nothing behind when the Binder can’t start from it', async () => {
    const { spaces, as, root, close } = await setUp({ breaks: 'Broken' })
    const copy = (await (await as('ana')).download('acme')).bytes
    const admin = await as('root')
    await admin.call('GET', '/api/spaces')
    const listed = spaces.list().length
    const answer = await admin.upload('Broken', copy)
    assert.equal(answer.status, 500)
    assert.equal(spaces.list().length, listed)
    assert.deepEqual(await teamFolders(root), ['acme'], 'the folder it was put in is gone')
    // And its address is free for the next try.
    assert.equal((await admin.upload('Fine', copy)).status, 200)
    await close()
  })

  it('gets an address of its own whatever the copy’s: two from one copy are two Binders', async () => {
    const { spaces, as, close } = await setUp()
    const copy = (await (await as('ana')).download('acme')).bytes
    const admin = await as('root')
    const [one, two] = await Promise.all([admin.upload('Twin', copy), admin.upload('Twin', copy)])
    assert.equal(one.status, 200)
    assert.equal(two.status, 200)
    assert.deepEqual([one.body.created.id, two.body.created.id].sort(), ['twin', 'twin-2'])
    assert.ok(spaces.get('twin') && spaces.get('twin-2'))
    await close()
  })
})

describe('what a copy holds', () => {
  it('holds no token and no connection: none of the secrets the hub was given is in it', async () => {
    const { as, acme, given, auth, token, dirOf, close } = await setUp()
    // The test hub does hold them all, so the search below isn’t looking for nothing.
    assert.ok(given.length >= 9)
    assert.ok(given.every((secret) => secret.length > 10))
    assert.equal(acme().github.webhookSecret(), secrets.githubHook)
    assert.equal((await auth.agentFor(token))?.id, 'a1')
    await editNote(acme().hub, '# First note\n\nTyped by someone.\n')

    const downloaded = (await (await as('ana')).download('acme')).bytes
    const text = gunzipSync(downloaded).toString('utf8')
    assert.ok(text.includes('First note') && text.includes('Fix the login'), 'it holds the Binder')
    for (const secret of given) assert.ok(!text.includes(secret), `a copy holds ${secret.slice(0, 14)}…`)
    // The file the hub keeps for the day is the same.
    await acme().copies!.tick(new Date(2026, 10, 10, 4, 0))
    const folder = join(dirOf('acme'), 'copies')
    const kept = (await readdir(folder)).filter((name) => name.endsWith('.gz'))
    assert.equal(kept.length, 1)
    const daily = gunzipSync(await readFile(join(folder, kept[0]))).toString('utf8')
    for (const secret of given) assert.ok(!daily.includes(secret), `a daily copy holds ${secret.slice(0, 14)}…`)
    // Nor is any field of the state named for one.
    assert.ok(!/"(token|secret|password|apiKey|webhookSecret)"/i.test(text))
    await close()
  })
})

describe('a Binder’s copies on the hub’s disk', () => {
  /** A hub with a note in it and a keeper writing into a folder of its own. */
  async function kept(options: { pushTo?: ConstructorParameters<typeof CopyKeeper>[0]['pushTo']; binder?: Record<string, unknown> } = {}) {
    const root = await tempDir('daily')
    const hub = new Hub(new MemoryLog())
    await hub.start([{ type: 'binder.put', binder: { id: 'b1', name: 'Acme', ...options.binder } }, { type: 'note.put', note: note('n1', 'First note') }])
    const dir = join(root, 'copies')
    const keeper = new CopyKeeper({ dir, hub, of: () => ({ id: 'acme', name: 'Acme', people: [{ login: 'ana', role: 'owner' }] }), author, pushTo: options.pushTo })
    const change = async (text: string) => hub.record({ kind: 'user', login: 'ana' }, { type: 'note.put', note: note('n1', 'First note', { text }) })
    const files = async () => (await readdir(dir).catch(() => [] as string[])).sort()
    const latest = async () => JSON.parse(await readFile(join(dir, 'latest.json'), 'utf8')) as { file: string; at: string; bytes: number; version: number }
    return { root, hub, dir, keeper, change, files, latest, stop: () => rm(root, { recursive: true, force: true }) }
  }
  /** The day `n` days after Tuesday 10 November 2026, at this hour, in the hub's own time. */
  const day = (n: number, hours = 4, minutes = 0) => new Date(2026, 10, 10 + n, hours, minutes)

  it('writes one copy a day, over last week’s, so an eighth replaces the first', async () => {
    const { hub, dir, keeper, change, files, latest, stop } = await kept()
    const names = ['tue', 'wed', 'thu', 'fri', 'sat', 'sun', 'mon']
    const firstTuesday = async () => readCopy(await readFile(join(dir, 'copy-tue.binder-copy.json.gz')))
    for (let n = 0; n < 7; n++) {
      await change(`Day ${n}`)
      await keeper.tick(day(n))
      assert.equal((await latest()).file, `copy-${names[n]}.binder-copy.json.gz`)
    }
    assert.deepEqual(await files(), [...names.map((d) => `copy-${d}.binder-copy.json.gz`).sort(), 'latest.json'])
    assert.equal((await firstTuesday()).state.notes[0].text, 'Day 0')
    await change('Day 7')
    await keeper.tick(day(7))
    assert.equal((await files()).length, 8, 'seven copies and latest.json: the eighth took the first’s place')
    assert.equal((await firstTuesday()).state.notes[0].text, 'Day 7')
    const now = await latest()
    assert.equal(now.file, 'copy-tue.binder-copy.json.gz')
    assert.equal(now.version, hub.version)
    assert.equal(now.bytes, (await readFile(join(dir, now.file))).length)
    assert.deepEqual(Object.keys(now).sort(), ['at', 'bytes', 'file', 'hub', 'version'])
    assert.deepEqual(await keeper.status().then((s) => ({ latest: s.latest, days: s.days })), { latest: { at: now.at, bytes: now.bytes, version: now.version }, days: 7 })
    await stop()
  })

  it('writes the first at once, then one for each day, a day turning at 03:00, and only after a change', async () => {
    const { keeper, change, latest, stop } = await kept()
    await keeper.tick(day(0, 2, 59))
    const first = await latest()
    assert.equal(first.file, 'copy-mon.binder-copy.json.gz', 'a minute before 03:00 on Tuesday is still Monday’s')
    await change('Changed')
    await keeper.tick(day(0, 3, 0))
    const second = await latest()
    assert.equal(second.file, 'copy-tue.binder-copy.json.gz', 'at 03:00 the day has turned')
    await change('Changed again')
    await keeper.tick(day(0, 23, 0))
    await keeper.tick(day(1, 2, 59))
    assert.deepEqual(await latest(), second, 'one a day, whatever changes in it')
    await keeper.tick(day(1, 3, 0))
    const third = await latest()
    assert.equal(third.file, 'copy-wed.binder-copy.json.gz')
    await keeper.tick(day(3, 4))
    assert.deepEqual(await latest(), third, 'and none when nothing changed')
    await stop()
  })

  it('never runs twice at once, and one that fails is logged, tried again in an hour, and doesn’t stop the next', async () => {
    const { hub, dir, keeper, change, files, latest, stop } = await kept()
    const one = keeper.tick(day(0))
    assert.equal(keeper.tick(day(0)), one, 'asked again while under way, it’s the same run')
    await one
    await rm(dir, { recursive: true, force: true })
    await change('Changed')
    // The folder can't be made: a file stands where it should be.
    await writeFile(dir, 'in the way')
    await keeper.tick(day(1, 4, 0))
    assert.equal(hub.state.notes[0].text, 'Changed', 'the hub goes on')
    await rm(dir)
    await keeper.tick(day(1, 4, 30))
    assert.deepEqual(await files(), [], 'not tried again for an hour')
    await keeper.tick(day(1, 5, 1))
    assert.equal((await latest()).file, 'copy-wed.binder-copy.json.gz', 'tried again, and it wrote')
    await stop()
  })

  it('pushes the copies as one commit on its own branch, however many pushes there are, and says when', async () => {
    const bare = join(await tempDir('bare'), 'copies.git')
    await run('git', ['init', '-q', '--bare', bare])
    let targets = 0
    const { keeper, change, latest, hub, stop } = await kept({ binder: { repo: 'acme/app', copies: true }, pushTo: async () => { targets++; return { url: bare, name: 'acme/app' } } })
    for (let n = 0; n < 4; n++) {
      await change(`Day ${n}`)
      await keeper.tick(day(n))
    }
    assert.equal(targets, 4)
    const git = async (...args: string[]) => (await run('git', ['--git-dir', bare, ...args])).stdout.trim()
    assert.equal(await git('rev-list', '--count', copiesBranch), '1', 'one commit after four pushes')
    assert.deepEqual((await git('ls-tree', '--name-only', copiesBranch)).split('\n'), ['copy-fri.binder-copy.json.gz', 'copy-thu.binder-copy.json.gz', 'copy-tue.binder-copy.json.gz', 'copy-wed.binder-copy.json.gz', 'latest.json'])
    assert.equal(await git('log', '-1', '--format=%an <%ae>', copiesBranch), 'Test Hub <hub@binders.invalid>')
    assert.equal(await git('log', '-1', '--format=%s', copiesBranch), `Copies of Acme, as of ${day(3).toISOString().slice(0, 10)}`)
    // What's on the branch is the copy: the newest file reads as the Binder at its latest.
    const onBranch = await run('git', ['--git-dir', bare, 'show', `${copiesBranch}:copy-fri.binder-copy.json.gz`], { encoding: 'buffer', maxBuffer: 20 * 1024 * 1024 })
    assert.equal((await readCopy(onBranch.stdout)).state.notes[0].text, 'Day 3')
    const status = await keeper.status()
    assert.deepEqual(status.inRepo, { on: true, repo: 'acme/app', branch: 'binders-copies', at: (await latest()).at })
    assert.equal(hub.state.binders[0].copies, true)
    await stop()
  })

  it('shows a push that failed in words, tries it again in an hour, and clears it once it works', async () => {
    const bare = join(await tempDir('bare'), 'copies.git')
    await run('git', ['init', '-q', '--bare', bare])
    let broken = true
    let asked = 0
    const { keeper, files, stop } = await kept({ binder: { repo: 'acme/app', copies: true }, pushTo: async () => {
      asked++
      if (broken) throw new Error('The hub can’t reach acme/app: install the GitHub App on it.')
      return { url: bare, name: 'acme/app' }
    } })
    await keeper.tick(day(0, 4, 0))
    assert.equal((await files()).includes('copy-tue.binder-copy.json.gz'), true, 'the copy is kept whatever the push does')
    assert.equal((await keeper.status()).inRepo?.failed, 'The hub can’t reach acme/app: install the GitHub App on it.')
    assert.equal((await keeper.status()).inRepo?.at, undefined)
    await keeper.tick(day(0, 4, 30))
    assert.equal(asked, 1, 'not tried again for an hour')
    broken = false
    await keeper.tick(day(0, 5, 1))
    assert.equal(asked, 2)
    const status = (await keeper.status()).inRepo!
    assert.equal(status.failed, undefined)
    assert.ok(status.at)
    assert.equal(await (async () => (await run('git', ['--git-dir', bare, 'rev-list', '--count', copiesBranch])).stdout.trim())(), '1')
    // Not pushed again while nothing is new.
    await keeper.tick(day(0, 7))
    assert.equal(asked, 2)
    await stop()
  })

  it('says a push that fails in git’s own words, with no token in them', async () => {
    const nowhere = pathToFileURL(join(await tempDir('refused'), 'nowhere.git')).href
    const { keeper, stop } = await kept({ binder: { repo: 'acme/app', copies: true }, pushTo: async () => ({ url: nowhere, token: 'SECRET-token-in-env', name: 'acme/app' }) })
    await keeper.tick(day(0))
    const failed = (await keeper.status()).inRepo?.failed ?? ''
    assert.match(failed, /nowhere\.git/)
    assert.ok(!failed.includes('SECRET-token-in-env') && !failed.startsWith('Command failed'), failed)
    await stop()
  })

  it('pushes nothing while the switch is off, and the status says so', async () => {
    let asked = 0
    const { keeper, files, stop } = await kept({ binder: { repo: 'acme/app', copies: false }, pushTo: async () => { asked++; return undefined } })
    await keeper.tick(day(0))
    assert.equal(asked, 0)
    assert.equal((await files()).length, 2)
    assert.deepEqual((await keeper.status()).inRepo, { on: false, repo: 'acme/app', branch: 'binders-copies' })
    await stop()
  })
})

describe('copies over the API', () => {
  it('says what’s on the hub’s disk and in the repo, to anyone in the Binder', async () => {
    const { as, acme, close } = await setUp()
    const reader = await as('di', 'acme')
    const before = await reader.call('GET', '/api/copies')
    assert.equal(before.status, 200)
    assert.deepEqual(before.body, { days: 0, inRepo: { on: true, repo: 'acme/app', branch: 'binders-copies' } })
    await acme().copies!.tick(new Date(2026, 10, 10, 4, 0))
    const after = (await reader.call('GET', '/api/copies')).body
    assert.equal(after.days, 1)
    assert.equal(after.latest.version, acme().hub.version)
    assert.ok(after.latest.bytes > 100 && Date.parse(after.latest.at) > 0)
    assert.equal((await (await as('eve', 'acme')).call('GET', '/api/copies')).status, 403, 'not to people outside the Binder')
    await close()
  })

  it('makes the switch the Binder’s owners’ and admins’, and says in its history when it’s turned on or off', async () => {
    const { as, acme, close } = await setUp()
    const binder = () => acme().hub.state.binders[0]
    const put = (who: Awaited<ReturnType<typeof as>>, copies: boolean) => who.call('POST', '/api/changes', { client: 'tab-1234', changes: [{ id: `s${Math.random().toString(36).slice(2, 8)}`, change: { type: 'binder.put', binder: { ...binder(), copies } } }] })
    const member = await as('cy', 'acme')
    const refused = await put(member, false)
    assert.equal(refused.status, 422)
    assert.match(refused.body.error, /Only this Binder’s owners and admins can change where its cards and notes go/)
    assert.equal(binder().copies, true)
    assert.equal((await put(await as('bo', 'acme'), false)).status, 200)
    assert.equal(binder().copies, false)
    assert.equal((await put(await as('ana', 'acme'), true)).status, 200)
    const lines = acme().hub.state.history!.map((l) => l.text)
    assert.ok(lines.includes('Turned off keeping a daily copy of “Acme” in GitHub.'), lines.join('\n'))
    assert.ok(lines.includes('Turned on keeping a daily copy of “Acme” in GitHub.'))
    // A client that writes the default out in full has changed nothing.
    assert.equal((await put(member, true)).status, 200)
    await close()
  })
})

/** For one test: a copy and the way it's made and read, with no hub in between. */
describe('making and reading a copy', () => {
  it('reads back what it made, and a paused state turns off what writes and revokes the agents', async () => {
    const hub = new Hub(new MemoryLog())
    await hub.start(acmeSeed())
    await hub.submit('ana', 'tab-1', [{ id: 'a', change: opened(hub).type('# First note\n\nWords.\n') }])
    const { bytes, version } = await makeCopy(hub, { id: 'acme', name: 'Acme', people: [{ login: 'ana', role: 'owner' }] })
    const copy = await readCopy(bytes)
    assert.equal(copy.meta.version, version)
    assert.deepEqual(copy.state, JSON.parse(JSON.stringify(hub.state)))
    assert.deepEqual([...copy.docs.keys()], ['n1'])
    assert.deepEqual(save(load(copy.docs.get('n1')!)), save(hub.noteDoc('n1')!))
    const paused = pausedState(copy, 'Elsewhere')
    assert.equal(paused.version, version)
    assert.deepEqual(paused.state.binders.map((b) => [b.name, b.notes, b.issues, b.reviewComments, b.copies, b.repo]), [['Elsewhere', false, false, false, false, 'acme/app']])
    assert.ok(paused.state.agents.every((a) => a.revoked === true))
    assert.equal(hub.state.agents[0].revoked, undefined, 'the Binder it was made from is as it was')
    const dir = await tempDir('written')
    await writeSaved(dir, paused, copy.docs)
    assert.deepEqual((await readdir(join(dir, 'note-docs'))).sort(), ['.saved', 'n1.automerge'])
  })
})
