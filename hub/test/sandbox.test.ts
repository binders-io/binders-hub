import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Sandboxes } from '../src/sandbox.ts'
import { Refused } from '../src/hub.ts'
import type { Space } from '../src/spaces.ts'
import type { Agent } from '../../shared/work.ts'

// A machine the hub keeps for an agent that has none: the hub starts it in its sandbox, with the Binder's repo cloned
// and a token of the agent's, and stops it when the agent has none there any more.

const agent = (fields: Partial<Agent> = {}): Agent => ({
  id: 'agent-1',
  name: 'Ana',
  provider: 'other',
  owner: 'ana',
  repos: [],
  binders: [],
  skills: [],
  createdAt: '2026-01-01T00:00:00.000Z',
  endpoint: { kind: 'openai', baseUrl: 'https://acme.example/v1', model: 'gpt', takes: { cards: true, chats: false, debriefs: false, challenges: false } },
  sandbox: true,
  ...fields,
})

const space = (binders: { id: string; repo?: string; repos?: string[] }[], reaches: (repo: string) => boolean = () => true) =>
  ({
    id: 'b1',
    hub: { state: { binders } },
    github: { gitAccess: async (repo: string) => (reaches(repo) ? { url: `https://github.com/${repo}.git`, token: 'ghs_clone' } : undefined) },
  }) as unknown as Space

/** A sandbox that answers as the hub's does, and keeps what it was told. */
function stand(status = 202) {
  const calls: { url: string; method: string; body?: unknown; authorization?: string }[] = []
  const fetch = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined, authorization: (init?.headers as Record<string, string>)?.authorization })
    return new Response(null, { status: init?.method === 'DELETE' ? 204 : status })
  }) as typeof globalThis.fetch
  return { calls, fetch }
}

const tokens: { asked: string[] } = { asked: [] }
const auth = { issueAgentToken: async (id: string) => { tokens.asked.push(id); return 'bnd_sandbox' } } as never

describe('a machine this hub keeps', () => {
  it('starts with the Binder’s repo cloned and a token of the agent’s, the old one stopped first', async () => {
    const sandbox = stand()
    const sandboxes = new Sandboxes({ url: 'http://sandbox:4500/', secret: 's3cret', publicUrl: 'https://hub.example/', auth, fetch: sandbox.fetch })
    await sandboxes.ensure(space([{ id: 'b1', repo: 'acme/web' }]), agent({ repos: ['acme/web'] }))
    assert.deepEqual(sandbox.calls.map((c) => c.method), ['DELETE', 'POST'], 'the one there goes before the new one')
    assert.equal(sandbox.calls[0]!.url, 'http://sandbox:4500/jobs/agent-1')
    const [posted] = sandbox.calls.slice(-1)
    assert.equal(posted!.url, 'http://sandbox:4500/jobs')
    assert.equal(posted!.authorization, 'Bearer s3cret', 'only the hub starts machines here')
    assert.deepEqual(posted!.body, {
      id: 'agent-1',
      name: 'Ana',
      hub: 'https://hub.example',
      token: 'bnd_sandbox',
      clones: [{ url: 'https://x-access-token:ghs_clone@github.com/acme/web.git', dir: 'web' }],
    })
    assert.deepEqual(tokens.asked, ['agent-1'], 'a token of the agent’s, as a machine of its own would hold')
  })

  it('holds the repos the agent names, as a machine of someone’s does, each in a folder of its own', async () => {
    const sandbox = stand()
    const sandboxes = new Sandboxes({ url: 'http://sandbox:4500', secret: 's3cret', publicUrl: 'https://hub.example', auth, fetch: sandbox.fetch })
    await sandboxes.ensure(space([{ id: 'b1', repo: 'acme/web' }]), agent({ repos: ['acme/api', 'acme/backend'] }))
    const posted = sandbox.calls.find((c) => c.method === 'POST')!
    assert.deepEqual((posted.body as { clones: { dir: string }[] }).clones.map((c) => c.dir), ['api', 'backend'])
    assert.match((posted.body as { clones: { url: string }[] }).clones[1]!.url, /acme\/backend\.git$/)
  })

  it('stops a machine, and says nothing of one that isn’t there', async () => {
    const sandbox = stand()
    const sandboxes = new Sandboxes({ url: 'http://sandbox:4500', secret: 's3cret', publicUrl: 'https://hub.example', auth, fetch: sandbox.fetch })
    await sandboxes.stop('agent-1')
    assert.deepEqual(sandbox.calls.map((c) => `${c.method} ${c.url}`), ['DELETE http://sandbox:4500/jobs/agent-1'])
    // 404 is what taking one away comes to.
    const gone = new Sandboxes({ url: 'http://sandbox:4500', secret: 's3cret', publicUrl: 'https://hub.example', auth, fetch: (async () => new Response(null, { status: 404 })) as typeof globalThis.fetch })
    await gone.stop('agent-1')
  })

  it('says why it can’t, when it can’t', async () => {
    const none = new Sandboxes({ url: undefined, secret: undefined, publicUrl: 'https://hub.example', auth })
    assert.equal(none.configured, false)
    await assert.rejects(() => none.ensure(space([{ id: 'b1', repo: 'acme/web' }]), agent()), Refused)
    const sandboxes = new Sandboxes({ url: 'http://sandbox:4500', secret: 's3cret', publicUrl: 'https://hub.example', auth, fetch: stand().fetch })
    // A machine here is for an agent the hub runs a model for.
    await assert.rejects(() => sandboxes.ensure(space([{ id: 'b1', repo: 'acme/web' }]), agent({ endpoint: undefined })), /runs a model for/)
    // A Binder with no repo has nothing to clone.
    await assert.rejects(() => sandboxes.ensure(space([{ id: 'b1' }]), agent()), /no repo/)
    // A sandbox that turns it down says so, and no machine is kept.
    const refusing = new Sandboxes({ url: 'http://sandbox:4500', secret: 's3cret', publicUrl: 'https://hub.example', auth, fetch: (async () => new Response('no room', { status: 507 })) as typeof globalThis.fetch })
    await assert.rejects(() => refusing.ensure(space([{ id: 'b1', repo: 'acme/web' }]), agent()), /no room/)
  })

  it('holds every repo the hub gives it work in, the Binder’s own first, and leaves out one its GitHub doesn’t reach', async () => {
    const sandbox = stand()
    const sandboxes = new Sandboxes({ url: 'http://sandbox:4500', secret: 's3cret', publicUrl: 'https://hub.example', auth, fetch: sandbox.fetch })
    // A Binder whose cards are kept in one repo and whose code is in others: an agent that names none has them all.
    const binder = { id: 'b1', repo: 'acme/binder', repos: ['acme/backend', 'acme/opentofu-server', 'acme/agent-service'] }
    await sandboxes.ensure(space([binder], (repo) => repo !== 'acme/agent-service'), agent())
    const posted = sandbox.calls.find((c) => c.method === 'POST')!.body as { clones: { dir: string }[] }
    assert.deepEqual(posted.clones.map((c) => c.dir), ['binder', 'backend', 'opentofu-server'])
    // None it reaches is no machine.
    await assert.rejects(() => sandboxes.ensure(space([binder], () => false), agent()), /doesn’t reach acme\/binder, acme\/backend/)
  })

  it('has its runners reach the hub beside it when told where, not through the public address', async () => {
    const sandbox = stand()
    const sandboxes = new Sandboxes({ url: 'http://sandbox:4500', secret: 's3cret', publicUrl: 'https://hub.example', hubUrl: 'http://hub:4400/', auth, fetch: sandbox.fetch })
    await sandboxes.ensure(space([{ id: 'b1', repo: 'acme/web' }]), agent())
    assert.equal((sandbox.calls.find((c) => c.method === 'POST')!.body as { hub: string }).hub, 'http://hub:4400')
  })

  it('renews its clones’ GitHub tokens, and leaves one that isn’t there to its next start', async () => {
    const sandbox = stand()
    const sandboxes = new Sandboxes({ url: 'http://sandbox:4500', secret: 's3cret', publicUrl: 'https://hub.example', auth, fetch: sandbox.fetch })
    await sandboxes.renew(space([{ id: 'b1', repo: 'acme/web' }]), agent())
    assert.deepEqual(sandbox.calls.map((c) => `${c.method} ${c.url}`), ['PUT http://sandbox:4500/jobs/agent-1/credentials'])
    assert.deepEqual(sandbox.calls[0]!.body, { clones: [{ url: 'https://x-access-token:ghs_clone@github.com/acme/web.git', dir: 'web' }] })
    const gone = new Sandboxes({ url: 'http://sandbox:4500', secret: 's3cret', publicUrl: 'https://hub.example', auth, fetch: (async () => new Response(null, { status: 404 })) as typeof globalThis.fetch })
    await gone.renew(space([{ id: 'b1', repo: 'acme/web' }]), agent())
  })
})
