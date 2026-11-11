import { useEffect, useRef, useState } from 'react'
import { Check, Copy, LoaderCircle } from 'lucide-react'
import { call, isNetworkFailure, unreachable } from '../data/api'
import { isListening, useStore, usePresence } from '../data/store'
import { toolInfo } from '../../../shared/agents.ts'
import { failure } from './Toast'

interface JoinLine {
  expiresAt: string
  command: { unix: string; windows: string }
}

/**
 * When a line runs out, in words: "tomorrow at 2:30 PM". A line is good for a day, so it's nearly always tomorrow, but
 * a hub that keeps them for less or more still reads right.
 */
export function until(expiresAt: string, now = new Date()) {
  const at = new Date(expiresAt)
  if (Number.isNaN(at.getTime())) return ''
  const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  const days = Math.round((day(at) - day(now)) / 86_400_000)
  const when = days <= 0 ? 'today' : days === 1 ? 'tomorrow' : at.toLocaleDateString([], { weekday: 'long' })
  return `${when} at ${at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`
}

/**
 * Adding a machine, as a step of adding an agent: the hub makes one line to paste in a terminal on each machine, in the
 * folder with the code, and each machine that runs it shows here as it joins. A machine that joins is an ordinary agent
 * of yours, so what joined is the agents that weren't there when this opened. The line carries a secret for a day: it's
 * shown, since it has to be copied, and kept in this component's state alone, never in an address, a toast or the
 * browser's storage.
 */
export function MachineLine() {
  const { state } = useStore()
  usePresence()
  const [line, setLine] = useState<JoinLine>()
  const [problem, setProblem] = useState<string>()
  const [windows, setWindows] = useState(() => /Windows/.test(navigator.userAgent))
  const [copied, setCopied] = useState(false)
  // What was already there, so only a machine that joins from now on is listed.
  const [before] = useState(() => new Set(state.agents.map((a) => a.id)))
  const asked = useRef(false)

  const ask = async () => {
    setProblem(undefined)
    try {
      const made = await call<JoinLine | undefined>('POST', '/api/agents/join-line')
      if (!made?.command) throw new Error('The hub didn’t make a line. Try again.')
      setLine(made)
    } catch (error) {
      // A hub that can't add machines says why in words made to be shown as they are.
      setProblem(isNetworkFailure(error) ? unreachable : (error as Error).message)
    }
  }
  // Asked once as it opens, though a development build runs effects twice: each ask makes a line.
  useEffect(() => {
    if (asked.current) return
    asked.current = true
    void ask()
  }, [])

  const login = state.me?.user.login.toLowerCase()
  const joined = state.agents.filter((a) => !a.revoked && !before.has(a.id) && !!login && a.owner.toLowerCase() === login)
  const last = joined.at(-1)
  const lastWords = last && `${last.name} joined${isListening(last) ? ' and is listening for work' : ', and isn’t listening yet'}.`
  // Said politely by a screen reader as it changes, since a machine joining comes with no action of the person's.
  const announced = copied ? 'Copied. Paste it in a terminal on each machine.' : last ? `${joined.length > 1 ? `${joined.length} machines joined. ` : ''}${lastWords}` : ''

  const text = line && (windows ? line.command.windows : line.command.unix)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text ?? '')
    } catch {
      failure('Couldn’t copy it: select it and copy it yourself.')
      return
    }
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1600)
  }

  return (
    <div className="add-machine">
      {problem ? (
        <div className="add-machine-problem">
          <p role="alert">{problem}</p>
          <button type="button" className="button" onClick={() => void ask()}>Try again</button>
        </div>
      ) : !line ? (
        <p className="add-machine-wait" role="status"><LoaderCircle size={14} className="spin" aria-hidden="true" /> Making the line…</p>
      ) : (
        <>
          <div className="segmented" role="radiogroup" aria-label="What it runs on">
            <button type="button" role="radio" aria-checked={!windows} className={!windows ? 'on' : ''} onClick={() => setWindows(false)}>macOS or Linux</button>
            <button type="button" role="radio" aria-checked={windows} className={windows ? 'on' : ''} onClick={() => setWindows(true)}>Windows</button>
          </div>
          <div className="command">
            <pre className="mono">{text}</pre>
            <button type="button" className="icon-button" onClick={() => void copy()} aria-label="Copy the line" title="Copy the line">{copied ? <Check size={14} /> : <Copy size={14} />}</button>
          </div>
          <p className="add-machine-note">It works for a day: anyone with this line can add a machine as you until {until(line.expiresAt)}.{state.me?.hubAdmin && ' You’re a hub admin, so each machine’s models are lent to the hub’s brain too.'}</p>
        </>
      )}
      <section className="add-machine-joined" aria-label="Machines that joined">
        <h4>Machines that joined</h4>
        {joined.length ? (
          <ul className="joined-list">
            {joined.map((agent) => {
              const listening = isListening(agent)
              const workspace = agent.runner?.workspace
              return (
                <li key={agent.id}>
                  <div>
                    <b>{agent.name}</b>
                    <span className="joined-where">{workspace ? <>Works in <span className="mono">{workspace}</span></> : agent.runsOn ? `On ${agent.runsOn}` : `${toolInfo(agent.runner?.tool ?? 'claude').name}`}</span>
                  </div>
                  <span className={`joined-state${listening ? ' on' : ''}`}>
                    {listening ? <Check size={13} strokeWidth={3} aria-hidden="true" /> : <LoaderCircle size={13} className="spin" aria-hidden="true" />}
                    {listening ? 'Listening' : 'Not listening yet'}
                  </span>
                </li>
              )
            })}
          </ul>
        ) : (
          <p className="add-machine-wait"><LoaderCircle size={14} className="spin" aria-hidden="true" /> Waiting for one to run it…</p>
        )}
      </section>
      <p className="sr-only" role="status">{announced}</p>
    </div>
  )
}
