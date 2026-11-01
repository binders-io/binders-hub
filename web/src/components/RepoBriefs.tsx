import { useState, type FormEvent } from 'react'
import { BookOpen, FileText, Plus, RefreshCw, Trash2, X } from 'lucide-react'
import { call } from '../data/api'
import { useStore } from '../data/store'
import { atLeast, briefsSince } from '../../../shared/agents.ts'
import { briefId, briefOf, lessonMost, type Agent, type RepoBrief } from '../../../shared/work.ts'
import { briefText, docsFolderName, repoDocs } from '../../../shared/briefs.ts'
import { href } from '../route'
import { ago } from './bits'
import { attempt } from './Toast'

/** The repos this binder works in, as the hub counts them: its projects', its agents', its pull requests'. */
function reposOf(state: { binders: { repo?: string }[]; agents: Agent[]; pulls: { repo: string }[]; briefs?: RepoBrief[] }) {
  const all = [...state.binders.map((b) => b.repo), ...state.agents.filter((a) => !a.revoked).flatMap((a) => a.repos), ...state.pulls.map((p) => p.repo), ...(state.briefs ?? []).map((b) => b.repo)]
  const seen = new Map<string, string>()
  for (const repo of all) if (repo && /^[\w.-]+\/[\w.-]+$/.test(repo) && !seen.has(briefId(repo))) seen.set(briefId(repo), repo)
  return [...seen.values()].sort((a, b) => a.localeCompare(b))
}

/** "3h ago", "just now", "on Nov 1". */
const when = (iso?: string) => {
  const said = ago(iso)
  return said === 'now' ? 'just now' : /^\d+[smh]$/.test(said) ? `${said} ago` : `on ${said}`
}

const path = (repo: string) => `/api/briefs/${repo.split('/').map(encodeURIComponent).join('/')}`

/**
 * Each repo's brief: what agents are told about it before they work or review there. An agent writes it the first time
 * one needs it and again as the repo moves on; here a person reads it, has it written now, and adds what agents should
 * know meanwhile.
 */
export function RepoBriefs() {
  const { state } = useStore()
  const repos = reposOf(state)
  if (!repos.length) return <p className="faint">No repos yet: link one to this binder or to an agent, and its brief is written the first time an agent works there.</p>
  return (
    <ul className="binder-cards">
      {repos.map((repo) => {
        const brief = briefOf(state, repo)
        return <BriefRow key={briefId(repo)} repo={repo} brief={brief} text={briefText(state, brief)} docs={repoDocs(state, repo, brief).length} agents={state.agents} />
      })}
    </ul>
  )
}

function BriefRow({ repo, brief, text, docs, agents }: { repo: string; brief?: RepoBrief; text?: string; docs: number; agents: Agent[] }) {
  const [agentId, setAgentId] = useState('')
  const [lesson, setLesson] = useState('')
  const name = (id?: string) => agents.find((a) => a.id === id)?.name ?? id ?? 'an agent'
  const able = agents.filter((a) => !a.revoked && (!a.repos.length || a.repos.some((r) => briefId(r) === briefId(repo))))
  const ask = brief?.ask
  const pending = ask && (ask.state === 'asked' || ask.state === 'writing')
  const status = pending
    ? `${name(ask.agentId)} is ${ask.state === 'asked' ? 'about to write' : 'writing'} it${ask.doing ? `: ${ask.doing}` : ''}`
    : text && brief
      ? `Written ${when(brief.writtenAt)} by ${name(brief.writtenBy)}${brief.sha ? ` from ${brief.sha.slice(0, 7)}` : ''}`
      : 'No brief yet: the first agent to work here writes it.'
  const write = () => void attempt(() => call('POST', `${path(repo)}/ask`, { agentId: agentId || undefined, refresh: !!text }))
  const addLesson = (event: FormEvent) => {
    event.preventDefault()
    if (!lesson.trim()) return
    void attempt(() => call('POST', `${path(repo)}/lessons`, { text: lesson })).then(() => setLesson(''))
  }
  const id = briefId(repo).replace(/[^a-z0-9]+/g, '-')
  return (
    <li className="settings-card brief-card">
      <div className="binder-card-head">
        <b className="mono">{repo}</b>
        {brief && !pending && <button className="icon-button" title="Forget this brief and its lessons" aria-label={`Forget ${repo}’s brief`} onClick={() => void attempt(() => call('DELETE', path(repo)))}><Trash2 size={14} /></button>}
      </div>
      <p className={pending ? 'brief-status live' : 'brief-status faint'} aria-live="polite">{status}</p>
      {ask?.state === 'failed' && <p className="brief-status bad">Last try: {ask.failed}</p>}
      {!pending && (
        <div className="brief-write">
          <label className="field-label" htmlFor={`brief-agent-${id}`}>Written by</label>
          <select id={`brief-agent-${id}`} value={agentId} onChange={(e) => setAgentId(e.target.value)}>
            <option value="">Any agent that can</option>
            {able.map((a) => {
              const old = !atLeast(a.runnerSeen?.version, briefsSince)
              return <option key={a.id} value={a.id} disabled={old}>{a.name}{old ? ` (needs runner ${briefsSince})` : ''}</option>
            })}
          </select>
          <button className="button" onClick={write} disabled={!able.length}>{text ? <><RefreshCw size={14} /> Write it again</> : <><BookOpen size={14} /> Write it now</>}</button>
        </div>
      )}
      {text && brief?.noteId && (
        <a className="brief-note" href={href({ screen: 'notes', id: brief.noteId })}><FileText size={14} /> Read it in {docsFolderName} / {repo}{docs ? `, with ${docs} more note${docs === 1 ? '' : 's'} agents get` : ''}</a>
      )}
      {text && !brief?.noteId && (
        <details className="brief-text">
          <summary>Read it ({text.length.toLocaleString()} characters)</summary>
          <pre>{text}</pre>
        </details>
      )}
      <div className="brief-lessons">
        <span className="field-label">Learned since{text ? ' it was written' : ''}</span>
        {brief?.lessons?.length ? (
          <ul>
            {brief.lessons.map((l) => (
              <li key={l.at}>
                <span>{l.text} <span className="faint">({name(l.by)}, {when(l.at)})</span></span>
                <button className="icon-button" aria-label="Remove this lesson" title="Remove" onClick={() => void attempt(() => call('DELETE', `${path(repo)}/lessons/${encodeURIComponent(l.at)}`))}><X size={13} /></button>
              </li>
            ))}
          </ul>
        ) : <p className="faint">Nothing yet. Agents add what they learn here as they work; it’s folded in when the brief is next written.</p>}
        <form className="brief-lesson-add" onSubmit={addLesson}>
          <input id={`brief-lesson-${id}`} aria-label={`Something agents should know about ${repo}`} value={lesson} maxLength={lessonMost} onChange={(e) => setLesson(e.target.value)} placeholder="Something agents should know, in one line" />
          <button className="button" disabled={!lesson.trim()}><Plus size={14} /> Add</button>
        </form>
      </div>
    </li>
  )
}
