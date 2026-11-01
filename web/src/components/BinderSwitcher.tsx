import { useEffect, useRef, useState } from 'react'
import { AnimatePresence } from 'motion/react'
import { Check, ChevronsUpDown, Layers, Plus, Users } from 'lucide-react'
import { useHub } from '../data/store'
import { space, spaceHref } from '../data/space'
import { go } from '../route'
import { Logo } from './Logo'
import { Dialog } from './Dialog'
import { NewSpace } from './SpacePanel'

const toSettings = (part: string) => {
  try { window.localStorage.setItem('binders-settings-part', part) } catch { /* only a convenience */ }
  go({ screen: 'settings' })
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
  const repo = binders.length === 1 ? binders[0].repo : undefined

  useEffect(() => {
    if (!open) return
    const away = (event: MouseEvent) => { if (!box.current?.contains(event.target as Node)) setOpen(false) }
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false) }
    window.addEventListener('mousedown', away)
    window.addEventListener('keydown', escape)
    return () => { window.removeEventListener('mousedown', away); window.removeEventListener('keydown', escape) }
  }, [open])

  const pick = (id: string) => {
    onPick(id)
    setOpen(false)
  }
  const label = (s: { id: string; name: string }) => (s.id.startsWith('~') ? `${s.name} (only you)` : s.name)

  return (
    <div className="binder-switcher" ref={box}>
      <button type="button" className="brand" onClick={() => setOpen(!open)} aria-haspopup="listbox" aria-expanded={open}>
        <Logo size={42} inverted />
        <div>
          <b>{here?.name ?? 'Binders'}</b>
          <span className="mono">{several ? (current ? current.name : `All ${binders.length} parts`) : repo ?? (here ? `/${here.id}` : '')}</span>
        </div>
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
            <button type="button" onClick={() => { setOpen(false); toSettings('binder') }}>
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
