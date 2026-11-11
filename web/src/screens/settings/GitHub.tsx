import { useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence } from 'motion/react'
import { ArrowUpRight, FileText, FolderGit2, Globe, Lock, Plus, Search, SlidersHorizontal, Tag, Trash2 } from 'lucide-react'
import { sameRepo } from '../../../../shared/work.ts'
import { call } from '../../data/api'
import type { Binder } from '../../data/model'
import { useStore } from '../../data/store'
import { GitHubSetup } from '../../components/GitHubSetup'
import { PersonalGitHub } from '../../components/PersonalGitHub'
import { isPersonal } from '../../components/PersonalRepo'
import { briefState, RepoBrief, reposOf, type BriefState } from '../../components/RepoBriefs'
import { leftOut, RepoInput } from '../../components/RepoInput'
import { ConfirmButton } from '../../components/ConfirmButton'
import { ago } from '../../components/bits'
import { attempt, failure, toast } from '../../components/Toast'
import { DataTable, Dialog, EmptyState, Guided, MenuButton, Section, Status, type Column, type GuidedOption, type GuidedStep } from '../../kit'
import { Changeable, Saved, WhoCan } from './shared'
import { useBinderAccess, useSaved } from './access'

/**
 * This binder's GitHub: how it's connected (or the guided setup, while there's something still to do), then its repos as
 * a table: the one its cards and notes go to, the ones its agents work in, and each one's brief. A repo opens to change
 * what it's for, read and write its brief, or take it off; Add repos is one button, by name, topic or custom property.
 * The repos are its owners' and admins' to change.
 */
export function GitHub() {
  const { may, managers } = useBinderAccess()
  return (
    <div className="gh-sections">
      <WhoCan may={may} managers={managers} />
      {isPersonal ? <PersonalGitHub /> : <GitHubSetup />}
      <Repos may={may} />
    </div>
  )
}

/** What GitHub says of a repo the app reaches: enough for its icon and its dialog's first line. */
interface RepoInfo { private: boolean; description?: string }
interface Found {
  repos?: ({ fullName: string } & RepoInfo)[]
  topics?: { name: string; count: number }[]
  properties?: { name: string; values: { value: string; count: number }[] }[]
}

/** The most repos added together, as the hub checks each with GitHub first. */
const mostTogether = 200
/** The most repos asked about one by one for their icons, beyond the first list: about a page of the table. */
const lookUpMost = 25

interface RepoRow {
  repo: string
  key: string
  /** The binders whose cards and notes go to it. */
  cards: Binder[]
  /** The binders whose agents were given it among their repos. */
  chosen: Binder[]
  used: string
  stands: BriefState
}

const anyRepo = (binder: Binder) => !binder.repos?.length

/** What a repo is used for, in a few words: by each binder when there are several. */
function usedFor(binders: Binder[], repo: string) {
  const uses = (b: Binder) => {
    const cards = !!b.repo && sameRepo(b.repo, repo)
    const agents = anyRepo(b) || !!b.repos?.some((r) => sameRepo(r, repo))
    return cards && agents ? 'cards, notes, agents' : cards ? 'cards and notes' : agents ? 'agents' : ''
  }
  const capital = (words: string) => words.charAt(0).toUpperCase() + words.slice(1)
  if (binders.length === 1) return capital(uses(binders[0]) || 'not chosen')
  const each = binders.map((b) => [b.name, uses(b)] as const).filter(([, words]) => words)
  return each.length ? each.map(([name, words]) => `${name}: ${words}`).join(' · ') : 'Not chosen'
}

/** A lock for a private repo, a globe for a public one, and a plain repo while GitHub hasn't said. */
function RepoIcon({ info, size = 15 }: { info?: RepoInfo; size?: number }) {
  if (!info) return <FolderGit2 size={size} className="repo-icon" aria-hidden="true" />
  return info.private ? <Lock size={size} className="repo-icon" aria-hidden="true" /> : <Globe size={size} className="repo-icon" aria-hidden="true" />
}

/** The repos the app reaches, as GitHub lists them first, and those asked about by name after, for their icons. */
function useRepoInfo(names: string[]) {
  const [found, setFound] = useState<Found>()
  const [info, setInfo] = useState<Record<string, RepoInfo>>({})
  const [asked] = useState(() => new Set<string>())
  const live = useRef(true)
  useEffect(() => {
    live.current = true
    void call<Found>('GET', '/api/github/repos?q=').then((answer) => {
      if (!live.current) return
      const repos = Array.isArray(answer?.repos) ? answer.repos : []
      setFound({ repos, topics: Array.isArray(answer?.topics) ? answer.topics : [], properties: Array.isArray(answer?.properties) ? answer.properties : [] })
      setInfo((was) => ({ ...was, ...Object.fromEntries(repos.map((r) => [r.fullName.toLowerCase(), { private: !!r.private, description: r.description }])) }))
    }, () => { if (live.current) setFound({ repos: [], topics: [], properties: [] }) })
    return () => { live.current = false }
  }, [])
  // A big organization lists more than the first answer has: the first page's others are asked about by name, a few at
  // a time, each once. What's asked keeps going as the answers come, whatever else is drawn meanwhile.
  const unknown = found ? names.filter((n) => !info[n.toLowerCase()] && !asked.has(n.toLowerCase())).slice(0, lookUpMost) : []
  const key = unknown.join(',')
  useEffect(() => {
    if (!key) return
    const queue = key.split(',')
    for (const name of queue) asked.add(name.toLowerCase())
    const next = async (): Promise<void> => {
      const name = queue.shift()
      if (!name || !live.current) return
      const answer = await call<Found>('GET', `/api/github/repos?q=${encodeURIComponent(name)}`).catch(() => undefined)
      const match = Array.isArray(answer?.repos) ? answer.repos.find((r) => sameRepo(r.fullName, name)) : undefined
      if (match && live.current) setInfo((was) => ({ ...was, [name.toLowerCase()]: { private: !!match.private, description: match.description } }))
      return next()
    }
    void Promise.all([next(), next(), next()])
  }, [key, asked])
  return { found, info }
}

/** The repos as a table that pages, each opening to change it; Add repos above it. */
function Repos({ may }: { may: boolean }) {
  const store = useStore()
  const { state } = store
  const binders = state.binders
  const [open, setOpen] = useState<string>()
  const [adding, setAdding] = useState(false)
  const rows = useMemo<RepoRow[]>(() => reposOf(state).map((repo) => ({
    repo,
    key: repo.toLowerCase(),
    cards: binders.filter((b) => !!b.repo && sameRepo(b.repo, repo)),
    chosen: binders.filter((b) => !!b.repos?.some((r) => sameRepo(r, repo))),
    used: usedFor(binders, repo),
    stands: briefState(state, repo),
  // Where the cards and notes go first, then the rest by name.
  })).sort((a, b) => Number(!!b.cards.length) - Number(!!a.cards.length) || a.repo.localeCompare(b.repo)), [state, binders])
  const { found, info } = useRepoInfo(rows.map((r) => r.repo))
  if (!binders.length) return null

  const any = binders.every(anyRepo)
  const chosen = new Set(binders.flatMap((b) => b.repos ?? []).map((r) => r.toLowerCase())).size
  const lead = any
    ? 'None are chosen for agents, so they work in any repo the app reaches.'
    : `Agents work only in the ${chosen === 1 ? 'one' : chosen.toLocaleString()} chosen here${binders.some(anyRepo) ? ', in the binders that chose some' : ''}.`
  const add = <button type="button" className="button small" onClick={() => setAdding(true)}><Plus size={14} aria-hidden="true" />Add repos</button>
  // Taking every chosen repo off at once, for a list that grew by topic or property: agents then work in any repo again.
  const clear = binders.some((b) => b.repos?.length) && (
    <MenuButton label="More for the repos" items={[{
      label: 'Take every repo off the agents’ list', icon: <Trash2 size={14} />, danger: true, confirm: 'Take them all off? Press again',
      onSelect: () => {
        for (const b of binders) if (b.repos?.length) store.updateBinder(b.id, { repos: [] })
        toast('Agents work in any repo the app reaches again.')
      },
    }]} />
  )

  const columns: Column<RepoRow>[] = [
    { key: 'repo', header: 'Repo', width: '40%', phone: 'title', cell: (r) => <span className="repo-cell"><RepoIcon info={info[r.key]} /><span className="repo-cell-name">{r.repo}</span></span>, text: (r) => r.repo },
    { key: 'used', header: 'Used for', cell: (r) => <span className={r.used === 'Not chosen' ? 'faint' : undefined}>{r.used}</span>, text: (r) => r.used },
    { key: 'brief', header: 'Its brief', width: '19%', cell: (r) => <Status tone={r.stands.tone}>{r.stands.word}</Status>, text: (r) => `${r.stands.word} brief` },
    { key: 'when', header: 'Written', width: '96px', align: 'end', phone: 'hidden', cell: (r) => (r.stands.word === 'Written' && r.stands.brief?.writtenAt ? short(r.stands.brief.writtenAt) : '') },
  ]

  return (
    <Section title="Repos" lead={lead} action={may && rows.length ? <>{add}{clear}</> : undefined}
      more={(
        <>
          <p>Its cards and notes go to one repo: its notes are pushed there on a branch of their own, and its cards kept as issues (How work flows has both). Its agents work in the repos chosen here, or in any the app reaches while none are; each agent can be kept to some of them on the Agents page.</p>
          <p>A repo’s brief is what agents are told about it before they work or review there. An agent writes it the first time one works in the repo, and again as the repo moves on. Each is a note in Repo docs, and agents also get any other notes you put in a repo’s folder there.</p>
        </>
      )}>
      <DataTable label="Repos" columns={columns} rows={rows} rowKey={(r) => r.key} onRowPress={(r) => setOpen(r.repo)} rowLabel={(r) => `Open ${r.repo}`}
        filter={rows.length > 8 ? 'Filter repos' : undefined} pageSize={25}
        empty={<EmptyState compact icon={<FolderGit2 size={18} />} title="No repos yet" line="Add the repo its cards and notes go to, and any its agents work in." action={may ? add : undefined} />} />
      <AnimatePresence>
        {open && <RepoDialog key="repo" repo={open} info={info[open.toLowerCase()]} may={may} onClose={() => setOpen(undefined)} />}
        {adding && <AddRepos key="add" found={found} onClose={() => setAdding(false)} />}
      </AnimatePresence>
    </Section>
  )
}

/** "3h", "2d", "Nov 1": short enough for a table's end column. */
function short(iso: string) {
  const said = ago(iso)
  const days = Math.floor((Date.now() - Date.parse(iso)) / 86_400_000)
  return said === 'now' ? 'Just now' : /^\d+[smh]$/.test(said) ? `${said} ago` : days < 7 ? `${days}d ago` : said
}

/**
 * One repo: what it is, what it's for in each binder (two switches that save at once), its brief, and taking it off. A
 * member reads it all, and can have its brief written and add to what agents learned, as anyone here can.
 */
function RepoDialog({ repo, info, may, onClose }: { repo: string; info?: RepoInfo; may: boolean; onClose: () => void }) {
  const store = useStore()
  const binders = store.state.binders
  const { saved, shown } = useSaved()
  const several = binders.length > 1
  const inUse = binders.some((b) => (b.repo && sameRepo(b.repo, repo)) || b.repos?.some((r) => sameRepo(r, repo)))
  const setCards = (binder: Binder, on: boolean) => {
    store.updateBinder(binder.id, { repo: on ? repo : '' })
    saved(`${binder.id}-cards`)
  }
  const setAgents = (binder: Binder, on: boolean) => {
    const rest = (binder.repos ?? []).filter((r) => !sameRepo(r, repo))
    store.updateBinder(binder.id, { repos: on ? [...rest, repo] : rest })
    saved(`${binder.id}-agents`)
  }
  const remove = () => {
    for (const binder of binders) {
      const cards = !!binder.repo && sameRepo(binder.repo, repo)
      const agents = !!binder.repos?.some((r) => sameRepo(r, repo))
      if (cards || agents) store.updateBinder(binder.id, { ...(cards ? { repo: '' } : {}), ...(agents ? { repos: binder.repos!.filter((r) => !sameRepo(r, repo)) } : {}) })
    }
    toast(`${repo} is off this binder.`)
    onClose()
  }
  const id = repo.toLowerCase().replace(/[^a-z0-9]+/g, '-')
  return (
    <Dialog title={repo} onClose={onClose} footer={(
      <>
        {may && inUse && <ConfirmButton className="button danger dialog-foot-start" question="Take it off? Press again" detail="Its brief and notes stay; agents stop working in it here." onConfirm={remove}>Remove</ConfirmButton>}
        <button type="button" className="button primary" onClick={onClose}>Done</button>
      </>
    )}>
      <div className="repo-dialog">
        <p className="repo-dialog-what">
          <RepoIcon info={info} size={14} />
          <span>{info ? (info.private ? 'Private' : 'Public') : 'A repo'}{info?.description ? ` · ${info.description}` : ''}</span>
          <a href={`https://github.com/${repo}`} target="_blank" rel="noreferrer">On GitHub<ArrowUpRight size={12} aria-hidden="true" /></a>
        </p>
        <section className="repo-dialog-part" aria-labelledby={`${id}-for`}>
          <h3 className="repo-dialog-title" id={`${id}-for`}>What it’s for</h3>
          <Changeable may={may}>
            {binders.map((binder) => {
              const cards = !!binder.repo && sameRepo(binder.repo, repo)
              const agents = !!binder.repos?.some((r) => sameRepo(r, repo))
              return (
                <div key={binder.id} className="repo-uses">
                  {several && <b className="repo-uses-binder">{binder.name}</b>}
                  <div className="repo-use">
                    <div className="repo-use-head">
                      <label className="switch"><input id={`${id}-${binder.id}-cards`} type="checkbox" checked={cards} onChange={(e) => setCards(binder, e.target.checked)} /><span aria-hidden="true" />Its cards and notes go here</label>
                      <Saved show={shown(`${binder.id}-cards`)} />
                    </div>
                    <p className="field-hint">{cards ? 'Its notes are pushed here, and its cards kept as issues.' : binder.repo ? `They go to ${binder.repo} now: one repo at a time, so this would take its place.` : 'They go nowhere yet: one repo takes them.'}</p>
                  </div>
                  <div className="repo-use">
                    <div className="repo-use-head">
                      <label className="switch"><input id={`${id}-${binder.id}-agents`} type="checkbox" checked={agents} onChange={(e) => setAgents(binder, e.target.checked)} /><span aria-hidden="true" />Chosen for its agents</label>
                      <Saved show={shown(`${binder.id}-agents`)} />
                    </div>
                    <p className="field-hint">{anyRepo(binder) ? 'None are chosen, so agents work in any repo the app reaches. Choosing this one keeps them to the chosen ones.' : agents ? 'Agents work here, and in the other chosen repos only.' : 'Agents don’t work here: they keep to the chosen repos.'}</p>
                  </div>
                </div>
              )
            })}
          </Changeable>
        </section>
        <section className="repo-dialog-part" aria-labelledby={`${id}-brief`}>
          <h3 className="repo-dialog-title" id={`${id}-brief`}>Its brief</h3>
          <RepoBrief repo={repo} />
        </section>
      </div>
    </Dialog>
  )
}

type AddWay = 'name' | 'topic' | 'property' | 'cards'

/**
 * Add repos, guided: by name, every repo with a topic, every repo with a custom property, or the one its cards and
 * notes go to. Those found by topic or property are checked with GitHub before they're added, as saving checks them,
 * so one that can't be linked is left out with why rather than refusing the rest.
 */
function AddRepos({ found, onClose }: { found?: Found; onClose: () => void }) {
  const store = useStore()
  const binders = store.state.binders
  const [binderId, setBinderId] = useState(binders[0]?.id)
  const binder = binders.find((b) => b.id === binderId) ?? binders[0]
  const { saved, shown } = useSaved()
  const [picks, setPicks] = useState<string[]>([])
  const [topic, setTopic] = useState('')
  const [property, setProperty] = useState('')
  const [matches, setMatches] = useState<{ names: string[]; total: number; for: string }>()
  const [busy, setBusy] = useState(false)
  const topics = found?.topics ?? []
  const properties = found?.properties ?? []
  const has = (name: string) => [binder?.repo, ...(binder?.repos ?? [])].some((r) => !!r && sameRepo(r, name))

  // Every match of the topic or property picked, by name, to add them together.
  const asking = useMemo(() => {
    if (topic) return new URLSearchParams({ q: '', topic, all: '1' }).toString()
    if (property) {
      const [name, value] = JSON.parse(property) as [string, string]
      return new URLSearchParams({ q: '', property: name, value, all: '1' }).toString()
    }
    return ''
  }, [topic, property])
  useEffect(() => {
    if (!asking) return
    let current = true
    void call<{ names: string[]; total: number }>('GET', `/api/github/repos?${asking}`).then((all) => {
      if (current && Array.isArray(all?.names)) setMatches({ names: all.names, total: all.total ?? all.names.length, for: asking })
    }, () => {})
    return () => { current = false }
  }, [asking])
  const shownMatches = matches?.for === asking ? matches : undefined
  const fresh = shownMatches?.names.filter((n) => !has(n)) ?? []
  const tooMany = (shownMatches?.total ?? 0) > mostTogether
  const already = (shownMatches?.names.length ?? 0) - fresh.length

  const addPicked = () => {
    if (!binder) return
    const adding = picks.filter((p) => !has(p))
    if (adding.length) store.updateBinder(binder.id, { repos: [...(binder.repos ?? []), ...adding] })
    toast(adding.length === 1 ? `Added ${adding[0]}.` : `Added ${adding.length} repos.`)
    onClose()
  }
  const addMatches = async () => {
    if (!binder) return
    setBusy(true)
    const checked = await attempt(() => call<{ ok: string[]; refused: { repo: string; why: string }[] }>('POST', '/api/github/repos/check', { repos: fresh }))
    setBusy(false)
    if (!checked) return
    const ok = checked.ok.filter((n) => !has(n))
    if (ok.length) store.updateBinder(binder.id, { repos: [...(binder.repos ?? []), ...ok] })
    if (checked.refused.length) failure(leftOut(ok.length, checked.refused))
    else toast(`Added ${ok.length} repo${ok.length === 1 ? '' : 's'}.`)
    onClose()
  }

  const forBinder = binders.length > 1 && (
    <label className="field">
      <span className="field-label">For the binder</span>
      <select id="add-repos-binder" value={binder?.id} onChange={(e) => setBinderId(e.target.value)}>
        {binders.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
      </select>
    </label>
  )
  const noneChosen = binder && anyRepo(binder) ? 'Once some are chosen, agents work only in those, not in any repo the app reaches.' : undefined
  const matchList = (what: string) => shownMatches && (
    <div className="repo-matches" aria-live="polite">
      <p className="repo-matches-count">
        {shownMatches.total === 0 ? `No repos ${what}.`
          : tooMany ? `${shownMatches.total.toLocaleString()} repos ${what}: narrow them to ${mostTogether} to add them together.`
            : fresh.length ? `${fresh.length.toLocaleString()} ${fresh.length === 1 ? 'repo' : 'repos'} ${what} ${fresh.length === 1 ? 'isn’t' : 'aren’t'} chosen yet${already ? `; ${already.toLocaleString()} ${already === 1 ? 'is' : 'are'} already` : ''}.`
              : `Every repo ${what} is chosen already.`}
      </p>
      {!tooMany && fresh.length > 0 && (
        <ul className="repo-match-list">
          {fresh.slice(0, 12).map((name) => <li key={name} className="tag mono">{name}</li>)}
          {fresh.length > 12 && <li className="faint">and {(fresh.length - 12).toLocaleString()} more</li>}
        </ul>
      )}
    </div>
  )
  const addAll = <button type="button" className="button primary" disabled={busy || tooMany || !fresh.length} onClick={() => void addMatches()}>{busy ? `Checking ${fresh.length} with GitHub…` : fresh.length ? `Add all ${fresh.length.toLocaleString()}` : 'Add them'}</button>

  const options: GuidedOption[] = [
    { id: 'name', icon: <Search size={18} />, name: 'By name', line: 'Pick them one at a time, as you type.', recommended: !!binder?.repo },
    { id: 'topic', icon: <Tag size={18} />, name: 'Every repo with a topic', line: topics.length ? 'All the repos GitHub tags with one, together.' : 'None of the repos the app reaches has a topic.', disabled: !topics.length },
    { id: 'property', icon: <SlidersHorizontal size={18} />, name: 'Every repo with a custom property', line: properties.length ? 'An organization’s own labels, such as a team.' : 'None of the repos the app reaches has one.', disabled: !properties.length },
    { id: 'cards', icon: <FileText size={18} />, name: 'The repo its cards and notes go to', line: binder?.repo ? `${binder.repo} now. Pick another.` : 'Its notes are pushed there, and its cards kept as issues.', recommended: !binder?.repo },
  ]
  const steps = (way: string): GuidedStep[] => {
    switch (way as AddWay) {
      case 'topic':
        return [{
          title: 'Which topic?', lead: noneChosen,
          content: (
            <div className="form repo-add">
              {forBinder}
              <label className="field">
                <span className="field-label">Topic</span>
                <select id="add-repos-topic" value={topic} onChange={(e) => { setTopic(e.target.value); setProperty('') }}>
                  <option value="">Pick a topic…</option>
                  {topics.map((t) => <option key={t.name} value={t.name}>{t.name} ({t.count})</option>)}
                </select>
              </label>
              {topic && matchList(`with the topic ${topic}`)}
            </div>
          ),
          footer: addAll,
        }]
      case 'property':
        return [{
          title: 'Which custom property?', lead: noneChosen,
          content: (
            <div className="form repo-add">
              {forBinder}
              <label className="field">
                <span className="field-label">Custom property</span>
                <select id="add-repos-property" value={property} onChange={(e) => { setProperty(e.target.value); setTopic('') }}>
                  <option value="">Pick a property…</option>
                  {/* Named in each choice, not grouped under it: a closed select shows only the value, and 1 says nothing alone. */}
                  {properties.flatMap((p) => p.values.map((v) => {
                    const choice = JSON.stringify([p.name, v.value])
                    return <option key={choice} value={choice}>{p.name}: {v.value} ({v.count})</option>
                  }))}
                </select>
              </label>
              {property && matchList(`with ${(JSON.parse(property) as string[]).join(': ')}`)}
            </div>
          ),
          footer: addAll,
        }]
      case 'cards':
        return [{
          title: 'Where do its cards and notes go?', lead: 'One repo at a time: its notes are pushed there on a branch of their own, and its cards kept as issues.',
          content: (
            <div className="form repo-add repo-add-pick">
              {forBinder}
              <div className="field">
                <div className="field-head"><label className="field-label" htmlFor={`add-cards-repo-${binder?.id}`}>GitHub repo</label><Saved show={shown('cards')} /></div>
                {binder && <RepoInput key={binder.id} id={`add-cards-repo-${binder.id}`} single value={binder.repo ? [binder.repo] : []} placeholder="Pick the repo its cards go to…" onChange={(repos) => { store.updateBinder(binder.id, { repo: repos[0] ?? '' }); saved('cards') }} />}
              </div>
            </div>
          ),
          footer: (nav) => <button type="button" className="button primary" onClick={nav.close}>Done</button>,
        }]
      default:
        return [{
          title: 'Which repos?', lead: noneChosen,
          content: (
            <div className="form repo-add repo-add-pick">
              {forBinder}
              <div className="field">
                <label className="field-label" htmlFor="add-repos-name">Repos for its agents</label>
                <RepoInput id="add-repos-name" value={picks} filters={false} placeholder="Type a repo’s name…" onChange={setPicks} />
              </div>
            </div>
          ),
          footer: <button type="button" className="button primary" disabled={!picks.length} onClick={addPicked}>{picks.length > 1 ? `Add ${picks.length} repos` : 'Add it'}</button>,
        }]
    }
  }
  return <Guided title="Add repos" question="How do you want to add them?" options={options} steps={steps} onClose={onClose} />
}
