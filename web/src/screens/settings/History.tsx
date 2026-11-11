import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { FileText, History as HistoryIcon, RotateCcw, SquareKanban, Trash2, TriangleAlert } from 'lucide-react'
import { call } from '../../data/api'
import type { HistoryLine, HistoryPage, TrashItem } from '../../data/model'
import { useStore } from '../../data/store'
import { EmptyState, Row, Rows, Section, Skeleton } from '../../kit'
import { PersonName, Who } from '../../components/bits'
import { shownName } from '../../../../shared/people.ts'

/** When something happened, as a person reads it: the day and the time, with the full date on hover. */
const when = (iso: string) => new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
/** The time alone, under its day's heading. */
const time = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })

/** A day's heading: Today, Yesterday, or its date. */
function dayOf(iso: string) {
  const at = new Date(iso)
  const today = new Date()
  const start = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  const days = Math.round((start(today) - start(at)) / 86_400_000)
  if (days === 0) return 'Today'
  if (days === 1) return 'Yesterday'
  return at.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', ...(at.getFullYear() === today.getFullYear() ? {} : { year: 'numeric' }) })
}

/** Who did it: a person or an agent by name, or the hub. */
const Doer = ({ by }: { by: string }) => (by === 'hub' ? <>The hub</> : <PersonName id={by} />)

/** Something that didn't load, said as more than grey text, with the way to try again. */
function Failed({ what, retry }: { what: string; retry: () => void }) {
  return (
    <div role="alert">
      <EmptyState compact icon={<TriangleAlert size={18} />} title={`Couldn’t load ${what}.`} line="The hub didn’t answer. It may be starting up."
        action={<button type="button" className="button small" onClick={retry}><RotateCcw size={14} aria-hidden="true" />Try again</button>} />
    </div>
  )
}

/** What people and agents did here that others would want to know of later, and what was deleted and can still be put back. */
export function HistoryPart() {
  // Putting something back is a line in the history too, so the list is read again.
  const [again, setAgain] = useState(0)
  return (
    <>
      <WhatHappened again={again} />
      <Deleted onPutBack={() => setAgain((n) => n + 1)} />
    </>
  )
}

function WhatHappened({ again }: { again: number }) {
  const { state } = useStore()
  const me = state.me
  const [who, setWho] = useState('')
  const [lines, setLines] = useState<HistoryLine[]>()
  const [more, setMore] = useState(false)
  const [people, setPeople] = useState<string[]>([])
  const [failed, setFailed] = useState(false)
  const [loadingOlder, setLoadingOlder] = useState(false)
  // Only the newest answer is shown: one for a person picked a moment ago can come back after the next.
  const asked = useRef(0)

  const load = useCallback(async (person: string, before?: string) => {
    const mine = ++asked.current
    const query = new URLSearchParams()
    if (person) query.set('who', person)
    if (before) query.set('before', before)
    try {
      const page = await call<HistoryPage>('GET', `/api/history${query.toString() ? `?${query}` : ''}`)
      if (mine !== asked.current) return
      setFailed(false)
      setLines((was) => (before ? [...(was ?? []), ...(page.lines ?? [])] : page.lines ?? []))
      setMore(!!page.more)
      // The list of people is of everyone in it, so choosing one doesn't shrink it to that one.
      if (!person) setPeople(page.people ?? [])
    } catch {
      if (mine === asked.current) setFailed(true)
    }
  }, [])

  useEffect(() => { void load(who) }, [who, again, load])

  const older = async () => {
    setLoadingOlder(true)
    await load(who, lines?.at(-1)?.at)
    setLoadingOlder(false)
  }
  const name = (login: string) => (login === 'hub' ? 'The hub' : shownName(login, me?.people, me?.emu))
  // The lines a day at a time, newest first, as the hub gives them.
  const days: { day: string; lines: HistoryLine[] }[] = []
  for (const line of lines ?? []) {
    const day = dayOf(line.at)
    if (days.at(-1)?.day === day) days.at(-1)!.lines.push(line)
    else days.push({ day, lines: [line] })
  }

  const filter = (people.length > 1 || who) && (
    <div className="history-filter">
      <label htmlFor="history-who">Show</label>
      <select id="history-who" className="select" value={who} onChange={(e) => setWho(e.target.value)}>
        <option value="">Everyone</option>
        {(people.includes(who) || !who ? people : [...people, who]).map((login) => <option key={login} value={login}>{name(login)}</option>)}
      </select>
    </div>
  )

  let body: ReactNode
  if (failed) body = <Failed what="the history" retry={() => void load(who)} />
  else if (!lines) {
    body = (
      <div className="timeline-loading" aria-busy="true">
        <span className="sr-only">Loading…</span>
        {[0, 1, 2].map((i) => <div key={i} className="timeline-skeleton"><Skeleton round width={24} height={24} /><Skeleton lines={2} /></div>)}
      </div>
    )
  } else if (!lines.length) {
    body = <EmptyState compact icon={<HistoryIcon size={18} />} title={who ? `Nothing noted from ${name(who)}.` : 'Nothing has happened here yet that’s worth noting.'} line={who ? undefined : 'When someone joins or leaves, or something is deleted, it shows here.'} />
  } else {
    body = (
      <div className="timeline">
        {days.map(({ day, lines: theirs }) => (
          <div key={day} className="timeline-day">
            <h4 className="timeline-day-name">{day}</h4>
            <ol className="history-list">
              {theirs.map((line) => (
                <li key={`${line.at}-${line.by}-${line.text}`}>
                  <time dateTime={line.at} title={new Date(line.at).toLocaleString()}>{time(line.at)}</time>
                  <span className="timeline-mark" aria-hidden="true"><Who id={line.by} size={24} /></span>
                  <span className="history-who-name"><Doer by={line.by} /></span>
                  <span className="history-text">{line.text}</span>
                </li>
              ))}
            </ol>
          </div>
        ))}
      </div>
    )
  }

  return (
    <Section title="What happened" lead="Who joined or left, what was deleted, and where work goes." action={filter || undefined} className="history-section"
      more={<p>Who was added or taken out, what was deleted, where cards and notes go, agents, change sets and environments. Not edits to notes, or cards moving on the board.</p>}>
      {body}
      {more && !failed && <div className="timeline-more"><button type="button" className="button small" disabled={loadingOlder} onClick={() => void older()}>{loadingOlder ? 'Loading…' : 'Show older'}</button></div>}
    </Section>
  )
}

function Deleted({ onPutBack }: { onPutBack: () => void }) {
  const { state, putBack } = useStore()
  const [items, setItems] = useState<TrashItem[]>()
  const [failed, setFailed] = useState(false)
  const [busy, setBusy] = useState<string>()

  const load = useCallback(async () => {
    try {
      setItems((await call<{ items?: TrashItem[] }>('GET', '/api/trash')).items ?? [])
      setFailed(false)
    } catch {
      setFailed(true)
    }
  }, [])
  useEffect(() => { void load() }, [load])

  const back = async (item: TrashItem) => {
    setBusy(`${item.kind}:${item.id}`)
    await putBack(item.kind, item.id)
    // Said whether it came back or not, as the list is of what the hub has now.
    await load()
    onPutBack()
    setBusy(undefined)
  }
  const binder = (id: string) => (state.binders.length > 1 ? state.binders.find((b) => b.id === id)?.name : undefined)

  let body: ReactNode
  if (failed) body = <Failed what="what was deleted" retry={() => void load()} />
  else if (!items) {
    body = (
      <div className="timeline-loading" aria-busy="true">
        <span className="sr-only">Loading…</span>
        {[0, 1].map((i) => <div key={i} className="timeline-skeleton"><Skeleton width={32} height={32} /><Skeleton lines={2} /></div>)}
      </div>
    )
  } else if (!items.length) body = <EmptyState compact icon={<Trash2 size={18} />} title="Nothing has been deleted in the last 30 days." />
  else {
    body = (
      <Rows label="Deleted in the last 30 days" className="trash-list">
        {items.map((item) => (
          <Row key={`${item.kind}:${item.id}`} icon={item.kind === 'note' ? <FileText size={16} /> : <SquareKanban size={16} />} title={item.title || 'Untitled'}
            meta={<>{item.kind === 'note' ? 'Note' : 'Card'}{binder(item.binderId) ? ` in ${binder(item.binderId)}` : ''}, deleted by <Doer by={item.by} /> <time dateTime={item.at} title={new Date(item.at).toLocaleString()}>{when(item.at)}</time></>}
            trailing={<button type="button" className="button small" disabled={busy === `${item.kind}:${item.id}`} aria-label={`Put back ${item.title || 'Untitled'}`} onClick={() => void back(item)}><RotateCcw size={14} aria-hidden="true" />Put back</button>} />
        ))}
      </Rows>
    )
  }

  return (
    <Section title="Deleted in the last 30 days" lead="A note goes back to its folder, a card to its stage. After 30 days they’re gone.">
      {body}
    </Section>
  )
}
