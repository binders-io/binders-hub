import { Fragment } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { ArrowRight, Globe, ShieldCheck } from 'lucide-react'
import { useStore } from '../data/store'
import { attempt } from '../components/Toast'
import { CheckGlyph, Progress, ago } from '../components/bits'
import { href } from '../route'

const spring = { type: 'spring', stiffness: 380, damping: 34 } as const

/** Where every change set is, environment by environment, and the runs that took it there. */
export function Delivery() {
  const store = useStore()
  const { state } = store

  return (
    <div className="delivery">
      <div className="envs" style={{ gridTemplateColumns: state.environments.map(() => 'minmax(0, 1fr)').join(' 96px ') }}>
        {state.environments.map((env, index) => {
          const next = state.environments[index + 1]
          const canPromote = next?.needsApproval && env.version !== next.version && env.state !== 'deploying' && next.state !== 'deploying'
          return (
            <Fragment key={env.id}>
              <motion.section layout className={`env ${env.state}`} transition={spring}>
                <header>
                  <h2>{env.name}</h2>
                  <span className={`env-state ${env.state}`}>
                    <i />
                    {env.state === 'deploying' ? 'Deploying' : env.state === 'waiting' && env.needsApproval ? 'Waiting for you' : 'Healthy'}
                  </span>
                </header>
                <div className="env-version">
                  <AnimatePresence mode="popLayout" initial={false}>
                    <motion.b key={env.version} className="num" initial={{ y: 14, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: -14, opacity: 0 }} transition={spring}>
                      {env.version}
                    </motion.b>
                  </AnimatePresence>
                </div>
                <span className="env-url mono"><Globe size={12} /> {env.url}</span>
                {env.state === 'deploying' && env.progress !== undefined && (
                  <div className="env-progress">
                    <Progress value={env.progress} />
                    <span className="num">{Math.round(env.progress * 100)}%</span>
                  </div>
                )}
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
                <footer className="faint">{env.deployedAt && env.deployedAt !== '\u2014' ? `Deployed ${ago(env.deployedAt)}` : 'Nothing deployed yet'}</footer>
              </motion.section>
              {next && (
                <div className="promote">
                  <span className={`promote-line${canPromote ? ' ready' : ''}`} />
                  {next.needsApproval ? (
                    <button className={`button${canPromote ? ' primary' : ''}`} disabled={!canPromote} onClick={() => void attempt(() => store.promote(next.id))}>
                      <ShieldCheck size={14} /> Promote
                    </button>
                  ) : (
                    <span className="promote-auto"><ArrowRight size={14} /> On merge</span>
                  )}
                  <span className={`promote-line${canPromote ? ' ready' : ''}`} />
                </div>
              )}
            </Fragment>
          )
        })}
      </div>

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
