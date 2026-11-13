import type { Auth } from './auth.ts'
import { Refused } from './hub.ts'
import type { Space } from './spaces.ts'
import { agentRepos, binderRepos, sameRepo, worksIn, type Agent } from '../../shared/work.ts'
import { log } from './logger.ts'

// A machine this hub keeps for an agent that has none. The agent is a model the hub runs; the sandbox is where its work
// happens: a copy of the Binder's repo and the Binders runner, started with a token of the agent's, so its cards are
// worked as any machine's are, and its steps reach the board as any runner's do. The hub still takes each step of its
// model, so the sandbox holds no model key, and the sandbox is a service of its own, with no Binder's data in it.
//
// The service is set on the hub (BINDERS_SANDBOX_URL and BINDERS_SANDBOX_SECRET, see README); without one, an agent has
// no machine here and works the cards it can without code, as it did before.

/** What the sandbox is told to keep: one runner, for one agent. */
export interface SandboxRun {
  /** The agent it runs as. */
  id: string
  /** The name it shows as, on the board. */
  name: string
  /** The hub its runner reaches. */
  hub: string
  /** A token of the agent's: what a machine of its own would hold. */
  token: string
  /** The repos to clone, each with the token to clone it, so it needs no other, and the folder it goes in. */
  clones: { url: string; dir: string }[]
  /** The branch to start from, when it isn't the repo's own. */
  branch?: string
}

export class Sandboxes {
  private url?: string
  private secret?: string
  private publicUrl: string
  private hubUrl: string
  private auth: Auth
  private fetchImpl: typeof fetch

  constructor(options: { url?: string; secret?: string; publicUrl: string; hubUrl?: string; auth: Auth; fetch?: typeof fetch }) {
    this.url = options.url?.replace(/\/+$/, '') || undefined
    this.secret = options.secret
    this.publicUrl = options.publicUrl.replace(/\/+$/, '')
    // The address its runners reach the hub at: beside it, on the network they share (BINDERS_SANDBOX_HUB_URL), so what
    // they send doesn't go out and back through whatever stands in front of the public address. A firewall there reads
    // an agent's conversation as an attack when it quotes /etc/hosts, and turns its every step away after that.
    this.hubUrl = options.hubUrl?.replace(/\/+$/, '') || this.publicUrl
    this.auth = options.auth
    this.fetchImpl = options.fetch ?? fetch
  }

  /** Whether this hub keeps machines for its agents: a sandbox service is set. */
  get configured(): boolean {
    return !!this.url && !!this.secret
  }

  /**
   * Gives an agent a machine of its own, or brings it back: the Binder's repo cloned, and the runner started as it.
   * A machine already there is stopped first, as its token has been replaced.
   */
  async ensure(space: Space, agent: Agent): Promise<void> {
    if (!this.configured) throw new Refused('This hub keeps no machines of its own: a runner on a machine of yours works this agent instead.')
    if (!agent.endpoint) throw new Refused('A machine here is for an agent the hub runs a model for. Give it a model first, or run a runner on a machine of your own.')
    const clones = await this.clonesFor(space, agent)
    // A new token stops any runner with the old one, so the one already there goes first.
    await this.stop(agent.id)
    const token = await this.auth.issueAgentToken(agent.id, space.id)
    const run: SandboxRun = { id: agent.id, name: agent.name, hub: this.hubUrl, token, clones }
    let answer: Response
    try {
      answer = await this.fetchImpl(`${this.url}/jobs`, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.secret}`, 'content-type': 'application/json' },
        body: JSON.stringify(run),
      })
    } catch (error) {
      throw new Refused(`The hub’s sandbox wasn’t reached: ${error instanceof Error ? error.message : 'it didn’t answer'}`)
    }
    if (!answer.ok) {
      const why = await answer.text().catch(() => '')
      throw new Refused(`The hub’s sandbox didn’t take the machine: ${why.trim().slice(0, 300) || `it answered ${answer.status}`}`)
    }
  }

  /**
   * Its clones' GitHub tokens, renewed: they last an hour, and the machine's git reads them from where this puts them.
   * The hub calls it for each machine it keeps, more often than they run out (main.ts). A machine that isn't there any
   * more is left to the next start.
   */
  async renew(space: Space, agent: Agent): Promise<void> {
    if (!this.configured) return
    const clones = await this.clonesFor(space, agent)
    const answer = await this.fetchImpl(`${this.url}/jobs/${encodeURIComponent(agent.id)}/credentials`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${this.secret}`, 'content-type': 'application/json' },
      body: JSON.stringify({ clones }),
    })
    if (!answer.ok && answer.status !== 404) throw new Error(`the hub’s sandbox answered ${answer.status}`)
  }

  /** Each repo it holds, with the Binder's GitHub's token for it and the folder it's in. */
  private async clonesFor(space: Space, agent: Agent): Promise<SandboxRun['clones']> {
    const repos = this.reposFor(space, agent)
    if (!repos.length) throw new Refused('This Binder has no repo for its machine to hold yet: connect one in Settings → GitHub, or give the agent its repos.')
    const clones: SandboxRun['clones'] = []
    const taken = new Set<string>()
    const unreached: string[] = []
    for (const repo of repos) {
      const access = await space.github.gitAccess(repo).catch(() => undefined)
      // One its GitHub doesn't reach is left out, and said; only none at all is no machine.
      if (!access) { unreached.push(repo); continue }
      // Its folder is the repo's own name, as a machine's folder of repos is laid out; two of one name keep their owners.
      const name = repo.split('/').pop()!
      const dir = taken.has(name.toLowerCase()) ? repo.replace('/', '-') : name
      taken.add(dir.toLowerCase())
      clones.push({ url: access.url.replace(/^https:\/\//, `https://x-access-token:${access.token}@`), dir })
    }
    if (!clones.length) throw new Refused(`This Binder’s GitHub doesn’t reach ${unreached.join(', ')}: set it up in Settings → GitHub, or install its app on ${unreached.length === 1 ? 'that repo' : 'those repos'}.`)
    if (unreached.length) log.warn({ agent: agent.id, repos: unreached }, 'The machine this hub keeps holds the repos its GitHub reaches; these it doesn’t')
    return clones
  }

  /** Takes an agent's machine away: the runner stops, and what it held goes back on the board as any runner's does. */
  async stop(id: string): Promise<void> {
    if (!this.configured) return
    try {
      const answer = await this.fetchImpl(`${this.url}/jobs/${encodeURIComponent(id)}`, { method: 'DELETE', headers: { authorization: `Bearer ${this.secret}` } })
      // Nothing there is what taking it away comes to.
      if (!answer.ok && answer.status !== 404) log.warn({ agent: id, status: answer.status }, 'The hub’s sandbox didn’t stop a machine')
    } catch (error) {
      // A sandbox that can't be reached has its machine stopped with it: nothing on the board waits on the call.
      log.warn({ agent: id, why: error instanceof Error ? error.message : String(error) }, 'The hub’s sandbox wasn’t reached to stop a machine')
    }
  }

  /**
   * The repos its machine holds: the ones the hub gives it work in (agentRepos), as far as twelve go: those it names; or its binders' when they name theirs; or,
   * when nothing limits it, every repo of the binders it works in. Each is cloned into a folder of repos by name, twelve
   * at most, as a runner takes; the Binder's own repo first, since cards are kept there.
   */
  private reposFor(space: Space, agent: Agent): string[] {
    const binders = space.hub.state.binders
    const limited = agentRepos(agent, binders)
    const open = binders.filter((b) => worksIn(agent, b.id, binders)).flatMap((b) => binderRepos(b))
    const own = binderRepos(binders.find((b) => b.id === space.id))
    const all = [...(limited.length ? limited : [...own, ...open])].map((r) => r.trim()).filter(Boolean)
    return all.filter((r, i) => all.findIndex((x) => sameRepo(x, r)) === i).slice(0, 12)
  }
}
