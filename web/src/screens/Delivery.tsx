import { Fragment, type CSSProperties } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { ArrowRight, ArrowUpRight, Globe, Rocket, ShieldCheck } from 'lucide-react'
import { environmentBefore, promotion, repoEnvironments, sameRepo, type EnvState, type Run } from '../../../shared/work.ts'
import type { Environment, HubState } from '../data/model'
import { useStore } from '../data/store'
import { attempt, toast } from '../components/Toast'
import { CheckGlyph, Progress, ago } from '../components/bits'
import { ConfirmButton } from '../components/ConfirmButton'
import { LookButton, environmentRepos, howEnvironmentsArrive } from '../components/Environments'
import { useBinderAccess, useMayChangeBinder } from './settings/access'
import { href } from '../route'
import { DataTable, EmptyState, PageHeader, Section, Status, type Column, type Tone } from '../kit'

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

/** How an environment stands, as the kit's pill says it. */
const stateTone: Record<EnvState, Tone> = { healthy: 'ok', deploying: 'running', waiting: 'waiting', failed: 'bad' }

/** How long a run took, in words: "3m 24s". */
const took = (seconds: number) => `${Math.floor(seconds / 60) ? `${Math.floor(seconds / 60)}m ` : ''}${seconds % 60}s`

const runColumns: Column<Run>[] = [
  {
    key: 'target', header: 'Run', phone: 'title', width: '44%',
    text: (run) => `${run.target} ${run.workflow} ${run.repo}`,
    cell: (run) => {
      const link = webAddress(run.url)
      return (
        <span className="run-target">
          <CheckGlyph state={run.state} />
          {link ? <a className="mono" href={link} target="_blank" rel="noreferrer">{run.target}</a> : <span className="mono">{run.target}</span>}
          <span className="sr-only">, {runWords[run.state]}</span>
        </span>
      )
    },
  },
  { key: 'workflow', header: 'Kind', width: '96px', cell: (run) => <span className={`workflow ${run.workflow}`}>{run.workflow}</span> },
  { key: 'repo', header: 'Repo', cell: (run) => run.repo.split('/')[1] },
  { key: 'took', header: 'Took', width: '110px', align: 'end', cell: (run) => (run.state === 'running' ? <span className="running-bar" role="img" aria-label="Running" /> : <span className="num">{took(run.seconds)}</span>) },
  { key: 'when', header: 'When', width: '96px', align: 'end', cell: (run) => <time className="num" dateTime={run.at}>{ago(run.at)}</time> },
]
const runWords: Record<Run['state'], string> = { passed: 'passed', failed: 'failed', running: 'running', queued: 'waiting to run' }

/** For each repo a binder works in, the environments GitHub deploys it to and what's on each, and the runs that took it there. */
export function Delivery() {
  const store = useStore()
  const { state } = store
  const { may } = useBinderAccess()
  // Promote puts a version on the next environment: a reader sees where each stands and has no button for it.
  const mayPromote = useMayChangeBinder()
  const repos = environmentRepos(state.environments)

  return (
    <div className="page delivery">
      <div className="page-column delivery-column">
        <PageHeader title="Delivery" lead={repos.length ? howEnvironmentsArrive : undefined} action={repos.length && may ? <LookButton /> : undefined} />

        {!repos.length && (
          <section className="delivery-empty" aria-label="Nothing deployed yet">
            <EmptyState icon={<Rocket size={20} />} title="Nothing has been deployed from this binder’s repos yet."
              line="When GitHub reports a deployment from one of them, it shows here by itself."
              action={may ? <LookButton className="button primary" /> : undefined} />
          </section>
        )}

        {repos.map((repo) => {
          const list = repoEnvironments(state, repo)
          return (
            <section key={repo.toLowerCase()} className="delivery-repo" aria-label={`${repo}’s environments`}>
              <h2 className="delivery-repo-name">
                <a href={`https://github.com/${repo}`} target="_blank" rel="noreferrer">{repo} <ArrowUpRight size={13} aria-hidden="true" /></a>
              </h2>
              <div className="envs" style={{ '--envs': list.length } as CSSProperties}>
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
                          <Status tone={stateTone[env.state]}>{stateWords[env.state]}</Status>
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
                        {env.changeSetIds.length > 0 && (
                          <ul className="env-sets" aria-label={`Change sets on ${env.name}`}>
                            {env.changeSetIds.map((id) => {
                              const set = state.changeSets.find((c) => c.id === id)
                              return set && (
                                <li key={id}>
                                  <a href={href({ screen: 'changes', id })}><span className="mono">CS-{set.number}</span> {set.title}</a>
                                </li>
                              )
                            })}
                          </ul>
                        )}
                        {(env.deployedAt || run) && (
                          <footer>
                            {env.deployedAt && <span>Deployed <time dateTime={env.deployedAt}>{deployedWords(env.deployedAt)}</time></span>}
                            {run && <a href={run} target="_blank" rel="noreferrer">See the run on GitHub <ArrowUpRight size={11} aria-hidden="true" /></a>}
                          </footer>
                        )}
                      </motion.section>
                      {next && (
                        <div className={`promote${move ? ' ready' : ''}`}>
                          <span className="promote-line" aria-hidden="true" />
                          {move && mayPromote ? (
                            <ConfirmButton
                              className="button primary small"
                              question={`Promote ${move.version} to ${next.name}? Press again`}
                              label={`Promote ${move.version} to ${next.name}`}
                              onConfirm={() => void attempt(async () => {
                                await store.promote(next.id)
                                toast(`Asked GitHub to deploy ${move.version} to ${next.name}.`)
                              })}
                            >
                              <ShieldCheck size={14} aria-hidden="true" /> Promote
                            </ConfirmButton>
                          ) : <span className="promote-arrow" aria-hidden="true"><ArrowRight size={14} /></span>}
                          <span className="promote-line" aria-hidden="true" />
                        </div>
                      )}
                    </Fragment>
                  )
                })}
              </div>
            </section>
          )
        })}

        <Section level={2} title="Runs" className="runs" lead={state.me?.github.webhooks ? 'From GitHub Actions.' : 'GitHub’s webhooks aren’t set up, so runs show when the hub records them.'}>
          <DataTable label="Runs" columns={runColumns} rows={state.runs} rowKey={(run) => run.id} pageSize={25}
            empty={<EmptyState compact icon={<Rocket size={18} />} title="No runs yet" line="They show here as GitHub Actions reports them." />} />
        </Section>
      </div>
    </div>
  )
}
