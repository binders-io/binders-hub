import { useEffect, useState } from 'react'
import { ArrowUpRight } from 'lucide-react'
import { call } from '../../data/api'
import { useStore } from '../../data/store'
import { GitHubSetup } from '../../components/GitHubSetup'
import { PersonalGitHub } from '../../components/PersonalGitHub'
import { isPersonal } from '../../components/PersonalRepo'
import { RepoBriefs } from '../../components/RepoBriefs'
import { RepoInput } from '../../components/RepoInput'
import { Changeable, Saved, Status, WhoCan } from './shared'
import { useBinderAccess, useSaved } from './access'

/**
 * This binder's GitHub: the repo its cards and notes go to first, then the app that reaches GitHub, the repos its agents
 * work in, and each repo's brief. The repos are its owners' and admins' to change.
 */
export function GitHub() {
  const { may, managers } = useBinderAccess()
  return (
    <>
      <WhoCan may={may} managers={managers} />
      <Changeable may={may}><RepoPicks /></Changeable>
      {isPersonal ? <PersonalGitHub /> : <GitHubApp />}
      <Changeable may={may}><AgentRepos /></Changeable>
      <Briefs />
    </>
  )
}

/** The repo each of the binder's notebooks sends its cards and notes to. */
function RepoPicks() {
  const store = useStore()
  const { state } = store
  const { saved, shown } = useSaved()
  if (!state.binders.length) return null
  const several = state.binders.length > 1
  return (
    <section className="settings-part">
      <h3 className="settings-sub">Where its cards and notes go</h3>
      <ul className="binder-cards">
        {state.binders.map((binder) => (
          <li key={binder.id} className="settings-card">
            <div className="field">
              <div className="field-head"><label className="field-label" htmlFor={`binder-repo-${binder.id}`}>{several ? `${binder.name}: GitHub repo` : 'GitHub repo'}</label><Saved show={shown(binder.id)} /></div>
              <RepoInput id={`binder-repo-${binder.id}`} single value={binder.repo ? [binder.repo] : []} placeholder="Pick the repo its cards go to…" onChange={(repos) => { store.updateBinder(binder.id, { repo: repos[0] ?? '' }); saved(binder.id) }} />
            </div>
            <p className="field-hint">
              {binder.repos?.length ? `Its agents work in ${binder.repos.length} repo${binder.repos.length === 1 ? '' : 's'}, chosen below.` : 'Its agents work in any repo the app reaches.'}
            </p>
          </li>
        ))}
      </ul>
    </section>
  )
}

function GitHubApp() {
  const me = useStore().state.me
  return (
    <>
      <GitHubSetup />
      {me?.github.server && <ul className="status-list">
        <Status ok={!!me.github.polling?.webhookHeard || !!me.github.polling?.active} label="GitHub’s news" detail={me.github.polling?.webhookHeard ? 'Webhooks arrive as things happen on GitHub.' : me.github.polling?.active ? `Asked for every ${me.github.polling.everySeconds} seconds, as webhooks don’t reach this hub.` : 'Neither webhooks nor asking, as HUB_POLL is off on this hub.'} />
      </ul>}
    </>
  )
}

/**
 * The repos a binder's agents work in, found by name, topic or custom property, and every match of a filter added at
 * once; with what the app reaches on each account, as the hub has read it from GitHub.
 */
function AgentRepos() {
  const store = useStore()
  const { state } = store
  const { saved, shown } = useSaved()
  if (!state.binders.length) return null
  const several = state.binders.length > 1
  return (
    <section className="settings-part">
      <h3 className="settings-sub">Repos its agents work in</h3>
      <p className="settings-part-detail">Agents in this binder work only in these, and each picks among them on the Agents page. None: any repo the app reaches. Filter by topic or custom property to add every match at once.</p>
      {state.binders.map((binder) => (
        <div key={binder.id} className="agent-repos">
          <div className="field-head"><label className="field-label" htmlFor={`binder-repos-${binder.id}`}>{several ? binder.name : 'Repos'}</label><Saved show={shown(binder.id)} /></div>
          <RepoInput id={`binder-repos-${binder.id}`} value={binder.repos ?? []} placeholder="Add repos… (none: any repo)" onChange={(repos) => { store.updateBinder(binder.id, { repos }); saved(binder.id) }} />
        </div>
      ))}
      <RepoLists />
    </section>
  )
}

interface RepoList {
  account: string
  kind?: 'User' | 'Organization'
  indexed: number
  total?: number
  complete: boolean
  reading: boolean
  failed: boolean
  properties?: 'listed' | 'organization' | 'denied' | 'failed' | 'none'
}

/** What the app reaches on each account it's installed on, as the hub has read it, and its repos' custom properties. */
function RepoLists() {
  const [lists, setLists] = useState<{ installations: RepoList[]; permissionsUrl?: string }>()
  useEffect(() => {
    let current = true
    const read = () => void call<{ installations?: RepoList[]; permissionsUrl?: string }>('GET', '/api/github/lists').then((found) => {
      if (!current || !Array.isArray(found?.installations)) return
      setLists({ installations: found.installations, permissionsUrl: found.permissionsUrl })
      // While a list is being read, how far it's got, every few seconds.
      if (found.installations.some((i) => !i.complete && !i.failed)) window.setTimeout(read, 4000)
    }, () => {})
    read()
    return () => { current = false }
  }, [])
  if (!lists?.installations.length) return null
  const count = (n: number) => n.toLocaleString()
  return (
    <ul className="repo-lists">
      {lists.installations.map((list) => (
        <li key={list.account}>
          <b>@{list.account}</b>{' '}
          {list.complete
            ? `${count(list.indexed)} repo${list.indexed === 1 ? '' : 's'} the app reaches${list.properties === 'listed' || list.properties === 'organization' ? ', with their topics and custom properties' : ', with their topics'}.`
            : list.failed
              ? `GitHub didn’t answer while its repos were read${list.indexed ? `, after ${count(list.indexed)}` : ''}. The hub tries again in a few minutes.`
              : `Reading its repos from GitHub: ${count(list.indexed)}${list.total ? ` of ${count(list.total)}` : ''} so far.`}
          {list.complete && list.kind !== 'User' && list.properties === 'denied' && (
            <span className="field-hint">
              GitHub didn’t give the app @{list.account}’s custom properties, if it uses any. To filter by them, the app needs Custom properties (read) under Organization permissions{lists.permissionsUrl ? <>: <a href={lists.permissionsUrl} target="_blank" rel="noreferrer">its permissions on GitHub <ArrowUpRight size={11} /></a></> : ''}. @{list.account} then accepts it, and the hub reads them within six hours.
            </span>
          )}
        </li>
      ))}
    </ul>
  )
}

/** Each repo's brief, under GitHub as they're about its repos. */
function Briefs() {
  return (
    <section className="settings-part">
      <h3 className="settings-sub">Repo briefs</h3>
      <p className="settings-part-detail">What agents are told about each repo before they work or review there. An agent writes it the first time one works in the repo, and again as the repo moves on. Each is a note in Repo docs, and agents also get any other notes you put in a repo’s folder there.</p>
      <RepoBriefs />
    </section>
  )
}
