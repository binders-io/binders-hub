import { useEffect, useState } from 'react'
import { Check as CheckIcon, CircleDashed, LoaderCircle, X } from 'lucide-react'
import type { Agent, Check, CheckState, Stage } from '../data/model'
import { useHub } from '../data/store'
import { ToolIcon } from './ToolIcon'

const tints: Record<Agent['provider'], string> = {
  claude: 'linear-gradient(150deg, #e0835e, #b4532f)',
  openai: 'linear-gradient(150deg, #3a3a44, #18181e)',
  copilot: 'linear-gradient(150deg, #6e7681, #30363d)',
  opencode: 'linear-gradient(150deg, #4b4f5c, #1f2129)',
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

export function usePhone() {
  const [phone, setPhone] = useState(() => window.matchMedia(phoneQuery).matches)
  useEffect(() => {
    const media = window.matchMedia(phoneQuery)
    const change = () => setPhone(media.matches)
    media.addEventListener('change', change)
    return () => media.removeEventListener('change', change)
  }, [])
  return phone
}

export function AgentAvatar({ agent, size = 26, live = false }: { agent?: Agent; size?: number; live?: boolean }) {
  if (!agent) return null
  return (
    <span className={`avatar agent${live ? ' live' : ''}`} style={{ width: size, height: size, background: tints[agent.provider], borderRadius: size * 0.3 }} title={`${agent.name}${agent.repos.length ? ` · ${agent.repos.join(', ')}` : ''}`}>
      {agent.provider === 'other' && agent.runner?.tool !== 'custom'
        ? <b style={{ fontSize: size * 0.45 }}>{agent.name.charAt(0).toUpperCase()}</b>
        : <span className="avatar-mark"><ToolIcon tool={agent.runner?.tool ?? (agent.provider === 'openai' ? 'codex' : agent.provider === 'other' ? 'custom' : agent.provider)} size={Math.round(size * 0.56)} /></span>}
    </span>
  )
}

/** A person by their GitHub login: their picture when it's the one signed in, else an initial on a colour of their own. */
export function PersonAvatar({ id, size = 22 }: { id: string; size?: number }) {
  const picture = useHub((state) => (state.me?.user.login === id ? state.me.user.avatar : undefined))
  const hue = [...id].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7)
  if (picture) return <img className="avatar person" src={picture} alt="" width={size} height={size} title={id} />
  return (
    <span className="avatar person" style={{ width: size, height: size, fontSize: size * 0.45, background: `oklch(0.6 0.12 ${hue})` }} title={id}>
      {id.charAt(0).toUpperCase()}
    </span>
  )
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

export function Kbd({ children }: { children: string }) {
  return <kbd className="kbd">{children}</kbd>
}
