import { useEffect, useRef, useState } from 'react'
import { X } from 'lucide-react'
import { call } from '../data/api'

interface Person {
  login: string
  avatar?: string
  why: string
}

/**
 * GitHub names as chips, filled in from GitHub as you type: members of the organizations the app is installed on, your
 * own organizations, and GitHub's search. Names the GitHub App already lets in show first, fixed, with why.
 */
export function PeopleInput({ id, kind, value, implied, impliedWhy, disabled, onChange }: {
  id: string
  kind: 'user' | 'org'
  value: string[]
  implied: string[]
  impliedWhy: string
  disabled: boolean
  onChange: (names: string[]) => void
}) {
  const [typed, setTyped] = useState('')
  const [open, setOpen] = useState(false)
  const [people, setPeople] = useState<Person[]>([])
  const [index, setIndex] = useState(0)
  const timer = useRef<number>(undefined)

  useEffect(() => {
    if (!open || disabled) return
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => {
      void call<{ people: Person[] }>('GET', `/api/github/people?kind=${kind}&q=${encodeURIComponent(typed)}`)
        .then((r) => setPeople(r.people.filter((p) => !value.includes(p.login) && !implied.includes(p.login))))
        .catch(() => setPeople([]))
    }, 180)
    return () => window.clearTimeout(timer.current)
  }, [typed, open, kind, value, implied, disabled])

  const add = (login: string) => {
    const clean = login.trim().replace(/^@/, '')
    if (!clean || value.includes(clean)) return
    onChange([...value, clean])
    setTyped('')
    setIndex(0)
  }

  return (
    <div className={`people-input${disabled ? ' disabled' : ''}`}>
      <div className="people-chips">
        {implied.map((login) => <span key={`i-${login}`} className="person-chip implied" title={impliedWhy}>@{login}<em>{impliedWhy}</em></span>)}
        {value.map((login) => (
          <span key={login} className="person-chip">
            @{login}
            {!disabled && <button type="button" onClick={() => onChange(value.filter((v) => v !== login))} aria-label={`Remove ${login}`}><X size={11} /></button>}
          </span>
        ))}
        {!disabled && (
          <input
            id={id}
            value={typed}
            placeholder={kind === 'org' ? 'Add an organization…' : 'Add someone…'}
            onFocus={() => setOpen(true)}
            onBlur={() => window.setTimeout(() => setOpen(false), 150)}
            onChange={(e) => { setTyped(e.target.value); setIndex(0) }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') { e.preventDefault(); setIndex((i) => Math.min(i + 1, people.length - 1)) }
              if (e.key === 'ArrowUp') { e.preventDefault(); setIndex((i) => Math.max(i - 1, 0)) }
              if (e.key === 'Enter' || e.key === ',' || e.key === 'Tab') {
                if (!typed.trim() && e.key === 'Tab') return
                e.preventDefault()
                add(people[index]?.login ?? typed)
              }
              if (e.key === 'Backspace' && !typed && value.length) onChange(value.slice(0, -1))
            }}
          />
        )}
      </div>
      {open && !disabled && people.length > 0 && (
        <ul className="people-suggestions" role="listbox">
          {people.map((person, i) => (
            <li key={person.login}>
              <button type="button" className={i === index ? 'on' : ''} onMouseDown={(e) => { e.preventDefault(); add(person.login) }} onMouseEnter={() => setIndex(i)}>
                {person.avatar ? <img src={person.avatar} alt="" width={20} height={20} /> : <span className="person-initial">{person.login.charAt(0).toUpperCase()}</span>}
                <b>{person.login}</b>
                <em>{person.why}</em>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
