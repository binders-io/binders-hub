import { useState } from 'react'
import { ArrowUpRight } from 'lucide-react'
import { isWebAddress, passNote } from '../data/listen'
import { useHub } from '../data/store'
import { useMayChangeBinder } from '../screens/settings/access'
import { attempt } from './Toast'

/**
 * One slim line over a note that came through a listener: which, from whom, and a way to the thing where it was said. A
 * note from outside starts no work until someone in the Binder has read it and let it through, so the line says so and,
 * for people who can change the Binder, has the button that does. It reads the note itself rather than being handed it,
 * so what changes as it's let through (the hub sends it live) is drawn here without drawing the note.
 */
export function CameThrough({ noteId }: { noteId: string }) {
  const from = useHub((state) => state.notes.find((n) => n.id === noteId)?.from)
  const mayChange = useMayChangeBinder()
  const [passing, setPassing] = useState(false)
  if (!from) return null
  const waiting = from.strength === 'outside' && !from.passed
  const letThrough = async () => {
    setPassing(true)
    await attempt(() => passNote(noteId))
    setPassing(false)
  }
  return (
    <div className="listen-came">
      <p className="listen-came-line">
        <span>Came through <b>{from.name}</b>{from.sender ? <> from <b>{from.sender}</b></> : null}</span>
        {isWebAddress(from.url) && <a href={from.url} target="_blank" rel="noopener noreferrer">Open it there <ArrowUpRight size={11} aria-hidden="true" /></a>}
      </p>
      {waiting && (
        <p className="listen-came-hold">
          <span>It’s from outside this Binder, so its folder’s rule won’t start work from it until someone here lets it through.</span>
          {mayChange && <button type="button" className="button small" disabled={passing} onClick={() => void letThrough()}>Let it through</button>}
        </p>
      )}
      {from.strength === 'outside' && from.passed && <p className="listen-came-hold">Let through by @{from.passed.by}</p>}
    </div>
  )
}
