import { useMemo, useState } from 'react'
import { motion } from 'motion/react'
import { Bot, CircleUser, CornerDownLeft, FileText, GitPullRequestArrow, Rocket, Search, Settings, Sparkles, SquareCheck, Workflow, LayoutDashboard } from 'lucide-react'
import { useStore } from '../data/store'
import { useUI } from '../ui'
import { go } from '../route'
import { useModal } from './useModal'

interface Command {
  id: string
  label: string
  group: string
  icon: typeof Search
  hint?: string
  run: () => void
}

/** ⌘K: every screen, note, change set and card, and the actions that matter right now. */
export function Palette({ onClose }: { onClose: () => void }) {
  const store = useStore()
  const { state } = store
  const { openItem } = useUI()
  const [query, setQuery] = useState('')
  const [index, setIndex] = useState(0)

  const commands = useMemo<Command[]>(() => {
    const list: Command[] = []
    const review = state.changeSets.find((c) => c.state === 'review')
    if (review) list.push({ id: 'approve', label: `Review change set #${review.number}: ${review.title}`, group: 'Actions', icon: GitPullRequestArrow, hint: `${review.prIds.length} PRs`, run: () => go({ screen: 'changes', id: review.id }) })
    const envs = state.environments
    const last = envs[envs.length - 1]
    const before = envs[envs.length - 2]
    if (last && before && last.needsApproval && before.version !== last.version) list.push({ id: 'promote', label: `Promote ${before.version} to ${last.name.toLowerCase()}`, group: 'Actions', icon: Rocket, run: () => go({ screen: 'delivery' }) })
    for (const card of state.cards.filter((c) => c.needsYou)) list.push({ id: `ask-${card.id}`, label: `Answer: ${card.needsYou}`, group: 'Actions', icon: Sparkles, run: () => openItem(card.id) })
    if (state.binders[0]) list.push({ id: 'new-note', label: 'New note', group: 'Actions', icon: FileText, run: () => go({ screen: 'notes', id: store.addNote(state.binders[0].id) }) })
    list.push({ id: 'new-agent', label: 'Set up an agent', group: 'Actions', icon: Bot, run: () => go({ screen: 'agents' }) })
    list.push(
      { id: 'home', label: 'Home', group: 'Go to', icon: LayoutDashboard, hint: '1', run: () => go({ screen: 'home' }) },
      { id: 'flow', label: 'Work', group: 'Go to', icon: Workflow, hint: '2', run: () => go({ screen: 'flow' }) },
      { id: 'notes', label: 'Notes', group: 'Go to', icon: FileText, hint: '3', run: () => go({ screen: 'notes', id: '' }) },
      { id: 'changes', label: 'Change sets', group: 'Go to', icon: GitPullRequestArrow, hint: '4', run: () => go({ screen: 'changes', id: '' }) },
      { id: 'delivery', label: 'Delivery', group: 'Go to', icon: Rocket, hint: '5', run: () => go({ screen: 'delivery' }) },
      { id: 'agents', label: 'Agents', group: 'Go to', icon: Bot, hint: '6', run: () => go({ screen: 'agents' }) },
      { id: 'settings', label: 'Settings', group: 'Go to', icon: Settings, hint: '7', run: () => go({ screen: 'settings' }) },
      { id: 'account', label: 'Your account', group: 'Go to', icon: CircleUser, run: () => go({ screen: 'account' }) },
    )
    for (const note of state.notes) list.push({ id: `n-${note.id}`, label: note.title, group: 'Notes', icon: FileText, hint: state.binders.find((b) => b.id === note.binderId)?.name, run: () => go({ screen: 'notes', id: note.id }) })
    for (const card of state.cards) list.push({ id: `c-${card.id}`, label: card.title, group: 'Cards', icon: SquareCheck, hint: card.issue ? `#${card.issue.number}` : undefined, run: () => openItem(card.id) })
    return list
  }, [state, store, openItem])

  const shown = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean)
    return commands.filter((c) => words.every((w) => `${c.label} ${c.hint ?? ''} ${c.group}`.toLowerCase().includes(w))).slice(0, 12)
  }, [commands, query])

  const run = (command?: Command) => {
    if (!command) return
    onClose()
    command.run()
  }

  const box = useModal<HTMLDivElement>(onClose)

  // In runs of a group, as they're sorted: each one a group of options, named for a screen reader by its heading.
  const groups: { name: string; commands: { command: Command; at: number }[] }[] = []
  shown.forEach((command, at) => {
    const last = groups[groups.length - 1]
    if (last?.name === command.group) last.commands.push({ command, at })
    else groups.push({ name: command.group, commands: [{ command, at }] })
  })

  return (
    <>
      <motion.div className="scrim strong" onClick={onClose} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} />
      <motion.div
        ref={box}
        tabIndex={-1}
        className="palette"
        role="dialog"
        aria-modal="true"
        aria-label="Search or run a command"
        initial={{ opacity: 0, scale: 0.97, y: -8 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.98, y: -4 }}
        transition={{ duration: 0.16, ease: [0.2, 0.8, 0.2, 1] }}
      >
        <label className="palette-input">
          <Search size={16} />
          <input
            id="palette-query"
            autoFocus
            role="combobox"
            aria-label="Search notes, cards and actions"
            aria-expanded="true"
            aria-controls="palette-list"
            aria-autocomplete="list"
            aria-activedescendant={shown[index] ? `palette-option-${index}` : undefined}
            placeholder="Search notes, cards and actions…"
            value={query}
            onChange={(event) => { setQuery(event.target.value); setIndex(0) }}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown') { event.preventDefault(); setIndex((i) => Math.min(i + 1, shown.length - 1)) }
              if (event.key === 'ArrowUp') { event.preventDefault(); setIndex((i) => Math.max(i - 1, 0)) }
              if (event.key === 'Enter') run(shown[index])
            }}
          />
        </label>
        <div id="palette-list" className="palette-list" role="listbox" aria-label="Results">
          {groups.map((group) => (
            <div key={group.name} role="group" aria-label={group.name}>
              <h4 aria-hidden="true">{group.name}</h4>
              {group.commands.map(({ command, at }) => {
                const Icon = command.icon
                return (
                  // Focus stays in the box, which says which this is: Tab has nowhere to go but out.
                  <button key={command.id} id={`palette-option-${at}`} tabIndex={-1} className={at === index ? 'on' : undefined} role="option" aria-selected={at === index} onMouseEnter={() => setIndex(at)} onClick={() => run(command)}>
                    <Icon size={15} />
                    <span>{command.label}</span>
                    {command.hint && <em>{command.hint}</em>}
                    {at === index && <CornerDownLeft size={13} className="enter" />}
                  </button>
                )
              })}
            </div>
          ))}
        </div>
        <p className={shown.length ? 'sr-only' : 'palette-empty'} role="status">{shown.length ? `${shown.length} result${shown.length === 1 ? '' : 's'}` : `Nothing matches “${query}”.`}</p>
      </motion.div>
    </>
  )
}
