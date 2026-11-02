import { Refusal } from '../auth.ts'
import { Refused } from '../hub.ts'
import { bodies } from '../schemas.ts'
import { personalId } from '../spaces.ts'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { HubOptions } from '../options.ts'
import type { Context } from './context.ts'
import { deprovisioned } from '../../../shared/people.ts'

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
          cached = { at: Date.now(), logins: client ? await orgMembers(client, account) : [] }
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
      // Through another binder's app, only the repos this person sees on GitHub, or this binder linked already: the
      // rest of that organization's repos aren't this binder's to list.
      const borrowing = !!github.status().app?.borrowedFrom
      const linked = new Set(sp(request).hub.state.binders.flatMap((x) => (x.repo ? [x.repo.toLowerCase()] : [])))
      const shown = borrowing ? byApp.filter((r) => listed.has(r.fullName.toLowerCase()) || linked.has(r.fullName.toLowerCase())) : byApp
      known = {
        at: Date.now(),
        repos: [
          ...shown.map((r) => ({ ...r, reached: true, push: push(r.fullName) })),
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
  /** The GitHub logins a person goes by here: their own, and the one they connected to this binder (an EMU's, say). */
  const githubLogins = async (request: FastifyRequest) => {
    const as = (await auth.githubLink(login(request), sp(request).id).catch(() => ({ as: undefined }))).as
    return [...new Set([login(request), ...(as ? [as] : [])])]
  }
  /** The accounts of a binder's app whose installations this person can reach, as GitHub says with their own sign-in. */
  const reachableOf = async (request: FastifyRequest, from: string, accounts: string[]) => {
    const lender = spaces.get(from)?.github
    if (!lender) return []
    const token = request.githubToken ?? request.identityToken
    const logins = await githubLogins(request)
    const out: string[] = []
    for (const account of accounts) {
      for (const who of logins) {
        if (await lender.mayReach(token, who, account).catch(() => false)) { out.push(account); break }
      }
    }
    return out
  }
  /**
   * Installations of other binders' GitHub Apps this one may use rather than making one more app (the hub's own first):
   * offered to its owners and admins while it has no app of its own (or borrows one, for more of its installations),
   * and only those GitHub lets them reach with their own sign-in: an organization they're in, or their own account.
   */
  const reusable = async (request: FastifyRequest) => {
    const here = sp(request)
    const status = here.github.status()
    const borrowing = status.app?.borrowedFrom
    if (!mayManageGitHub(request) || (status.mode !== 'none' && !borrowing)) return []
    const taken = (status.app?.borrowedAccounts ?? []).map((a) => a.toLowerCase())
    const first = firstGitHub()
    const offers = []
    for (const info of spaces.list()) {
      if (info.id === here.id || info.personal || (borrowing && borrowing !== info.id)) continue
      const lender = spaces.get(info.id)?.github
      await lender?.knowInstallations().catch(() => undefined)
      const app = lender?.shareable()
      if (!lender || !app) continue
      const open = app.installations.filter((i) => !taken.includes(i.account.toLowerCase()))
      const reached = await reachableOf(request, info.id, open.map((i) => i.account))
      const installations = open.filter((i) => reached.includes(i.account))
      if (installations.length) offers.push({ binder: { id: info.id, name: info.name }, hub: lender === first, app: { ...app, installations } })
    }
    // The hub's own app first.
    return offers.sort((a, b) => Number(b.hub) - Number(a.hub))
  }
  app.get('/api/github/reusable', act(async (request) => ({ apps: await reusable(request) })))
  app.post('/api/github/app/reuse', act(async (request) => {
    if (!mayManageGitHub(request)) throw new Refused('Only the Binder’s owners and admins can change how it reaches GitHub.')
    const body = bodyOf(bodies.reuse, request)
    const from = body.from ?? ''
    const info = spaces.info(from)
    const lender = spaces.get(from)?.github
    if (!info || info.personal || !lender) throw new Refused('That binder has no GitHub App to use here.')
    await lender.knowInstallations().catch(() => undefined)
    const app = lender.shareable()
    if (!app) throw new Refused('That binder has no GitHub App of its own to share.')
    // The accounts asked for, or every installation this person can reach.
    const asked = body.accounts?.length ? body.accounts : app.installations.map((i) => i.account)
    const reached = await reachableOf(request, from, asked)
    const [who] = await githubLogins(request)
    const barred = body.accounts?.length ? asked.find((a) => !reached.some((r) => r.toLowerCase() === a.toLowerCase())) : undefined
    if (barred) throw new Refused(`GitHub doesn’t show @${who} as able to reach ${app.name} on @${barred}: an organization’s installation is for its members, and one on a person’s account for that person. Connect the GitHub account that’s in @${barred} (Your account, from your picture at the top), then try again.`)
    if (!reached.length) throw new Refused(`GitHub doesn’t show @${who} as able to reach any of ${app.name}’s installations.`)
    const made = await sp(request).github.reuse(from, who, reached)
    return { app: made.name, from: { id: info.id, name: info.name }, accounts: reached, github: sp(request).github.status() }
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

/**
 * An organization's members, every page of them, without deprovisioned managed accounts: GitHub lists members by login,
 * so in an enterprise of managed users the first pages can be all hashes of people who left, and the people who are
 * there come after them. Up to 5,000.
 */
export async function orgMembers(client: { get: <T>(path: string) => Promise<T> }, account: string) {
  const out: { login: string; avatar?: string }[] = []
  for (let page = 1; page <= 50; page++) {
    const list = await client.get<{ login: string; avatar_url?: string }[]>(`/orgs/${encodeURIComponent(account)}/members?per_page=100&page=${page}`).catch(() => undefined)
    if (!list?.length) break
    for (const m of list) if (!deprovisioned(m.login)) out.push({ login: m.login, avatar: m.avatar_url })
    if (list.length < 100) break
  }
  return out
}
