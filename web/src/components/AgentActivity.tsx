import { useEffect, useMemo, useRef, useState } from 'react'
import type { Agent, Card } from '../data/model'
import type { Chat } from '../../../shared/work.ts'
import { AgentAvatar } from './bits'

// The day's agent activity, as Home on the Mac shows it: a smooth line for each agent through the day, how long they
// worked against yesterday by the same hour, and what their runs used. Read from the board: every line an agent put on a
// card, and every chat answer, counts it at work for the five minutes it falls in.

const bucket = 5 * 60_000
const step = 15 * 60_000
const shown = 6
const lineColours: Record<string, string> = { claude: '#e0835e', codex: '#a3a3a3', opencode: '#6cb6ff', copilot: '#c084fc', pi: '#4ade80', gemini: '#60a5fa', cursor: '#e5e5e5' }
const spare = ['#fbbf24', '#f472b6', '#2dd4bf', '#a78bfa', '#fb923c']

interface Series {
  agent: Agent
  colour: string
  values: number[]
  worked: number
  tokens: number
  cost: number
}

const startOfDay = (offsetDays = 0) => {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  return d.getTime() + offsetDays * 86_400_000
}

const duration = (ms: number) => {
  const minutes = Math.round(ms / 60_000)
  return minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : `${minutes}m`
}

/** Where the numbers come from, for their tooltip. */
const usageHelp = 'What each run reported when it ended: Claude Code and Codex say how many tokens a run used, and Claude Code what it would cost at API list prices. That isn’t what a Claude subscription bills. Runners before 0.4 don’t send tokens.'

const compact = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n))

export function AgentActivity({ agents, cards, chats }: { agents: Agent[]; cards: Card[]; chats: Chat[] }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000)
    return () => window.clearInterval(timer)
  }, [])

  const day = useMemo(() => {
    const today = startOfDay()
    const yesterday = startOfDay(-1)
    const buckets = new Map<string, Set<number>>()
    const yesterdayBuckets = new Set<string>()
    const used = new Map<string, { tokens: number; cost: number }>()
    const agentIds = new Set(agents.map((a) => a.id))
    const mark = (by: string, iso: string) => {
      if (!agentIds.has(by)) return
      const at = Date.parse(iso)
      if (at >= today && at <= now) {
        if (!buckets.has(by)) buckets.set(by, new Set())
        buckets.get(by)!.add(Math.floor((at - today) / bucket))
      } else if (at >= yesterday && at < yesterday + (now - today)) {
        yesterdayBuckets.add(`${by}|${Math.floor((at - yesterday) / bucket)}`)
      }
    }
    for (const card of cards) {
      for (const a of card.activity) {
        mark(a.by, a.at)
        if (a.kind === 'ran' && Date.parse(a.at) >= today && agentIds.has(a.by)) {
          const was = used.get(a.by) ?? { tokens: 0, cost: 0 }
          used.set(a.by, { tokens: was.tokens + (a.tokens ?? 0), cost: was.cost + (a.cost ?? 0) })
        }
      }
    }
    for (const chat of chats) for (const m of chat.messages) mark(m.by, m.at)

    // From 8 AM, or the hour work began if earlier, to now, every quarter hour.
    const firstBucket = Math.min(...[...buckets.values()].flatMap((b) => [...b]), Infinity)
    const begin = Math.min(today + 8 * 3_600_000, Number.isFinite(firstBucket) ? today + Math.floor((firstBucket * bucket) / 3_600_000) * 3_600_000 : Infinity, now - 2 * 3_600_000)
    const points: number[] = []
    for (let t = begin; t < now; t += step) points.push(t)
    points.push(now)

    const colourFor = (() => {
      const taken = new Set<string>()
      let next = 0
      return (agent: Agent) => {
        const own = lineColours[agent.runner?.tool ?? agent.provider]
        if (own && !taken.has(own)) { taken.add(own); return own }
        return spare[next++ % spare.length]
      }
    })()
    const series: Series[] = [...buckets.entries()]
      .sort((a, b) => b[1].size - a[1].size)
      .slice(0, shown)
      .map(([id, set]) => {
        const agent = agents.find((a) => a.id === id)!
        // Each point: how much of the hour around it the agent was at work.
        const values = points.map((t) => {
          const from = Math.floor((t - 1_800_000 - today) / bucket)
          const to = Math.floor((t + 1_800_000 - today) / bucket)
          let n = 0
          for (let b = from; b <= to; b++) if (set.has(b)) n++
          return Math.min(1, n / 12)
        })
        return { agent, colour: colourFor(agent), values, worked: set.size * bucket, tokens: used.get(id)?.tokens ?? 0, cost: used.get(id)?.cost ?? 0 }
      })
    const worked = [...buckets.values()].reduce((sum, b) => sum + b.size, 0) * bucket
    return { points, series, worked, yesterday: yesterdayBuckets.size * bucket, tokens: [...used.values()].reduce((s, u) => s + u.tokens, 0), cost: [...used.values()].reduce((s, u) => s + u.cost, 0) }
  }, [agents, cards, chats, now])

  const box = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(800)
  useEffect(() => {
    if (!box.current) return
    const watch = new ResizeObserver(([entry]) => setWidth(Math.max(240, Math.round(entry.contentRect.width))))
    watch.observe(box.current)
    return () => watch.disconnect()
  }, [])

  const height = 150
  const pad = { top: 10, bottom: 8, left: 2, right: 8 }
  const span = day.points[day.points.length - 1] - day.points[0] || 1
  const x = (t: number) => pad.left + ((t - day.points[0]) / span) * (width - pad.left - pad.right)
  const y = (v: number) => pad.top + (1 - v) * (height - pad.top - pad.bottom)
  // The hours along the bottom: every hour, or every two or three when the day is long.
  const hours = (() => {
    const out: number[] = []
    const first = new Date(day.points[0])
    first.setMinutes(0, 0, 0)
    const every = span > 10 * 3_600_000 ? 3 : span > 5 * 3_600_000 ? 2 : 1
    for (let t = first.getTime() + 3_600_000; t < day.points[day.points.length - 1] - 1_200_000; t += every * 3_600_000) out.push(t)
    return out
  })()
  const change = day.worked - day.yesterday

  return (
    <section className="activity-panel" aria-label="Agent activity today">
      <header>
        <h2>Agent activity</h2>
        <span className="activity-total num">{duration(day.worked)} today</span>
        {day.yesterday > 0 || day.worked > 0 ? <span className={`activity-change num${change >= 0 ? ' up' : ' down'}`}>{change >= 0 ? '+' : '−'}{duration(Math.abs(change))} on yesterday by now</span> : null}
        <span className="activity-used num" title={usageHelp}>{day.tokens ? `${compact(day.tokens)} tokens` : 'No tokens reported yet'}{day.cost > 0 ? ` · ≈ $${day.cost.toFixed(2)} at API prices` : ''}</span>
      </header>
      <div className="activity-chart" ref={box}>
        {day.series.length ? (
          <svg width={width} height={height + 22} role="img" aria-label={day.series.map((s) => `${s.agent.name}: ${duration(s.worked)} today`).join(', ')}>
            {[0.25, 0.5, 0.75, 1].map((v) => <line key={v} x1={pad.left} x2={width - pad.right} y1={y(v)} y2={y(v)} className="activity-guide" />)}
            <line x1={pad.left} x2={width - pad.right} y1={y(0)} y2={y(0)} className="activity-floor" />
            {day.series.map((s) => {
              const pts = day.points.map((t, i) => [x(t), y(s.values[i])] as const)
              const line = smooth(pts, y(0))
              const last = pts[pts.length - 1]
              return (
                <g key={s.agent.id}>
                  <path d={`${line} L ${last[0]} ${y(0)} L ${pts[0][0]} ${y(0)} Z`} fill={s.colour} opacity={0.07} />
                  <path d={line} fill="none" stroke={s.colour} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
                  <circle cx={last[0]} cy={last[1]} r={3.5} fill={s.colour} />
                </g>
              )
            })}
            {hours.map((t) => <text key={t} x={x(t)} y={height + 16} className="activity-hour" textAnchor="middle">{new Date(t).toLocaleTimeString([], { hour: 'numeric' })}</text>)}
            <text x={width - pad.right} y={height + 16} className="activity-hour now" textAnchor="end">Now</text>
          </svg>
        ) : (
          <p className="activity-empty">No agent has worked on your boards today.</p>
        )}
      </div>
      {day.series.length > 0 && (
        <ul className="activity-legend">
          {day.series.map((s) => (
            <li key={s.agent.id}>
              <i style={{ background: s.colour }} />
              <AgentAvatar agent={s.agent} size={18} />
              <b>{s.agent.name}</b>
              <span className="num" title={usageHelp}>{duration(s.worked)}{s.tokens ? ` · ${compact(s.tokens)} tokens` : ''}{s.cost ? ` · ≈ $${s.cost.toFixed(2)}` : ''}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

/** A curve through the points, Catmull-Rom style, that never dips below the floor. */
function smooth(points: (readonly [number, number])[], floor: number) {
  if (!points.length) return ''
  let d = `M ${points[0][0]} ${points[0][1]}`
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i - 1] ?? points[i]
    const p1 = points[i]
    const p2 = points[i + 1]
    const p3 = points[i + 2] ?? p2
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, Math.min(floor, p1[1] + (p2[1] - p0[1]) / 6)]
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, Math.min(floor, p2[1] - (p3[1] - p1[1]) / 6)]
    d += ` C ${c1[0]} ${c1[1]}, ${c2[0]} ${c2[1]}, ${p2[0]} ${p2[1]}`
  }
  return d
}
