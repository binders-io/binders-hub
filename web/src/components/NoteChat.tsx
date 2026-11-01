import { useEffect, useRef, useState, type FormEvent } from 'react'
import { LoaderCircle, Send, Trash2 } from 'lucide-react'
import type { Agent } from '../data/model'
import type { Note } from '../../../shared/notes.ts'
import { call } from '../data/api'
import { isListening, nameFor, useActions, useHub, usePresence } from '../data/store'
import { AgentAvatar, Who, ago } from './bits'
import { attempt } from './Toast'
import { href } from '../route'

/**
 * Talking with an agent about the note open beside it, as with a manager: it reads the note, changes it, makes cards or
 * looks at the code, and answers here. One chat for each note and agent, kept by the hub.
 */
export function NoteChat({ note, agents, initial }: { note: Pick<Note, 'id'>; agents: Agent[]; initial?: Agent }) {
  const store = useActions()
  const allAgents = useHub((state) => state.agents)
  usePresence()
  const [agentId, setAgentId] = useState(initial?.id ?? agents[0]?.id ?? '')
  const agent = agents.find((a) => a.id === agentId) ?? agents[0]
  const chat = useHub((state) => (agent ? (state.chats ?? []).find((c) => c.id === `chat-${note.id}-${agent.id}`) : undefined))
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const list = useRef<HTMLOListElement>(null)
  const waiting = !!chat?.messages.length && chat.messages[chat.messages.length - 1].by !== agent?.id
  const listening = agent ? isListening(agent) : false
  const busy = useHub((state) => (agent ? state.cards.find((c) => c.agentId === agent.id && c.stage === 'working') : undefined))

  useEffect(() => {
    list.current?.scrollTo({ top: list.current.scrollHeight, behavior: 'smooth' })
  }, [chat?.messages.length, chat?.doing])

  const send = async (event?: FormEvent) => {
    event?.preventDefault()
    if (!agent || !text.trim() || sending) return
    setSending(true)
    const sent = await attempt(() => call('POST', `/api/notes/${note.id}/chat`, { agentId: agent.id, text }))
    setSending(false)
    if (sent) setText('')
  }

  if (!agents.length) return <p className="distill-with">Set up an agent in <a href={href({ screen: 'agents' })}>Agents</a> to talk with it about this note.</p>

  return (
    <div className="note-chat">
      <label className="distill-with">
        <AgentAvatar agent={agent} size={18} />
        <select id="chat-agent" value={agent?.id ?? ''} onChange={(e) => setAgentId(e.target.value)}>
          {agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
        </select>
        {chat?.messages.length ? <button type="button" className="icon-button" title="Start over" aria-label="Start over" onClick={() => store.clearChat(chat.id)}><Trash2 size={13} /></button> : null}
      </label>
      <ol className="chat-messages" ref={list}>
        {!chat?.messages.length && (
          <li className="chat-empty">
            Ask {agent?.name} about this note, or to change it: “tighten the second section”, “turn the open questions into cards”, “check this against the code”.
          </li>
        )}
        {chat?.messages.map((m, i) => (
          <li key={i} className={m.by === agent?.id ? 'from-agent' : 'from-person'}>
            {m.by === agent?.id ? <AgentAvatar agent={agent} size={20} /> : <Who id={m.by} size={20} />}
            <div>
              <span className="chat-who"><b>{nameFor({ agents: allAgents }, m.by)}</b> <time>{ago(m.at)}</time></span>
              <p>{m.text}</p>
            </div>
          </li>
        ))}
        {waiting && (
          <li className="from-agent thinking">
            <AgentAvatar agent={agent} size={20} live />
            <div>
              <p><LoaderCircle size={12} className="spin" /> {chat?.working ? (chat.doing ?? 'Working…') : listening ? 'Picking it up…' : busy ? `${agent?.name} is busy on “${busy.title}”. A runner from this version answers chats while it works; restart it from Agents.` : `${agent?.name} isn’t listening: it answers once its runner is started.`}</p>
            </div>
          </li>
        )}
      </ol>
      <form className="chat-input" onSubmit={send}>
        <textarea
          id="chat-text"
          rows={2}
          value={text}
          placeholder={`Message ${agent?.name ?? 'the agent'}…`}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send() } }}
        />
        <button className="icon-button send" disabled={!text.trim() || sending} aria-label="Send"><Send size={15} /></button>
      </form>
    </div>
  )
}
