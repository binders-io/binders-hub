import { Refused } from '../hub.ts'
import { captureHome } from '../appLink.ts'
import { chooseHome } from '../brain/captures.ts'
import { personalId, readerWords } from '../spaces.ts'
import { bodies } from '../schemas.ts'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { Context } from './context.ts'

// A personal Binder's repo, and where a person's captures go.

export async function personalRoutes(app: FastifyInstance, context: Context) {
  const { spaces, auth, sp, login, isAdmin, act, bodyOf, callback } = context
  // A personal Binder's repo: <login>/binders-notes, private, made as the person once the app is on their account ------

  const personalRepoName = 'binders-notes'
  /** Where the person's own Binder stands with GitHub: its repo, or what's missing for one. */
  const personalStatus = (request: FastifyRequest) => {
    const info = spaces.info(request.space?.id ?? '')
    if (!info?.personal) throw new Refused('Only a personal Binder has a repo of its own.')
    const { github, hub } = sp(request)
    const project = hub.state.binders.find((b) => b.id === 'notes') ?? hub.state.binders[0]
    const status = github.status()
    return {
      repo: project?.repo,
      app: status.mode === 'app',
      installed: github.installedAccounts().some((a) => a.toLowerCase() === info.personal!.toLowerCase()),
      installUrl: status.app?.installUrl,
      signedIn: !!request.githubToken,
      suggested: `${info.personal}/${personalRepoName}`,
      // Through the hub's OAuth App, which needs nothing installed on their account: whether it's there, and connected.
      oauth: false,
      connected: false,
    }
  }
  const personalNow = async (request: FastifyRequest) => {
    const app = await auth.personalOAuthStatus(login(request), isAdmin(login(request)))
    return { ...personalStatus(request), oauth: app.set, oauthApp: app, callback, connected: !!(await auth.personalToken(login(request))) }
  }
  // Their own OAuth App, for their personal binder alone: set, replaced and taken away from it.
  app.put('/api/personal/oauth', act(async (request) => {
    personalStatus(request)
    const body = bodyOf(bodies.oauth, request)
    await auth.setPersonalOAuth(login(request), body.clientId ?? '', body.clientSecret ?? '')
    return personalNow(request)
  }))
  app.delete('/api/personal/oauth', act(async (request) => {
    personalStatus(request)
    await auth.clearPersonalOAuth(login(request), isAdmin(login(request)))
    return personalNow(request)
  }))
  app.get('/api/personal', act(async (request) => personalNow(request)))

  // Where what the person's phone and Mac capture goes: their own Binder, or a team's they're in. Theirs alone, kept in
  // their own Binder's store, and read as their own again when it names a Binder they've left.
  const capturesNow = async (request: FastifyRequest) => {
    const me = login(request)
    const own = personalId(me)
    return {
      home: await captureHome(spaces, me),
      // Only Binders they're a member of and can change: a hub admin's others aren't theirs to send captures to, and a
      // reader's notes can't be written there.
      binders: spaces.forPerson(me, false).filter((s) => s.role !== 'reader').map(({ info }) => ({ id: info.id, name: info.name, personal: !!info.personal })).sort((a, b) => Number(b.id === own) - Number(a.id === own)),
    }
  }
  app.get('/api/personal/captures', act(async (request) => capturesNow(request)))
  app.put('/api/personal/captures', act(async (request) => {
    const me = login(request)
    const body = (request.body ?? {}) as { binder?: unknown }
    if (typeof body.binder !== 'string' || !body.binder) throw new Refused('Say which Binder your captures go to.')
    const there = spaces.forPerson(me, false).find((s) => s.info.id === body.binder)
    if (!there) throw new Refused('You’re not in that Binder.')
    if (there.role === 'reader') throw new Refused(readerWords)
    const kv = (await spaces.start(personalId(me)))?.brain?.kv
    if (!kv) throw new Refused('Your own Binder isn’t ready yet. Try again in a moment.')
    // Their own is the default: nothing is kept for it.
    await chooseHome(kv, body.binder === personalId(me) ? undefined : body.binder)
    return capturesNow(request)
  }))
  /** Makes the repo (or takes it, when it's there already and the app reaches it) and links the Notes project to it. */
  app.post('/api/personal/repo', act(async (request) => {
    const status = await personalNow(request)
    if (status.repo) return status
    const me = login(request)
    // With their own GitHub, connected through the OAuth App: made in their account as them, no GitHub App needed.
    const own = await auth.personalToken(me)
    if (own) {
      const { github, hub } = sp(request)
      const as = github.asUser(own)
      let repo = status.suggested
      try {
        repo = (await as.send<{ full_name: string }>('POST', '/user/repos', { name: personalRepoName, private: true, auto_init: true, description: 'My notes, from my personal binder.' })).full_name
      } catch (error) {
        const words = (error as Error).message
        if (/401|Bad credentials/i.test(words)) {
          await auth.forgetPersonal(me)
          throw new Refused('GitHub no longer takes your connection: connect your GitHub account again.')
        }
        if (!/422|already exists/i.test(words)) throw new Refused(words)
        const there = await as.get<{ full_name: string; permissions?: { push?: boolean } }>(`/repos/${repo}`).catch(() => undefined)
        if (!there?.permissions?.push) throw new Refused(`${repo} is there already, and you can’t push to it.`)
        repo = there.full_name
      }
      const project = hub.state.binders.find((b) => b.id === 'notes') ?? hub.state.binders[0]
      const binder = { ...(project ?? { id: 'notes', name: 'Notes' }), repo, notes: true, notesBranch: 'main', issues: false }
      await hub.record({ kind: 'user', login: me }, { type: 'binder.put', binder })
      return personalNow(request)
    }
    throw new Refused('Connect your GitHub account first: your personal binder’s repo is made in your own account, through the hub’s OAuth App.')
  }))
}
