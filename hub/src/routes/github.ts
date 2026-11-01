import { Refusal } from '../auth.ts'
import { Refused } from '../hub.ts'
import { bodies } from '../schemas.ts'
import { personalId } from '../spaces.ts'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { HubOptions } from '../options.ts'
import type { Context } from './context.ts'

// The hub's options, GitHub as people reach it, and setting up a Binder's GitHub App.

export async function githubRoutes(app: FastifyInstance, context: Context) {
  const { spaces, auth, hubOptions, options, sp, login, firstGitHub, isAdmin, mayManageGitHub, act, bodyOf, backFor } = context
  // The hub's options: anyone signed in may read them, an admin may change them ------------------------------------

  // What the GitHub App already lets in or makes admin, shown with the options so Settings isn't blank about it.
  // Let in by the Binders' GitHub Apps (their makers, their owners' organizations); the first's maker is an admin.
  const implied = () => {
    const apps = spaces.all().map((s) => s.github.allowed())
    return { admins: firstGitHub()?.admins() ?? [], allowedUsers: [...new Set(apps.flatMap((a) => a.users))], allowedOrgs: [...new Set(apps.flatMap((a) => a.orgs))] }
  }
  app.get('/api/options', async () => ({ options: hubOptions?.get(), locked: hubOptions?.locked() ?? {}, implied: implied() }))
  app.patch('/api/options', act(async (request) => {
    if (!hubOptions) throw new Refused('This hub has no options to change.')
    if (!isAdmin(login(request))) throw new Refused('Only the hub’s admins can change its options.')
    return { options: await hubOptions.set(bodyOf(bodies.options, request) as Partial<HubOptions>), locked: hubOptions.locked(), implied: implied() }
  }))

  // People and organizations to suggest as names are typed: members of the organizations the app is installed on, the
  // person's own organizations, and GitHub's user search.
  const members = new Map<string, { at: number; logins: { login: string; avatar?: string }[] }>()
  app.get('/api/github/people', act(async (request) => {
    const { q = '', kind = 'user' } = request.query as { q?: string; kind?: 'user' | 'org' }
    const typed = q.trim().replace(/^@/, '').toLowerCase()
    const found = new Map<string, { login: string; avatar?: string; why: string }>()
    const add = (login: string, why: string, avatar?: string) => {
      if (!typed || login.toLowerCase().includes(typed)) if (!found.has(login.toLowerCase())) found.set(login.toLowerCase(), { login, avatar, why })
    }
    const { github } = sp(request)
    // Their GitHub sign-in searches too: the GitHub App's, or the OAuth App's they signed in with.
    const searchWith = request.githubToken ?? request.identityToken
    const me = searchWith ? github.asUser(searchWith) : undefined
    if (kind === 'org') {
      for (const account of github.installedAccounts()) add(account, 'The app is installed there')
      const mine = await me?.get<{ login: string; avatar_url: string }[]>('/user/orgs').catch(() => [])
      for (const org of mine ?? []) add(org.login, 'One of yours', org.avatar_url)
    } else {
      for (const account of github.installedAccounts()) {
        let cached = members.get(`${sp(request).id}:${account}`)
        if (!cached || Date.now() - cached.at > 5 * 60_000) {
          const client = await github.forAccount(account).catch(() => undefined)
          const list = await client?.get<{ login: string; avatar_url: string }[]>(`/orgs/${account}/members?per_page=100`).catch(() => undefined)
          cached = { at: Date.now(), logins: (list ?? []).map((m) => ({ login: m.login, avatar: m.avatar_url })) }
          members.set(`${sp(request).id}:${account}`, cached)
        }
        for (const member of cached.logins) add(member.login, `In ${account}`, member.avatar)
      }
      if (typed.length >= 2 && found.size < 8 && me) {
        const search = await me.get<{ items: { login: string; avatar_url: string }[] }>(`/search/users?q=${encodeURIComponent(`${typed} in:login`)}&per_page=8`).catch(() => ({ items: [] }))
        for (const user of search.items) add(user.login, 'On GitHub', user.avatar_url)
      }
    }
    return { people: [...found.values()].slice(0, 12) }
  }))

  // Your GitHub, as this Binder sees it: whether the hub holds a sign-in for you, and what you may do in each of its
  // projects' repos.
  app.get('/api/github/me', act(async (request) => {
    const { hub, github, id } = sp(request)
    const link = await auth.githubLink(login(request), id)
    const token = request.githubToken
    const projects = await Promise.all(hub.state.binders.map(async (b) => {
      let access: 'push' | 'read' | 'none' | 'unknown' = 'unknown'
      if (b.repo && token) access = await github.access(token, b.repo).catch(() => 'unknown' as const)
      return { id: b.id, name: b.name, repo: b.repo, access: b.repo ? access : undefined, issues: !!b.repo && b.issues !== false, notes: !!b.repo && b.notes !== false, notesBranch: b.notesBranch || 'binders-notes' }
    }))
    // The GitHub account it acts as: theirs, or the one they connected (an Enterprise Managed User's, say).
    return { login: link.as ?? login(request), ...link, projects }
  }))

  // Repos to pick from, for a binder or an agent: the ones the GitHub App reaches, then the person's own.
  // Kept a couple of minutes per person, as their own repos are theirs alone.
  const reachable = new Map<string, { at: number; repos: { fullName: string; private: boolean; description?: string; reached: boolean; push?: boolean }[] }>()
  app.get('/api/github/repos', act(async (request) => {
    const typed = String((request.query as { q?: string }).q ?? '').trim().toLowerCase()
    const { github, id } = sp(request)
    const cacheKey = `${id}:${login(request)}`
    let known = reachable.get(cacheKey)
    if (!known || Date.now() - known.at > 2 * 60_000) {
      const byApp = await github.reachableRepos().catch(() => [])
      type Theirs = { full_name: string; private: boolean; description: string | null; permissions?: { push?: boolean; maintain?: boolean; admin?: boolean } }
      // Every page of the person's repos, not GitHub's first hundred.
      const mine: Theirs[] = []
      for (let n = 1; request.githubToken && n <= 20; n++) {
        const page = await github.asUser(request.githubToken).get<Theirs[]>(`/user/repos?per_page=100&sort=pushed&page=${n}`).catch(() => [] as Theirs[])
        mine.push(...page)
        if (page.length < 100) break
      }
      const pushable = new Set(mine.filter((r) => r.permissions?.push || r.permissions?.maintain || r.permissions?.admin).map((r) => r.full_name.toLowerCase()))
      // Known for the repos GitHub listed as the person's; for the app's others, the check on linking says.
      const listed = new Set(mine.map((r) => r.full_name.toLowerCase()))
      const push = (name: string) => (listed.has(name.toLowerCase()) ? pushable.has(name.toLowerCase()) : undefined)
      known = {
        at: Date.now(),
        repos: [
          ...byApp.map((r) => ({ ...r, reached: true, push: push(r.fullName) })),
          // Only what this binder's app reaches: a repo it isn't installed on can't be worked in from here.
        ],
      }
      reachable.set(cacheKey, known)
    }
    const found = known.repos.filter((r) => !typed || r.fullName.toLowerCase().includes(typed))
    return { repos: found.slice(0, 500), more: Math.max(0, found.length - 500) }
  }))

  app.post('/api/github/repos', act(async (request) => {
    const body = bodyOf(bodies.newRepo, request)
    const owner = (body.owner ?? '').trim()
    const name = (body.name ?? '').trim()
    if (!/^[\w-]+$/.test(owner) || !/^[\w.-]{1,100}$/.test(name)) throw new Refused('A repo needs an owner and a name of letters, digits, dots, dashes and underscores.')
    const acting = (await auth.githubLink(login(request), sp(request).id)).as ?? login(request)
    // Without their GitHub connected to this binder, only its owners and admins make one, in an organization through
    // its app; anyone else connects first.
    const throughApp = mayManageGitHub(request) && sp(request).github.installedAccounts().some((a) => a.toLowerCase() === owner.toLowerCase())
    if (!request.githubToken && !throughApp) throw new Refused(`Connect your GitHub to this binder first (Your account, from your picture at the top → Connect), then make the repo.${mayManageGitHub(request) ? '' : ' Or ask one of its owners or admins: they can make it through its app.'}`)
    try {
      const made = await sp(request).github.createRepo(request.githubToken, acting, { owner, name, private: body.private !== false, description: body.description }, mayManageGitHub(request))
      reachable.delete(`${sp(request).id}:${login(request)}`)
      return made
    } catch (error) {
      const words = (error as Error).message
      // Refused: the app lacks Administration (Settings → GitHub says so), or this account can't make repos there.
      if (/Administration|admin access|Resource not accessible|Must have admin/i.test(words)) {
        const health = await sp(request).github.health().catch(() => undefined)
        const lacking = !health || health.missing.some((m) => m.permission === 'administration') || health.installations.some((i) => i.pending?.some((p) => p.permission === 'administration'))
        if (lacking) throw new Refused(`GitHub won’t let the hub make repos in ${owner} yet: this binder’s GitHub App needs Administration (read and write), accepted where it’s installed. Settings → GitHub shows where.`)
        throw new Refused(`GitHub didn’t let @${acting} make a repo in ${owner}: that account can’t make repos there. ${mayManageGitHub(request) ? '' : 'This binder’s owners and admins can make it for you, through its app. '}If another GitHub account of yours can (an organization of Enterprise Managed Users lets in only its own), connect it: Your account (your picture, top right) → Use another GitHub account.`)
      }
      throw new Refused(words)
    }
  }))
  // How this binder's GitHub App stands with GitHub now: what it lacks, and each installation's repos and acceptance.
  app.get('/api/github/health', act(async (request) => ({ health: await sp(request).github.health() })))

  // Where a repo can be made: the person's account and the organizations the app is installed on.
  app.get('/api/github/owners', async (request) => ({ owners: [...new Set([...(request.githubToken ? [login(request)] : []), ...sp(request).github.installedAccounts()])] }))

  // Setting up GitHub: a GitHub App made from its manifest, then installed on repos -------------------------------------

  // Each Binder's own: made, installed and forgotten from its Settings by its owners and admins, leaving the others'
  // alone.
  app.post('/api/github/app', act(async (request) => {
    if (!mayManageGitHub(request)) throw new Refused('Only the Binder’s owners and admins can change how it reaches GitHub.')
    return sp(request).github.startCreating(login(request), !!request.githubToken, options.publicUrl, bodyOf(bodies.newApp, request))
  }))
  app.delete('/api/github/app', act(async (request) => {
    if (!mayManageGitHub(request)) throw new Refused('Only the Binder’s owners and admins can change how it reaches GitHub.')
    await sp(request).github.disconnect()
  }))
  /**
   * Whether a person may lend a binder's app: one of its own owners or admins. Being the hub's admin isn't enough, since
   * lending lets another binder's people reach that binder's repos, which its owners haven't agreed to.
   */
  const mayLend = (id: string, who: string) => ['owner', 'admin'].includes(spaces.roleOf(id, who) ?? '')
  /**
   * Apps other binders made on an organization, which this one may use rather than making one more: offered while it has
   * none, to someone who runs both it and the binder that made the app. An app on a person's own account is never
   * offered: it serves only the binder it was made for.
   */
  const reusable = (request: FastifyRequest) => {
    const here = sp(request)
    if (!mayManageGitHub(request) || here.github.status().mode !== 'none') return []
    const who = login(request)
    return spaces.list()
      .filter((info) => info.id !== here.id && !info.personal && mayLend(info.id, who))
      .flatMap((info) => {
        const app = spaces.get(info.id)?.github.shareable()
        return app ? [{ binder: { id: info.id, name: info.name }, app }] : []
      })
  }
  app.get('/api/github/reusable', act(async (request) => ({ apps: reusable(request) })))
  app.post('/api/github/app/reuse', act(async (request) => {
    if (!mayManageGitHub(request)) throw new Refused('Only the Binder’s owners and admins can change how it reaches GitHub.')
    const from = bodyOf(bodies.reuse, request).from ?? ''
    const who = login(request)
    const info = spaces.info(from)
    if (!info || info.personal || !spaces.get(from) || !mayLend(from, who)) throw new Refused('Only the app of a binder you’re an owner or admin of can be used here.')
    const made = await sp(request).github.reuse(from, who)
    return { app: made.name, from: { id: info.id, name: info.name }, github: sp(request).github.status() }
  }))
  /** Ends a loan of this binder's app: that binder stops reaching GitHub through it at once. */
  app.delete('/api/github/app/loans/:to', act(async (request) => {
    if (!mayManageGitHub(request)) throw new Refused('Only the Binder’s owners and admins can change how it reaches GitHub.')
    await sp(request).github.endLoan(String((request.params as { to: string }).to))
    return { github: sp(request).github.status() }
  }))
  /** The Binder GitHub came back for: named in the path, or the first's, at the plain path. */
  const settingsOf = (space?: { id: string }) => (space ? `/${space.id}/#/settings` : '/#/settings')
  const created = async (request: FastifyRequest, reply: FastifyReply) => {
    const { code, state } = request.query as { code?: string; state?: string }
    const space = backFor(request)
    try {
      if (!code || !state || !space) throw new Refusal('GitHub didn’t send the app back.')
      await space.github.finishCreating(code, state)
      await space.github.pointWebhook(options.publicUrl).catch(() => undefined)
      return reply.redirect(settingsOf(space))
    } catch (error) {
      return reply.code(400).type('text/html').send(`<p>${(error as Error).message.replace(/</g, '&lt;')} <a href="${settingsOf(space)}">Back to Settings</a></p>`)
    }
  }
  const installed = async (request: FastifyRequest, reply: FastifyReply) => {
    const id = Number((request.query as { installation_id?: string }).installation_id)
    const space = backFor(request)
    try {
      // GitHub only answers for this app's own installations, so a made-up id goes nowhere.
      const account = id && space ? await space.github.installed(id) : undefined
      // Installed on a person's own account: back to their personal Binder, which makes its repo now it can.
      const personal = account ? spaces.info(personalId(account)) : undefined
      if (personal) return reply.redirect(`/${personal.id}/#/home`)
      return reply.redirect(settingsOf(space))
    } catch (error) {
      return reply.code(400).type('text/html').send(`<p>${(error as Error).message.replace(/</g, '&lt;')} <a href="${settingsOf(space)}">Back to Settings</a></p>`)
    }
  }
  app.get('/setup/github/created', created)
  app.get('/setup/github/created/:space', created)
  app.get('/setup/github/installed', installed)
  app.get('/setup/github/installed/:space', installed)
}
