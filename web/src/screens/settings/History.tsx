import { useCallback, useEffect, useRef, useState } from 'react'
import { call } from '../../data/api'
import type { HistoryLine, HistoryPage, TrashItem } from '../../data/model'
import { useStore } from '../../data/store'
import { PersonName } from '../../components/bits'
import { shownName } from '../../../../shared/people.ts'

/** When something happened, as a person reads it: the day and the time, with the full date on hover. */
const when = (iso: string) => new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })

/** Who did it: a person or an agent by name, or the hub. */
const Doer = ({ by }: { by: string }) => (by === 'hub' ? <>The hub</> : <PersonName id={by} />)

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

  return (
    <section className="settings-card history-card">
      <h3 className="settings-sub">What happened</h3>
      <p className="field-hint">Who was added or taken out, what was deleted, where cards and notes go, agents, change sets and environments. Not edits to notes, or cards moving on the board.</p>
      {(people.length > 1 || who) && (
        <label className="field history-who">
          <span className="field-label">Show</span>
          <select value={who} onChange={(e) => setWho(e.target.value)}>
            <option value="">Everyone</option>
            {(people.includes(who) || !who ? people : [...people, who]).map((login) => <option key={login} value={login}>{name(login)}</option>)}
          </select>
        </label>
      )}
      {failed && (
        <p className="setup-note" role="alert">Couldn’t load the history. <button className="mini-button" onClick={() => void load(who)}>Try again</button></p>
      )}
      {!failed && !lines && <p className="field-hint">Loading…</p>}
      {lines && !lines.length && !failed && <p className="field-hint">{who ? `Nothing noted from ${name(who)}.` : 'Nothing has happened here yet that’s worth noting.'}</p>}
      {!!lines?.length && (
        <ul className="history-list">
          {lines.map((line) => (
            <li key={`${line.at}-${line.by}-${line.text}`}>
              <time dateTime={line.at} title={new Date(line.at).toLocaleString()}>{when(line.at)}</time>
              <span className="history-who-name"><Doer by={line.by} /></span>
              <span className="history-text">{line.text}</span>
            </li>
          ))}
        </ul>
      )}
      {more && <div><button className="button" disabled={loadingOlder} onClick={() => void older()}>Show older</button></div>}
    </section>
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

  return (
    <section className="settings-card history-card">
      <h3 className="settings-sub">Deleted in the last 30 days</h3>
      <p className="field-hint">Notes and cards come back as they were, a note to its folder and a card to its stage. After 30 days they’re gone for good.</p>
      {failed && <p className="setup-note" role="alert">Couldn’t load what was deleted. <button className="mini-button" onClick={() => void load()}>Try again</button></p>}
      {!failed && !items && <p className="field-hint">Loading…</p>}
      {items && !items.length && !failed && <p className="field-hint">Nothing has been deleted in the last 30 days.</p>}
      {!!items?.length && (
        <ul className="history-list trash-list">
          {items.map((item) => (
            <li key={`${item.kind}:${item.id}`}>
              <span className="trash-what">
                <b>{item.title || 'Untitled'}</b>
                <span>{item.kind === 'note' ? 'Note' : 'Card'}{binder(item.binderId) ? ` in ${binder(item.binderId)}` : ''}, deleted by <Doer by={item.by} /> <time dateTime={item.at} title={new Date(item.at).toLocaleString()}>{when(item.at)}</time></span>
              </span>
              <button className="button" disabled={busy === `${item.kind}:${item.id}`} aria-label={`Put back ${item.title || 'Untitled'}`} onClick={() => void back(item)}>Put back</button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
