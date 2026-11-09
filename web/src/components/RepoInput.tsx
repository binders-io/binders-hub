import { useEffect, useRef, useState } from 'react'
import { Lock, Plus, X } from 'lucide-react'
import { attempt, toast } from './Toast'
import { call } from '../data/api'
import { useStore } from '../data/store'

interface Repo {
  fullName: string
  private: boolean
  description?: string
  /** Whether it can be linked here. Unset, GitHub says so on linking. */
  linkable?: boolean
  /** Why it can't be. */
  why?: string
}

interface Found {
  repos: Repo[]
  /** How many more match than were sent. */
  more?: number
  topics?: { name: string; count: number }[]
  properties?: { name: string; values: { value: string; count: number }[] }[]
  /** GitHub didn't give them all. */
  failed?: boolean
  /** While the hub is still reading an organization's repos from GitHub: how far it's got. */
  reading?: { indexed: number; total?: number }
}

/** The most chips shown before the rest fold away. */
const foldAt = 12
/** The most repos added together, as the hub checks each with GitHub first. */
const mostTogether = 200

/** What adding them together did: how many it added, and which it left out and why, a few named. */
export function leftOut(added: number, refused: { repo: string; why: string }[]) {
  const named = refused.slice(0, 3).map((r) => r.repo).join(', ') + (refused.length > 3 ? ` and ${refused.length - 3} more` : '')
  const whys = [...new Set(refused.map((r) => r.why))]
  const why = whys.length > 1 ? 'GitHub said no to each' : refused.length > 1 ? whys[0].replace(/\bit\b/, 'them') : whys[0]
  return `Added ${added}. Left out ${named}: ${why}.`
}

/**
 * GitHub repos as chips, picked from the ones the GitHub App reaches, by what's typed or by their topics and custom
 * properties. `single` keeps one, for a binder's cards; a binder's agents and each agent keep several, and can take every
 * match of a filter at once. `within`, when given, is all there is to pick from (an agent picks among its `binders`'
 * repos), and nothing else can be added. A name GitHub doesn't list can otherwise still be typed in and added with Enter.
 */
export function RepoInput({ id, value, single = false, placeholder, within, binders, onChange }: {
  id: string
  value: string[]
  single?: boolean
  placeholder?: string
  within?: string[]
  binders?: string[]
  onChange: (repos: string[]) => void
}) {
  // Where this binder's GitHub App's repos are changed, for the line that says only those can be linked.
  const installUrl = useStore().state.me?.github.app?.installUrl
  const box = useRef<HTMLDivElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const [typed, setTyped] = useState('')
  const [open, setOpen] = useState(false)
  const [topic, setTopic] = useState('')
  const [property, setProperty] = useState<{ name: string; value: string }>()
  const [found, setFound] = useState<Found>()
  // What the shown suggestions were asked with: Enter only picks from them when that's what's being asked now.
  const [foundFor, setFoundFor] = useState<string>()
  // Every match of a filter, by name, for adding them together; and while they're checked with GitHub.
  const [matches, setMatches] = useState<{ names: string[]; total: number; for: string }>()
  const [adding, setAdding] = useState(false)
  const [tries, setTries] = useState(0)
  // The tries already asked for: Try again has the hub read a failed list now, for the next answer only.
  const triesAsked = useRef(0)
  const [index, setIndex] = useState(0)
  const [showAll, setShowAll] = useState(false)
  const [making, setMaking] = useState<{ owner: string; name: string; private: boolean }>()
  const [owners, setOwners] = useState<string[]>([])
  const fixed = within?.length ? within : undefined

  const asking = new URLSearchParams({ q: typed })
  if (topic) asking.set('topic', topic)
  if (property) {
    asking.set('property', property.name)
    asking.set('value', property.value)
  }
  if (single) asking.set('for', 'binder')
  // An agent's binders, or every binder (*) for one that works in them all.
  if (fixed) asking.set('binders', binders?.length ? binders.join(',') : '*')
  const path = `/api/github/repos?${asking}`
  const filtered = !!topic || !!property

  useEffect(() => {
    if (!open) return
    // Only the answer to what's asked now: a slower, older one mustn't replace it.
    let current = true
    const timer = window.setTimeout(() => {
      const show = (answer: (before?: Found) => Found) => {
        if (!current) return
        setFound(answer)
        setFoundFor(path)
      }
      const again = tries > triesAsked.current ? '&again=1' : ''
      triesAsked.current = tries
      void call<Found>('GET', `${path}${again}`).then((answer) => show(() => answer), () => {
        // An agent's binder's repos are known here: picked among by name when the hub can't say more of them.
        const words = typed.trim().toLowerCase()
        if (fixed) show(() => ({ repos: fixed.filter((r) => !words || r.toLowerCase().includes(words)).map((fullName) => ({ fullName, private: false })) }))
        else show((before) => ({ ...before, repos: [], failed: true }))
      })
      // Filtered: every match, to offer adding them together.
      if (filtered && !single) void call<{ names: string[]; total: number }>('GET', `${path}&all=1`).then((all) => { if (current) setMatches({ ...all, for: path }) }, () => {})
    }, 150)
    return () => {
      current = false
      window.clearTimeout(timer)
    }
  }, [path, open, tries])

  // Low in a form, the list opens past the fold: bring it up once there's something in it.
  const answered = !!found
  useEffect(() => {
    if (open && answered) panel.current?.scrollIntoView?.({ block: 'nearest' })
  }, [open, answered])

  // A press elsewhere closes the list by itself: Safari moves no focus to what's pressed, so blur can't be told apart.
  useEffect(() => {
    if (!open) return
    const away = (event: PointerEvent) => { if (!box.current?.contains(event.target as Node)) setOpen(false) }
    document.addEventListener('pointerdown', away)
    return () => document.removeEventListener('pointerdown', away)
  }, [open])

  const chosen = (name: string) => value.some((v) => v.toLowerCase() === name.toLowerCase())
  const settled = foundFor === path
  const rows = (found?.repos ?? []).filter((r) => !chosen(r.fullName))
  const active = Math.min(index, Math.max(rows.length - 1, 0))
  const optionId = (i: number) => `${id}-option-${i}`
  const topics = found?.topics ?? []
  const properties = found?.properties ?? []
  const showInput = !single || !value.length
  // Every match not known to be refused and not chosen yet, when they're for what's asked now.
  const together = matches?.for === path ? matches.names.filter((n) => !chosen(n)) : []
  const tooMany = matches?.for === path && matches.total > mostTogether
  const folded = !showAll && value.length > foldAt

  const add = (name: string) => {
    const clean = name.trim().replace(/^https:\/\/github\.com\//, '').replace(/\.git$/, '').replace(/\/$/, '')
    if (!/^[\w.-]+\/[\w.-]+$/.test(clean) || chosen(clean)) return
    if (fixed && !fixed.some((r) => r.toLowerCase() === clean.toLowerCase())) return
    onChange(single ? [clean] : [...value, clean])
    setTyped('')
    setIndex(0)
    if (single) {
      setOpen(false)
      setTopic('')
      setProperty(undefined)
    }
  }
  // Each is checked with GitHub as saving will check it, so one that can't be linked is left out with why, rather
  // than refusing the rest with it.
  const addTogether = async () => {
    setAdding(true)
    const checked = await attempt(() => call<{ ok: string[]; refused: { repo: string; why: string }[] }>('POST', '/api/github/repos/check', { repos: together }))
    setAdding(false)
    if (!checked) return
    const fresh = checked.ok.filter((n) => !chosen(n))
    if (fresh.length) onChange([...value, ...fresh])
    if (checked.refused.length) toast(leftOut(fresh.length, checked.refused))
    setIndex(0)
    // This button goes with what it added: focus stays in the field.
    document.getElementById(id)?.focus()
  }
  const move = (by: number) => {
    const next = Math.max(0, Math.min(active + by, rows.length - 1))
    setIndex(next)
    document.getElementById(optionId(next))?.scrollIntoView?.({ block: 'nearest' })
  }
  const filterBy = (change: () => void) => {
    change()
    setIndex(0)
    setOpen(true)
  }
  // What's typed, as a new repo's name (and owner, if given).
  const typedName = typed.trim().split('/').pop() ?? ''
  // Not while GitHub isn't answering: a list that may be missing repos can't say the name is free.
  const canMake = !fixed && /^[\w.-]{1,100}$/.test(typedName) && !found?.failed && !(found?.repos ?? []).some((r) => r.fullName.toLowerCase().endsWith(`/${typedName.toLowerCase()}`))
  const startMaking = async () => {
    const list = owners.length ? owners : (await call<{ owners: string[] }>('GET', '/api/github/owners').catch(() => ({ owners: [] }))).owners
    setOwners(list)
    const typedOwner = typed.includes('/') ? typed.split('/')[0].trim() : ''
    setMaking({ owner: list.find((o) => o.toLowerCase() === typedOwner.toLowerCase()) ?? list[list.length - 1] ?? '', name: typedName, private: true })
    setOpen(false)
  }
  const make = async () => {
    if (!making) return
    const made = await attempt(() => call<{ fullName: string }>('POST', '/api/github/repos', making))
    if (!made) return
    setMaking(undefined)
    add(made.fullName)
  }

  const nothing = filtered ? 'No repos match these filters.' : typed.trim() ? `No repos match “${typed.trim()}”.` : 'No repos to pick from.'
  const note = !settled
    ? (rows.length ? undefined : 'Looking…')
    : found?.failed
      ? 'GitHub didn’t answer, so some repos may be missing.'
      : !rows.length
        ? nothing
        : found?.more
          ? `Showing the first ${found.repos.length} of ${found.repos.length + found.more}. Type or filter to narrow them.`
          : undefined

  return (
    <div
      ref={box}
      className="people-input repo-input"
      onBlur={(e) => { if (e.relatedTarget && !e.currentTarget.contains(e.relatedTarget)) setOpen(false) }}
      // The list goes first, not the form around it.
      onKeyDown={(e) => {
        if (e.key === 'Escape' && open) {
          e.stopPropagation()
          setOpen(false)
        }
      }}
    >
      <div className="people-chips" onClick={() => document.getElementById(id)?.focus()}>
        {(folded ? value.slice(0, foldAt) : value).map((repo) => (
          <span key={repo} className="person-chip">
            {repo}
            <button type="button" onClick={() => onChange(value.filter((v) => v !== repo))} aria-label={`Remove ${repo}`}><X size={11} /></button>
          </span>
        ))}
        {showInput && (
          <input
            id={id}
            role="combobox"
            aria-expanded={open}
            aria-autocomplete="list"
            aria-controls={open && rows.length ? `${id}-list` : undefined}
            aria-activedescendant={open && rows.length ? optionId(active) : undefined}
            autoComplete="off"
            value={typed}
            placeholder={placeholder ?? (single ? 'Pick a repo…' : 'Add repos…')}
            onFocus={() => setOpen(true)}
            onClick={() => setOpen(true)}
            onChange={(e) => { setTyped(e.target.value); setIndex(0); setOpen(true) }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault()
                if (open) move(e.key === 'ArrowDown' ? 1 : -1)
                else setOpen(true)
              }
              if (e.key === 'Enter' || (e.key === 'Tab' && typed.trim())) {
                const picked = settled ? rows[active] : undefined
                // Tab goes on past a row that can't be picked; Enter stays, and the row says why.
                if (e.key === 'Tab' && picked?.linkable === false) return
                e.preventDefault()
                if (picked) {
                  if (picked.linkable !== false) add(picked.fullName)
                } else if (typed.includes('/')) add(typed)
                // Typed faster than the hub answered: ask now, and take the best match.
                else if (typed.trim()) void call<Found>('GET', path).then((r) => {
                  const words = typed.trim().toLowerCase()
                  const fresh = (r.repos ?? []).filter((x) => !chosen(x.fullName) && x.linkable !== false)
                  const match = fresh.find((x) => x.fullName.toLowerCase().endsWith(`/${words}`)) ?? fresh[0]
                  if (match) add(match.fullName)
                }).catch(() => {})
              }
              if (e.key === 'Backspace' && !typed && value.length && !folded) onChange(value.slice(0, -1))
            }}
          />
        )}
      </div>
      {value.length > foldAt && (
        <div className="repo-chips-more">
          <button type="button" className="text-button" onClick={() => setShowAll(!showAll)}>{showAll ? 'Show fewer' : `Show all ${value.length}`}</button>
          <button type="button" className="text-button" onClick={() => { onChange([]); setShowAll(false) }}>Remove all</button>
        </div>
      )}
      {showInput && (topics.length > 0 || properties.length > 0 || filtered) && (
        <div className="repo-filters">
          {(topics.length > 0 || topic) && (
            <select id={`${id}-topic`} aria-label="Filter by topic" value={topic} onChange={(e) => filterBy(() => setTopic(e.target.value))}>
              <option value="">Any topic</option>
              {topics.map((t) => <option key={t.name} value={t.name}>{t.name} ({t.count})</option>)}
            </select>
          )}
          {(properties.length > 0 || property) && (
            <select
              id={`${id}-property`}
              aria-label="Filter by custom property"
              value={property ? JSON.stringify([property.name, property.value]) : ''}
              onChange={(e) => filterBy(() => {
                if (!e.target.value) return setProperty(undefined)
                const [name, picked] = JSON.parse(e.target.value) as [string, string]
                setProperty({ name, value: picked })
              })}
            >
              <option value="">Any property</option>
              {/* Named in each choice, not grouped under it: a closed select shows only the value, and 1 says nothing alone. */}
              {properties.flatMap((p) => p.values.map((v) => {
                const choice = JSON.stringify([p.name, v.value])
                return <option key={choice} value={choice}>{p.name}: {v.value} ({v.count})</option>
              }))}
            </select>
          )}
          {!single && filtered && tooMany && <span className="faint">{matches!.total} match. Narrow them to {mostTogether} to add them together.</span>}
          {!single && filtered && !tooMany && together.length > 0 && (
            <button type="button" className="button" disabled={adding} onClick={() => void addTogether()}>{adding ? `Checking ${together.length} with GitHub…` : `Add all ${together.length}`}</button>
          )}
        </div>
      )}
      {making && (
        <div className="repo-make">
          <select id={`${id}-owner`} value={making.owner} onChange={(e) => setMaking({ ...making, owner: e.target.value })} aria-label="Owner">
            {owners.map((o) => <option key={o} value={o}>{o}</option>)}
          </select>
          <span className="faint">/</span>
          <input id={`${id}-name`} className="mono" value={making.name} onChange={(e) => setMaking({ ...making, name: e.target.value })} aria-label="Name" autoFocus onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void make() } if (e.key === 'Escape') setMaking(undefined) }} />
          <label className="check"><input id={`${id}-private`} type="checkbox" checked={making.private} onChange={(e) => setMaking({ ...making, private: e.target.checked })} /> Private</label>
          <button type="button" className="button primary" disabled={!making.owner || !making.name.trim()} onClick={() => void make()}>Create on GitHub</button>
          <button type="button" className="icon-button" onClick={() => setMaking(undefined)} aria-label="Cancel"><X size={14} /></button>
        </div>
      )}
      {open && showInput && (
        <div ref={panel} className="people-suggestions">
          {rows.length > 0 && (
            <div id={`${id}-list`} role="listbox" aria-label="Repos">
              {rows.map((repo, i) => (
                <button
                  key={repo.fullName}
                  id={optionId(i)}
                  type="button"
                  role="option"
                  tabIndex={-1}
                  aria-selected={i === active}
                  aria-disabled={repo.linkable === false || undefined}
                  className={`${i === active ? 'on' : ''}${repo.linkable === false ? ' unlinkable' : ''}`}
                  onMouseDown={(e) => { e.preventDefault(); if (repo.linkable !== false) add(repo.fullName) }}
                  onMouseEnter={() => setIndex(i)}
                >
                  <b>{repo.fullName}</b>
                  {repo.private && <Lock size={11} className="faint" aria-label="Private" />}
                  <em>{repo.why ?? repo.description ?? ''}</em>
                </button>
              ))}
            </div>
          )}
          <p className={note ? 'repo-status' : 'sr-only'} role="status">{note ?? `${rows.length} repo${rows.length === 1 ? '' : 's'}`}</p>
          {/* Clicks, so a keyboard reaches them too; the mouse down mustn't take focus from the field. */}
          {settled && found?.failed && <button type="button" className="repo-retry" onMouseDown={(e) => e.preventDefault()} onClick={() => { setFoundFor(undefined); setTries(tries + 1) }}>Try again</button>}
          {settled && found?.reading && (
            <p className="repo-hint">
              Still reading this organization’s repos from GitHub: {found.reading.indexed.toLocaleString()}{found.reading.total ? ` of ${found.reading.total.toLocaleString()}` : ''} so far. A repo not read yet is looked up on GitHub by name.
            </p>
          )}
          {installUrl && !fixed && (
            <p className="repo-hint">
              Only repos this binder’s GitHub App is installed on can be linked. <a href={installUrl} target="_blank" rel="noreferrer">Add repos to it on GitHub</a>
            </p>
          )}
          {canMake && typed.trim() && (
            <button type="button" className="make-repo" onMouseDown={(e) => e.preventDefault()} onClick={() => void startMaking()}>
              <Plus size={13} /> <b>Create “{typedName}” on GitHub…</b>
            </button>
          )}
        </div>
      )}
    </div>
  )
}
