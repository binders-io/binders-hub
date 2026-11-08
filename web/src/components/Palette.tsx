import { useEffect, useMemo, useState } from 'react'
import { motion } from 'motion/react'
import { Bot, Brain, CircleUser, CornerDownLeft, FileText, GitPullRequestArrow, Rocket, Search, Settings, Sparkles, SquareCheck, SquareTerminal, Workflow, LayoutDashboard } from 'lucide-react'
import { useStore } from '../data/store'
import { call } from '../data/api'
import { useUI } from '../ui'
import { go } from '../route'
import { cardNumber } from '../../../shared/work.ts'
import { useModal } from './useModal'

interface Command {
  id: string
  label: string
  group: string
  icon: typeof Search
  hint?: string
  /** A line under it: the words of a passage that matched. */
  detail?: string
  run: () => void
}

interface Passage {
  kind: 'note' | 'card'
  id: string
  title: string
  context?: string
  text: string
}

/** Words that open a question: Enter should ask it, not open the first title that happens to share a word. */
const questionWords = /^(what|whats|what's|why|how|when|where|who|whose|which|did|does|do|is|are|was|were|can|could|should|would|will|has|have|had)\b/i
const isQuestion = (text: string) => /\?\s*$/.test(text) || questionWords.test(text)

/**
 * ⌘K: every screen, note, change set and card, the actions that matter right now, and the passages that match by their
 * words and what they mean. Its Ask row takes what you typed to Ask for a cited answer.
 */
export function Palette({ onClose }: { onClose: () => void }) {
  const store = useStore()
  const { state } = store
  const { openItem, connectClaudeCode, askQuestion } = useUI()
  const [found, setFound] = useState<Passage[]>([])
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
    if (connectClaudeCode) list.push({ id: 'claude-code', label: 'Add the hub to Claude Code', group: 'Actions', icon: SquareTerminal, hint: 'MCP', run: connectClaudeCode })
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
    for (const card of state.cards) list.push({ id: `c-${card.id}`, label: card.title, group: 'Cards', icon: SquareCheck, hint: cardNumber(card), run: () => openItem(card.id) })
    return list
  }, [state, store, openItem, connectClaudeCode])

  // The passages come from the hub, when typing pauses. What was found stays until the next answer, so the list holds still.
  const asked = query.trim()
  useEffect(() => {
    if (asked.length < 3) return
    let current = true
    const timer = window.setTimeout(() => {
      void call<{ sources?: Passage[] }>('POST', '/api/brain/search', { query: asked }).then((r) => { if (current) setFound(r.sources ?? []) }, () => { if (current) setFound([]) })
    }, 250)
    return () => {
      current = false
      window.clearTimeout(timer)
    }
  }, [asked])

  const shown = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean)
    const matching = commands.filter((c) => words.every((w) => `${c.label} ${c.hint ?? ''} ${c.group}`.toLowerCase().includes(w)))
    if (!asked) return matching.slice(0, 12)
    const titles = matching.slice(0, 8)
    const askRow: Command[] = askQuestion ? [{ id: 'ask', label: `Ask: ${asked}`, group: 'Ask', icon: Brain, run: () => askQuestion(asked) }] : []
    // A passage of something already listed by its title adds nothing but noise.
    const listed = new Set(titles.map((c) => c.id))
    const seen = new Set<string>()
    const passages: Command[] = asked.length < 3 ? [] : found.flatMap((p) => {
      const id = p.kind === 'note' ? `n-${p.id}` : `c-${p.id}`
      if (listed.has(id) || seen.has(id)) return []
      seen.add(id)
      return [{
        id: `p-${id}`, label: p.title, group: 'In your notes and cards', icon: p.kind === 'note' ? FileText : SquareCheck, hint: p.context,
        detail: p.text.replace(/^#+\s*/gm, '').replace(/\s+/g, ' ').trim().slice(0, 140),
        run: () => { if (p.kind === 'note') go({ screen: 'notes', id: p.id }); else openItem(p.id) },
      }]
    }).slice(0, 6)
    return isQuestion(asked) || !titles.length ? [...askRow, ...titles, ...passages] : [...titles, ...askRow, ...passages]
  }, [commands, query, asked, found, askQuestion, openItem])

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
        aria-label="Search or ask"
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
            aria-label="Search or ask your binders"
            aria-expanded="true"
            aria-controls="palette-list"
            aria-autocomplete="list"
            aria-activedescendant={shown[index] ? `palette-option-${index}` : undefined}
            placeholder="Search or ask your binders…"
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
                  <button key={command.id} id={`palette-option-${at}`} tabIndex={-1} className={`${at === index ? 'on' : ''}${command.detail ? ' with-detail' : ''}`.trim() || undefined} role="option" aria-selected={at === index} onMouseEnter={() => setIndex(at)} onClick={() => run(command)}>
                    <Icon size={15} />
                    <span>{command.label}{command.detail && <small>{command.detail}</small>}</span>
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
