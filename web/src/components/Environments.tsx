import { useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react'
import { ArrowDown, ArrowUp, ArrowUpRight, Search, Trash2 } from 'lucide-react'
import { deliveryRepos, environmentId, repoEnvironments, sameRepo, type Environment } from '../../../shared/work.ts'
import { useStore, type EnvironmentChange } from '../data/store'
import { useBinderAccess, useSaved } from '../screens/settings/access'
import { Changeable, Saved } from '../screens/settings/shared'
import { sectionHref } from '../screens/settings/sections'
import { ConfirmButton } from './ConfirmButton'
import { attempt, failure, toast } from './Toast'

// Delivery's environments. The hub follows what GitHub deploys, so most of them turn up by themselves; here an owner or
// an admin says what GitHub can't (where one is served, a workflow the hub may run to deploy to it), puts them in order,
// takes one away, or has the hub look on GitHub now. Delivery shows the same ones, and anyone in the binder sees both.

/** How environments get here, said the same on Delivery and in Settings. */
export const howEnvironmentsArrive = 'When GitHub reports a deployment from one of this binder’s repos, the hub shows it in Delivery.'

/** The repos that have environments, each once, in the order they first appear. */
export function environmentRepos(environments: Environment[]): string[] {
  const repos = environments.map((e) => e.repo).filter((r): r is string => !!r)
  return repos.filter((r, at) => repos.findIndex((x) => sameRepo(x, r)) === at)
}

const names = (repos: string[]) => (repos.length > 3 ? `${repos.slice(0, 3).join(', ')} and ${repos.length - 3} more` : repos.join(', '))

/** "Look on GitHub now": it takes a while, since the hub asks one repo after another, so it says it's working and then what it found. */
export function LookButton({ repo, className = 'button' }: { repo?: string; className?: string }) {
  const { lookForDeployments } = useStore()
  const [looking, setLooking] = useState(false)
  const look = async () => {
    setLooking(true)
    const found = await attempt(() => lookForDeployments(repo))
    setLooking(false)
    if (!found) return
    const looked = found.looked.length ? `Looked at ${names(found.looked)}.` : ''
    const failed = found.failed.map((f) => `${f.repo}: ${f.why.replace(/[.\s]+$/, '')}.`)
    if (failed.length) failure([looked, `Couldn’t look at ${failed.join(' ')}`].filter(Boolean).join(' '))
    else toast(looked || 'This binder has no repos to look at yet.')
  }
  return (
    <>
      <button type="button" className={className} disabled={looking} aria-busy={looking} onClick={() => void look()}>
        <Search size={14} aria-hidden="true" /> {looking ? 'Looking on GitHub…' : 'Look on GitHub now'}
      </button>
      <span className="sr-only" role="status">{looking ? 'Looking on GitHub. This can take a minute.' : ''}</span>
    </>
  )
}

export function Environments() {
  const store = useStore()
  const { state } = store
  const { may } = useBinderAccess()
  const { saved, shown } = useSaved()
  const repos = environmentRepos(state.environments)
  // A rename changes an environment's id, and a row that took a new key would be drawn again and lose the person's place:
  // the new id keeps the key the old one had.
  const [keys] = useState(() => new Map<string, string>())
  const keyOf = (id: string) => keys.get(id) ?? id

  /** Changes one and says Saved on it; whether it was kept. */
  const change = async (env: Environment, fields: EnvironmentChange) => {
    if (fields.name !== undefined && env.repo) keys.set(environmentId(env.repo, fields.name), keyOf(env.id))
    const done = await attempt(() => store.changeEnvironment(env.id, fields))
    if (done) saved(keyOf(env.id))
    return !!done
  }

  return (
    <section className="settings-part">
      <h3 className="settings-sub">Environments</h3>
      <p className="settings-part-detail">{howEnvironmentsArrive} Add or change one here to say where it’s served, or how the hub deploys to it.</p>
      <Changeable may={may}>
        {repos.length ? repos.map((repo) => {
          const list = repoEnvironments(state, repo)
          return (
            <div key={repo.toLowerCase()} className="env-repo">
              <h4 className="env-repo-name"><a href={`https://github.com/${repo}`} target="_blank" rel="noreferrer">{repo} <ArrowUpRight size={11} aria-hidden="true" /></a></h4>
              <ul className="env-rows">
                {list.map((env, at) => (
                  <EnvironmentRow key={keyOf(env.id)} env={env} at={at} last={list.length - 1} saved={<Saved show={shown(keyOf(env.id))} />} change={(fields) => change(env, fields)} />
                ))}
              </ul>
            </div>
          )
        }) : <p className="faint">No environments yet.</p>}
        <AddEnvironment onAdded={saved} saved={<Saved show={shown('add')} />} />
        <div className="env-look">
          <LookButton />
          <span className="field-hint">Asks GitHub what it has deployed from each repo. It can take a minute.</span>
        </div>
      </Changeable>
    </section>
  )
}

function EnvironmentRow({ env, at, last, saved, change }: { env: Environment; at: number; last: number; saved: ReactNode; change: (fields: EnvironmentChange) => Promise<boolean> }) {
  const store = useStore()
  const [deploying, setDeploying] = useState(false)
  const bodyId = `env-deploy-${env.id.replace(/[^\w-]/g, '-')}`
  const move = (to: number) => {
    if (to >= 0 && to <= last) void change({ order: to })
  }
  return (
    <li className="env-row">
      <div className="env-row-head">
        <b>{env.name}</b>
        <span className="faint">{env.version ? `On it: ${env.version}` : 'Nothing deployed yet'}</span>
        {saved}
        <span className="env-row-actions">
          <button type="button" className="button only-icon" aria-label={`Move ${env.name} up`} aria-disabled={at === 0} onClick={() => move(at - 1)}><ArrowUp size={14} aria-hidden="true" /></button>
          <button type="button" className="button only-icon" aria-label={`Move ${env.name} down`} aria-disabled={at === last} onClick={() => move(at + 1)}><ArrowDown size={14} aria-hidden="true" /></button>
          <ConfirmButton question={`Remove ${env.name}? Press again`} detail="If GitHub deploys there again, it comes back by itself." label={`Remove ${env.name}`} className="button only-icon danger" onConfirm={() => void attempt(() => store.removeEnvironment(env.id))}>
            <Trash2 size={14} aria-hidden="true" />
          </ConfirmButton>
        </span>
      </div>
      <div className="env-fields">
        <SaveText label="Name" value={env.name} onSave={(next) => (next ? change({ name: next }) : false)} />
        <SaveText label="Where it’s served" value={env.url} placeholder="https://" onSave={(next) => change({ url: next })} />
      </div>
      {env.deploy && !deploying && (
        <p className="field-hint">The hub deploys to it with {env.deploy.workflow} on {env.deploy.ref}, once someone presses Promote.</p>
      )}
      <button type="button" className="text-button env-deploy-toggle" aria-expanded={deploying} aria-controls={bodyId} onClick={() => setDeploying(!deploying)}>Deploy from the hub</button>
      {deploying && <DeployFrom id={bodyId} env={env} change={change} />}
    </li>
  )
}

/** A text box that keeps what's typed when it's left, and goes back to what it was if the hub says no. */
function SaveText({ label, value, placeholder, onSave }: { label: string; value: string; placeholder?: string; onSave: (next: string) => Promise<boolean> | boolean }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      <input
        key={value}
        defaultValue={value}
        placeholder={placeholder}
        onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur() }}
        onBlur={(event) => {
          const input = event.currentTarget
          const next = input.value.trim()
          if (next === value) return
          void Promise.resolve(onSave(next)).then((kept) => { if (!kept) input.value = value })
        }}
      />
    </label>
  )
}

/** The workflow the hub runs to deploy to an environment, and on what. Kept once both are given, and cleared when both are emptied. */
function DeployFrom({ id, env, change }: { id: string; env: Environment; change: (fields: EnvironmentChange) => Promise<boolean> }) {
  const [workflow, setWorkflow] = useState(env.deploy?.workflow ?? '')
  const [ref, setRef] = useState(env.deploy?.ref ?? '')
  // What another tab or the hub changed replaces what's in the boxes; drawn again at once, without losing the person's place.
  const kept = `${env.deploy?.workflow ?? ''}\n${env.deploy?.ref ?? ''}`
  const [seen, setSeen] = useState(kept)
  if (seen !== kept) {
    setSeen(kept)
    setWorkflow(env.deploy?.workflow ?? '')
    setRef(env.deploy?.ref ?? '')
  }
  const keep = () => {
    const w = workflow.trim()
    const r = ref.trim()
    const had = env.deploy
    if (!w && !r) {
      if (had) void change({ deploy: null }).then((kept) => { if (!kept) { setWorkflow(had.workflow); setRef(had.ref) } })
      return
    }
    // The hub wants both, so one alone waits for the other.
    if (!w || !r || (had && had.workflow === w && had.ref === r)) return
    void change({ deploy: { ...(had && !sameRepo(had.repo, env.repo) ? { repo: had.repo } : {}), workflow: w, ref: r } })
  }
  const enter = (event: KeyboardEvent<HTMLInputElement>) => { if (event.key === 'Enter') event.currentTarget.blur() }
  return (
    <div id={id} className="env-deploy">
      <div className="env-fields">
        <label className="field">
          <span className="field-label">Workflow file</span>
          <input value={workflow} placeholder="deploy.yml" onChange={(e) => setWorkflow(e.target.value)} onBlur={keep} onKeyDown={enter} />
        </label>
        <label className="field">
          <span className="field-label">Branch or tag to run it on</span>
          <input value={ref} placeholder="main" onChange={(e) => setRef(e.target.value)} onBlur={keep} onKeyDown={enter} />
        </label>
      </div>
      {env.deploy ? (
        // Nothing deploys by itself: the hub runs the workflow when someone presses Promote on Delivery.
        <p className="field-hint">It deploys when someone presses Promote on Delivery. Empty both boxes to stop the hub deploying to it.</p>
      ) : (
        <p className="field-hint">Give both, and when someone presses Promote the hub runs the workflow with the version on the environment before this one. Left empty, the hub only shows what GitHub deploys.</p>
      )}
    </div>
  )
}

/** One more environment, for a repo this binder works in, which is the only kind GitHub's deployments are followed for. */
function AddEnvironment({ onAdded, saved }: { onAdded: (key: string) => void; saved: ReactNode }) {
  const store = useStore()
  const repos = deliveryRepos(store.state)
  const [repo, setRepo] = useState('')
  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  const [adding, setAdding] = useState(false)
  if (!repos.length) return <p className="field-hint">Environments belong to the repos this binder works in. Add one in <a href={sectionHref('github')}>GitHub</a> first.</p>
  const chosen = repos.find((r) => sameRepo(r, repo)) ?? repos[0]
  const add = async (event: FormEvent) => {
    event.preventDefault()
    if (!name.trim() || adding) return
    setAdding(true)
    const made = await attempt(() => store.addEnvironment({ repo: chosen, name: name.trim(), ...(url.trim() ? { url: url.trim() } : {}) }))
    setAdding(false)
    if (!made) return
    setName('')
    setUrl('')
    onAdded('add')
  }
  return (
    <form className="env-add" onSubmit={(event) => void add(event)}>
      <h4 className="env-repo-name">Add an environment</h4>
      <label className="field">
        <span className="field-label">Repo</span>
        <select value={chosen} onChange={(e) => setRepo(e.target.value)}>
          {repos.map((r) => <option key={r} value={r}>{r}</option>)}
        </select>
      </label>
      <label className="field">
        <span className="field-label">Name, as GitHub calls it</span>
        <input value={name} placeholder="staging" onChange={(e) => setName(e.target.value)} />
      </label>
      <label className="field">
        <span className="field-label">Where it’s served (optional)</span>
        <input value={url} placeholder="https://" onChange={(e) => setUrl(e.target.value)} />
      </label>
      <div className="env-add-actions">
        <button type="submit" className="button" disabled={!name.trim() || adding}>Add environment</button>
        {saved}
      </div>
    </form>
  )
}
