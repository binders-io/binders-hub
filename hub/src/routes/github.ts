import { Refusal } from '../auth.ts'
import { Refused } from '../hub.ts'
import { bodies } from '../schemas.ts'
import { personalId } from '../spaces.ts'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { HubOptions } from '../options.ts'
import type { Context } from './context.ts'
import { filterRepos, linkOf } from '../repoFilter.ts'
import type { IndexedRepo } from '../repoIndex.ts'
import { agentRepos, binderRepos } from '../../../shared/work.ts'

/** The most repos added together: each is checked with GitHub on adding, so more should be a choice, not a slip. */
const mostTogether = 200

/** Why a repo can't be linked, in a few words, for a list of those left out. */
export function shortWhy(refusal: string) {
  if (/lets you read .* but not push/.test(refusal)) return 'you can only read it'
  if (/doesn’t let you reach/.test(refusal)) return 'GitHub doesn’t let you reach it'
  if (/^Connect your GitHub/.test(refusal)) return 'your GitHub isn’t connected to this binder'
  if (/didn’t say whether/.test(refusal)) return 'GitHub didn’t answer'
  return refusal.split(/(?<=[.:])\s/)[0].replace(/[.:]$/, '')
}

// The hub's options, GitHub as people reach it, and setting up a Binder's GitHub App.

export async function githubRoutes(app: FastifyInstance, context: Context) {
  const { spaces, auth, hubOptions, options, sp, login, firstGitHub, isAdmin, mayManageGitHub, act, bodyOf, backFor, mayLink } = context
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

  // People and organizations to suggest as names are typed: members of the organizations the app is installed on, from
  // the list the hub keeps of them (an organization can have thousands), the person's own organizations, and GitHub's
  // user search.
  app.get('/api/github/people', act(async (request) => {
    const { q = '', kind = 'user' } = request.query as { q?: string; kind?: 'user' | 'org' }
    const typed = String(q).trim().replace(/^@/, '').slice(0, 100).toLowerCase()
    const found = new Map<string, { login: string; avatar?: string; why: string }>()
    const add = (login: string, why: string, avatar?: string) => {
      if (!typed || login.toLowerCase().includes(typed)) if (!found.has(login.toLowerCase())) found.set(login.toLowerCase(), { login, avatar, why })
    }
    const { github } = sp(request)
    // Their GitHub sign-in searches too: the GitHub App's, or the OAuth App's they signed in with.
    const searchWith = request.githubToken ?? request.identityToken
    const me = searchWith ? github.asUser(searchWith) : undefined
    let reading: { indexed: number } | undefined
    if (kind === 'org') {
      for (const account of github.installedAccounts()) add(account, 'The app is installed there')
      const mine = await me?.get<{ login: string; avatar_url: string }[]>('/user/orgs').catch(() => [])
      for (const org of mine ?? []) add(org.login, 'One of yours', org.avatar_url)
    } else {
      const members = await github.findPeople(typed, 12).catch(() => ({ people: [], managed: false, reading: undefined }))
      for (const member of members.people) add(member.login, `In ${member.account}`, member.avatar)
      reading = members.reading
      // An organization of managed users can only have its own accounts in it: nobody from the rest of GitHub to offer.
      if (typed.length >= 2 && found.size < 8 && me && !members.managed) {
        const search = await me.get<{ items: { login: string; avatar_url: string }[] }>(`/search/users?q=${encodeURIComponent(`${typed} in:login`)}&per_page=8`).catch(() => ({ items: [] }))
        for (const user of search.items) add(user.login, 'On GitHub', user.avatar_url)
      }
    }
    return { people: [...found.values()].slice(0, 12), ...(reading ? { reading } : {}) }
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

  // Repos to pick from, for a binder or an agent: the ones the GitHub App reaches that match what's typed, from the list
  // the hub keeps of them (an organization can have tens of thousands), or GitHub's search for one it hasn't read yet.
  // The person's own repos say which they can push to; kept a few minutes per person, as they're theirs alone.
  const theirs = new Map<string, { at: number; listed: Set<string>; pushable: Set<string> }>()
  const theirRepos = async (request: FastifyRequest, everything: boolean) => {
    const key = `${sp(request).id}:${login(request)}:${everything ? 'all' : 'own'}`
    const known = theirs.get(key)
    if (known && Date.now() - known.at < 5 * 60_000) return known
    type Theirs = { full_name: string; permissions?: { push?: boolean; maintain?: boolean; admin?: boolean } }
    const mine: Theirs[] = []
    // Their own and those they were added to, a few pages: an organization's every repo is the app's to list. Through
    // another Binder's app, all they see, as only those are shown.
    const affiliation = everything ? '' : '&affiliation=owner,collaborator'
    for (let n = 1; request.githubToken && n <= (everything ? 20 : 5); n++) {
      const page = await sp(request).github.asUser(request.githubToken).get<Theirs[]>(`/user/repos?per_page=100&sort=pushed&page=${n}${affiliation}`).catch(() => [] as Theirs[])
      mine.push(...page)
      if (page.length < 100) break
    }
    const found = {
      at: Date.now(),
      listed: new Set(mine.map((r) => r.full_name.toLowerCase())),
      pushable: new Set(mine.filter((r) => r.permissions?.push || r.permissions?.maintain || r.permissions?.admin).map((r) => r.full_name.toLowerCase())),
    }
    if (theirs.size > 1000) theirs.clear()
    theirs.set(key, found)
    return found
  }
  // What a picker asks for: words, a topic, a custom property with a value; `binders`, an agent's binders, to pick among
  // the repos they name; `for=binder`, a binder's own repo; `all`, every match's name, to add them together.
  app.get('/api/github/repos', act(async (request) => {
    const query = request.query as Record<string, unknown>
    // A filter sent twice is a list: taken as no filter, like one left out.
    const given = (name: string) => (typeof query[name] === 'string' ? (query[name] as string).slice(0, 200) : undefined)
    const typed = (given('q') ?? '').trim().slice(0, 100)
    const { github, hub } = sp(request)
    // Through another binder's app, only the repos this person sees on GitHub, or this binder linked already: the
    // rest of that organization's repos aren't this binder's to list.
    const borrowing = !!github.status().app?.borrowedFrom
    const mine = await theirRepos(request, borrowing)
    const lower = (name: string) => name.toLowerCase()
    const linked = new Set(hub.state.binders.flatMap((x) => binderRepos(x).map(lower)))
    // An agent in binders that name their repos picks among those alone.
    const binders = given('binders')
    const among = binders ? agentRepos({ repos: [], binders: binders === '*' ? [] : binders.split(',').filter(Boolean) }, hub.state.binders) : []
    const scope = among.length ? new Set(among.map(lower)) : undefined
    const keep = scope ? (name: string) => scope.has(lower(name)) : borrowing ? (name: string) => mine.listed.has(lower(name)) || linked.has(lower(name)) : undefined
    const found = await github.findRepos(typed, keep, given('again') === '1').catch(() => ({ repos: [] as IndexedRepo[], reading: undefined, failed: true }))
    const failed = !!found.failed
    // A binder's repos the app doesn't reach (typed in by name) are still among an agent's to pick.
    if (scope) for (const name of among) if (!found.repos.some((r) => lower(r.fullName) === lower(name))) found.repos.push({ fullName: name, private: false })
    // A private repo's topics and properties say more than its name: only to those GitHub shows it to, those who run
    // this binder's GitHub, and on the repos the binder named itself.
    const manages = mayManageGitHub(request)
    const sees = (repo: IndexedRepo) => !repo.private || manages || linked.has(lower(repo.fullName)) || mine.listed.has(lower(repo.fullName))
    const visible = found.repos.map((repo) => (sees(repo) ? repo : { ...repo, topics: undefined, properties: undefined }))
    // Known for the repos GitHub listed as the person's; for the app's others, the check on linking says.
    const push = (name: string) => (mine.listed.has(lower(name)) ? mine.pushable.has(lower(name)) : undefined)
    const who = { anyReached: given('for') === 'binder' && manages && github.status().mode === 'app', token: !!request.githubToken, byName: auth.options.devLogin() }
    const result = filterRepos(visible, { q: typed, topic: given('topic'), property: given('property'), value: given('value') }, (repo) => linkOf({ archived: repo.archived, push: push(repo.fullName) }, who))
    // Every match that isn't known to be refused, by name, for adding them together.
    if (given('all')) return { names: result.repos.filter((r) => r.linkable !== false).slice(0, mostTogether).map((r) => r.fullName), total: result.repos.length }
    const shown = result.repos.slice(0, 50)
    return {
      repos: shown.map((r) => ({ ...r, topics: r.topics ?? [], properties: r.properties ?? {}, reached: true, push: push(r.fullName) })),
      topics: result.topics.slice(0, 200),
      properties: result.properties.slice(0, 50),
      total: result.repos.length,
      more: Math.max(0, result.repos.length - shown.length),
      ...(found.reading ? { reading: found.reading } : {}),
      ...(failed ? { failed } : {}),
    }
  }))

  // Repos about to be added together: which this person may link, each checked as saving will check it, a few at a time.
  app.post('/api/github/repos/check', act(async (request) => {
    const { repos } = bodyOf<{ repos: string[] }>(bodies.repoCheck, request)
    const ok: string[] = []
    const refused: { repo: string; why: string }[] = []
    for (let at = 0; at < repos.length; at += 8) {
      await Promise.all(repos.slice(at, at + 8).map(async (repo) => {
        try {
          await mayLink(request, repo)
          ok.push(repo)
        } catch (error) {
          refused.push({ repo, why: shortWhy((error as Error).message) })
        }
      }))
    }
    // In the order asked.
    const order = new Map(repos.map((r, n) => [r, n]))
    ok.sort((a, b) => order.get(a)! - order.get(b)!)
    return { ok, refused }
  }))

  // How the lists the pickers search stand: what the app reaches, how far it's read, and its repos' custom properties.
  app.get('/api/github/lists', act(async (request) => sp(request).github.lists()))

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
      for (const key of theirs.keys()) if (key.startsWith(`${sp(request).id}:${login(request)}:`)) theirs.delete(key)
      // Into the list pickers search now, rather than when it's next read through.
      await sp(request).github.findRepos(made.fullName).catch(() => undefined)
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
  /**
   * The accounts of a binder's app whose installations this person can reach, as GitHub says with their own sign-in:
   * this binder's (or the one they signed in with), or the one they keep in the binder that made the app. A binder
   * without an app yet has no sign-in of its own, and the account that's in the app's organization (an Enterprise
   * Managed User's, say) is often the one they connected there.
   */
  const reachableOf = async (request: FastifyRequest, from: string, accounts: string[]) => {
    const lender = spaces.get(from)?.github
    if (!lender) return []
    const who = login(request)
    const there = await auth.githubLink(who, from).catch(() => ({ as: undefined as string | undefined }))
    const tries = [
      { token: request.githubToken ?? request.identityToken, logins: await githubLogins(request) },
      { token: await auth.githubFor(who, from).catch(() => undefined), logins: [...new Set([who, ...(there.as ? [there.as] : [])])] },
    ]
    const out: string[] = []
    for (const account of accounts) {
      reach: for (const { token, logins } of tries) {
        if (!token) continue
        for (const as of logins) if (await lender.mayReach(token, as, account).catch(() => false)) { out.push(account); break reach }
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
      // Installations they can't show they reach: named, so the screen can say which account to connect.
      const unreached = open.filter((i) => !reached.includes(i.account)).map((i) => i.account)
      if (installations.length || unreached.length) offers.push({ binder: { id: info.id, name: info.name }, hub: lender === first, app: { ...app, installations }, unreached })
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
