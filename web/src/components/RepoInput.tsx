import { useEffect, useRef, useState } from 'react'
import { Lock, Plus, X } from 'lucide-react'
import { attempt } from './Toast'
import { call } from '../data/api'
import { useStore } from '../data/store'

interface Repo {
  fullName: string
  private: boolean
  description?: string
  /** Whether the GitHub App reaches it: issues, pull requests and checks only work for those. */
  reached: boolean
  /** Whether you can push to it, when GitHub listed it as yours; only those can be linked. */
  push?: boolean
}

/**
 * GitHub repos as chips, picked from the ones the GitHub App reaches as you type. `single` keeps one, for a binder's
 * cards; a binder's agents and each agent keep several. `within`, when given, is all there is to pick from (an agent
 * picks among its binder's repos), and nothing else can be added. A name GitHub doesn't list can otherwise still be
 * typed in and added with Enter.
 */
export function RepoInput({ id, value, single = false, placeholder, within, onChange }: {
  id: string
  value: string[]
  single?: boolean
  placeholder?: string
  within?: string[]
  onChange: (repos: string[]) => void
}) {
  // Where this binder's GitHub App's repos are changed, for the line that says only those can be linked.
  const installUrl = useStore().state.me?.github.app?.installUrl
  const [typed, setTyped] = useState('')
  const [open, setOpen] = useState(false)
  const [repos, setRepos] = useState<Repo[]>([])
  // The words the shown suggestions are for: Enter only picks from them when they match what's typed now.
  const [shownFor, setShownFor] = useState('')
  const [index, setIndex] = useState(0)
  const timer = useRef<number>(undefined)
  const [making, setMaking] = useState<{ owner: string; name: string; private: boolean }>()
  const [owners, setOwners] = useState<string[]>([])
  // While the hub is still reading an organization's repos from GitHub: how far it's got.
  const [reading, setReading] = useState<{ indexed: number; total?: number }>()
  const fixed = within?.length ? within : undefined

  useEffect(() => {
    if (!open) return
    if (fixed) {
      const words = typed.trim().toLowerCase()
      setRepos(fixed.filter((r) => (!words || r.toLowerCase().includes(words)) && !value.some((v) => v.toLowerCase() === r.toLowerCase())).slice(0, 50).map((fullName) => ({ fullName, private: false, reached: true })))
      setShownFor(typed)
      setReading(undefined)
      return
    }
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => {
      void call<{ repos: Repo[]; reading?: { indexed: number; total?: number } }>('GET', `/api/github/repos?q=${encodeURIComponent(typed)}`)
        .then((r) => { setRepos(r.repos.filter((x) => !value.some((v) => v.toLowerCase() === x.fullName.toLowerCase()))); setShownFor(typed); setReading(r.reading) })
        .catch(() => setRepos([]))
    }, 200)
    return () => window.clearTimeout(timer.current)
  }, [typed, open, value, fixed])

  const add = (name: string) => {
    const clean = name.trim().replace(/^https:\/\/github\.com\//, '').replace(/\.git$/, '').replace(/\/$/, '')
    if (!/^[\w.-]+\/[\w.-]+$/.test(clean) || value.includes(clean)) return
    if (fixed && !fixed.some((r) => r.toLowerCase() === clean.toLowerCase())) return
    onChange(single ? [clean] : [...value, clean])
    setTyped('')
    setIndex(0)
    if (single) setOpen(false)
  }
  const showInput = !single || !value.length
  // What's typed, as a new repo's name (and owner, if given).
  const typedName = typed.trim().split('/').pop() ?? ''
  const canMake = !fixed && /^[\w.-]{1,100}$/.test(typedName) && !repos.some((r) => r.fullName.toLowerCase().endsWith(`/${typedName.toLowerCase()}`))
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

  return (
    <div className="people-input repo-input">
      <div className="people-chips" onClick={() => document.getElementById(id)?.focus()}>
        {value.map((repo) => (
          <span key={repo} className="person-chip">
            {repo}
            <button type="button" onClick={() => onChange(value.filter((v) => v !== repo))} aria-label={`Remove ${repo}`}><X size={11} /></button>
          </span>
        ))}
        {showInput && (
          <input
            id={id}
            value={typed}
            placeholder={placeholder ?? (single ? 'Pick a repo…' : 'Add repos…')}
            onFocus={() => setOpen(true)}
            onBlur={() => window.setTimeout(() => setOpen(false), 150)}
            onChange={(e) => { setTyped(e.target.value); setIndex(0); setOpen(true) }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') { e.preventDefault(); setIndex((i) => Math.min(i + 1, repos.length - 1)) }
              if (e.key === 'ArrowUp') { e.preventDefault(); setIndex((i) => Math.max(i - 1, 0)) }
              if (e.key === 'Enter' || (e.key === 'Tab' && typed.trim())) {
                e.preventDefault()
                const picked = shownFor === typed ? repos[index]?.fullName : undefined
                if (picked || typed.includes('/')) add(picked ?? typed)
                else if (fixed) add(repos[0]?.fullName ?? '')
                // Typed faster than GitHub answered: ask now, and take the best match.
                else if (typed.trim()) void call<{ repos: Repo[] }>('GET', `/api/github/repos?q=${encodeURIComponent(typed.trim())}`).then((r) => {
                  const words = typed.trim().toLowerCase()
                  const fresh = r.repos.filter((x) => !value.includes(x.fullName))
                  const match = fresh.find((x) => x.fullName.toLowerCase().endsWith(`/${words}`)) ?? fresh[0]
                  if (match) add(match.fullName)
                }).catch(() => {})
              }
              if (e.key === 'Backspace' && !typed && value.length) onChange(value.slice(0, -1))
            }}
          />
        )}
      </div>
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
      {open && ((repos.length > 0 && shownFor === typed) || (canMake && typed.trim()) || (!!reading && shownFor === typed)) && (
        <ul className="people-suggestions" role="listbox">
          {repos.map((repo, i) => (
            <li key={repo.fullName}>
              <button type="button" className={i === index ? 'on' : ''} onMouseDown={(e) => { e.preventDefault(); add(repo.fullName) }} onMouseEnter={() => setIndex(i)}>
                <b>{repo.fullName}</b>
                {repo.private && <Lock size={11} className="faint" aria-label="Private" />}
                <em>{repo.push === false ? 'You can only read it, so it can’t be linked' : repo.reached ? (repo.description ?? '') : 'The GitHub App isn’t installed here'}</em>
              </button>
            </li>
          ))}
          {reading && (
            <li className="repo-hint">
              Still reading this organization’s repos from GitHub: {reading.indexed.toLocaleString()}{reading.total ? ` of ${reading.total.toLocaleString()}` : ''} so far. Repos not read yet are looked up on GitHub by name.
            </li>
          )}
          {installUrl && !fixed && (
            <li className="repo-hint">
              Only repos this binder’s GitHub App is installed on can be linked. <a href={installUrl} target="_blank" rel="noreferrer" onMouseDown={(e) => e.stopPropagation()}>Add repos to it on GitHub</a>
            </li>
          )}
          {canMake && typed.trim() && (
            <li>
              <button type="button" className="make-repo" onMouseDown={(e) => { e.preventDefault(); void startMaking() }}>
                <Plus size={13} /> <b>Create “{typedName}” on GitHub…</b>
              </button>
            </li>
          )}
        </ul>
      )}
    </div>
  )
}
