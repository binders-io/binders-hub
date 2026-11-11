import { useEffect, useRef, useState } from 'react'
import { AnimatePresence } from 'motion/react'
import { Check, ChevronsUpDown, Layers, Plus, Users } from 'lucide-react'
import { useHub } from '../data/store'
import { space, spaceHref } from '../data/space'
import { call } from '../data/api'
import { go } from '../route'
import { Logo } from './Logo'
import { Dialog } from './Dialog'
import { NewSpace } from './SpacePanel'

/** How often the numbers beside the other binders are asked for again while the page is in view. */
export const waitingEveryMs = 120_000

/**
 * What waits for you, or for anyone, in each binder you're in, by binder's address. Asked when the page opens, each time
 * the list is opened and every two minutes while the page is visible; a failed ask shows nothing, and the last answer stays.
 */
function useWaitingElsewhere(open: boolean) {
  const [counts, setCounts] = useState<Record<string, number>>({})
  const ask = () => {
    void call<{ binders?: { id: string; count: number }[] }>('GET', '/api/me/waiting').then((answer) => {
      if (!Array.isArray(answer?.binders)) return
      setCounts(Object.fromEntries(answer.binders.filter((b) => b.count > 0).map((b) => [b.id, b.count])))
    }).catch(() => undefined)
  }
  useEffect(() => {
    const timer = window.setInterval(() => { if (document.visibilityState !== 'hidden') ask() }, waitingEveryMs)
    return () => window.clearInterval(timer)
  }, [])
  useEffect(ask, [])
  useEffect(() => { if (open) ask() }, [open])
  return counts
}

/**
 * Where you are, at the top of the sidebar: the binder you're in (its notes, board, repo and members) and your other
 * binders, each at its own address, and a new one. A binder made before a binder was one notebook may hold several
 * parts; those are offered here too, to look at one or all.
 */
export function BinderSwitcher({ binder, onPick }: { binder: string; onPick: (id: string) => void }) {
  const binders = useHub((hub) => hub.binders)
  const me = useHub((hub) => hub.me)
  const [open, setOpen] = useState(false)
  const [making, setMaking] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  const current = binders.find((b) => b.id === binder)
  const spaces = me?.spaces ?? []
  const here = spaces.find((s) => s.id === (me?.space ?? space))
  const several = binders.length > 1
  const waiting = useWaitingElsewhere(open)
  const elsewhere = Object.entries(waiting).filter(([id]) => id !== (me?.space ?? space)).reduce((sum, [, count]) => sum + count, 0)
  const repo = binders.length === 1 ? binders[0].repo : undefined

  useEffect(() => {
    if (!open) return
    const away = (event: MouseEvent) => { if (!box.current?.contains(event.target as Node)) setOpen(false) }
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false) }
    // pointerdown too: a tap on nothing in particular has no mousedown on an iPhone.
    window.addEventListener('pointerdown', away)
    window.addEventListener('mousedown', away)
    window.addEventListener('keydown', escape)
    return () => { window.removeEventListener('pointerdown', away); window.removeEventListener('mousedown', away); window.removeEventListener('keydown', escape) }
  }, [open])

  const pick = (id: string) => {
    onPick(id)
    setOpen(false)
  }
  const label = (s: { id: string; name: string }) => (s.id.startsWith('~') ? `${s.name} (only you)` : s.name)

  return (
    <div className="binder-switcher" ref={box}>
      <button type="button" className="brand" onClick={() => setOpen(!open)} aria-haspopup="listbox" aria-expanded={open}>
        <Logo size={36} inverted />
        <div>
          <b>{here?.name ?? 'Binders'}</b>
          <span className="mono">{several ? (current ? current.name : `All ${binders.length} parts`) : repo ?? (here ? `/${here.id}` : '')}</span>
        </div>
        {elsewhere > 0 && <span className="binder-dot" />}
        {elsewhere > 0 && <span className="sr-only">{elsewhere === 1 ? '1 thing is waiting in your other binders' : `${elsewhere} things are waiting in your other binders`}</span>}
        <ChevronsUpDown size={14} className="faint" />
      </button>
      {open && (
        <ul className="binder-menu" role="listbox" aria-label="Binders">
          <li className="binder-menu-head faint">Binders</li>
          {spaces.map((s) => (
            <li key={s.id}>
              {s.id === here?.id ? (
                <button type="button" aria-current="true" onClick={() => setOpen(false)}>
                  <span className="binder-initial">{s.name.charAt(0).toUpperCase()}</span>
                  <span className="binder-menu-name"><b>{label(s)}</b><em className="mono">{repo ?? `/${s.id}`}</em></span>
                  <Check size={14} />
                </button>
              ) : (
                <a href={spaceHref(s.id, '#/home')}>
                  <span className="binder-initial">{s.name.charAt(0).toUpperCase()}</span>
                  <span className="binder-menu-name"><b>{label(s)}</b><em className="mono">/{s.id}</em></span>
                  {waiting[s.id] > 0 && <span className="count binder-waiting"><span aria-hidden="true">{waiting[s.id]}</span><span className="sr-only">{waiting[s.id]} waiting</span></span>}
                </a>
              )}
            </li>
          ))}
          <li>
            <button type="button" onClick={() => { setOpen(false); setMaking(true) }}>
              <span className="binder-initial"><Plus size={13} /></span>
              <span className="binder-menu-name"><b>New binder…</b></span>
            </button>
          </li>
          {several && <>
            <li className="binder-menu-head binder-menu-sep faint">Its parts</li>
            {binders.map((b) => (
              <li key={b.id}>
                <button type="button" role="option" aria-selected={b.id === binder} onClick={() => pick(b.id)}>
                  <span className="binder-initial">{b.name.charAt(0).toUpperCase()}</span>
                  <span className="binder-menu-name"><b>{b.name}</b><em className="mono">{b.repo ?? 'No repo yet'}</em></span>
                  {b.id === binder && <Check size={14} />}
                </button>
              </li>
            ))}
            <li>
              <button type="button" role="option" aria-selected={binder === 'all'} onClick={() => pick('all')}>
                <span className="binder-initial"><Layers size={13} /></span>
                <span className="binder-menu-name"><b>All of it</b></span>
                {binder === 'all' && <Check size={14} />}
              </button>
            </li>
          </>}
          <li className="binder-menu-sep">
            <button type="button" onClick={() => { setOpen(false); go({ screen: 'settings', id: 'people' }) }}>
              <span className="binder-initial"><Users size={13} /></span>
              <span className="binder-menu-name"><b>Members, repo and settings…</b></span>
            </button>
          </li>
        </ul>
      )}
      <AnimatePresence>
        {making && me && (
          <Dialog key="new-binder" title="New binder" onClose={() => setMaking(false)}>
            <NewSpace me={me.user.login} forOthers={!!me.hubAdmin} />
          </Dialog>
        )}
      </AnimatePresence>
    </div>
  )
}
