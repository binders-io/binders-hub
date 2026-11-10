import type { Ref } from 'react'
import { ChevronRight, CircleAlert, FileText, GitPullRequest, KeyRound, MessageCircleQuestion, Rocket, SearchCheck, Sparkles, type LucideIcon } from 'lucide-react'
import { sameList, useHub } from '../data/store'
import { openRow } from '../data/notify'
import { ago } from './bits'
import { BinderTag } from './BinderTag'
import { NotifySwitch } from './NotifySwitch'
import type { WaitKind, Waiting } from '../../../shared/waiting.ts'

// What waits on a person, drawn the same way wherever it shows: Home's list, and the Brain's "Needs you". Which rows
// there are comes from shared/waiting.ts; this is how a row looks and what pressing it does.

const kindIcon: Record<WaitKind, LucideIcon> = { question: MessageCircleQuestion, stopped: CircleAlert, permission: KeyRound, changeSet: GitPullRequest, proposals: Sparkles, noteChange: FileText, findings: SearchCheck, promotion: Rocket }

/** How long a row has waited, in words; nothing when it has no date. */
const waited = (iso: string) => {
  if (Number.isNaN(Date.parse(iso))) return ''
  const t = ago(iso)
  return t === 'now' ? 'just now' : /^\d+[smh]$/.test(t) ? `${t} ago` : `since ${t}`
}

/**
 * What waits on you, in groups: yours first, then what anyone here can deal with, and what's on others folded away. On a
 * phone it opens Home, as it's what people come back for.
 */
export function WaitingList({ rows, showBinder, loaded, ref }: { rows: Waiting[]; showBinder: boolean; loaded: boolean; ref: Ref<HTMLElement> }) {
  const binders = useHub((state) => state.binders, sameList)
  const mine = rows.filter((r) => r.for === 'you')
  const anyone = rows.filter((r) => r.for === 'anyone')
  const others = rows.filter((r) => r.for === 'others')
  return (
    <section className="home-waiting" ref={ref} tabIndex={-1} aria-labelledby="waiting-heading">
      <div className="waiting-head">
        <h2 id="waiting-heading">Waiting on you</h2>
        <NotifySwitch id="notify-home" />
      </div>
      {!mine.length && !anyone.length && <p className="faint waiting-none">{loaded ? 'Nothing is waiting on you.' : 'Loading…'}</p>}
      {mine.length > 0 && <WaitingGroup title="For you" rows={mine} binders={showBinder && binders.length > 1 ? binders : []} />}
      {anyone.length > 0 && <WaitingGroup title="For anyone here" rows={anyone} binders={showBinder && binders.length > 1 ? binders : []} />}
      {others.length > 0 && (
        <details className="waiting-others">
          <summary><ChevronRight size={13} aria-hidden /> Waiting on others <span className="count">{others.length}</span></summary>
          <WaitingItems rows={others} binders={showBinder && binders.length > 1 ? binders : []} />
        </details>
      )}
    </section>
  )
}

function WaitingGroup({ title, rows, binders }: { title: string; rows: Waiting[]; binders: { id: string; name: string }[] }) {
  return (
    <div className="waiting-group">
      <h3>{title}</h3>
      <WaitingItems rows={rows} binders={binders} />
    </div>
  )
}

/**
 * The rows as a list of buttons that open what each is about; with `binders`, each says which binder it's in. `compact`
 * is for a narrow column: the detail keeps to one line.
 */
export function WaitingItems({ rows, binders = [], compact = false }: { rows: Waiting[]; binders?: { id: string; name: string }[]; compact?: boolean }) {
  return (
    <ul className={compact ? 'waiting compact' : 'waiting'}>
      {rows.map((row) => {
        const Icon = kindIcon[row.kind]
        const binder = binders.find((b) => b.id === row.binderId)
        const when = waited(row.since)
        return (
          <li key={row.id}>
            <button type="button" onClick={() => openRow(row)}>
              <Icon size={14} className={row.for === 'others' ? 'faint' : 'amber'} aria-hidden />
              <span><b>{row.title}</b><em>{row.detail}</em>{(binder || when) && <small>{binder && <BinderTag name={binder.name} />}{when}</small>}</span>
            </button>
          </li>
        )
      })}
    </ul>
  )
}
