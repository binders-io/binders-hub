import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'
import { Actions } from '../src/actions.ts'
import { Auth } from '../src/auth.ts'
import { GitHubConnection } from '../src/githubConnection.ts'
import { Hub } from '../src/hub.ts'
import { MemoryKV } from '../src/kv.ts'
import { MemoryLog } from '../src/log.ts'
import { OptionsStore, optionsFromEnv } from '../src/options.ts'
import { Sealer } from '../src/secrets.ts'
import { buildServer } from '../src/server.ts'
import { Webhooks } from '../src/webhooks.ts'
import { oneSpace, seed } from './helpers.ts'

describe('the hub’s options', () => {
  it('are changed by admins in Settings, checked, take effect at once, and can be fixed by the environment', async () => {
    const hub = new Hub(new MemoryLog())
    await hub.start(seed())
    const kv = new MemoryKV()
    const sealer = new Sealer('x')
    const options = await new OptionsStore(kv, { pollSeconds: 45 }).load()
    const github = new GitHubConnection(kv, sealer, { webUrl: 'http://unused', apiUrl: 'http://unused' })
    const auth = new Auth(kv, sealer, { github: () => undefined, allowed: () => ({ users: options.get().allowedUsers, orgs: [] }), devLogin: () => options.get().devLogin !== 'off' })
    const actions = new Actions(hub, github)
    const app = await buildServer(oneSpace(kv, { hub, actions, webhooks: new Webhooks(hub, actions), github }), { auth, options }, { publicUrl: 'http://hub.test' })
    await app.listen({ port: 0, host: '127.0.0.1' })
    const url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`
    const signIn = async (login: string) => /binders_session=[^;]+/.exec((await fetch(`${url}/auth/dev`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-binders': '1' }, body: JSON.stringify({ login }) })).headers.get('set-cookie') ?? '')?.[0] ?? ''
    const patch = async (cookie: string, body: unknown) => {
      const response = await fetch(`${url}/api/options`, { method: 'PATCH', headers: { cookie, 'x-binders': '1', 'content-type': 'application/json' }, body: JSON.stringify(body) })
      return { status: response.status, body: await response.json() as { options?: Record<string, unknown>; locked?: Record<string, string>; error?: string } }
    }
    const you = await signIn('you')
    const read = await (await fetch(`${url}/api/options`, { headers: { cookie: you } })).json() as { options: Record<string, unknown>; locked: Record<string, string> }
    assert.equal(read.options.pollSeconds, 45)
    assert.equal(read.locked.pollSeconds, 'HUB_POLL_SECONDS')

    // Nobody's an admin yet, so whoever could sign in sets it up.
    const changed = await patch(you, { mergeMethod: 'squash' })
    assert.equal(changed.status, 200)
    assert.equal(options.get().mergeMethod, 'squash')
    assert.match((await patch(you, { pollSeconds: 60 })).body.error!, /set on the hub by HUB_POLL_SECONDS/)
    assert.match((await patch(you, { mergeMethod: 'nope' })).body.error!, /merge commits, squash or rebase/)
    // What has no switch in Settings isn't changed from there.
    assert.match((await patch(you, { notesQuietSeconds: 120 })).body.error!, /set on the hub itself, with NOTES_QUIET_SECONDS/)
    assert.match((await patch(you, { devLogin: 'on' })).body.error!, /set on the hub itself, with HUB_DEV_LOGIN/)
    assert.equal(options.get().devLogin, 'auto')
    assert.match((await patch(you, { allowedUsers: ['not a name!'] })).body.error!, /isn’t a GitHub name/)

    // Naming admins hands it over: from then on only they change options.
    assert.equal((await patch(you, { admins: ['boss'] })).status, 200)
    assert.match((await patch(you, { mergeMethod: 'rebase' })).body.error!, /Only the hub’s admins/)
    const boss = await signIn('boss')

    // Who agents' commits are by: each agent's choice until an admin fixes it; people see it on /api/me.
    const me = async (cookie: string) => (await (await fetch(`${url}/api/me`, { headers: { cookie } })).json() as { agentCommits?: string }).agentCommits
    assert.equal(await me(boss), 'agent')
    assert.match((await patch(boss, { agentCommits: 'everyone' })).body.error!, /each agent’s choice, its owner, or the hub’s GitHub App/)
    assert.match((await patch(you, { agentCommits: 'app' })).body.error!, /Only the hub’s admins/)
    assert.equal((await patch(boss, { agentCommits: 'app' })).status, 200)
    assert.equal(await me(boss), 'app')
    assert.deepEqual(new OptionsStore(kv, { agentCommits: 'owner' }).locked(), { agentCommits: 'HUB_AGENT_COMMITS' })
    assert.equal(optionsFromEnv({ HUB_AGENT_COMMITS: 'app' }).agentCommits, 'app')
    assert.equal(optionsFromEnv({ HUB_AGENT_COMMITS: 'nobody' }).agentCommits, undefined)

    // And they're kept: a hub reading the same store sees them.
    assert.equal((await new OptionsStore(kv).load()).get().mergeMethod, 'squash')
    await app.close()
  })

  it('ignores what was saved for an option with no switch any more, so nothing is left on that nobody can turn off', async () => {
    const kv = new MemoryKV()
    await kv.set('options', JSON.stringify({ devLogin: 'on', pollMode: 'off', pollSeconds: 999, notesQuietSeconds: 2, notesLongestMinutes: 90, mergeMethod: 'squash' }))
    const options = await new OptionsStore(kv).load()
    const { devLogin, pollMode, pollSeconds, notesQuietSeconds, notesLongestMinutes, mergeMethod } = options.get()
    assert.deepEqual({ devLogin, pollMode, pollSeconds, notesQuietSeconds, notesLongestMinutes }, { devLogin: 'auto', pollMode: 'auto', pollSeconds: 30, notesQuietSeconds: 60, notesLongestMinutes: 5 })
    assert.equal(mergeMethod, 'squash', 'and what still has a switch stays')

    // The environment still sets them, for a hub that wants something else.
    const fixed = await new OptionsStore(kv, optionsFromEnv({ HUB_DEV_LOGIN: 'off', NOTES_QUIET_SECONDS: '120', HUB_POLL: 'off' })).load()
    assert.deepEqual([fixed.get().devLogin, fixed.get().notesQuietSeconds, fixed.get().pollMode], ['off', 120, 'off'])

    // Saving anything leaves the old ones behind.
    await options.set({ allowedUsers: ['sam'] })
    assert.doesNotMatch((await kv.get('options'))!, /devLogin|pollMode|notesQuiet/)
  })
})
