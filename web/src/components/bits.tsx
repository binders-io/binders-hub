import { shownName } from '../../../shared/people.ts'
import { useCallback, useSyncExternalStore } from 'react'
import { Check as CheckIcon, CircleDashed, LoaderCircle, X } from 'lucide-react'
import type { Agent, Card, Check, CheckState, Stage } from '../data/model'
import { stoppedTwice } from '../../../shared/work.ts'
import { useHub } from '../data/store'
import { go } from '../route'
import { ToolIcon } from './ToolIcon'

const tints: Record<Agent['provider'], string> = {
  claude: 'linear-gradient(150deg, #e0835e, #b4532f)',
  openai: 'linear-gradient(150deg, #3a3a44, #18181e)',
  copilot: 'linear-gradient(150deg, #6e7681, #30363d)',
  opencode: 'linear-gradient(150deg, #4b4f5c, #1f2129)',
  dsh: 'linear-gradient(150deg, #3f6fe0, #1d3a8a)',
  cursor: 'linear-gradient(150deg, #3a3a44, #121216)',
  gemini: 'linear-gradient(150deg, #5b8cff, #8b5cf6)',
  pi: 'linear-gradient(150deg, #4b4f5c, #1f2129)',
  amp: 'linear-gradient(150deg, #4b4f5c, #1f2129)',
  goose: 'linear-gradient(150deg, #4b4f5c, #1f2129)',
  aider: 'linear-gradient(150deg, #4b4f5c, #1f2129)',
  qwen: 'linear-gradient(150deg, #5b5bd6, #3b3ba6)',
  other: 'linear-gradient(150deg, #737373, #404040)',
}

/** A phone-sized window: the width app.css switches to one column, a tab bar and a menu at. */
export const phoneQuery = '(max-width: 900px)'
/** A touchscreen, of any size: there's no pointer to hover with, and focusing a field brings up its keyboard. */
export const onTouch = () => window.matchMedia('(hover: none)').matches

/** A phone held upright, or a window as narrow: a dialog is a sheet from the bottom, and a table is a list of rows. */
export const sheetQuery = '(max-width: 600px)'

/** Whether a media query matches now, following it as the window changes. */
export function useMedia(query: string) {
  const subscribe = useCallback((changed: () => void) => {
    const media = window.matchMedia?.(query)
    media?.addEventListener('change', changed)
    return () => media?.removeEventListener('change', changed)
  }, [query])
  // A page without matchMedia (a test's, an old browser's) is taken to be a wide window.
  return useSyncExternalStore(subscribe, () => window.matchMedia?.(query).matches ?? false)
}

export const usePhone = () => useMedia(phoneQuery)

export function AgentAvatar({ agent, size = 26, live = false }: { agent?: Agent; size?: number; live?: boolean }) {
  if (!agent) return null
  return (
    <span className={`avatar agent${live ? ' live' : ''}`} style={{ width: size, height: size, background: tints[agent.provider], borderRadius: size * 0.3 }} title={`${agent.name}${agent.repos.length ? ` · ${agent.repos.join(', ')}` : ''}`}>
      {agent.provider === 'other' && agent.runner?.tool !== 'custom' && agent.runner?.tool !== 'binders'
        ? <b style={{ fontSize: size * 0.45 }}>{agent.name.charAt(0).toUpperCase()}</b>
        : <span className="avatar-mark"><ToolIcon tool={agent.runner?.tool ?? (agent.provider === 'openai' ? 'codex' : agent.provider === 'other' ? 'custom' : agent.provider)} size={Math.round(size * 0.56)} /></span>}
    </span>
  )
}

/** A person by their GitHub login, as shown: their name, with their login beside it when that's different. */
export function useShown(id: string) {
  const name = useHub((state) => shownName(id, state.me?.people, state.me?.emu))
  return { name, title: name === id ? id : `${name} (@${id})` }
}

/** A person by their GitHub login: their GitHub picture when the hub has it, else an initial on a colour of their own. */
export function PersonAvatar({ id, size = 22 }: { id: string; size?: number }) {
  const picture = useHub((state) => (state.me?.user.login === id ? state.me.user.avatar : state.me?.people?.[id.toLowerCase()]?.avatar))
  const { name, title } = useShown(id)
  const hue = [...id].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7)
  if (picture) return <img className="avatar person" src={picture} alt="" width={size} height={size} title={title} />
  return (
    <span className="avatar person" style={{ width: size, height: size, fontSize: size * 0.45, background: `oklch(0.6 0.12 ${hue})` }} title={title}>
      {name.charAt(0).toUpperCase()}
    </span>
  )
}

/** A person's name as shown, with their full login on hover. */
export function PersonName({ id }: { id: string }) {
  const { name, title } = useShown(id)
  return <span title={title}>{name}</span>
}

/** Whoever did something: an agent, a person, or Binders itself. */
export function Who({ id, size = 22 }: { id: string; size?: number }) {
  const agent = useHub((state) => state.agents.find((a) => a.id === id))
  if (agent) return <AgentAvatar agent={agent} size={size} />
  if (id === 'hub') return <span className="avatar system ship" style={{ width: size, height: size }}><span className="ship-glyph" /></span>
  return <PersonAvatar id={id} size={size} />
}

export function CheckGlyph({ state, size = 13 }: { state: CheckState; size?: number }) {
  if (state === 'passed') return <CheckIcon className="glyph passed" size={size} strokeWidth={3} />
  if (state === 'failed') return <X className="glyph failed" size={size} strokeWidth={3} />
  if (state === 'running') return <LoaderCircle className="glyph running spin" size={size} strokeWidth={2.6} />
  return <CircleDashed className="glyph queued" size={size} strokeWidth={2.4} />
}

/** A pull request's checks as a row of small marks, for cards. */
export function CheckDots({ checks }: { checks: Check[] }) {
  return (
    <span className="check-dots" aria-label={checks.map((c) => `${c.name} ${c.state}`).join(', ')}>
      {checks.map((c) => <i key={c.name} className={c.state} title={`${c.name}: ${c.state}`} />)}
    </span>
  )
}

export function checksSummary(checks: Check[]): { state: CheckState; text: string } {
  if (!checks.length) return { state: 'queued', text: 'No checks reported' }
  const failed = checks.filter((c) => c.state === 'failed').length
  const passed = checks.filter((c) => c.state === 'passed').length
  if (failed) return { state: 'failed', text: `${failed} failed` }
  if (passed === checks.length) return { state: 'passed', text: 'All checks passed' }
  if (checks.some((c) => c.state === 'running')) return { state: 'running', text: `${passed} of ${checks.length} passed` }
  return { state: 'queued', text: 'Waiting to run' }
}

export const stageTone: Record<Stage, string> = {
  proposed: 'amber',
  ready: 'faint',
  working: 'blue',
  review: 'violet',
  blocked: 'red',
  live: 'green',
}

export function RepoTag({ repo, title }: { repo: string; title?: string }) {
  return <span className="repo-tag mono" title={title ?? repo}>{repo.split('/')[1]}</span>
}

/**
 * Where a card's code goes: its pull request's repo once it has one; before that its project's, unless the card is
 * already an issue there, which its issue number says.
 */
export function codeRepo(card: { issue?: { repo: string } }, pullRepo?: string, projectRepo?: string) {
  if (pullRepo) return pullRepo
  return card.issue ? undefined : projectRepo
}

/** A run of the same event (an agent taking a card and putting it back, again and again) as one, with how many. */
export function foldRepeats<T extends { by: string; kind: string; text: string }>(events: T[]): (T & { times: number })[] {
  // People's words each count; the hub's and agents' repeats fold into their latest.
  const said = new Set(['comment', 'answer', 'question'])
  const out: (T & { times: number })[] = []
  const seen = new Map<string, number>()
  for (const event of events) {
    const key = said.has(event.kind) ? undefined : `${event.by}\u0000${event.kind}\u0000${event.text}`
    const at = key ? seen.get(key) : undefined
    if (at !== undefined) {
      const times = out[at].times + 1
      out.splice(at, 1)
      for (const [k, i] of seen) if (i > at) seen.set(k, i - 1)
      out.push({ ...event, times })
    } else out.push({ ...event, times: 1 })
    if (key) seen.set(key, out.length - 1)
  }
  return out
}

export function Progress({ value }: { value: number }) {
  return (
    <span className="progress" role="progressbar" aria-label="Progress" aria-valuenow={Math.round(value * 100)} aria-valuemin={0} aria-valuemax={100}>
      <i style={{ width: `${Math.round(value * 100)}%` }} />
    </span>
  )
}

/** How long ago an ISO time was, briefly. */
export function ago(iso?: string) {
  if (!iso || Number.isNaN(Date.parse(iso))) return iso ?? ''
  const seconds = Math.round((Date.now() - Date.parse(iso)) / 1000)
  if (seconds < 3) return 'now'
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

/** How long the hub waits on a debrief or Challenge, started or not, before it takes a new ask for it. */
const unpickedAfterMs = 30 * 60_000

/**
 * Asked of an agent, and nothing has come of it in all that time: it never started, or it started and went quiet. The
 * hub takes a new ask then, so the page offers one.
 */
export const unpicked = (asked?: { state: string; askedAt: string }) => (asked?.state === 'asked' || asked?.state === 'writing' || asked?.state === 'reviewing') && Date.now() - Date.parse(asked.askedAt) > unpickedAfterMs

/** When it was asked, as words: "42m ago", or "on Nov 3" once it is days. */
export function askedWords(askedAt: string) {
  const how = ago(askedAt)
  return /\d[smh]$/.test(how) ? `${how} ago` : how === 'now' ? 'just now' : `on ${how}`
}

/** What to say of an ask nothing came of, by whether its agent ever started on it. */
export const quietWords = (who: string, asked: { state: string; askedAt: string }) =>
  asked.state === 'asked' ? `${who} hasn’t started on it since it was asked ${askedWords(asked.askedAt)}.` : `${who} started on it, then went quiet. It was asked ${askedWords(asked.askedAt)}.`

/**
 * A blocked card no agent holds because its runs stopped twice without finishing: it waits for a person to fix what's
 * wrong, so it isn't an agent asking something.
 */
export const stoppedBlock = (card: Pick<Card, 'stage' | 'agentId' | 'stopped' | 'needsYou'>) =>
  card.stage === 'blocked' && !card.agentId && (card.stopped ? card.stopped.times >= stoppedTwice : !!card.needsYou?.startsWith('It stopped twice without finishing:'))

/** How often a card's work stopped without finishing, as a label: "Stopped twice". */
export const stoppedWords = (times: number) => (times === 1 ? 'Stopped once' : times === 2 ? 'Stopped twice' : `Stopped ${times} times`)

// How many screens of the app this entry of the browser's history is in: 0 for the first one, which a link from another
// site opens. It's kept in the entry itself, so it survives a reload and coming back to it.
let depth = 0
if (typeof window !== 'undefined') {
  depth = window.history.state?.appDepth ?? 0
  if (window.history.state?.appDepth === undefined) window.history.replaceState({ ...window.history.state, appDepth: depth }, '')
  window.addEventListener('hashchange', () => {
    const known = window.history.state?.appDepth
    // An entry seen before has its own; a new one is a screen further in than the last.
    depth = known ?? depth + 1
    if (known === undefined) window.history.replaceState({ ...window.history.state, appDepth: depth }, '')
  })
}

/**
 * Back from a card: to the screen before it when that was this app, and to the board when it wasn't, as the browser's
 * Back would go to the other site a link to the card came from.
 */
export function leaveCard() {
  if ((window.history.state?.appDepth ?? 0) > 0) window.history.back()
  else go({ screen: 'flow' })
}

export function Kbd({ children }: { children: string }) {
  return <kbd className="kbd">{children}</kbd>
}
