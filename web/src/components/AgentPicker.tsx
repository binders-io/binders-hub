import { useEffect, useRef, useState } from 'react'
import { Check, ChevronDown, Layers } from 'lucide-react'
import type { Card } from '../data/model'
import { isListening, useStore } from '../data/store'
import { AgentAvatar } from './bits'
import { useMayChangeBinder } from '../screens/settings/access'

/**
 * Who a card is for, at the top of its page, and the place to change it: pick an agent, or any agent. Giving away a
 * card an agent holds puts it back on the board for the new one, and the old one's runner stops.
 */
export function AgentPicker({ card, working }: { card: Card; working: boolean }) {
  const store = useStore()
  const { state } = store
  const may = useMayChangeBinder()
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  const holder = state.agents.find((a) => a.id === card.agentId)
  const meant = state.agents.find((a) => a.id === card.meantFor)
  const shown = holder ?? meant
  const agents = state.agents.filter((a) => !a.revoked)
  const settled = card.stage === 'review' || card.stage === 'live'

  useEffect(() => {
    if (!open) return
    const away = (event: MouseEvent) => { if (!box.current?.contains(event.target as Node)) setOpen(false) }
    // Escape closes this and goes no further: the page behind would otherwise take the same press and leave the card.
    // Caught on the way down, before anything else has it, so which was listening first doesn't matter.
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.stopImmediatePropagation()
      setOpen(false)
      box.current?.querySelector<HTMLElement>('.work-agent')?.focus()
    }
    // pointerdown too: a tap on nothing in particular has no mousedown on an iPhone.
    window.addEventListener('pointerdown', away)
    window.addEventListener('mousedown', away)
    window.addEventListener('keydown', escape, true)
    return () => { window.removeEventListener('pointerdown', away); window.removeEventListener('mousedown', away); window.removeEventListener('keydown', escape, true) }
  }, [open])

  const give = (agentId: string) => {
    store.giveCard(card.id, agentId)
    setOpen(false)
  }

  // A reader is told who it's with, and can't give it to another.
  if (!may) {
    return (
      <div className="work-agent-picker">
        <div className="work-agent">
          {shown ? <AgentAvatar agent={shown} size={34} live={working} /> : <span className="any-agent"><Layers size={16} /></span>}
          <div>
            <b>{shown?.name ?? 'Any agent'}</b>
            <span>{holder ? (card.needsYou ? 'Waiting on an answer' : working ? holder.runsOn ?? 'Working on it' : 'Had it') : meant ? 'It’s meant for them' : 'The first one free that can do it'}</span>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="work-agent-picker" ref={box}>
      <button type="button" className="work-agent" onClick={() => setOpen(!open)} aria-haspopup="listbox" aria-expanded={open} disabled={settled && !!holder} title={settled ? undefined : 'Give it to another agent'}>
        {shown ? <AgentAvatar agent={shown} size={34} live={working} /> : <span className="any-agent"><Layers size={16} /></span>}
        <div>
          <b>{shown?.name ?? 'Any agent'}</b>
          <span>{holder ? (card.needsYou ? 'Waiting on you' : working ? holder.runsOn ?? 'Working on it' : 'Had it') : meant ? 'It’s meant for them' : 'The first one free that can do it'}</span>
        </div>
        {!(settled && holder) && <ChevronDown size={14} className="faint" />}
      </button>
      {open && (
        <ul className="agent-menu" role="listbox" aria-label="Give it to">
          <li className="agent-menu-label">{holder && working ? `Take it from ${holder.name} and give it to` : 'Give it to'}</li>
          {agents.map((a) => {
            const on = (card.meantFor ?? card.agentId) === a.id
            return (
              <li key={a.id}>
                <button type="button" role="option" aria-selected={on} onClick={() => give(a.id)}>
                  <AgentAvatar agent={a} size={22} />
                  <span><b>{a.name}</b><em>{isListening(a) ? 'Listening' : 'Its runner isn’t running'}</em></span>
                  {on && <Check size={14} />}
                </button>
              </li>
            )
          })}
          <li>
            <button type="button" role="option" aria-selected={!card.meantFor && !card.agentId} onClick={() => give('')}>
              <span className="any-agent small"><Layers size={13} /></span>
              <span><b>Any agent</b><em>The first one free that can do it</em></span>
              {!card.meantFor && !card.agentId && <Check size={14} />}
            </button>
          </li>
        </ul>
      )}
    </div>
  )
}
