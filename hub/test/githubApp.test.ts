import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import { Actions } from '../src/actions.ts'
import { Auth } from '../src/auth.ts'
import { GitHubConnection } from '../src/githubConnection.ts'
import { Hub } from '../src/hub.ts'
import { MemoryKV } from '../src/kv.ts'
import { MemoryLog } from '../src/log.ts'
import { IssuesSaver } from '../src/savers/issues.ts'
import { Sealer } from '../src/secrets.ts'
import { buildServer } from '../src/server.ts'
import { Spaces } from '../src/spaces.ts'
import { Webhooks } from '../src/webhooks.ts'
import type { Card } from '../../shared/work.ts'
import type { Change } from '../../shared/state.ts'
import { fakeGitHub, oneSpace, seed, until } from './helpers.ts'

async function setUp(github: Awaited<ReturnType<typeof fakeGitHub>>, publicUrl = 'https://hub.test') {
  const hub = new Hub(new MemoryLog())
  await hub.start(seed())
  const kv = new MemoryKV()
  const sealer = new Sealer('test-secret')
  const connection = new GitHubConnection(kv, sealer, { webUrl: github.url, apiUrl: github.url })
  const auth = new Auth(kv, sealer, { github: () => connection.signIn(), allowed: () => connection.allowed(), devLogin: () => !connection.signIn() })
  const actions = new Actions(hub, connection)
  const issues = new IssuesSaver(hub, connection, { quietMs: 20 })
  issues.start()
  const app = await buildServer(oneSpace(kv, { hub, actions, webhooks: new Webhooks(hub, actions, issues), github: connection, issues }), { auth }, { publicUrl })
  await app.listen({ port: 0, host: '127.0.0.1' })
  const url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`
  return { hub, url, kv, sealer, connection, close: async () => { await issues.stop(); await app.close() } }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const json = async (response: Response): Promise<any> => response.json()

const cookieOf = (response: Response, name: string) => new RegExp(`${name}=[^;]+`).exec(response.headers.get('set-cookie') ?? '')?.[0] ?? ''

describe('setting GitHub up from Settings', () => {
  it('makes a GitHub App from its manifest, installs it, and works through it', async () => {
    const github = await fakeGitHub({ login: 'octo', appOwner: { login: 'octo', type: 'User' } })
    const { url, hub, kv, sealer, connection, close } = await setUp(github)

    // Nobody's set GitHub up, so this hub on 127.0.0.1 lets its first person in by name.
    const dev = await fetch(`${url}/auth/dev`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-binders': '1' }, body: JSON.stringify({ login: 'first' }) })
    const cookie = cookieOf(dev, 'binders_session')
    const call = (method: string, path: string, body?: unknown) => fetch(`${url}${path}`, { method, redirect: 'manual', headers: { cookie, 'x-binders': '1', ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined })

    const started = await json(await call('POST', '/api/github/app', { name: 'Binders test' }))
    const action = new URL(started.action)
    assert.equal(action.pathname, '/settings/apps/new')
    const manifest = JSON.parse(started.manifest)
    assert.equal(manifest.hook_attributes.url, 'https://hub.test/webhooks/github')
    assert.equal(manifest.hook_attributes.active, true)
    assert.deepEqual(manifest.callback_urls, ['https://hub.test/auth/github/callback'])
    assert.equal(manifest.redirect_url, 'https://hub.test/setup/github/created')
    assert.equal(manifest.default_permissions.issues, 'write')
    // People joining and leaving the organization too, for the list its people pickers search (Members: read covers it).
    assert.deepEqual(manifest.default_events, ['issues', 'pull_request', 'check_run', 'workflow_run', 'deployment_status', 'organization'])
    assert.equal(manifest.default_permissions.members, 'read')

    const forged = await fetch(`${url}/setup/github/created?code=made&state=not-ours`, { redirect: 'manual' })
    assert.equal(forged.status, 400, 'a state the hub didn’t make is refused')
    const created = await fetch(`${url}/setup/github/created?code=made&state=${action.searchParams.get('state')}`, { redirect: 'manual' })
    assert.equal(created.status, 302)
    assert.equal(created.headers.get('location'), '/test/#/settings', 'back to the Binder’s Settings')
    assert.equal(connection.status().mode, 'app')
    assert.equal(connection.signIn()?.clientId, 'Iv1.app', 'people now sign in through the app')

    // Its keys are kept sealed: a hub with another secret can't read them.
    const other = new GitHubConnection(kv, new Sealer('another-secret'), { webUrl: github.url, apiUrl: github.url })
    await other.load()
    assert.equal(other.status().mode, 'none')
    const same = new GitHubConnection(kv, sealer, { webUrl: github.url, apiUrl: github.url })
    await same.load()
    assert.equal(same.status().app?.slug, 'binders-test')

    const installed = await fetch(`${url}/setup/github/installed?installation_id=7&setup_action=install`, { redirect: 'manual' })
    assert.equal(installed.status, 302)
    assert.deepEqual(connection.status().app?.installations, ['acme'])

    // An agent's run gets a token of the app's narrowed to its card's repo, and to code and pull requests.
    const run = await connection.runToken('acme/web')
    assert.equal(run?.token, 'ghs_installation')
    const asked = github.calls.filter((c) => c.path === '/app/installations/7/access_tokens').at(-1)!
    assert.deepEqual(asked.body, { repositories: ['web'], permissions: { contents: 'write', pull_requests: 'write', checks: 'read', metadata: 'read' } })

    // Names to suggest come from GitHub: the members of the account it's installed on, and that account itself.
    const people = await json(await call('GET', '/api/github/people?kind=user&q=an'))
    assert.deepEqual(people.people.map((p: { login: string; why: string }) => [p.login, p.why]), [['ana', 'In acme']])
    const orgs = await json(await call('GET', '/api/github/people?kind=org'))
    assert.deepEqual(orgs.people.map((p: { login: string }) => p.login), ['acme'])

    // A card in a binder whose repo it's installed on becomes an issue, made with the installation's own token.
    // (Linked by the hub itself: someone signed in by name can't link a repo once GitHub signs people in.)
    await hub.record({ kind: 'hub' }, { type: 'binder.put', binder: { id: 'b1', name: 'Server', repo: 'acme/web' } })
    const card = await json(await call('POST', '/api/cards', { binderId: 'b1', title: 'Through the app' }))
    await until(() => !!hub.state.cards.find((c) => c.id === card.id)?.issue)
    const made = github.calls.find((c) => c.method === 'POST' && c.path === '/repos/acme/web/issues')!
    assert.equal(made.auth, 'Bearer ghs_installation')

    // GitHub's deliveries are checked with the app's webhook secret.
    const body = JSON.stringify({ zen: 'Keep it logically awesome.' })
    const signed = await fetch(`${url}/webhooks/github`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-github-event': 'ping', 'x-hub-signature-256': `sha256=${createHmac('sha256', 'app-hook-secret').update(body).digest('hex')}` }, body })
    assert.equal(signed.status, 200)

    // Made by someone signed in by name: the first GitHub sign-in, as the app's owner, becomes its maker and admin.
    const start = await fetch(`${url}/auth/github`, { redirect: 'manual' })
    const state = new URL(start.headers.get('location')!).searchParams.get('state')!
    assert.equal(new URL(start.headers.get('location')!).searchParams.get('client_id'), 'Iv1.app')
    const back = await fetch(`${url}/auth/github/callback?code=good&state=${state}`, { headers: { cookie: cookieOf(start, 'binders_oauth') }, redirect: 'manual' })
    assert.equal(back.status, 302)
    const octo = cookieOf(back, 'binders_session')
    const me = await json(await fetch(`${url}/api/me`, { headers: { cookie: octo } }))
    assert.equal(me.user.login, 'octo')
    assert.deepEqual(me.people.octo, { name: 'Octo Person', avatar: 'https://github.test/a.png' }, 'their GitHub profile, kept to show them by')
    assert.equal(me.github.admin, true)
    assert.equal(me.github.token, true)
    const implied = await json(await fetch(`${url}/api/options`, { headers: { cookie: octo } }))
    assert.deepEqual(implied.implied, { admins: ['octo'], allowedUsers: ['octo'], allowedOrgs: [] }, 'Settings shows who the app lets in')
    const searched = await json(await fetch(`${url}/api/github/people?kind=user&q=anab`, { headers: { cookie: octo } }))
    assert.deepEqual(searched.people.map((p: { login: string; why: string }) => [p.login, p.why]), [['anabel', 'On GitHub']], 'signed in with GitHub, its search helps too')

    // Connecting a GitHub account to the binder's app, signed in already: kept for them, and they stay signed in as
    // themselves (an Enterprise Managed User's account is another login than their own).
    const connect = await fetch(`${url}/auth/github?connect=1&space=test`, { redirect: 'manual' })
    const connectTo = new URL(connect.headers.get('location')!)
    assert.equal(connectTo.searchParams.get('client_id'), 'Iv1.app', 'through the binder’s GitHub App')
    const connected = await fetch(`${url}/auth/github/callback?code=good&state=${connectTo.searchParams.get('state')}`, { headers: { cookie: `${cookieOf(connect, 'binders_oauth')}; ${octo}` }, redirect: 'manual' })
    assert.equal(connected.headers.get('location'), '/test/#/settings')
    assert.equal(cookieOf(connected, 'binders_session'), '', 'no new session: still who they were')
    // Connecting from their account page comes back there, not to the binder's Settings.
    const fromAccount = await fetch(`${url}/auth/github?connect=1&space=test&back=account`, { redirect: 'manual' })
    const fromAccountTo = new URL(fromAccount.headers.get('location')!)
    const toAccount = await fetch(`${url}/auth/github/callback?code=good&state=${fromAccountTo.searchParams.get('state')}`, { headers: { cookie: `${cookieOf(fromAccount, 'binders_oauth')}; ${octo}` }, redirect: 'manual' })
    assert.equal(toAccount.headers.get('location'), '/test/#/account')

    // GitHub won't let their account make a repo in the organization: the app makes it, for the binder's admin.
    const orgRepo = await json(await fetch(`${url}/api/github/repos`, { method: 'POST', headers: { cookie: octo, 'x-binders': '1', 'content-type': 'application/json' }, body: JSON.stringify({ owner: 'acme', name: 'notes' }) }))
    assert.deepEqual(orgRepo, { fullName: 'acme/notes', url: 'https://github.test/acme/notes', byApp: true })
    // And links it, though GitHub says their own account can't push there: the binder's app reaches it.
    github.world.access['acme/notes'] = 'none'
    const linked = await fetch(`${url}/api/changes`, { method: 'POST', headers: { cookie: octo, 'x-binders': '1', 'content-type': 'application/json' }, body: JSON.stringify({ client: 'tab-link', changes: [{ id: 'link-1', change: { type: 'binder.put', binder: { id: 'b-notes', name: 'Notes', repo: 'acme/notes' } } }] }) })
    assert.equal(linked.status, 200, await linked.clone().text())
    assert.equal(hub.state.binders.find((b) => b.id === 'b-notes')?.repo, 'acme/notes')
    // An organization of thousands of repos: the picker finds one among them by name, from the list the hub keeps, and
    // one GitHub hasn't listed yet through GitHub's search.
    github.world.installationRepos = 2300
    github.world.listedRepos = 1200
    // (Read once already, when acme/notes was made and the organization had no others: read from the start.)
    await connection.ownIndex.forget(7)
    const before = github.calls.filter((c) => c.path.startsWith('/installation/repositories')).length
    const pick = async (q: string) => json(await fetch(`${url}/api/github/repos?q=${encodeURIComponent(q)}`, { headers: { cookie: octo } }))
    assert.equal((await pick('repo-1199')).repos[0].fullName, 'acme/repo-1199')
    const pages = () => github.calls.filter((c) => c.path.startsWith('/installation/repositories')).length - before
    await until(() => pages() === 13, 10_000)
    const deep = await pick('repo-1199')
    assert.equal(deep.repos[0].fullName, 'acme/repo-1199')
    assert.equal(deep.reading, undefined)
    const unlisted = await pick('repo-2299')
    assert.deepEqual(unlisted.repos.map((r: { fullName: string }) => r.fullName), ['acme/repo-2299'])
    assert.ok(github.calls.some((c) => c.path.startsWith('/search/repositories')))
    const searches = github.calls.filter((c) => c.path.startsWith('/search/repositories')).length
    assert.equal((await pick('repo-2299')).repos[0].fullName, 'acme/repo-2299')
    assert.equal(github.calls.filter((c) => c.path.startsWith('/search/repositories')).length, searches, 'kept once found')
    assert.equal((await pick('repo-1')).repos.length, 50, 'a page of suggestions, not the organization')
    // GitHub says a repo was added to the installation: it's in the list at once.
    const added = JSON.stringify({ action: 'added', installation: { id: 7 }, repositories_added: [{ full_name: 'acme/brand-new', private: true }], repositories_removed: [{ full_name: 'acme/repo-3' }] })
    await fetch(`${url}/webhooks/github`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-github-event': 'installation_repositories', 'x-hub-signature-256': `sha256=${createHmac('sha256', 'app-hook-secret').update(added).digest('hex')}` }, body: added })
    assert.deepEqual((await pick('brand-new')).repos.map((r: { fullName: string }) => r.fullName), ['acme/brand-new'])
    assert.equal((await pick('acme/repo-3')).repos.some((r: { fullName: string }) => r.fullName === 'acme/repo-3'), false)

    // The binder names the repos its agents work in; an agent picks among them, and nothing else.
    const scoped = await fetch(`${url}/api/changes`, { method: 'POST', headers: { cookie: octo, 'x-binders': '1', 'content-type': 'application/json' }, body: JSON.stringify({ client: 'tab-link', changes: [{ id: 'repos-1', change: { type: 'binder.put', binder: { id: 'b-notes', name: 'Notes', repo: 'acme/notes', repos: ['acme/repo-5', 'acme/repo-6'] } } }] }) })
    assert.equal(scoped.status, 200, await scoped.clone().text())
    assert.deepEqual(hub.state.binders.find((b) => b.id === 'b-notes')?.repos, ['acme/repo-5', 'acme/repo-6'])
    const agentCall = (body: unknown) => fetch(`${url}/api/agents`, { method: 'POST', headers: { cookie: octo, 'x-binders': '1', 'content-type': 'application/json' }, body: JSON.stringify(body) })
    const outside = await json(await agentCall({ name: 'Outside', provider: 'claude', repos: ['acme/repo-9'], binders: ['b-notes'], skills: [] }))
    assert.match(outside.error, /acme\/repo-9 isn’t among its binder’s repos/)
    const inside = await json(await agentCall({ name: 'Inside', provider: 'claude', repos: ['acme/repo-6'], binders: ['b-notes'], skills: [] }))
    assert.deepEqual(inside.agent.repos, ['acme/repo-6'])

    // Someone with no GitHub connected here, who doesn't run the binder: told to connect, or to ask one who does.
    const unconnected = await json(await call('POST', '/api/github/repos', { owner: 'acme', name: 'other' }))
    assert.match(unconnected.error, /Connect your GitHub to this binder first .*Or ask one of its owners or admins/)

    // Signing in by name is off now that GitHub is set up.
    const late = await fetch(`${url}/auth/dev`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-binders': '1' }, body: JSON.stringify({ login: 'someone' }) })
    assert.equal(late.status, 422)

    // Only an admin can undo it.
    const stranger = await json(await call('DELETE', '/api/github/app'))
    assert.match(stranger.error, /Only the Binder’s owners and admins/)
    const undone = await fetch(`${url}/api/github/app`, { method: 'DELETE', headers: { cookie: octo, 'x-binders': '1' } })
    assert.equal(undone.status, 200)
    assert.equal(connection.status().mode, 'none')

    await close()
    await github.close()
  })

  it('keeps a person’s own OAuth App for their personal binder alone, and connects their own GitHub through it', async () => {
    const github = await fakeGitHub({ login: 'outsider' })
    const hub = new Hub(new MemoryLog())
    await hub.start(seed())
    const kv = new MemoryKV()
    const connection = new GitHubConnection(kv, new Sealer('test-secret'), { webUrl: github.url, apiUrl: github.url })
    const auth = new Auth(kv, new Sealer('test-secret'), { github: () => connection.signIn(), allowed: () => ({ users: [], orgs: [] }), devLogin: () => true, endpoints: { webUrl: github.url, apiUrl: github.url } })
    const actions = new Actions(hub, connection)
    const app = await buildServer(oneSpace(kv, { hub, actions, webhooks: new Webhooks(hub, actions), github: connection }), { auth }, { publicUrl: 'https://hub.test' })
    await app.listen({ port: 0, host: '127.0.0.1' })
    const url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`
    const dev = await fetch(`${url}/auth/dev`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-binders': '1' }, body: JSON.stringify({ login: 'outsider' }) })
    const cookie = cookieOf(dev, 'binders_session')

    // Theirs alone: a made-up secret is refused, and nobody else has it; signing in to the hub doesn't change.
    assert.equal((await auth.setPersonalOAuth('outsider', 'Ov23liOAuthApp', 'short').catch((e: Error) => e.message)), 'That isn’t an OAuth App’s client secret.')
    await auth.setPersonalOAuth('outsider', 'Ov23liOAuthApp', 'f'.repeat(40))
    assert.deepEqual(await auth.personalOAuthStatus('outsider'), { set: true, clientId: 'Ov23liOAuthApp' })
    assert.deepEqual(await auth.personalOAuthStatus('someone-else'), { set: false }, 'nobody else has it')
    assert.equal(auth.signInVia(), 'app', 'people still sign in through a binder’s GitHub App')
    const me = await json(await fetch(`${url}/api/me`, { headers: { cookie } }))
    assert.deepEqual(me.ownGitHub, { connected: false, possible: true })

    // Their own GitHub, with repo access, through their own app, kept for their personal binder, back to it after.
    const start = await fetch(`${url}/auth/github?personal=1`, { headers: { cookie }, redirect: 'manual' })
    const asked = new URL(start.headers.get('location')!)
    assert.equal(asked.searchParams.get('client_id'), 'Ov23liOAuthApp')
    assert.match(asked.searchParams.get('scope') ?? '', /^repo /)
    const back = await fetch(`${url}/auth/github/callback?code=good&state=${asked.searchParams.get('state')}`, { headers: { cookie: `${cookieOf(start, 'binders_oauth')}; ${cookie}` }, redirect: 'manual' })
    assert.equal(back.headers.get('location'), '/~outsider/#/settings')
    assert.equal(cookieOf(back, 'binders_session'), '', 'still signed in as themselves')
    const again = await fetch(`${url}/auth/github?personal=1&back=account`, { headers: { cookie }, redirect: 'manual' })
    const againAsked = new URL(again.headers.get('location')!)
    const toAccount = await fetch(`${url}/auth/github/callback?code=good&state=${againAsked.searchParams.get('state')}`, { headers: { cookie: `${cookieOf(again, 'binders_oauth')}; ${cookie}` }, redirect: 'manual' })
    assert.equal(toAccount.headers.get('location'), '/~outsider/#/account', 'from the account page, back to it')
    assert.equal(await auth.personalToken('outsider'), 'gho_test')
    assert.equal((await fetch(`${url}/auth/github?personal=1`, { redirect: 'manual' })).status, 422, 'signed in first')

    // Taken away: the app and the connection both.
    await auth.clearPersonalOAuth('outsider')
    assert.deepEqual(await auth.personalOAuthStatus('outsider'), { set: false })
    assert.equal(await auth.personalToken('outsider'), undefined)
    await app.close()
    await github.close()
  })

  it('makes the app without a webhook on this machine, and points it here once the hub has a public address', async () => {
    const github = await fakeGitHub()
    const { connection, close } = await setUp(github, 'http://localhost:5173')
    const { manifest, local, action } = await connection.startCreating('you', false, 'http://localhost:5173', { org: 'acme' })
    assert.equal(local, true)
    assert.equal(JSON.parse(manifest).hook_attributes, undefined, 'GitHub refuses a webhook it can’t reach, so there is none')
    assert.equal(JSON.parse(manifest).default_events, undefined, 'nor events, which GitHub refuses without a webhook')
    assert.equal(JSON.parse(manifest).name, 'Binders for you', 'named for who it’s for, as names are unique on GitHub')
    assert.deepEqual(JSON.parse(manifest).callback_urls, ['http://localhost:5173/auth/github/callback'])
    await connection.finishCreating('made', new URL(action).searchParams.get('state')!)
    assert.equal(await connection.pointWebhook('http://localhost:5173'), 'local')
    assert.equal(await connection.pointWebhook('https://binders.example.test'), 'pointed')
    const hook = github.calls.find((c) => c.method === 'PATCH' && c.path === '/app/hook/config')!
    assert.equal(hook.body?.url, 'https://binders.example.test/webhooks/github')
    assert.equal(hook.body?.secret, connection.webhookSecret())
    assert.equal(await connection.pointWebhook('https://binders.example.test'), 'already', 'once is enough')
    assert.equal(connection.status().webhooks, true)
    await assert.rejects(connection.startCreating('you', false, 'http://localhost:5173', { org: 'not an org!' }), /letters, digits and dashes/)
    await close()
    await github.close()
  })
})

describe('where a GitHub App is installed scopes which binders use it', () => {
  /** The offers with installations to use, leaving out those only named (that the person can't show they reach). */
  const usable = (apps: { app: { installations: unknown[] } }[]) => apps.filter((o) => o.app.installations.length)
  /**
   * Four binders: acme-other (bo's, the hub's first), acme-one and acme-two (ana's; acme-two links acme/web and dee owns
   * it too), and anas, whose app is made on ana's own account. ana is a member of acme, bo of acme and elsewhere, dee of
   * acme. Their GitHub tokens are gho_<name>; GitHub lists no installations for them (they signed in through another app).
   */
  async function binders() {
    // Changed by tests: the next app GitHub makes for acme's binders.
    const people = { memberships: { gho_ana: ['acme'], gho_bo: ['acme', 'elsewhere'], gho_dee: ['acme'] } }
    const org: NonNullable<Parameters<typeof fakeGitHub>[0]> = { appOwner: { login: 'acme', type: 'Organization' }, installations: { 7: 'acme', 8: 'elsewhere', 9: 'ana' }, installationTypes: { 9: 'User' }, repoInstallations: { acme: 7, elsewhere: 8, ana: 9 }, ...people }
    const orgGitHub = await fakeGitHub(org)
    const kv = new MemoryKV()
    const sealer = new Sealer('test-secret')
    let spaces: Spaces | undefined
    // As main.ts: another binder's connection, and the repos this one linked (its projects' and its agents').
    const linkedIn = (id: string) => (repo: string) => {
      const state = spaces?.get(id)?.hub.state
      return !!state && (state.binders.some((b) => b.repo?.toLowerCase() === repo.toLowerCase()) || state.agents.some((a) => a.repos.some((r) => r.toLowerCase() === repo.toLowerCase())))
    }
    const sharing = (id: string) => ({ id, binder: (other: string) => spaces?.get(other)?.github, linked: linkedIn(id) })
    const make = async (id: string, github: Awaited<ReturnType<typeof fakeGitHub>>, members: { login: string; role: 'owner' | 'admin' | 'member' }[], extra: Change[] = []) => {
      const connection = new GitHubConnection(new MemoryKV(), sealer, { webUrl: github.url, apiUrl: github.url }, {}, id, sharing(id))
      const hub = new Hub(new MemoryLog())
      await hub.start([...seed(), ...extra])
      const actions = new Actions(hub, connection)
      return { info: { id, name: id, members }, space: { id, hub, actions, webhooks: new Webhooks(hub, actions), github: connection } }
    }
    const card: Card = { id: 'c-two', binderId: 'b1', title: 'In the second', brief: '', doneWhen: '', size: 'M', stage: 'review', createdAt: '2026-10-29T00:00:00Z', createdBy: 'ana', updatedAt: '2026-10-29T00:00:00Z', waitsFor: [], activity: [], issue: { repo: 'acme/web', number: 101, url: '' } }
    const ana = [{ login: 'ana', role: 'owner' as const }]
    spaces = Spaces.of(kv, [
      await make('acme-other', orgGitHub, [{ login: 'bo', role: 'owner' }, { login: 'ana', role: 'member' }]),
      await make('acme-one', orgGitHub, ana),
      await make('acme-two', orgGitHub, [...ana, { login: 'dee', role: 'owner' }, { login: 'root', role: 'member' }], [{ type: 'binder.put', binder: { id: 'b1', name: 'Server', repo: 'acme/web' } }, { type: 'card.put', card }]),
      await make('anas', orgGitHub, ana),
    ])
    const appFor = async (id: string, maker = 'ana') => {
      const connection = spaces!.get(id)!.github
      const { action } = await connection.startCreating(maker, true, 'https://hub.test', {})
      await connection.finishCreating('made', new URL(action).searchParams.get('state')!)
      return connection
    }
    const auth = new Auth(kv, sealer, { github: () => undefined, allowed: () => ({ users: [], orgs: [] }), devLogin: () => true })
    const app = await buildServer(spaces, { auth }, { publicUrl: 'https://hub.test', admins: ['root'] })
    await app.listen({ port: 0, host: '127.0.0.1' })
    const url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`
    // Signed in as a person, with the token their GitHub sign-in left (none: signed in by name).
    const as = async (who: string, token: string | undefined = `gho_${who}`) => {
      const { id } = await auth.startSession({ login: who, name: who }, undefined, undefined, token)
      return async (space: string, method: string, path: string, body?: unknown) => {
        const response = await fetch(`${url}${path}`, { method, headers: { cookie: `binders_session=${id}`, 'x-binders': '1', 'x-binders-space': space, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined })
        return { status: response.status, body: await json(response) }
      }
    }
    const call = await as('ana')
    return { spaces, org, sharing, appFor, url, call, as, auth, close: async () => { await app.close(); await orgGitHub.close() } }
  }

  it('offers a new binder the app by the GitHub account someone connected where the app was made', async () => {
    const { appFor, as, auth, close } = await binders()
    const other = await appFor('acme-other', 'bo')
    await other.installed(7)
    // dee signed in without a GitHub sign-in that reaches acme (by name here; an account outside an organization of
    // managed users, say), and acme-two has no app to connect one through: acme is named, not offered.
    const dee = await as('dee', 'gho_nobody')
    const before = (await dee('acme-two', 'GET', '/api/github/reusable')).body.apps
    assert.deepEqual(before.map((o: { app: { installations: unknown[] }; unreached: string[] }) => [o.app.installations.length, o.unreached]), [[0, ['acme']]])
    assert.equal((await dee('acme-two', 'POST', '/api/github/app/reuse', { from: 'acme-other', accounts: ['acme'] })).status, 422)
    // The account dee connected in acme-other, where the app was made, is in acme: that shows it.
    await auth.githubFor('dee', 'acme-other', 'gho_dee')
    const after = (await dee('acme-two', 'GET', '/api/github/reusable')).body.apps
    assert.deepEqual(after.map((o: { binder: { id: string }; app: { installations: { account: string }[] } }) => [o.binder.id, o.app.installations.map((i) => i.account)]), [['acme-other', ['acme']]])
    const reused = await dee('acme-two', 'POST', '/api/github/app/reuse', { from: 'acme-other', accounts: ['acme'] })
    assert.equal(reused.status, 200, JSON.stringify(reused.body))
    await close()
  })

  it('shares an app made on a person’s own account through its installation on an organization', async () => {
    const { spaces, org, appFor, call, as, close } = await binders()
    // GitHub makes anas's app on ana's own account.
    org.appOwner = { login: 'ana', type: 'User' }
    const anas = await appFor('anas')
    await anas.installed(7)
    await anas.installed(9)
    assert.equal(anas.status().app?.ownerType, 'User')
    assert.deepEqual(anas.shareable()?.installations, [{ account: 'acme', type: 'Organization' }, { account: 'ana', type: 'User' }])
    assert.equal(anas.status().app?.shareable, true)

    // Offered to acme-two's owners: acme, which ana is in, and her own account's to her alone.
    const offered = (await call('acme-two', 'GET', '/api/github/reusable')).body.apps
    assert.deepEqual(offered.map((o: { binder: { id: string }; app: { installations: { account: string }[] } }) => [o.binder.id, o.app.installations.map((i) => i.account)]), [['anas', ['acme', 'ana']]])
    const dee = await as('dee')
    assert.deepEqual((await dee('acme-two', 'GET', '/api/github/reusable')).body.apps[0].app.installations.map((i: { account: string }) => i.account), ['acme'], 'not ana’s own account to dee')
    const notHers = await dee('acme-two', 'POST', '/api/github/app/reuse', { from: 'anas', accounts: ['ana'] })
    assert.equal(notHers.status, 422)
    assert.match(notHers.body.error, /doesn’t show @dee as able to reach Binders test on @ana/)

    const reused = await call('acme-two', 'POST', '/api/github/app/reuse', { from: 'anas', accounts: ['acme'] })
    assert.equal(reused.status, 200, JSON.stringify(reused.body))
    assert.deepEqual(reused.body.accounts, ['acme'])
    const two = spaces.get('acme-two')!.github
    assert.equal(two.status().mode, 'app')
    assert.equal(two.borrowedFrom, 'anas')
    assert.deepEqual(two.installedAccounts(), ['acme'])
    assert.equal((await two.runToken('acme/web'))?.token, 'ghs_installation', 'it reaches the repo it linked')
    assert.equal(await two.runToken('ana/diary'), undefined, 'not her own account’s')
    assert.deepEqual(anas.status().app?.lentTo.map((l) => [l.binder, l.by, l.accounts]), [['acme-two', 'ana', ['acme']]])
    await close()
  })

  it('reaches only the installations it was lent, and through them only the repos it linked', async () => {
    const { spaces, sharing, appFor, url, call, close } = await binders()
    const one = await appFor('acme-one')
    await one.installed(7)
    await one.installed(8)
    const two = spaces.get('acme-two')!.github

    // ana is in acme, not elsewhere: only acme's installation is offered, or taken.
    const offered = (await call('acme-two', 'GET', '/api/github/reusable')).body.apps
    assert.deepEqual(offered.map((o: { binder: { id: string }; app: { installations: { account: string }[] } }) => [o.binder.id, o.app.installations.map((i) => i.account)]), [['acme-one', ['acme']]])
    assert.deepEqual((await call('acme-one', 'GET', '/api/github/reusable')).body.apps, [], 'acme-one has its own')
    const elsewhere = await call('acme-two', 'POST', '/api/github/app/reuse', { from: 'acme-one', accounts: ['elsewhere'] })
    assert.equal(elsewhere.status, 422)
    assert.match(elsewhere.body.error, /doesn’t show @ana as able to reach Binders test on @elsewhere/)
    const reused = await call('acme-two', 'POST', '/api/github/app/reuse', { from: 'acme-one' })
    assert.equal(reused.status, 200, JSON.stringify(reused.body))
    assert.deepEqual(reused.body.github.app.installations, ['acme'])
    assert.deepEqual(reused.body.github.app.borrowedAccounts, ['acme'])
    assert.equal(reused.body.github.app.shareable, false, 'shared on from where it was made, not from here')
    assert.deepEqual(usable((await call('acme-two', 'GET', '/api/github/reusable')).body.apps), [], 'nothing more she can reach')

    assert.deepEqual(two.installedAccounts(), ['acme'])
    assert.equal((await two.runToken('acme/web'))?.token, 'ghs_installation')
    assert.equal(await two.runToken('acme/payroll'), undefined, 'not a repo of acme’s it didn’t link')
    assert.equal(await two.forRepo('acme/payroll'), undefined)
    assert.equal(await two.gitAccess('acme/payroll'), undefined)
    assert.ok(await one.runToken('acme/payroll'), 'acme-one, whose app it is, still does')
    assert.equal(await two.runToken('elsewhere/secret'), undefined, 'nor another account’s')
    assert.equal(await two.forAccount('elsewhere'), undefined)
    assert.deepEqual((await call('acme-two', 'GET', '/api/github/owners')).body.owners, ['acme'], 'nor make repos there through the app')
    assert.equal(two.signIn()?.clientId, 'Iv1.app', 'people sign in to it through the same app')

    // Its webhook stays pointed at the binder that made it, which hands each delivery on.
    assert.equal(await two.pointWebhook('https://hub.test'), 'borrowed')
    assert.equal(two.path('hook'), '/webhooks/github/acme-one')
    const body = JSON.stringify({ action: 'closed', issue: { number: 101, title: 'In the second', body: '' }, repository: { full_name: 'acme/web' } })
    const delivered = await fetch(`${url}/webhooks/github/acme-one`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-github-event': 'issues', 'x-hub-signature-256': `sha256=${createHmac('sha256', 'app-hook-secret').update(body).digest('hex')}` }, body })
    assert.equal(delivered.status, 200)
    assert.equal(spaces.get('acme-two')!.hub.state.cards.find((c) => c.id === 'c-two')?.stage, 'live', 'acme-two heard its issue close')

    // Kept as a link, not a copy: reloaded, it still borrows the same installations.
    const kv = new MemoryKV()
    const again = new GitHubConnection(kv, new Sealer('test-secret'), two.endpoints, {}, 'acme-two', sharing('acme-two'))
    await again.reuse('acme-one', 'ana', ['acme'])
    const reloaded = new GitHubConnection(kv, new Sealer('test-secret'), two.endpoints, {}, 'acme-two', sharing('acme-two'))
    await reloaded.load()
    assert.equal(reloaded.borrowedFrom, 'acme-one')
    assert.deepEqual(reloaded.borrowedAccounts, ['acme'])
    await assert.rejects(one.reuse('acme-other', 'ana', ['acme']), /has a GitHub App of its own/, 'a binder with its own app keeps it')
    await assert.rejects(two.reuse('acme-one', 'ana', ['nowhere']), /isn’t installed on @nowhere/)

    // Forgotten here: acme-two stops using it, and acme-one keeps it.
    assert.equal((await call('acme-two', 'DELETE', '/api/github/app')).status, 200)
    assert.equal(two.status().mode, 'none')
    assert.equal(two.status().lost, undefined, 'handed back, not lost')
    assert.equal(one.status().mode, 'app')
    assert.deepEqual(one.status().app?.lentTo.filter((l) => l.binder === 'acme-two'), [], 'and the loan is handed back')
    await close()
  })

  it('holds a borrowed installation only while it’s lent, to people GitHub lets reach it', async () => {
    const { spaces, appFor, call, as, close } = await binders()
    const one = await appFor('acme-one')
    await one.installed(7)
    const two = spaces.get('acme-two')!.github
    const reuse = () => call('acme-two', 'POST', '/api/github/app/reuse', { from: 'acme-one' })
    assert.equal((await reuse()).status, 200)

    // acme-one's owners end the loan: acme-two loses the app at once, and says why.
    assert.equal((await call('acme-one', 'DELETE', '/api/github/app/loans/acme-two')).status, 200)
    assert.equal(two.status().mode, 'none')
    assert.equal(two.status().app, undefined)
    assert.equal(two.borrowedFrom, undefined, 'webhooks aren’t handed on to it')
    assert.equal(two.signIn(), undefined)
    assert.equal(await two.runToken('acme/web'), undefined)
    assert.equal(two.status().lost?.from, 'acme-one')
    assert.match(two.status().lost!.why, /stopped lending it/)
    assert.equal((await call('acme-two', 'GET', '/api/github/reusable')).body.apps.length, 1, 'offered again')
    assert.equal((await reuse()).status, 200)
    await two.disconnect()

    // Someone GitHub doesn't show in acme, the hub's admin included, gets nothing: no sign-in token, or not a member.
    for (const [who, token] of [['root', undefined], ['dee', 'gho_nobody']] as const) {
      const person = await as(who, token)
      assert.deepEqual(usable((await person('acme-two', 'GET', '/api/github/reusable')).body.apps), [], who)
      const refused = await person('acme-two', 'POST', '/api/github/app/reuse', { from: 'acme-one' })
      assert.equal(refused.status, 422)
      assert.match(refused.body.error, /able to reach any of Binders test’s installations|Only the Binder’s owners and admins/, who)
    }
    assert.equal(two.status().mode, 'none')
    await close()
  })

  it('doesn’t carry a borrower onto another app acme-one makes', async () => {
    const { spaces, org, appFor, call, close } = await binders()
    const one = await appFor('acme-one')
    await one.installed(7)
    const two = spaces.get('acme-two')!.github
    assert.equal((await call('acme-two', 'POST', '/api/github/app/reuse', { from: 'acme-one' })).status, 200)

    // Forgotten in acme-one: acme-two loses it too.
    await one.disconnect()
    assert.equal(two.status().mode, 'none')
    assert.match(two.status().lost!.why, /its app is gone/)

    // Remade there, as another app: not picked up, until it's lent again.
    org.appId = 43
    await appFor('acme-one')
    await one.installed(7)
    assert.equal(two.status().mode, 'none')
    assert.equal(two.status().app, undefined)
    assert.equal(two.signIn(), undefined)
    assert.equal(two.borrowedFrom, undefined)
    assert.equal(await two.runToken('acme/web'), undefined)
    assert.match(two.status().lost!.why, /its app is gone/)
    assert.deepEqual(one.status().app?.lentTo, [])
    assert.equal((await call('acme-two', 'POST', '/api/github/app/reuse', { from: 'acme-one' })).status, 200)
    assert.equal(two.status().mode, 'app')
    assert.equal(two.status().lost, undefined)
    await close()
  })

  it('knows the kind of account of installations kept before it asked', async () => {
    const { spaces, appFor, close } = await binders()
    const one = await appFor('acme-one')
    await one.installed(7)
    await one.installed(9)
    // As kept by an older hub: no kinds.
    const kept = (one as unknown as { own: { installations: { id: number; account: string; type?: string }[] } }).own
    kept.installations = kept.installations.map(({ id, account }) => ({ id, account }))
    assert.deepEqual(one.shareable()?.installations, [{ account: 'acme', type: 'Organization' }, { account: 'ana', type: undefined }], 'its own organization’s is known from the app')
    await one.knowInstallations()
    assert.deepEqual(one.shareable()?.installations, [{ account: 'acme', type: 'Organization' }, { account: 'ana', type: 'User' }])
    assert.equal(spaces.get('acme-two')!.github.status().mode, 'none')
    await close()
  })
})
