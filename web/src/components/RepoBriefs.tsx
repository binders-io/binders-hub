import { useState, type FormEvent } from 'react'
import { BookOpen, FileText, Plus, RefreshCw, X } from 'lucide-react'
import { call } from '../data/api'
import { useStore } from '../data/store'
import { atLeast, briefsSince } from '../../../shared/agents.ts'
import { briefId, briefOf, lessonMost, type Agent, type RepoBrief } from '../../../shared/work.ts'
import { briefText, docsFolderName, repoDocs } from '../../../shared/briefs.ts'
import { headOf } from '../data/noteText'
import { href } from '../route'
import { Status, type Tone } from '../kit'
import { ago } from './bits'
import { attempt } from './Toast'
import { ConfirmButton } from './ConfirmButton'

/** The repos this binder works in, as the hub counts them: its projects', its agents', its pull requests'. */
export function reposOf(state: { binders: { repo?: string; repos?: string[] }[]; agents: Agent[]; pulls: { repo: string }[]; briefs?: RepoBrief[] }) {
  const all = [...state.binders.flatMap((b) => [b.repo, ...(b.repos ?? [])]), ...state.agents.filter((a) => !a.revoked).flatMap((a) => a.repos), ...state.pulls.map((p) => p.repo), ...(state.briefs ?? []).map((b) => b.repo)]
  const seen = new Map<string, string>()
  for (const repo of all) if (repo && /^[\w.-]+\/[\w.-]+$/.test(repo) && !seen.has(briefId(repo))) seen.set(briefId(repo), repo)
  return [...seen.values()].sort((a, b) => a.localeCompare(b))
}

/**
 * A brief's words, for showing it has some. A brief kept in a note whose text this browser doesn't hold has how the note
 * starts, which is as much as a row says of it: its words are in the note, which is a click away.
 */
export function briefWords(state: Parameters<typeof briefText>[0], brief: RepoBrief | undefined) {
  const note = brief?.noteId ? state.notes.find((n) => n.id === brief.noteId) : undefined
  if (!note?.left) return briefText(state, brief)
  return headOf(note).replace(/^\s*#\s+[^\n]*\n+/, '').trim() || undefined
}

/** "3h ago", "just now", "on Nov 1". */
export const when = (iso?: string) => {
  const said = ago(iso)
  return said === 'now' ? 'just now' : /^\d+[smh]$/.test(said) ? `${said} ago` : `on ${said}`
}

const path = (repo: string) => `/api/briefs/${repo.split('/').map(encodeURIComponent).join('/')}`

/** How a repo's brief stands, in a word for a table and a line for its dialog. */
export interface BriefState {
  brief?: RepoBrief
  text?: string
  tone: Tone
  word: string
  line: string
  /** Being written, or about to be: nothing to ask for meanwhile. */
  pending: boolean
}

export function briefState(state: Parameters<typeof briefWords>[0] & { briefs?: RepoBrief[]; agents: Agent[] }, repo: string): BriefState {
  const brief = briefOf(state, repo)
  const text = briefWords(state, brief)
  const name = (id?: string) => state.agents.find((a) => a.id === id)?.name ?? id ?? 'an agent'
  const ask = brief?.ask
  const pending = !!ask && (ask.state === 'asked' || ask.state === 'writing')
  if (pending) return { brief, text, pending, tone: 'running', word: ask.state === 'asked' ? 'Asked for' : 'Being written', line: `${name(ask.agentId)} is ${ask.state === 'asked' ? 'about to write' : 'writing'} it${ask.doing ? `: ${ask.doing}` : '.'}` }
  if (text && brief) return { brief, text, pending, tone: 'ok', word: 'Written', line: `Written ${when(brief.writtenAt)} by ${name(brief.writtenBy)}${brief.sha ? ` from ${brief.sha.slice(0, 7)}` : ''}.` }
  if (ask?.state === 'failed') return { brief, text, pending, tone: 'bad', word: 'Failed', line: 'No brief yet: the last try didn’t finish.' }
  return { brief, text, pending, tone: 'off', word: 'None', line: 'No brief yet: the first agent to work here writes it.' }
}

/**
 * A repo's brief: what agents are told about it before they work or review there. An agent writes it the first time one
 * needs it and again as the repo moves on; here a person reads it, has it written now, adds what agents should know
 * meanwhile, or forgets it.
 */
export function RepoBrief({ repo }: { repo: string }) {
  const { state } = useStore()
  const stands = briefState(state, repo)
  const { brief, text, pending } = stands
  const docs = repoDocs(state, repo, brief).length
  const agents = state.agents
  const [agentId, setAgentId] = useState('')
  const [lesson, setLesson] = useState('')
  const name = (id?: string) => agents.find((a) => a.id === id)?.name ?? id ?? 'an agent'
  const able = agents.filter((a) => !a.revoked && (!a.repos.length || a.repos.some((r) => briefId(r) === briefId(repo))))
  const ask = brief?.ask
  const write = () => void attempt(() => call('POST', `${path(repo)}/ask`, { agentId: agentId || undefined, refresh: !!text }))
  const addLesson = (event: FormEvent) => {
    event.preventDefault()
    if (!lesson.trim()) return
    void attempt(() => call('POST', `${path(repo)}/lessons`, { text: lesson })).then(() => setLesson(''))
  }
  const id = briefId(repo).replace(/[^a-z0-9]+/g, '-')
  return (
    <div className="brief-card">
      <div className="brief-head">
        <Status tone={stands.tone}>{stands.word}</Status>
        <p className={pending ? 'brief-status live' : 'brief-status'} aria-live="polite">{stands.line}</p>
      </div>
      {ask?.state === 'failed' && <p className="brief-status bad">Last try: {ask.failed}</p>}
      {text && brief?.noteId && (
        <a className="brief-note" href={href({ screen: 'notes', id: brief.noteId })}><FileText size={14} aria-hidden="true" /> Read it in {docsFolderName} / {repo}{docs ? `, with ${docs} more note${docs === 1 ? '' : 's'} agents get` : ''}</a>
      )}
      {text && !brief?.noteId && (
        <details className="brief-text">
          <summary>Read it ({text.length.toLocaleString()} characters)</summary>
          <pre>{text}</pre>
        </details>
      )}
      {!pending && (
        <div className="brief-write">
          <label className="field">
            <span className="field-label">Written by</span>
            <select id={`brief-agent-${id}`} value={agentId} onChange={(e) => setAgentId(e.target.value)}>
              <option value="">Any agent that can</option>
              {able.map((a) => {
                const old = !atLeast(a.runnerSeen?.version, briefsSince)
                return <option key={a.id} value={a.id} disabled={old}>{a.name}{old ? ` (needs runner ${briefsSince})` : ''}</option>
              })}
            </select>
          </label>
          <button type="button" className="button" onClick={write} disabled={!able.length}>{text ? <><RefreshCw size={14} aria-hidden="true" /> Write it again</> : <><BookOpen size={14} aria-hidden="true" /> Write it now</>}</button>
        </div>
      )}
      <div className="brief-lessons">
        <span className="field-label" id={`brief-lessons-${id}`}>Learned since{text ? ' it was written' : ''}</span>
        {brief?.lessons?.length ? (
          <ul aria-labelledby={`brief-lessons-${id}`}>
            {brief.lessons.map((l) => (
              <li key={l.at}>
                <span>{l.text} <span className="faint">({name(l.by)}, {when(l.at)})</span></span>
                <button type="button" className="icon-button" aria-label="Remove this lesson" title="Remove" onClick={() => void attempt(() => call('DELETE', `${path(repo)}/lessons/${encodeURIComponent(l.at)}`))}><X size={13} /></button>
              </li>
            ))}
          </ul>
        ) : <p className="faint">Nothing yet. Agents add what they learn here as they work; it’s folded in when the brief is next written.</p>}
        <form className="brief-lesson-add" onSubmit={addLesson}>
          <input id={`brief-lesson-${id}`} className="input" aria-label={`Something agents should know about ${repo}`} value={lesson} maxLength={lessonMost} onChange={(e) => setLesson(e.target.value)} placeholder="Something agents should know, in one line" />
          <button type="submit" className="button" disabled={!lesson.trim()}><Plus size={14} aria-hidden="true" /> Add</button>
        </form>
      </div>
      {brief && !pending && (
        <div className="brief-forget">
          <ConfirmButton className="text-button danger" question="Forget the brief and its lessons? Press again" onConfirm={() => void attempt(() => call('DELETE', path(repo)))}>Forget this brief</ConfirmButton>
        </div>
      )}
    </div>
  )
}
