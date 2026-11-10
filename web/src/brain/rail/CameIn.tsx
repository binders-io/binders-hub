import { useEffect, useRef, useState } from 'react'
import { loadFeed, undoRow, useHeard, type Outcome } from '../../data/listen'
import { useHub } from '../../data/store'
import { askedWords } from '../../components/bits'
import { SettingsLink } from '../../components/SettingsLink'
import { useMayChangeBinder } from '../../screens/settings/access'
import { href } from '../../route'
import { HubError } from '../../data/api'
import { RailSection } from './RailSection'

/** How many rows show at first, and the most "Show more" reveals. */
const firstRows = 6
const mostRows = 30

/**
 * The rail's third part: what came in through the Binder's listeners, newest first, and what the hub did with each.
 * It asks again whenever the hub says something was heard or taken back. A row that became a note opens it and, for
 * people who can change the Binder, can be taken back.
 */
export function CameIn() {
  const [rows, setRows] = useState<Outcome[]>([])
  const [loaded, setLoaded] = useState(false)
  const [failed, setFailed] = useState(false)
  const [more, setMore] = useState(false)
  // Which row is being taken back, and a row the hub refused to take back, with its words.
  const [undoing, setUndoing] = useState<string>()
  const [refused, setRefused] = useState<{ id: string; why: string }>()
  const asked = useRef(0)
  const mayChange = useMayChangeBinder()
  const mayManage = useHub((state) => state.me?.role === 'owner' || state.me?.role === 'admin')
  const load = () => {
    // An answer that comes after a newer question was asked is out of date and is dropped.
    const mine = ++asked.current
    loadFeed().then((found) => { if (mine === asked.current) { setRows(found); setFailed(false); setLoaded(true) } }, () => { if (mine === asked.current) { setFailed(true); setLoaded(true) } })
  }
  useEffect(load, [])
  useHeard(load)

  const undo = async (row: Outcome) => {
    setUndoing(row.id)
    setRefused(undefined)
    try {
      const done = await undoRow(row.id)
      setRows((was) => was.map((r) => (r.id === row.id ? done : r)))
    } catch (error) {
      setRefused({ id: row.id, why: error instanceof HubError ? error.message : 'Couldn’t take it back. Try again in a moment.' })
    }
    setUndoing(undefined)
  }

  const shown = rows.slice(0, more ? mostRows : firstRows)
  return (
    <RailSection id="came" title="Came in" count={rows.length}>
      {shown.length ? (
        <>
          <ul className="brain-came">
            {shown.map((row) => {
              const noted = row.did === 'noted'
              const titleId = `brain-came-${row.id}`
              return (
                <li key={row.id} className={`brain-came-row${noted ? '' : ' quiet'}`}>
                  <div className="brain-came-from">
                    <b>{row.listenerName}</b>
                    {row.sender && <span className="brain-came-sender">{row.sender}</span>}
                    {row.strength === 'outside' && <span className="brain-came-tag">From outside</span>}
                  </div>
                  <div className="brain-came-title" id={titleId}>{noted && row.note ? <a href={href({ screen: 'notes', id: row.note })}>{row.title}</a> : row.title}</div>
                  <div className="brain-came-line">{row.line}</div>
                  <div className="brain-came-foot">
                    <time dateTime={row.at}>{askedWords(row.at)}</time>
                    {noted && mayChange && <button type="button" className="text-button brain-came-undo" aria-describedby={titleId} disabled={undoing === row.id} onClick={() => void undo(row)}>Undo</button>}
                  </div>
                  {refused?.id === row.id && <p className="brain-came-refused" role="alert">{refused.why}</p>}
                </li>
              )
            })}
          </ul>
          {!more && rows.length > firstRows && <button type="button" className="text-button brain-came-more" onClick={() => setMore(true)}>Show more</button>}
        </>
      ) : !loaded ? (
        <p className="faint brain-rail-none">Loading…</p>
      ) : failed ? (
        <p className="faint brain-rail-none">Couldn’t load what came in.</p>
      ) : (
        <p className="faint brain-rail-none">Nothing has come in.{mayManage && <> Add a listener in <SettingsLink section="listeners" />.</>}</p>
      )}
    </RailSection>
  )
}
