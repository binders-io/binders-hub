import type { FastifyReply, FastifyRequest } from 'fastify'
import { Refusal, type Auth } from '../auth.ts'
import { GitHubError } from '../github.ts'
import { Refused } from '../hub.ts'
import type { OptionsStore } from '../options.ts'
import { readBody } from '../schemas.ts'
import type { ServerOptions } from '../server.ts'
import type { Spaces } from '../spaces.ts'
import { Terminals } from '../terminals.ts'

// What the routes share: who's asking, what they may do, and how a route says no. Each file beside this one is a part
// of the API, given the app and this.

export type Context = ReturnType<typeof makeContext>

export function makeContext(spaces: Spaces, deps: { auth: Auth; options?: OptionsStore }, options: ServerOptions) {
  const { auth } = deps
  const hubOptions = deps.options
  const secure = options.publicUrl.startsWith('https:')
  const callback = new URL('/auth/github/callback', options.publicUrl).toString()
  const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(options.publicUrl)
  const terminals = new Terminals()
  terminals.setMaxListeners(0)

  /** The Binder a call back from GitHub is for: the one in its path, else the first. */
  const backFor = (request: FastifyRequest) => spaces.get((request.params as { space?: string }).space ?? spaces.list()[0]?.id ?? '')
  /** The request's Binder; the hook has made sure there is one for everything else. */
  const sp = (request: FastifyRequest) => {
    if (!request.space) throw new Refused('Open a Binder first.')
    return request.space
  }
  const login = (request: FastifyRequest) => request.user!.login
  const param = (request: FastifyRequest, name: string) => (request.params as Record<string, string>)[name]

  /** The first Binder's GitHub: whoever made its app is one of the hub's admins, as when the hub had one Binder. */
  const firstGitHub = () => spaces.get(spaces.list()[0]?.id ?? '')?.github
  /** Who may run the hub (make Binders, change its options): its admins, or, before anyone's named, whoever can sign in. */
  const isAdmin = (login: string) => {
    const admins = [...(firstGitHub()?.admins() ?? []), ...(options.admins ?? []), ...(hubOptions?.get().admins ?? [])].map((a) => a.toLowerCase())
    return admins.length ? admins.includes(login.toLowerCase()) : true
  }
  /** Who may change how a Binder reaches GitHub: its owners and admins, and the hub's admins. */
  // A Binder on the hub's app (a personal one too) reaches GitHub through its home Binder's: changed there, by that
  // Binder's owners, not from here.
  const mayManageGitHub = (request: FastifyRequest) => !spaces.info(request.space?.id ?? '')?.personal && (isAdmin(request.user!.login) || request.role === 'owner' || request.role === 'admin')

  /** The Binder to sign in through: the one named, when it has a GitHub App, else the first that has one. */
  const signInSpace = (named?: string) => {
    // A personal Binder signs in through its home's app, and keeps the grant there.
    const asked = named && !spaces.info(named)?.personal ? named : undefined
    if (asked && spaces.get(asked)?.github.signIn()) return asked
    return spaces.list().find((s) => !s.personal && spaces.get(s.id)?.github.signIn())?.id
  }

  const fail = (reply: FastifyReply, error: unknown) => {
    if (error instanceof Refused || error instanceof Refusal) return reply.code(422).send({ error: error.message })
    throw error
  }
  const act = <T>(work: (request: FastifyRequest) => Promise<T>) => async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      return (await work(request)) ?? { ok: true }
    } catch (error) {
      return fail(reply, error)
    }
  }
  /** A request's body, as its route takes it. */
  const bodyOf = <T>(schema: Parameters<typeof readBody<T>>[0], request: FastifyRequest) => {
    const read = readBody(schema, request.body)
    if (read.wrong) throw new Refused(`That request can’t be used: ${read.wrong}.`)
    return read.body as T
  }

  /**
   * Whether this person may link a repo to a project or an agent: only one GitHub says they can push to, so a Binder
   * never works in a repo its people couldn't work in themselves.
   */
  const mayLink = async (request: FastifyRequest, repo: string, binderRepo = false) => {
    const token = request.githubToken
    // A binder's own repo: its owners and admins link any its GitHub App reaches (one it made, say), as they run its
    // GitHub. An agent's repos stay within its owner's own reach.
    const appReaches = async () => binderRepo && mayManageGitHub(request) && sp(request).github.status().mode === 'app' && !!(await sp(request).github.gitAccess(repo).catch(() => undefined))
    if (await appReaches()) return
    if (!token) {
      // Signed in by name, on a hub tried out on this machine: no GitHub to ask.
      if (auth.options.devLogin()) return
      throw new Refused('Connect your GitHub to this binder first (Your account, from your picture at the top → Connect), with the account that can push to these repos: the hub links only repos you can push to, and each binder keeps its own GitHub sign-in.')
    }
    let access
    try {
      access = await sp(request).github.access(token, repo)
    } catch (error) {
      if (error instanceof GitHubError && error.status === 401) {
        await auth.forgetGitHub(login(request), sp(request).id)
        throw new Refused('GitHub turned your sign-in down: sign in with GitHub again to link a repo.')
      }
      throw new Refused(`GitHub didn’t say whether you can push to ${repo}. Try again in a moment.`)
    }
    // Said as the GitHub account the binder acts as for them, which may not be the one that can (an organization of
    // Enterprise Managed Users lets in only its own accounts).
    const as = `@${(await auth.githubLink(login(request), sp(request).id)).as ?? login(request)}`
    const other = 'If another GitHub account of yours can, connect it: Your account (your picture, top right) → Use another GitHub account.'
    if (access === 'read') throw new Refused(`As ${as}, GitHub lets you read ${repo} but not push to it, so it can’t be linked here. ${other}`)
    if (access === 'none') throw new Refused(`As ${as}, GitHub doesn’t let you reach ${repo}. ${other}`)
  }
  /** The repos in `repos` that aren't in `before`, each checked as above. */
  const mayLinkAll = async (request: FastifyRequest, repos: unknown, before: string[] = []) => {
    if (!Array.isArray(repos)) return
    const known = new Set(before.map((r) => r.toLowerCase()))
    for (const repo of repos) if (typeof repo === 'string' && !known.has(repo.toLowerCase())) await mayLink(request, repo)
  }

  return { spaces, auth, hubOptions, options, secure, callback, isLocal, terminals, backFor, sp, login, param, firstGitHub, isAdmin, mayManageGitHub, signInSpace, fail, act, bodyOf, mayLink, mayLinkAll }
}
