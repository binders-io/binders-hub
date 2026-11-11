import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react'
import { ArrowUp, LoaderCircle, Trash2 } from 'lucide-react'
import type { Agent } from '../data/model'
import type { Note } from '../../../shared/notes.ts'
import { call } from '../data/api'
import { isListening, nameFor, useActions, useHub, usePresence } from '../data/store'
import { AgentAvatar, Who, ago } from './bits'
import { attempt } from './Toast'
import { ConfirmButton } from './ConfirmButton'
import { citeMark, Rendered } from './Rendered'
import { SettingsLink } from './SettingsLink'
import { isModelAgent, modelReady } from './modelAgent'
import { href } from '../route'
import { useMayChangeBinder } from '../screens/settings/access'

/** Who the picker names when it's the hub's own model that answers, not an agent. */
const hub = 'hub'

/** What the hub answered about a note: its words with the numbers of the sources they rest on, and the sources. */
interface Answered {
  answer?: { text: string; parts: { text: string; sources: number[] }[] }
  sources: { n: number; title: string; url: string; binder: string }[]
  problem?: string
}

/** One message in a chat with the hub: what the person asked, or what the hub answered, with its sources. */
interface HubMessage {
  by: 'you' | 'hub'
  text: string
  at: string
  parts?: { text: string; sources: number[] }[]
  sources?: Answered['sources']
}

/** The chats with the hub about each note, as this visit has had them: the hub keeps none, so closing the panel doesn't lose one but a reload does. */
const hubChats = new Map<string, HubMessage[]>()

/** How many exchanges go along with a new question, and the most of each that does. */
const taken = 6
const cutAt = 1200

/** A source's address as this tab opens it: in place when it's in this page's Binder, else the hub's address for it. */
function linkOf(url: string) {
  try {
    const found = new URL(url)
    if (found.origin === window.location.origin && found.pathname === window.location.pathname) return found.hash
  } catch {
    // Not a full address: as it is.
  }
  return url
}

/**
 * Talking about the note open beside it, with an agent or with the hub. An agent is as a manager is: it reads the note,
 * changes it, makes cards or looks at the code, and answers here, in one chat for each note and agent, kept by the hub.
 * The hub's own model, when it has one, answers from the note and the rest of the Binder with its sources, and only
 * reads: it's who answers when no agent is listening.
 */
export function NoteChat({ note, agents: given, initial, onFocusChange }: { note: Pick<Note, 'id'>; agents: Agent[]; initial?: Agent; /** Whether the message box has focus: on a phone the page makes room for the keyboard while it does. */ onFocusChange?: (focused: boolean) => void }) {
  const store = useActions()
  const allAgents = useHub((state) => state.agents)
  const login = useHub((state) => state.me?.user.login ?? '')
  // A reader asks the hub about the note: an agent in a chat would change things, which they can't.
  const reads = !useMayChangeBinder()
  const agents = reads ? [] : given
  usePresence()
  const [picked, setPicked] = useState<string>()
  // Whether the hub has a model of its own to answer with: not known until it has said.
  const [model, setModel] = useState<boolean>()
  useEffect(() => {
    void call<{ brain?: { inUse?: string } }>('GET', '/api/brain').then((r) => setModel(!!r?.brain?.inUse)).catch(() => setModel(false))
  }, [])
  const anyListening = agents.some((a) => isListening(a))
  // The hub answers when it's chosen, or when nothing was chosen and no agent is listening.
  const withHub = !!model && (picked === hub || (picked === undefined && !anyListening) || reads)
  const agent = withHub ? undefined : agents.find((a) => a.id === (picked ?? initial?.id)) ?? agents[0]
  const chat = useHub((state) => (agent ? (state.chats ?? []).find((c) => c.id === `chat-${note.id}-${agent.id}`) : undefined))
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [said, setSaid] = useState<HubMessage[]>(() => hubChats.get(note.id) ?? [])
  /** The question the hub is answering, shown where its answer will be. */
  const [asking, setAsking] = useState<{ text: string; at: string }>()
  const list = useRef<HTMLOListElement>(null)
  const box = useRef<HTMLTextAreaElement>(null)
  const waiting = !!chat?.messages.length && chat.messages[chat.messages.length - 1].by !== agent?.id
  // One the hub runs as a model has no runner to be listening: it picks a chat up when it's able to.
  const listening = agent ? (isModelAgent(agent) ? modelReady(agent) : isListening(agent)) : false
  const busy = useHub((state) => (agent ? state.cards.find((c) => c.agentId === agent.id && c.stage === 'working') : undefined))

  useEffect(() => {
    list.current?.scrollTo({ top: list.current.scrollHeight, behavior: 'smooth' })
  }, [chat?.messages.length, chat?.doing, said.length, asking])

  // The box grows with what's typed, from two lines to about six, then scrolls: as the Brain's does.
  useLayoutEffect(() => {
    const field = box.current
    if (!field) return
    field.style.height = 'auto'
    const style = window.getComputedStyle(field)
    const line = parseFloat(style.lineHeight) || 20
    const room = (parseFloat(style.paddingTop) || 0) + (parseFloat(style.paddingBottom) || 0)
    field.style.height = `${Math.min(Math.max(field.scrollHeight, line * 2 + room), line * 6 + room)}px`
  }, [text])

  const send = async (event?: FormEvent) => {
    event?.preventDefault()
    if (!text.trim() || sending) return
    if (withHub) return askHub(text.trim())
    if (!agent) return
    setSending(true)
    const sent = await attempt(() => call('POST', `/api/notes/${note.id}/chat`, { agentId: agent.id, text }))
    setSending(false)
    if (sent) setText('')
  }

  /** The question goes to the hub with the last few exchanges of this chat, and its answer comes back here with its sources. */
  const askHub = async (question: string) => {
    setSending(true)
    setAsking({ text: question, at: new Date().toISOString() })
    const before = said.slice(-taken * 2).map((m) => ({ role: m.by === 'you' ? 'user' : 'assistant', text: (m.parts ? m.parts.map((p) => p.text).join('').trim() : m.text).slice(0, cutAt) }))
    const result = await attempt(() => call<Answered>('POST', `/api/notes/${encodeURIComponent(note.id)}/ask`, { question, turns: before }))
    setSending(false)
    setAsking(undefined)
    // One that failed said why, and what was typed stays to try again.
    if (!result) return
    const at = new Date().toISOString()
    const answer = result.answer?.parts.length ? result.answer : undefined
    const reply: HubMessage = answer
      ? { by: 'hub', text: answer.text, at, parts: answer.parts, sources: result.sources }
      : { by: 'hub', text: result.problem ? `I couldn’t answer: ${result.problem}` : 'I couldn’t answer that.', at }
    const next = [...said, { by: 'you' as const, text: question, at }, reply]
    hubChats.set(note.id, next)
    setSaid(next)
    setText('')
  }

  const startOver = () => {
    hubChats.delete(note.id)
    setSaid([])
  }

  if (!agents.length && !model) {
    if (reads) return model === undefined ? null : <p className="distill-with">The hub has no model of its own to answer with yet. An admin can give it one in <SettingsLink section="brain" />.</p>
    return model === undefined ? null : <p className="distill-with">Set up an agent in <a href={href({ screen: 'agents' })}>Agents</a> to talk with it about this note, or an admin can give the hub a model of its own in <SettingsLink section="brain" />.</p>
  }

  const name = withHub ? 'The hub' : agent?.name
  const hasChat = withHub ? said.length > 0 : !!chat?.messages.length

  return (
    <div className="note-chat">
      <div className="distill-with">
        <label className="chat-agent">
          {withHub ? <Who id="hub" size={18} /> : <AgentAvatar agent={agent} size={18} />}
          <select id="chat-agent" aria-label="Who to talk with" value={withHub ? hub : agent?.id ?? ''} onChange={(e) => setPicked(e.target.value)}>
            {agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            {model && <option value={hub}>The hub</option>}
          </select>
        </label>
        {hasChat ? <ConfirmButton className="icon-button" question="Clear this chat? Press again" label="Start over" title="Start over: clear this chat" onConfirm={() => (withHub ? startOver() : chat && store.clearChat(chat.id))}><Trash2 size={13} /></ConfirmButton> : null}
      </div>
      {withHub && <p className="chat-reads faint">It reads the note and your binder, and can’t change the note.{reads ? '' : agents.length ? ' Pick an agent for that.' : <> Set up an agent in <a href={href({ screen: 'agents' })}>Agents</a> for that.</>}</p>}
      {model === false && !anyListening && <p className="chat-reads faint">No agent is listening, and the hub has no model of its own. Start an agent’s runner in <a href={href({ screen: 'agents' })}>Agents</a>, or an admin can set the hub’s model up in <SettingsLink section="brain" />.</p>}
      <ol className="chat-messages" ref={list}>
        {withHub && !said.length && !asking && (
          <li className="chat-empty">
            Ask the hub about this note: “what’s still open here?”, “where else do we talk about this?”.
          </li>
        )}
        {!withHub && !chat?.messages.length && (
          <li className="chat-empty">
            Ask {agent?.name} about this note, or to change it: “tighten the second section”, “turn the open questions into cards”, “check this against the code”.
          </li>
        )}
        {!withHub && chat?.messages.map((m, i) => (
          <li key={i} className={m.by === agent?.id ? 'from-agent' : 'from-person'}>
            {m.by === agent?.id ? <AgentAvatar agent={agent} size={20} /> : <Who id={m.by} size={20} />}
            <div>
              <span className="chat-who"><b>{nameFor({ agents: allAgents }, m.by)}</b> <time>{ago(m.at)}</time></span>
              <p>{m.text}</p>
            </div>
          </li>
        ))}
        {withHub && [...said, ...(asking ? [{ by: 'you' as const, ...asking }] : [])].map((m, i) => (
          <li key={i} className={m.by === 'hub' ? 'from-agent' : 'from-person'}>
            <Who id={m.by === 'hub' ? hub : login} size={20} />
            <div>
              <span className="chat-who"><b>{m.by === 'hub' ? 'The hub' : nameFor({ agents: allAgents }, login)}</b> <time>{ago(m.at)}</time></span>
              {m.parts ? (
                <>
                  <Rendered
                    compact
                    text={m.parts.map((part) => part.text.replace(/\s*$/, (space) => `${part.sources.map(citeMark).join('')}${space}`)).join('')}
                    cite={(n) => {
                      const found = m.sources?.find((s) => s.n === n)
                      return <a className="chat-cite" href={found ? linkOf(found.url) : undefined} title={found?.title} aria-label={`Source ${n}${found ? `: ${found.title}` : ''}`}>{n}</a>
                    }}
                  />
                  {!!m.sources?.length && (
                    <p className="chat-sources faint">
                      Sources: {m.sources.map((s, k) => <span key={s.n}>{k ? ' · ' : ''}<a href={linkOf(s.url)}>{s.n} {s.title}</a></span>)}
                    </p>
                  )}
                </>
              ) : <p>{m.text}</p>}
            </div>
          </li>
        ))}
        {withHub && asking && (
          <li className="from-agent thinking">
            <Who id={hub} size={20} />
            <div>
              <p><LoaderCircle size={12} className="spin" /> Reading the note and your binder…</p>
            </div>
          </li>
        )}
        {!withHub && waiting && (
          <li className="from-agent thinking">
            <AgentAvatar agent={agent} size={20} live />
            <div>
              <p><LoaderCircle size={12} className="spin" /> {chat?.working ? (chat.doing ?? 'Working…') : listening ? 'Picking it up…' : busy ? `${agent?.name} is busy on “${busy.title}”. A runner from this version answers chats while it works; restart it from Agents.` : `${agent?.name} isn’t listening: it answers once its runner is started.`}</p>
            </div>
          </li>
        )}
      </ol>
      <form className="chat-input" onSubmit={send}>
        <div className="ask-box">
          <textarea
            id="chat-text"
            ref={box}
            rows={2}
            value={text}
            placeholder={`Message ${name ?? 'the agent'}…`}
            aria-label={`Message ${name ?? 'the agent'}`}
            onChange={(e) => setText(e.target.value)}
            onFocus={() => onFocusChange?.(true)}
            onBlur={() => onFocusChange?.(false)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send() } }}
          />
          {/* Pressing it keeps focus in the box, so on a phone the keyboard stays and the page doesn't move from under the finger. */}
          <button type="submit" className="ask-send" onMouseDown={(e) => e.preventDefault()} disabled={!text.trim() || sending} aria-label="Send">{sending ? <LoaderCircle size={16} className="spin" /> : <ArrowUp size={16} strokeWidth={2.6} />}</button>
        </div>
      </form>
    </div>
  )
}
