import { Fragment } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { ArrowRight, ArrowUpRight, Globe, ShieldCheck } from 'lucide-react'
import { environmentBefore, promotion, repoEnvironments, sameRepo, type EnvState } from '../../../shared/work.ts'
import type { Environment, HubState } from '../data/model'
import { useStore } from '../data/store'
import { attempt, toast } from '../components/Toast'
import { CheckGlyph, Progress, ago } from '../components/bits'
import { ConfirmButton } from '../components/ConfirmButton'
import { LookButton, environmentRepos, howEnvironmentsArrive } from '../components/Environments'
import { useBinderAccess } from './settings/access'
import { href } from '../route'

const spring = { type: 'spring', stiffness: 380, damping: 34 } as const

const stateWords: Record<EnvState, string> = { healthy: 'Healthy', deploying: 'Deploying', waiting: 'Waiting on GitHub', failed: 'Failed' }

/** An address a person may follow: GitHub or a person gave it, but only http and https are ever linked. */
const webAddress = (url: string | undefined) => (url && /^https?:\/\/\S+$/i.test(url) ? url : undefined)

/** When it was deployed, in words: "5m ago", or the date once it's older than a day. */
function deployedWords(iso: string) {
  const then = ago(iso)
  return then === 'now' ? 'just now' : /^\d+[smh]$/.test(then) ? `${then} ago` : `on ${then}`
}

const pulls = (n: number) => `${n} merged pull request${n === 1 ? '' : 's'}`

/**
 * How far an environment is behind, in words: for the first of its repo, the repo's merged pull requests that aren't on
 * it; for a later one, those on the environment before it that aren't on this one.
 */
function behindWords(state: Pick<HubState, 'pulls' | 'environments'>, env: Environment): string {
  const before = environmentBefore(state, env)
  const merged = state.pulls.filter((p) => p.state === 'merged' && sameRepo(p.repo, env.repo))
  const here = new Set(env.pullIds ?? [])
  if (!before) {
    const left = merged.filter((p) => !here.has(p.id)).length
    return left ? `${pulls(left)} ${left === 1 ? 'isn’t' : 'aren’t'} here yet` : 'Everything merged is here'
  }
  if (!before.version) return `Nothing is on ${before.name} yet`
  const ahead = new Set(before.pullIds ?? [])
  const left = merged.filter((p) => ahead.has(p.id) && !here.has(p.id)).length
  return left ? `${pulls(left)} on ${before.name} ${left === 1 ? 'isn’t' : 'aren’t'} here yet` : `Up to date with ${before.name}`
}

/** For each repo a binder works in, the environments GitHub deploys it to and what's on each, and the runs that took it there. */
export function Delivery() {
  const store = useStore()
  const { state } = store
  const { may } = useBinderAccess()
  const repos = environmentRepos(state.environments)

  return (
    <div className="delivery">
      {repos.length ? (
        <div className="delivery-note">
          <p className="faint">{howEnvironmentsArrive}</p>
          {may && <LookButton />}
        </div>
      ) : (
        <section className="delivery-empty">
          <p>Nothing has been deployed from this binder’s repos yet. When GitHub reports a deployment from one of them, it shows here by itself.</p>
          {may && <LookButton className="button primary" />}
        </section>
      )}

      {repos.map((repo) => {
        const list = repoEnvironments(state, repo)
        return (
          <section key={repo.toLowerCase()} className="delivery-repo" aria-label={`${repo}’s environments`}>
            <h2 className="delivery-repo-name">
              <a href={`https://github.com/${repo}`} target="_blank" rel="noreferrer">{repo} <ArrowUpRight size={13} aria-hidden="true" /></a>
            </h2>
            <div className="envs" style={{ gridTemplateColumns: list.map(() => 'minmax(0, 1fr)').join(' 96px ') }}>
              {list.map((env, index) => {
                const next = list[index + 1]
                const move = next && promotion(state, next)
                const served = webAddress(env.url)
                const run = webAddress(env.logUrl)
                return (
                  <Fragment key={env.id}>
                    <motion.section layout className={`env ${env.state}`} transition={spring}>
                      <header>
                        <h3>{env.name}</h3>
                        <span className={`env-state ${env.state}`}>
                          <i aria-hidden="true" />
                          {stateWords[env.state]}
                        </span>
                      </header>
                      <div className="env-version">
                        {env.version ? (
                          <AnimatePresence mode="popLayout" initial={false}>
                            <motion.b key={env.version} className="num" initial={{ y: 14, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: -14, opacity: 0 }} transition={spring}>
                              {env.version}
                            </motion.b>
                          </AnimatePresence>
                        ) : <span className="env-none">Nothing deployed yet</span>}
                      </div>
                      {served && <a className="env-url mono" href={served} target="_blank" rel="noreferrer"><Globe size={12} aria-hidden="true" /> {served.replace(/^https?:\/\//i, '')}</a>}
                      {env.state === 'deploying' && env.progress !== undefined && (
                        <div className="env-progress">
                          <Progress value={env.progress} />
                          <span className="num">{Math.round(env.progress * 100)}%</span>
                        </div>
                      )}
                      <p className="env-behind">{behindWords(state, env)}</p>
                      <ul className="env-sets">
                        {env.changeSetIds.map((id) => {
                          const set = state.changeSets.find((c) => c.id === id)
                          return set && (
                            <li key={id}>
                              <a href={href({ screen: 'changes', id })}><span className="mono">CS-{set.number}</span> {set.title}</a>
                            </li>
                          )
                        })}
                      </ul>
                      <footer className="faint">
                        {env.deployedAt && <span>Deployed <time dateTime={env.deployedAt}>{deployedWords(env.deployedAt)}</time></span>}
                        {run && <a href={run} target="_blank" rel="noreferrer">See the run on GitHub <ArrowUpRight size={11} aria-hidden="true" /></a>}
                      </footer>
                    </motion.section>
                    {next && (
                      <div className="promote">
                        <span className={`promote-line${move ? ' ready' : ''}`} />
                        {move ? (
                          <ConfirmButton
                            className="button primary"
                            question={`Promote ${move.version} to ${next.name}? Press again`}
                            label={`Promote ${move.version} to ${next.name}`}
                            onConfirm={() => void attempt(async () => {
                              await store.promote(next.id)
                              toast(`Asked GitHub to deploy ${move.version} to ${next.name}.`)
                            })}
                          >
                            <ShieldCheck size={14} aria-hidden="true" /> Promote
                          </ConfirmButton>
                        ) : <ArrowRight className="promote-arrow" size={14} aria-hidden="true" />}
                        <span className={`promote-line${move ? ' ready' : ''}`} />
                      </div>
                    )}
                  </Fragment>
                )
              })}
            </div>
          </section>
        )
      })}

      <section className="runs">
        <header>
          <h2>Runs</h2>
          <span className="faint">{state.me?.github.webhooks ? 'From GitHub Actions' : 'GitHub\u2019s webhooks aren\u2019t set up, so runs show when the hub records them'}</span>
        </header>
        <ol>
          <AnimatePresence initial={false}>
            {state.runs.map((run) => (
              <motion.li key={run.id} layout initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} transition={spring} className={`run ${run.state}`}>
                <CheckGlyph state={run.state} />
                <span className={`workflow ${run.workflow}`}>{run.workflow}</span>
                <span className="run-target mono">{run.target}</span>
                <span className="run-repo faint">{run.repo.split('/')[1]}</span>
                <span className="run-time num">{run.state === 'running' ? <span className="running-bar" /> : `${Math.floor(run.seconds / 60) ? `${Math.floor(run.seconds / 60)}m ` : ''}${run.seconds % 60}s`}</span>
                <time className="faint">{ago(run.at)}</time>
              </motion.li>
            ))}
          </AnimatePresence>
        </ol>
      </section>
    </div>
  )
}
