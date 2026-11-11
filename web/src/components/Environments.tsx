import { useState, type FormEvent, type KeyboardEvent } from 'react'
import { AnimatePresence } from 'motion/react'
import { ArrowDown, ArrowUp, ArrowUpRight, ChevronDown, Plus, Rocket, Search, Trash2 } from 'lucide-react'
import { openMenuUnder } from './ContextMenu'
import { deliveryRepos, environmentId, repoEnvironments, sameRepo, type Environment } from '../../../shared/work.ts'
import { useStore, type EnvironmentChange } from '../data/store'
import { useBinderAccess, useSaved } from '../screens/settings/access'
import { Changeable, Saved } from '../screens/settings/shared'
import { sectionHref } from '../screens/settings/sections'
import { attempt, failure, toast } from './Toast'
import { DataTable, Dialog, EmptyState, Section, type Column } from '../kit'

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

/** Where an environment is served, without its scheme: what a table has room for. */
const host = (url?: string) => (url ? url.replace(/^https?:\/\//, '').replace(/\/$/, '') : '')

/**
 * The environments of each repo as a table (its name, what's on it, where it's served, how the hub deploys to it), a
 * row opening its dialog to change it, put it in order or take it away; one Add button for a new one, and the hub asked
 * to look on GitHub now. A member reads them all and changes none.
 */
export function Environments() {
  const store = useStore()
  const { state } = store
  const { may } = useBinderAccess()
  const { saved, shown } = useSaved()
  const repos = environmentRepos(state.environments)
  const deliverable = deliveryRepos(state)
  // A rename changes an environment's id, and a dialog that took a new key would be drawn again and lose the person's
  // place: the new id keeps the key the old one had.
  const [keys] = useState(() => new Map<string, string>())
  const keyOf = (id: string) => keys.get(id) ?? id
  const [open, setOpen] = useState<string>()
  const [adding, setAdding] = useState(false)

  /** Changes one and says Saved on it; whether it was kept. */
  const change = async (env: Environment, fields: EnvironmentChange) => {
    if (fields.name !== undefined && env.repo) keys.set(environmentId(env.repo, fields.name), keyOf(env.id))
    const done = await attempt(() => store.changeEnvironment(env.id, fields))
    if (done) saved(`${keyOf(env.id)}-${Object.keys(fields)[0]}`)
    return !!done
  }
  const opened = open ? state.environments.find((e) => keyOf(e.id) === open) : undefined
  const columns: Column<Environment>[] = [
    { key: 'name', header: 'Name', width: '24%', phone: 'title', cell: (e) => e.name, text: (e) => e.name },
    { key: 'on', header: 'On it', width: '22%', cell: (e) => (e.version ? <span className="mono">{e.version}</span> : <span className="faint">Nothing yet</span>), text: (e) => e.version ?? '' },
    { key: 'url', header: 'Served at', cell: (e) => (e.url ? host(e.url) : <span className="faint">Not said</span>), text: (e) => e.url ?? '' },
    { key: 'deploy', header: 'Deploys', width: '22%', phone: 'hidden', cell: (e) => (e.deploy ? <span className="mono">{e.deploy.workflow}</span> : <span className="faint">From GitHub</span>) },
  ]
  const add = may && deliverable.length > 0 && <button type="button" className="button small" onClick={() => setAdding(true)}><Plus size={14} aria-hidden="true" />Add</button>

  return (
    <Section title="Environments" lead={howEnvironmentsArrive} action={(repos.length && add) || undefined}
      more={<p>Add or change one here to say where it’s served, or how the hub deploys to it. The hub runs a deploy only when someone presses Promote on Delivery. One taken off comes back by itself if GitHub deploys there again.</p>}>
      {repos.length ? repos.map((repo) => {
        const list = repoEnvironments(state, repo)
        return (
          <div key={repo.toLowerCase()} className="env-repo">
            <h4 className="env-repo-name"><a href={`https://github.com/${repo}`} target="_blank" rel="noreferrer">{repo}<ArrowUpRight size={12} aria-hidden="true" /></a></h4>
            <DataTable label={`${repo}’s environments`} columns={columns} rows={list} rowKey={(e) => keyOf(e.id)} onRowPress={(e) => setOpen(keyOf(e.id))} rowLabel={(e) => `Open ${e.name}`} />
          </div>
        )
      }) : <EmptyState compact icon={<Rocket size={18} />} title="No environments yet" line="They turn up here when GitHub deploys from one of this binder’s repos." action={add || undefined} />}
      {deliverable.length ? (
        may && <div className="env-look"><span>Asks GitHub what it has deployed from each repo. It can take a minute.</span><LookButton className="button small" /></div>
      ) : (
        <p className="env-none">Environments belong to the repos this binder works in. Add one in <a href={sectionHref('github')}>GitHub</a> first.</p>
      )}
      <AnimatePresence>
        {opened && (() => {
          const list = repoEnvironments(state, opened.repo ?? '')
          const at = list.findIndex((e) => e.id === opened.id)
          return <EnvironmentDialog key={open} env={opened} at={at} last={list.length - 1} may={may} shown={(field) => shown(`${keyOf(opened.id)}-${field}`)} change={(fields) => change(opened, fields)}
            onRemove={() => { setOpen(undefined); void attempt(() => store.removeEnvironment(opened.id)) }} onClose={() => setOpen(undefined)} />
        })()}
        {adding && <AddEnvironment key="add" onAdded={() => setAdding(false)} onClose={() => setAdding(false)} />}
      </AnimatePresence>
    </Section>
  )
}

/** One environment: its name, where it's served, how the hub deploys to it; its place and its removal in a menu. */
function EnvironmentDialog({ env, at, last, may, shown, change, onRemove, onClose }: { env: Environment; at: number; last: number; may: boolean; shown: (field: string) => boolean; change: (fields: EnvironmentChange) => Promise<boolean>; onRemove: () => void; onClose: () => void }) {
  const [menu, setMenu] = useState(false)
  const move = (to: number) => {
    if (to >= 0 && to <= last) void change({ order: to })
  }
  return (
    <Dialog title={env.name} onClose={onClose} footer={(
      <>
        {may && (
          // Its place and its removal, in a menu: rare, and the removal asks first.
          <button type="button" className="button dialog-foot-start" aria-haspopup="menu" aria-expanded={menu}
            onClick={(event) => { if (openMenuUnder(event, [
              { label: `Move ${env.name} up`, icon: <ArrowUp size={14} />, disabled: at <= 0, onSelect: () => move(at - 1) },
              { label: `Move ${env.name} down`, icon: <ArrowDown size={14} />, disabled: at >= last, onSelect: () => move(at + 1) },
              { separator: true },
              { label: `Remove ${env.name}`, icon: <Trash2 size={14} />, danger: true, confirm: `Remove ${env.name}? Press again`, onSelect: onRemove },
            ], { onClose: () => setMenu(false) })) setMenu(true) }}>
            Move or remove<ChevronDown size={14} aria-hidden="true" />
          </button>
        )}
        <button type="button" className="button primary" onClick={onClose}>Done</button>
      </>
    )}>
      <div className="env-dialog">
        <p className="env-dialog-what">{env.repo} · {env.version ? <>on it: <span className="mono">{env.version}</span></> : 'nothing deployed yet'}{last > 0 ? ` · ${ordinal(at)} of ${last + 1}` : ''}</p>
        <Changeable may={may}>
          <SaveText label="Name" value={env.name} saved={shown('name')} onSave={(next) => (next ? change({ name: next }) : false)} />
          <SaveText label="Where it’s served" value={env.url} placeholder="https://" saved={shown('url')} onSave={(next) => change({ url: next })} />
          <DeployFrom env={env} saved={shown('deploy')} change={change} />
        </Changeable>
      </div>
    </Dialog>
  )
}

const ordinal = (n: number) => ['First', 'Second', 'Third', 'Fourth', 'Fifth'][n] ?? `Number ${n + 1}`

/** A text box that keeps what's typed when it's left, and goes back to what it was if the hub says no. */
function SaveText({ label, value, placeholder, saved, onSave }: { label: string; value: string; placeholder?: string; saved: boolean; onSave: (next: string) => Promise<boolean> | boolean }) {
  return (
    <label className="field">
      <span className="field-head"><span className="field-label">{label}</span><Saved show={saved} /></span>
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
function DeployFrom({ env, saved, change }: { env: Environment; saved: boolean; change: (fields: EnvironmentChange) => Promise<boolean> }) {
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
    <div className="env-deploy" role="group" aria-labelledby={`env-deploy-${env.id.replace(/[^\w-]/g, '-')}`}>
      <span className="field-head"><span className="env-deploy-title" id={`env-deploy-${env.id.replace(/[^\w-]/g, '-')}`}>Deploy from the hub</span><Saved show={saved} /></span>
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
        <p className="field-hint">The hub deploys to it with {env.deploy.workflow} on {env.deploy.ref} when someone presses Promote on Delivery. Empty both boxes to stop the hub deploying to it.</p>
      ) : (
        <p className="field-hint">Give both, and when someone presses Promote the hub runs the workflow with the version on the environment before this one. Left empty, the hub only shows what GitHub deploys.</p>
      )}
    </div>
  )
}

/** One more environment, for a repo this binder works in, which is the only kind GitHub's deployments are followed for. */
function AddEnvironment({ onAdded, onClose }: { onAdded: () => void; onClose: () => void }) {
  const store = useStore()
  const repos = deliveryRepos(store.state)
  const [repo, setRepo] = useState('')
  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  const [adding, setAdding] = useState(false)
  const chosen = repos.find((r) => sameRepo(r, repo)) ?? repos[0]
  const add = async (event: FormEvent) => {
    event.preventDefault()
    if (!name.trim() || adding || !chosen) return
    setAdding(true)
    const made = await attempt(() => store.addEnvironment({ repo: chosen, name: name.trim(), ...(url.trim() ? { url: url.trim() } : {}) }))
    setAdding(false)
    if (!made) return
    toast(`Added ${name.trim()} to ${chosen}.`)
    onAdded()
  }
  return (
    <Dialog title="Add an environment" onClose={onClose} footer={<button type="submit" form="env-add" className="button primary" disabled={!name.trim() || adding}>Add environment</button>}>
      <form id="env-add" className="form env-add" onSubmit={(event) => void add(event)}>
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
      </form>
    </Dialog>
  )
}
