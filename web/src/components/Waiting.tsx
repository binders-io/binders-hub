import type { Ref } from 'react'
import { ChevronRight, CircleAlert, FileText, GitPullRequest, KeyRound, MessageCircleQuestion, Rocket, SearchCheck, Sparkles, type LucideIcon } from 'lucide-react'
import { useFirst, type Draft, type FirstView, type Gathered } from '../data/first'
import { sameList, useHub } from '../data/store'
import { openRow } from '../data/notify'
import { ago } from './bits'
import { BinderTag } from './BinderTag'
import { DraftBlock, GroupRow } from './FirstDraft'
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
  const first = useFirst(rows)
  return (
    <section className="home-waiting" ref={ref} tabIndex={-1} aria-labelledby="waiting-heading">
      <div className="waiting-head">
        <h2 id="waiting-heading">Waiting on you</h2>
        <NotifySwitch id="notify-home" />
      </div>
      {!mine.length && !anyone.length && <p className="faint waiting-none">{loaded ? 'Nothing is waiting on you.' : 'Loading…'}</p>}
      {mine.length > 0 && <WaitingGroup title="For you" rows={mine} first={first} binders={showBinder && binders.length > 1 ? binders : []} />}
      {anyone.length > 0 && <WaitingGroup title="For anyone here" rows={anyone} first={first} binders={showBinder && binders.length > 1 ? binders : []} />}
      {others.length > 0 && (
        <details className="waiting-others">
          <summary><ChevronRight size={13} aria-hidden /> Waiting on others <span className="count">{others.length}</span></summary>
          <WaitingItems rows={others} first={first} binders={showBinder && binders.length > 1 ? binders : []} />
        </details>
      )}
    </section>
  )
}

function WaitingGroup({ title, rows, binders, first }: { title: string; rows: Waiting[]; binders: { id: string; name: string }[]; first: FirstView }) {
  return (
    <div className="waiting-group">
      <h3>{title}</h3>
      <WaitingItems rows={rows} binders={binders} first={first} />
    </div>
  )
}

/** A row can have a draft from the Brain when it's a card that asks something or has stopped. */
const mayHaveDraft = (row: Waiting) => row.about.type === 'card' && (row.kind === 'question' || row.kind === 'stopped')

type Entry = { row: Waiting } | { group: Gathered; rows: Waiting[] }

/**
 * The rows in the order given, except that cards the Brain says wait for the same thing become one entry, standing where
 * the first of them was. A group needs two of its cards here to be one; a lone card is an ordinary row.
 */
function arranged(rows: Waiting[], groups: Gathered[]): Entry[] {
  const groupOf = new Map<string, Gathered>()
  for (const group of groups) for (const id of group.cards) if (!groupOf.has(id)) groupOf.set(id, group)
  const members = new Map<string, Waiting[]>()
  for (const row of rows) {
    const group = mayHaveDraft(row) ? groupOf.get(row.about.id) : undefined
    if (group) members.set(group.key, [...(members.get(group.key) ?? []), row])
  }
  const entries: Entry[] = []
  for (const row of rows) {
    const group = mayHaveDraft(row) ? groupOf.get(row.about.id) : undefined
    const together = group && members.get(group.key)!
    if (!group || !together || together.length < 2) entries.push({ row })
    else if (together[0] === row) entries.push({ group, rows: together })
  }
  return entries
}

/**
 * The rows as a list of buttons that open what each is about; with `binders`, each says which binder it's in. `compact`
 * is for a narrow column: the detail keeps to one line. With the Brain's drafts (`first`), a card's row has its draft
 * under it, and cards that wait for the same thing are one row that lists them.
 */
export function WaitingItems({ rows, binders = [], compact = false, first }: { rows: Waiting[]; binders?: { id: string; name: string }[]; compact?: boolean; first?: FirstView }) {
  const drafts = new Map<string, Draft>()
  for (const draft of first?.drafts ?? []) if (!drafts.has(draft.card)) drafts.set(draft.card, draft)
  const row = (r: Waiting, draftFor = true) => <WaitingRow key={r.id} row={r} binders={binders} draft={draftFor && mayHaveDraft(r) ? drafts.get(r.about.id) : undefined} />
  return (
    <ul className={compact ? 'waiting compact' : 'waiting'}>
      {arranged(rows, first?.groups ?? []).map((entry) => {
        if ('row' in entry) return row(entry.row)
        const cards = [...new Set(entry.rows.map((r) => r.about.id))]
        const asked = entry.group.why === 'question'
        // One draft answers all of them that ask the same thing; a note's cards each have their own.
        const answer = asked ? cards.map((id) => drafts.get(id)).find((d) => d?.kind === 'answer') : undefined
        return (
          <GroupRow
            key={`group:${entry.group.key}`}
            group={entry.group}
            cards={cards}
            answer={answer}
            rows={<ul className={compact ? 'waiting compact first-inner' : 'waiting first-inner'}>{entry.rows.map((r) => row(r, !asked))}</ul>}
          />
        )
      })}
    </ul>
  )
}

function WaitingRow({ row, binders, draft }: { row: Waiting; binders: { id: string; name: string }[]; draft?: Draft }) {
  const Icon = kindIcon[row.kind]
  const binder = binders.find((b) => b.id === row.binderId)
  const when = waited(row.since)
  return (
    <li>
      <button type="button" onClick={() => openRow(row)}>
        <Icon size={14} className={row.for === 'others' ? 'faint' : 'amber'} aria-hidden />
        <span><b>{row.title}</b><em>{row.detail}</em>{(binder || when) && <small>{binder && <BinderTag name={binder.name} />}{when}</small>}</span>
      </button>
      {draft && <DraftBlock draft={draft} />}
    </li>
  )
}
