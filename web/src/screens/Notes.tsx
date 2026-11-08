import { space } from '../data/space'
import { memo, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { ArrowUpRight, CalendarClock, Check, GitCommitHorizontal, GitPullRequest, LoaderCircle, Lock, ChevronsLeft, ChevronsRight, ExternalLink, Maximize2, MessageSquare, Minimize2, PanelLeft, PanelRight, Sparkles, Trash2, X } from 'lucide-react'
import { stages } from '../data/model'
import { isOnline, nameFor, sameFields, sameValues, useActions, useClock, useHub, useLiveNote, usePresence, type State } from '../data/store'
import { cardPrompt } from '../data/prompts'
import type { Card, Note } from '../data/model'
import { ago, usePhone } from '../components/bits'
import { attempt, toast } from '../components/Toast'
import { call } from '../data/api'
import { NoteControls, useMayChange } from '../components/NoteControls'
import { AgentAvatar, Who, stageTone } from '../components/bits'
import { NoteTree } from '../components/NoteTree'
import { NoteChat } from '../components/NoteChat'
import { poppedOut, popOut, useNotesLayout } from '../components/notesLayout'
import { MarkdownEditor, type EditorHandle } from '../editor/MarkdownEditor'
import { Toolbar } from '../editor/Toolbar'
import type { Marks, WorkMark } from '../editor/workMarks'
import { linksIn, slug } from '../../../shared/notes.ts'
import { cardNumber, changeSetOf } from '../../../shared/work.ts'
import { go, href } from '../route'
import { useUI } from '../ui'
import { openMenu } from '../components/ContextMenu'
import { cardMenuItems } from '../components/CardMenu'
import { ScheduleDialog } from '../components/Schedules'

const spring = { type: 'spring', stiffness: 380, damping: 34 } as const


const lastKey = (binder: string) => `binders-last-note:${binder}`
const lastNote = (binder: string) => {
  try { return window.localStorage.getItem(lastKey(binder)) ?? undefined } catch { return undefined }
}
const rememberNote = (binderId: string, noteId: string) => {
  try {
    window.localStorage.setItem(lastKey(binderId), noteId)
    window.localStorage.setItem(lastKey('all'), noteId)
  } catch { /* only a convenience */ }
}

/** Which note to show: the one asked for, else the one you were last on in this binder, else its first. */
function pick(state: State, id: string, binder: string, last: string | undefined) {
  const inView = (binderId: string) => binder === 'all' || binderId === binder
  const asked = state.notes.find((n) => n.id === id)
  const note = asked ?? state.notes.find((n) => n.id === last && inView(n.binderId)) ?? state.notes.find((n) => inView(n.binderId))
  return { askedBinder: asked?.binderId, noteId: note?.id, noteBinder: note?.binderId }
}

/** A note, the work that came from it marked where it came from, and Distill beside it. */
export function Notes({ id }: { id: string }) {
  const store = useActions()
  const binders = useHub((state) => state.binders)
  const { binder, setBinder } = useUI()
  // Notes from the sidebar opens the note you were last on in this binder, else its first.
  const last = lastNote(binder)
  const phone = usePhone()
  const { askedBinder, noteId, noteBinder } = useHub((state) => pick(state, id, binder, last), sameValues)
  // A note opened from elsewhere (a link, search) takes you into its binder.
  useEffect(() => {
    if (askedBinder && binder !== 'all' && askedBinder !== binder) setBinder(askedBinder)
  }, [askedBinder, binder, setBinder])
  // Remembered for this binder and for all binders, and put in the address so back and reload keep it.
  useEffect(() => {
    if (!noteId || !noteBinder) return
    rememberNote(noteBinder, noteId)
    // On a phone Notes opens on the list, whose address it keeps: picking the note it remembers still goes to it.
    if (!id && !phone) window.history.replaceState(null, '', href({ screen: 'notes', id: noteId }))
  }, [noteId, noteBinder, id, phone])
  if (!noteId) {
    return (
      <div className="notes empty">
        <NoteTree currentId="" />
        <div className="empty-screen">
          <h2>No notes yet</h2>
          <p>{binders.length ? 'Write one, then Distill it into work for your agents.' : 'Make a binder first, in the notes list or in Settings.'}</p>
          {binders[0] && <button className="button primary" onClick={() => go({ screen: 'notes', id: store.addNote(binders[0].id) })}>New note</button>}
        </div>
      </div>
    )
  }
  return <NoteScreen key="note" noteId={noteId} listFirst={!id} />
}

/**
 * What of a note stays put as you type. Everything here is built on this rather than the note itself, so a keystroke
 * reaches the editor and the line over it, and not the list, the chat, or the marks in the editor.
 */
const sameShape = sameFields<Note>('id', 'binderId', 'folderId', 'title')

const isDistill = (title: string) => title.startsWith('Distill “')

function NoteScreen({ noteId, listFirst }: { noteId: string; listFirst: boolean }) {
  const store = useActions()
  const { openItem } = useUI()
  const note = useHub((state) => state.notes.find((n) => n.id === noteId), sameShape)
  const allProposals = useHub((state) => state.proposals)
  const allCards = useHub((state) => state.cards)
  const allAgents = useHub((state) => state.agents)
  const binders = useHub((state) => state.binders)
  const folders = useHub((state) => state.folders)
  const login = useHub((state) => state.me?.user.login)
  const scheduled = useHub((state) => (state.schedules ?? []).filter((x) => x.noteId === noteId && x.enabled).length)
  const ownSet = useHub((state) => {
    const here = state.notes.find((n) => n.id === noteId)
    return !!here && changeSetOf(state, here) === 'own'
  })
  usePresence()
  const proposals = useMemo(() => allProposals.filter((p) => p.noteId === noteId && p.state !== 'dismissed'), [allProposals, noteId])
  const fresh = useMemo(() => proposals.filter((p) => p.state === 'new'), [proposals])
  const items = useMemo(() => allCards.filter((c) => c.noteId === noteId && !isDistill(c.title)), [allCards, noteId])
  const distillCard = useMemo(() => allCards.filter((c) => c.noteId === noteId && isDistill(c.title)).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0], [allCards, noteId])
  const distilling = !!distillCard && distillCard.stage !== 'live'
  const agents = useMemo(() => allAgents.filter((a) => !a.revoked), [allAgents])
  const { layout, change, focus, setFocus, popped, drag } = useNotesLayout()
  const [scheduling, setScheduling] = useState(false)
  // On a phone the notes list opens over the note, and goes once a note is picked.
  const phone = usePhone()
  const [listFor, setListFor] = useState<string | undefined>(phone && listFirst ? noteId : undefined)
  // Notes from the tab bar is the list; a note picked from it, the note.
  useEffect(() => {
    if (phone) setListFor(listFirst ? noteId : undefined)
    // Only when it goes between the two: the list's button opens and closes it in between.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listFirst, phone])
  const listOpen = phone && listFor !== undefined && listFor === noteId
  const [distiller, setDistiller] = useState('')
  const [side, setSide] = useState<'chat' | 'distill'>(() => {
    if (poppedOut() === 'chat') return 'chat'
    try { return window.localStorage.getItem('binders-note-side') === 'distill' ? 'distill' : 'chat' } catch { return 'chat' }
  })
  const chooseSide = (next: 'chat' | 'distill') => {
    setSide(next)
    try { window.localStorage.setItem('binders-note-side', next) } catch { /* only a convenience */ }
  }
  // The one you picked, else one that's listening, else one you set up yourself, else one that says it distills.
  const chosen = agents.find((a) => a.id === distiller)
    ?? agents.find((a) => isOnline(a))
    ?? agents.find((a) => a.owner.toLowerCase() === login?.toLowerCase())
    ?? agents.find((a) => a.skills.some((s) => /distill/i.test(s)))
    ?? agents[0]
  const { discardIfEmpty } = store

  // Leaving a note you never wrote in throws it away, as Notes on the Mac does.
  const previous = useRef(noteId)
  useEffect(() => {
    if (previous.current !== noteId) discardIfEmpty(previous.current)
    previous.current = noteId
  }, [noteId, discardIfEmpty])

  const editor = useRef<EditorHandle>(null)
  const [raw, setRaw] = useState(() => {
    try {
      return window.localStorage.getItem('binders-hub-raw') === '1'
    } catch {
      return false
    }
  })
  const showRaw = (on: boolean) => {
    setRaw(on)
    try {
      window.localStorage.setItem('binders-hub-raw', on ? '1' : '0')
    } catch {
      // For this tab only.
    }
  }

  const mayChange = useMayChange(note ?? { id: noteId })
  if (!note) return null

  const binder = binders.find((b) => b.id === note.binderId)
  const trail: string[] = []
  let folder = folders.find((f) => f.id === note.folderId)
  while (folder) {
    trail.unshift(folder.name)
    folder = folders.find((f) => f.id === folder!.parentId)
  }
  const path = ['notes', binder?.name ?? '', ...trail].map(slug).join('/') + `/${slug(note.title)}.md`

  const showTree = phone ? listOpen : focus === 'none' && layout.treeOpen
  const showNote = focus !== 'chat'
  const showSide = focus === 'chat' || (!phone && focus === 'none' && layout.sideOpen)
  const columns = phone || focus === 'note' ? 'minmax(0, 1fr)' : focus === 'chat' ? 'minmax(0, 1fr)'
    : [showTree ? `${layout.tree}px` : '', 'minmax(0, 1fr)', showSide ? (layout.wide ? 'minmax(360px, 50%)' : `${layout.side}px`) : ''].filter(Boolean).join(' ')

  return (
    <div className={`notes${focus !== 'none' ? ` focus-${focus}` : ''}${popped ? ' popped' : ''}${listOpen ? ' list-open' : ''}`} style={{ gridTemplateColumns: columns }}>
      {showTree && <NoteTree currentId={note.id} />}

      {showNote && <article className="note">
        {showTree && !phone && <div className="resize-handle" onPointerDown={drag('tree')} role="separator" aria-orientation="vertical" aria-label="Resize the notes list" />}
        <NoteMeta noteId={note.id} trail={[binder?.name, ...trail].join(' / ')}>
          <span className="view-buttons">
            <NoteControls note={note} mayChange={mayChange} />
            {focus === 'none' && phone && <button type="button" className="icon-button" onClick={() => setListFor(listOpen ? undefined : note.id)} title="Notes" aria-label={listOpen ? 'Hide the notes list' : 'Show the notes list'} aria-expanded={listOpen}><PanelLeft size={15} /></button>}
            {focus === 'none' && !phone && <button type="button" className="icon-button" onClick={() => change({ treeOpen: !layout.treeOpen })} title={layout.treeOpen ? 'Hide the notes list' : 'Show the notes list'} aria-label={layout.treeOpen ? 'Hide the notes list' : 'Show the notes list'}><PanelLeft size={15} /></button>}
            {focus === 'none' && !phone && <button type="button" className="icon-button" onClick={() => change({ sideOpen: !layout.sideOpen })} title={layout.sideOpen ? 'Hide the chat and Distill' : 'Show the chat and Distill'} aria-label={layout.sideOpen ? 'Hide the side panel' : 'Show the side panel'}><PanelRight size={15} /></button>}
            {!popped && <button type="button" className="icon-button" onClick={() => setFocus(focus === 'note' ? 'none' : 'note')} title={focus === 'note' ? 'Leave full screen (Esc)' : 'Full screen'} aria-label={focus === 'note' ? 'Leave full screen' : 'Full screen'}>{focus === 'note' ? <Minimize2 size={15} /> : <Maximize2 size={15} />}</button>}
            <button type="button" className={`icon-button${scheduled ? ' on' : ''}`} onClick={() => setScheduling(true)} title={scheduled ? `Scheduled: ${scheduled} schedule${scheduled === 1 ? '' : 's'}` : 'Schedule it: run this note as a card on a timer'} aria-label="Schedule"><CalendarClock size={15} /></button>
            <button type="button" className={`icon-button${ownSet ? ' on' : ''}`} aria-pressed={ownSet} onClick={() => void attempt(() => call('PUT', `/api/notes/${note.id}/change-set`, { changeSet: ownSet ? 'shared' : 'own' })).then((done) => { if (done !== undefined) toast(ownSet ? 'This note’s work joins the open change set.' : 'This note’s work gets its own change set.') })} title={ownSet ? 'This note’s work gets its own change set. Click to add it to the open one instead.' : 'This note’s work joins the open change set. Click to give it its own.'} aria-label="Own change set"><GitPullRequest size={15} /></button>
            {!popped && <button type="button" className="icon-button" onClick={() => popOut('note', note.id)} title="Open in a window of its own" aria-label="Pop out"><ExternalLink size={15} /></button>}
          </span>
          <DeleteNote onDelete={() => {
            // The note next to it in the same binder opens, else the first anywhere.
            const rest = store.current().notes.filter((n) => n.id !== note.id)
            const next = rest.find((n) => n.binderId === note.binderId && n.folderId === note.folderId) ?? rest.find((n) => n.binderId === note.binderId) ?? rest[0]
            store.deleteNote(note.id)
            go({ screen: 'notes', id: next?.id })
          }} />
        </NoteMeta>
        <div className="note-path mono" title="Where the hub keeps this note">{space || 'notes'}/{path}</div>
        {note.locked && !mayChange && <p className="note-locked"><Lock size={13} /> Locked by @{note.locked.by}. Use the versions button to propose a change for review.</p>}
        {mayChange && <Toolbar editor={editor} raw={raw} onRaw={showRaw} />}
        <NoteEditor key={`${note.id}:${mayChange ? 'edit' : 'read'}`} noteId={note.id} binderId={note.binderId} folderId={note.folderId} editor={editor} raw={raw} readOnly={!mayChange} />
        <Backlinks noteId={note.id} title={note.title} />
      </article>}

      {showSide && <aside className="distill" aria-label="Beside the note">
        {focus === 'none' && <div className="resize-handle" onPointerDown={drag('side')} onDoubleClick={() => change({ wide: !layout.wide })} role="separator" aria-orientation="vertical" aria-label="Resize the side panel" />}
        <div className="side-head">
          <div className="side-tabs" role="tablist">
            <button role="tab" aria-selected={side === 'chat'} className={side === 'chat' ? 'on' : ''} onClick={() => chooseSide('chat')}><MessageSquare size={14} /> Chat</button>
            <button role="tab" aria-selected={side === 'distill'} className={side === 'distill' ? 'on' : ''} onClick={() => chooseSide('distill')}><Sparkles size={14} /> Distill</button>
          </div>
          {focus === 'none' && <button type="button" className="icon-button" onClick={() => change({ wide: !layout.wide })} title={layout.wide ? 'Narrower' : 'Wider'} aria-label={layout.wide ? 'Narrower' : 'Wider'}>{layout.wide ? <ChevronsRight size={15} /> : <ChevronsLeft size={15} />}</button>}
          {!popped && <button type="button" className="icon-button" onClick={() => { chooseSide('chat'); setFocus(focus === 'chat' ? 'none' : 'chat') }} title={focus === 'chat' ? 'Leave full screen (Esc)' : 'Chat full screen'} aria-label={focus === 'chat' ? 'Leave full screen' : 'Chat full screen'}>{focus === 'chat' ? <Minimize2 size={15} /> : <Maximize2 size={15} />}</button>}
          {!popped && <button type="button" className="icon-button" onClick={() => popOut('chat', note.id)} title="Chat in a window of its own" aria-label="Pop out the chat"><ExternalLink size={15} /></button>}
        </div>
        {focus === 'chat' && <p className="chat-about">About <a href={href({ screen: 'notes', id: note.id })} onClick={() => setFocus('none')}>{note.title}</a></p>}
        {side === 'chat' ? <NoteChat key={note.id} note={note} agents={agents} initial={chosen} /> : <>
        <header>
          <h2><Sparkles size={15} /> Distill</h2>
          <button className="button primary" onClick={() => chosen && void attempt(() => store.distill(note.id, chosen.id))} disabled={distilling || !chosen}>
            {distilling ? 'Reading…' : items.length || proposals.length ? 'Distill again' : 'Distill'}
          </button>
        </header>
        {agents.length ? (
          <label className="distill-with">
            <AgentAvatar agent={chosen} size={18} />
            <select id="distiller" value={chosen?.id ?? ''} onChange={(e) => setDistiller(e.target.value)} disabled={distilling}>
              {agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
            reads the whole note and proposes its work, leaving out what’s on the board.
          </label>
        ) : (
          <p className="distill-with">Set up an agent in <a href={href({ screen: 'agents' })}>Agents</a>, and it can distill this note into work items.</p>
        )}
        {distillCard && distilling && <DistillStatus card={distillCard} />}

        {items.length > 0 && (
          <div className="note-progress">
            <div className="segments">
              {stages.filter((s) => s.id !== 'proposed').map((s) => {
                const n = items.filter((i) => i.stage === s.id).length
                return n ? <motion.i key={s.id} layout className={stageTone[s.id]} style={{ flexGrow: n }} title={`${s.title}: ${n}`} transition={spring} /> : null
              })}
            </div>
            <p className="num">
              {items.length} on the board · {items.filter((i) => i.stage === 'working').length} being worked · {items.filter((i) => i.stage === 'live').length} done
            </p>
          </div>
        )}

        <div className="proposals">
          {fresh.length > 1 && (
            <div className="proposals-head">
              <span>{fresh.length} proposed</span>
              <button className="text-button" onClick={() => void (async () => { for (const p of fresh) await attempt(() => store.acceptProposal(p.id)) })()}>Accept all</button>
            </div>
          )}
          <AnimatePresence initial={false}>
            {proposals.map((p) => {
              const by = allAgents.find((a) => a.id === p.by)
              const meant = allAgents.find((a) => a.id === p.meantFor)
              return (
                <motion.div key={p.id} layout className={`proposal-card ${p.state}`} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={spring}>
                  <div className="card-top">
                    {by && <AgentAvatar agent={by} size={18} />}
                    {meant && <span className="faint">for {meant.name}</span>}
                    <span className="size">{p.size}</span>
                  </div>
                  <h3>{p.title}</h3>
                  <q>{p.quote}</q>
                  {p.state === 'new' ? (
                    <div className="proposal-actions">
                      <button className="mini-button primary" onClick={() => void attempt(() => store.acceptProposal(p.id))}><Check size={12} strokeWidth={3} /> Accept</button>
                      <button className="mini-button" onClick={() => store.dismissProposal(p.id)}><X size={12} strokeWidth={3} /> Dismiss</button>
                    </div>
                  ) : (
                    <button className="on-board" onClick={() => p.cardId && openItem(p.cardId)}>
                      <Check size={12} strokeWidth={3} /> On the board
                    </button>
                  )}
                </motion.div>
              )
            })}
          </AnimatePresence>
          {!proposals.length && !distilling && <p className="distill-empty">Distill reads this note into work items, each with who it’s for. Nothing reaches the board until you accept it.</p>}
        </div>
        </>}
      </aside>}
      <AnimatePresence>{scheduling && <ScheduleDialog key="schedule" noteId={note.id} onClose={() => setScheduling(false)} />}</AnimatePresence>
    </div>
  )
}

/** The line over a note: where it is, who edited it and when, and whether it's saved. All of it changes as you type. */
function NoteMeta({ noteId, trail, children }: { noteId: string; trail: string; children: ReactNode }) {
  const note = useHub((state) => state.notes.find((n) => n.id === noteId))
  const connection = useHub((state) => state.sync.connection)
  if (!note) return null
  return (
    <div className="note-meta">
      <span className="trail">{trail}</span>
      <EditedAt note={note} />
      <span className="note-saved">
        {note.saving ? (
          connection === 'live' ? <><LoaderCircle size={12} className="spin" /> Saving</> : <span title="Kept in this browser, and sent when the hub is back">Waiting for the hub</span>
        ) : note.committing ? (
          <span title="The hub has your words. It commits them to the notes repo once typing pauses for a minute.">Saved</span>
        ) : (
          <><GitCommitHorizontal size={13} /> <span className="mono">{note.commit ?? 'not saved'}</span></>
        )}
      </span>
      <span className="note-editors">
        {note.editors.map((e) => <Who key={e} id={e} size={22} />)}
      </span>
      {children}
    </div>
  )
}

/** The work from this note at its words: cards with their number and stage, and what Distill proposed. */
function workOf(state: State, noteId: string): WorkMark[] {
  const note = state.notes.find((n) => n.id === noteId)
  return [
    ...(note?.work ?? []).map((w) => {
      const card = state.cards.find((c) => c.id === w.itemId)
      return { quote: w.quote, kind: 'card' as const, label: (card && cardNumber(card)) ?? card?.title.slice(0, 18) ?? 'card', tone: card ? stageTone[card.stage] : 'faint', stage: card ? stages.find((s) => s.id === card.stage)?.title : undefined, itemId: card?.id }
    }),
    ...state.proposals.filter((p) => p.noteId === noteId && p.state === 'new').map((p) => ({ quote: p.quote, kind: 'proposed' as const, label: 'Proposed' })),
  ]
}

// New marks make the editor work them out again, so they're only new when something in them is.
const sameWork = (a: WorkMark[], b: WorkMark[]) => a.length === b.length && a.every((mark, index) => sameValues(mark, b[index]))

interface EditorProps {
  noteId: string
  binderId: string
  folderId?: string
  editor: RefObject<EditorHandle | null>
  raw: boolean
  readOnly?: boolean
}

/** The note itself. Once its document is here the editor keeps its own text, so a keystroke goes no further than this. */
const NoteEditor = memo(function NoteEditor({ noteId, binderId, folderId, editor, raw, readOnly }: EditorProps) {
  const store = useActions()
  const { openItem } = useUI()
  const live = useLiveNote(noteId)
  const text = useHub((state) => state.notes.find((n) => n.id === noteId)?.text ?? '')
  const work = useHub((state) => workOf(state, noteId), sameWork)
  const marks = useMemo<Marks>(() => ({
    work,
    open: openItem,
    menu: (itemId, event) => {
      const card = store.current().cards.find((c) => c.id === itemId)
      if (card) openMenu(event, cardMenuItems(card, store, openItem))
    },
  }), [work, openItem, store])
  // What [[links]] reach: the notes by title. One that isn't there yet is made beside this note.
  const links = useMemo(() => ({
    titles: () => store.current().notes.map((n) => n.title),
    exists: (title: string) => store.current().notes.some((n) => n.title.toLowerCase() === title.toLowerCase()),
    open: (title: string) => {
      const found = store.current().notes.find((n) => n.title.toLowerCase() === title.toLowerCase())
      go({ screen: 'notes', id: found ? found.id : store.addNote(binderId, folderId, `# ${title}\n\n`) })
    },
  }), [store, binderId, folderId])
  return <MarkdownEditor ref={editor} noteId={noteId} text={text} live={live} onChange={(next, changes) => store.editNote(noteId, next, changes)} links={links} marks={marks} raw={raw} readOnly={readOnly} />
})

/** A note's [[links]], in lower case, worked out once for each version of it: this looks through every note on every change. */
const linksOf = new WeakMap<Note, string[]>()
function linkedFrom(note: Note) {
  let titles = linksOf.get(note)
  if (!titles) {
    titles = linksIn(note.text).map((t) => t.toLowerCase())
    linksOf.set(note, titles)
  }
  return titles
}

/** Notes that link here, with the line that does. */
function backlinksTo(state: State, noteId: string, title: string) {
  const wanted = title.toLowerCase()
  return state.notes
    .filter((n) => n.id !== noteId && linkedFrom(n).includes(wanted))
    .map((n) => ({ id: n.id, title: n.title, line: n.text.split('\n').find((l) => linksIn(l).some((t) => t.toLowerCase() === wanted))?.replace(/^[-*>#\s]+/, '') ?? '' }))
}

type Backlink = ReturnType<typeof backlinksTo>[number]
const sameBacklinks = (a: Backlink[], b: Backlink[]) => a.length === b.length && a.every((link, index) => sameValues(link, b[index]))

const Backlinks = memo(function Backlinks({ noteId, title }: { noteId: string; title: string }) {
  const backlinks = useHub((state) => backlinksTo(state, noteId, title), sameBacklinks)
  return (
    <section className="backlinks" aria-label="Linked mentions">
      <h2>Linked mentions <span className="num">{backlinks.length}</span></h2>
      {backlinks.map((from) => (
        <a key={from.id} href={href({ screen: 'notes', id: from.id })} className="backlink">
          <b>{from.title} <ArrowUpRight size={12} /></b>
          <span>{from.line.replace(/\[\[([^\]|]+)(\|([^\]]*))?\]\]/g, (_m, t: string, _a, alias?: string) => alias || t)}</span>
        </a>
      ))}
      {!backlinks.length && <p>No note links here yet. Type [[{title}]] in another note to link it.</p>}
    </section>
  )
})

/**
 * A Distill on its way: who's reading the note, or who it waits for. An agent like Claude Code only calls Binders when
 * asked, so when the one it's meant for isn't listening, this says what to tell it, and the request can be called off.
 */
function DistillStatus({ card }: { card: Card }) {
  const store = useActions()
  const agents = useHub((state) => state.agents)
  usePresence()
  const { openItem } = useUI()
  const [copied, setCopied] = useState(false)
  const taken = !!card.agentId
  const agent = agents.find((a) => a.id === (card.agentId ?? card.meantFor))
  const listening = agent ? isOnline(agent) : agents.some((a) => !a.revoked && isOnline(a))
  const name = agent?.name ?? 'an agent'
  const copy = async () => {
    await navigator.clipboard.writeText(cardPrompt(card.id)).catch(() => {})
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1600)
  }
  return (
    <div className={`distill-status${!taken && !listening ? ' stuck' : ''}`}>
      {(taken || listening) && <span className="shimmer" />}
      <p>
        <b>{taken ? `${name} is reading it` : `Waiting for ${name} to take it`}</b>
        {card.doing ? `: ${card.doing}` : ''}
        <span className="faint"> · asked {ago(card.createdAt) === 'now' ? 'just now' : `${ago(card.createdAt)} ago`}</span>
      </p>
      {!taken && !listening && (
        <p className="distill-hint">
          {name} isn’t listening for work. In Claude Code (or wherever it runs), paste this:
          <code>{cardPrompt(card.id)}</code>
        </p>
      )}
      <div className="distill-actions">
        {!taken && !listening && <button className="mini-button primary" onClick={() => void copy()}>{copied ? 'Copied' : 'Copy what to say'}</button>}
        <button className="mini-button" onClick={() => openItem(card.id)}>Open the card</button>
        {!taken && <button className="mini-button" onClick={() => store.deleteCard(card.id)}>Call it off</button>}
      </div>
    </div>
  )
}

/** Delete asks once more on the button itself, then deletes; the notes repo's history still has it. */
/** When the note last changed and who changed it: "Edited 5m ago by ana", the full date and time on hover. */
function EditedAt({ note }: { note: { editedAt: string; editedBy?: string; editors: string[] } }) {
  const agents = useHub((state) => state.agents)
  useClock()
  if (Number.isNaN(Date.parse(note.editedAt))) return null
  const when = ago(note.editedAt)
  const phrase = when === 'now' ? 'just now' : /^\d/.test(when) ? `${when} ago` : `on ${when}`
  const by = note.editedBy ?? (note.editors.length === 1 ? note.editors[0] : undefined)
  const full = new Date(note.editedAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
  return <time className="note-edited" dateTime={note.editedAt} title={`Last edited ${full}`}>Edited {phrase}{by ? ` by ${nameFor({ agents }, by)}` : ''}</time>
}

function DeleteNote({ onDelete }: { onDelete: () => void }) {
  const [sure, setSure] = useState(false)
  useEffect(() => {
    if (!sure) return
    const timer = window.setTimeout(() => setSure(false), 4000)
    return () => window.clearTimeout(timer)
  }, [sure])
  return (
    <button type="button" className={`note-delete${sure ? ' sure' : ''}`} onClick={() => (sure ? onDelete() : setSure(true))} onBlur={() => setSure(false)} aria-label="Delete this note" title="Delete this note">
      <Trash2 size={14} />{sure && ' Delete for good?'}
    </button>
  )
}
