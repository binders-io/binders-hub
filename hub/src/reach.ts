import type { Auth } from './auth.ts'
import { GitHubError } from './github.ts'
import type { GitHubConnection } from './githubConnection.ts'

// What an agent may reach on GitHub: no more than the person who set it up. An agent takes a card only in a repo its
// owner can push to, as GitHub says with the owner's own sign-in, and each run gets a token of the GitHub App's for
// that one repo, for an hour, to read and push code and open pull requests: never the hub's own reach, nor the
// machine's.

/** What GitHub says the owner may do: push, read or nothing; signed-out when the hub holds no sign-in of theirs to ask
 * with; open when the hub doesn't sign people in with GitHub, so there's nobody to ask. */
export type OwnerAccess = 'push' | 'read' | 'none' | 'signed-out' | 'open'

export interface AgentReach {
  owner(owner: string, repo: string): Promise<OwnerAccess>
  /** A token for one repo and an hour; undefined when the hub reaches GitHub with a token set by hand, which it can't narrow. */
  runToken(repo: string): Promise<{ token: string; expiresAt: string } | undefined>
  /** The owner's own GitHub token, from their sign-in to the hub, to push and open pull requests as them. */
  ownerToken?(owner: string): Promise<string | undefined>
  /** Who commits are by: the owner, as GitHub knows them (with their private noreply email), or the app's bot. */
  author?(as: 'owner' | 'app', token: string): Promise<{ name: string; email: string } | undefined>
  /** The GitHub the tokens are for (github.com, or an Enterprise server). */
  webUrl: string
}

/** For one Binder: its GitHub App, and its members' sign-ins to it. */
export function agentReach(github: GitHubConnection, auth: Auth, space: string, webUrl: string): AgentReach {
  return {
    webUrl,
    async owner(owner, repo) {
      if (!github.signIn()) return 'open'
      const token = await auth.githubFor(owner, space)
      if (!token) return 'signed-out'
      try {
        return await github.access(token, repo)
      } catch (error) {
        if (error instanceof GitHubError && error.status === 401) {
          await auth.forgetGitHub(owner, space)
          return 'signed-out'
        }
        throw error
      }
    },
    runToken: (repo) => github.runToken(repo),
    ownerToken: (owner) => (github.signIn() ? auth.githubFor(owner, space) : Promise.resolve(undefined)),
    async author(as, token) {
      const host = new URL(webUrl).host
      const noreply = host === 'github.com' ? 'users.noreply.github.com' : `users.noreply.${host}`
      if (as === 'owner') {
        const me = await github.asUser(token).get<{ id: number; login: string; name?: string | null }>('/user')
        return { name: me.name?.trim() || me.login, email: `${me.id}+${me.login}@${noreply}` }
      }
      const slug = github.status().app?.slug
      if (!slug) return undefined
      const cached = bots.get(slug)
      if (cached) return cached
      const bot = await github.asUser(token).get<{ id: number }>(`/users/${encodeURIComponent(`${slug}[bot]`)}`)
      const made = { name: `${slug}[bot]`, email: `${bot.id}+${slug}[bot]@${noreply}` }
      bots.set(slug, made)
      return made
    },
  }
}

/** The apps' bot accounts, by slug: asked of GitHub once. */
const bots = new Map<string, { name: string; email: string }>()

/** Why an agent can't take a card in a repo, from what GitHub said of its owner; undefined when it can. */
export function barredBecause(access: OwnerAccess, owner: string, repo: string) {
  if (access === 'push' || access === 'open') return undefined
  if (access === 'signed-out') return `${owner}, who set this agent up, needs to sign in to the hub with GitHub again before it works in ${repo}.`
  return `${owner}, who set this agent up, can’t push to ${repo}${access === 'read' ? ' (read only)' : ''}, so it doesn’t work there.`
}
