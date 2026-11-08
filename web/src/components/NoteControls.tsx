import { useEffect, useState } from 'react'
import { BookMarked, Ellipsis, History, Lock, LockOpen } from 'lucide-react'
import { guideMost } from '../../../shared/guide.ts'
import { lineDiff, fromMarkdown, type Note, type NoteProposal } from '../../../shared/notes.ts'
import { call } from '../data/api'
import { spaceHeaders } from '../data/space'
import { useActions, useHub } from '../data/store'
import { openMenuUnder, type MenuItem } from './ContextMenu'
import { Dialog } from './Dialog'
import { attempt } from './Toast'

// What's kept around a note: its lock, its versions, what's proposed for it while it's locked, and whether it's the
// guide every agent in its binder reads first.

/** Whether you may change a note. Only a locked one needs asking, and until the hub says, you may not. */
export function useMayChange(note: Pick<Note, 'id' | 'locked'>) {
  const [known, setKnown] = useState<{ id: string; by?: string; may: boolean }>()
  const by = note.locked?.by
  useEffect(() => {
    if (!by) return
    let gone = false
    void call<{ mayChange: boolean }>('GET', `/api/notes/${note.id}/access`).then((answer) => {
      if (!gone) setKnown({ id: note.id, by, may: answer.mayChange })
    }, () => undefined)
    return () => { gone = true }
  }, [note.id, by])
  if (!by) return true
  return known?.id === note.id && known.by === by && known.may
}

const noProposals: NoteProposal[] = []

const whoIs = (id: string, agents: { id: string; name: string }[]) => agents.find((a) => a.id === id)?.name ?? `@${id}`

function Diff({ before, after }: { before: string; after: string }) {
  const lines = lineDiff(before, after)
  const changed = lines.some((l) => l.kind !== ' ')
  // The changes and a little around them: a long note's other lines aren't what's being decided.
  const near = (index: number) => lines.slice(Math.max(0, index - 2), index + 3).some((l) => l.kind !== ' ')
  const shown = lines.map((line, index) => ({ line, index })).filter(({ index }) => near(index))
  if (!changed) return <p className="faint">No differences.</p>
  return (
    <div className="note-diff mono" role="group" aria-label="What changes">
      {shown.map(({ line, index }, at) => (
        <div key={index}>
          {at > 0 && shown[at - 1].index !== index - 1 && <div className="d-line faint"><span className="d-sign"> </span><span className="d-text">…</span></div>}
          <div className={`d-line${line.kind === '+' ? ' add' : line.kind === '-' ? ' del' : ''}`}><span className="d-sign">{line.kind}</span><span className="d-text">{line.text}</span></div>
        </div>
      ))}
    </div>
  )
}

function ProposalRow({ proposal, note, mayChange, agents }: { proposal: NoteProposal; note: Note; mayChange: boolean; agents: { id: string; name: string }[] }) {
  const [said, setSaid] = useState('')
  const open = proposal.state === 'open'
  const stale = open && proposal.base !== note.text
  const decide = (accept: boolean) => void attempt(() => call('POST', `/api/note-proposals/${proposal.id}/decide`, { accept }))
  const comment = () => void attempt(() => call('POST', `/api/note-proposals/${proposal.id}/comments`, { text: said })).then((done) => { if (done) setSaid('') })
  return (
    <section className="note-proposal">
      <p><b>{whoIs(proposal.by, agents)}</b> <span className="faint">proposes{open ? '' : `, ${proposal.state} by ${whoIs(proposal.decidedBy ?? '', agents)}`}</span></p>
      <p>{proposal.why}</p>
      <Diff before={proposal.base} after={proposal.text} />
      {proposal.comments.map((c, index) => <p key={index} className="note-proposal-said"><b>{whoIs(c.by, agents)}</b> {c.text}</p>)}
      {open && (
        <>
          <label className="field"><span className="field-label">Talk it over</span>
            <textarea id={`proposal-comment-${proposal.id}`} rows={2} value={said} onChange={(e) => setSaid(e.target.value)} />
          </label>
          {stale && <p className="field-hint">The note has changed since this was proposed, so accepting it would undo that. Ask for it to be proposed again.</p>}
          <div className="note-proposal-actions">
            <button type="button" className="button" disabled={!said.trim()} onClick={comment}>Comment</button>
            {mayChange && <button type="button" className="button" onClick={() => decide(false)}>Turn down</button>}
            {mayChange && <button type="button" className="button primary" disabled={stale} onClick={() => decide(true)}>Accept</button>}
          </div>
        </>
      )}
    </section>
  )
}

interface Commit {
  sha: string
  short: string
  at: string
  subject: string
}

function Versions({ note, mayChange, onPropose }: { note: Note; mayChange: boolean; onPropose: (text: string) => void }) {
  const [commits, setCommits] = useState<Commit[]>()
  const [chosen, setChosen] = useState<{ sha: string; text: string }>()
  useEffect(() => {
    void call<{ commits: Commit[] }>('GET', `/api/notes/${note.id}/history`).then((r) => setCommits(r.commits), () => setCommits([]))
  }, [note.id, note.commit])
  const open = (sha: string) => void fetch(`/api/notes/${note.id}/at/${sha}`, { credentials: 'same-origin', headers: { 'x-binders': '1', ...spaceHeaders } }).then(async (r) => {
    if (r.ok) setChosen({ sha, text: fromMarkdown(await r.text()) })
  })
  if (!commits) return <p className="faint">Reading its versions…</p>
  if (!commits.length) return <p className="faint">No versions yet. One is saved shortly after each edit.</p>
  return (
    <div className="note-versions">
      <ol reversed>
        {commits.map((commit, index) => (
          <li key={commit.sha}>
            <button type="button" className={`note-version${chosen?.sha === commit.sha ? ' on' : ''}`} onClick={() => open(commit.sha)}>
              <b>v{commits.length - index}</b> <span>{commit.subject}</span> <span className="faint">{new Date(commit.at).toLocaleString()}</span>
            </button>
          </li>
        ))}
      </ol>
      {chosen && (
        <div>
          <p className="faint">From that version to the note now:</p>
          <Diff before={chosen.text} after={note.text} />
          {chosen.text.trim() !== note.text.trim() && (
            mayChange
              ? <button type="button" className="button" onClick={() => void attempt(() => call('POST', `/api/notes/${note.id}/restore`, { sha: chosen.sha }))}>Go back to this version</button>
              : <button type="button" className="button" onClick={() => onPropose(chosen.text)}>Propose going back to this version</button>
          )}
        </div>
      )}
    </div>
  )
}

function ProposeForm({ note, start, onDone }: { note: Note; start: string; onDone: () => void }) {
  const [text, setText] = useState(start)
  const [why, setWhy] = useState('')
  const send = () => void attempt(() => call('POST', `/api/notes/${note.id}/proposals`, { text, why })).then((done) => { if (done) onDone() })
  return (
    <div className="form">
      <label className="field"><span className="field-label">How it should read</span>
        <textarea id="proposal-text" className="mono" rows={12} value={text} onChange={(e) => setText(e.target.value)} />
      </label>
      <label className="field"><span className="field-label">Why</span>
        <textarea id="proposal-why" rows={2} value={why} onChange={(e) => setWhy(e.target.value)} />
      </label>
      <div className="note-proposal-actions">
        <button type="button" className="button" onClick={onDone}>Cancel</button>
        <button type="button" className="button primary" disabled={!why.trim() || text === note.text} onClick={send}>Propose</button>
      </div>
    </div>
  )
}

/** A note's open proposals and its versions, in one place to review them. */
function NoteReview({ note, mayChange, onClose, opening }: { note: Note; mayChange: boolean; onClose: () => void; opening: 'proposals' | 'versions' }) {
  const proposals = useHub((state) => state.noteProposals ?? noProposals)
  const agents = useHub((state) => state.agents)
  const [tab, setTab] = useState(opening)
  const [proposing, setProposing] = useState<string>()
  const mine = proposals.filter((p) => p.noteId === note.id).sort((a, b) => Number(b.state === 'open') - Number(a.state === 'open') || b.at.localeCompare(a.at))
  return (
    <Dialog title={note.title || 'Untitled'} onClose={onClose} wide>
      {proposing !== undefined
        ? <ProposeForm note={note} start={proposing} onDone={() => { setProposing(undefined); setTab('proposals') }} />
        : (
          <>
            <div className="note-review-tabs" role="tablist">
              <button type="button" role="tab" aria-selected={tab === 'proposals'} className={`button${tab === 'proposals' ? ' primary' : ''}`} onClick={() => setTab('proposals')}>Proposals</button>
              <button type="button" role="tab" aria-selected={tab === 'versions'} className={`button${tab === 'versions' ? ' primary' : ''}`} onClick={() => setTab('versions')}>Versions</button>
              {note.locked && !mayChange && <button type="button" className="button" onClick={() => setProposing(note.text)}>Propose a change</button>}
            </div>
            {tab === 'versions'
              ? <Versions note={note} mayChange={mayChange} onPropose={setProposing} />
              : mine.length
                ? mine.map((p) => <ProposalRow key={p.id} proposal={p} note={note} mayChange={mayChange} agents={agents} />)
                : <p className="faint">{note.locked ? 'Nothing proposed. Anyone in this binder can propose a change, and agents do it with propose_note_change.' : 'Proposals are for locked notes. This one can be edited directly.'}</p>}
          </>
        )}
    </Dialog>
  )
}

/** The note's guide, lock and history buttons; on a phone, one button for them all, with what `more` adds. */
export function NoteControls({ note, mayChange, more }: { note: Note; mayChange: boolean; more?: MenuItem[] }) {
  const store = useActions()
  const binder = useHub((state) => state.binders.find((b) => b.id === note.binderId))
  const open = useHub((state) => (state.noteProposals ?? []).filter((p) => p.noteId === note.id && p.state === 'open').length)
  const [review, setReview] = useState<'proposals' | 'versions'>()
  const guide = binder?.guideNoteId === note.id
  const lockTitle = note.locked
    ? mayChange ? `Locked by @${note.locked.by}: only they and this Binder’s owners and admins can change it. Unlock it` : `Locked by @${note.locked.by}: propose changes for review`
    : 'Lock it: others, agents included, can only propose changes'
  const toggleGuide = () => store.updateBinder(note.binderId, { guideNoteId: guide ? '' : note.id })
  const toggleLock = () => void attempt(() => call('POST', `/api/notes/${note.id}/lock`, { locked: !note.locked }))
  const openReview = () => setReview(open || note.locked ? 'proposals' : 'versions')
  if (more) {
    const items: MenuItem[] = [
      { label: open ? `Review ${open} proposed change${open === 1 ? '' : 's'}` : 'Versions and proposals', icon: <History size={14} />, onSelect: openReview },
      { label: note.locked ? 'Unlock' : 'Lock', icon: note.locked ? <LockOpen size={14} /> : <Lock size={14} />, disabled: !!note.locked && !mayChange, onSelect: toggleLock },
      { label: guide ? 'Stop using as the guide' : 'Make it the binder’s guide', icon: <BookMarked size={14} />, onSelect: toggleGuide },
      ...more,
    ]
    return (
      <>
        <button type="button" className="icon-button note-more" onClick={(event) => openMenuUnder(event, items)} aria-haspopup="menu" aria-label="More for this note">
          <Ellipsis size={18} />{open > 0 && <i className="waiting num">{open}</i>}
        </button>
        {review && <NoteReview note={note} mayChange={mayChange} opening={review} onClose={() => setReview(undefined)} />}
      </>
    )
  }
  return (
    <>
      <button type="button" className={`icon-button${guide ? ' on' : ''}`} aria-pressed={guide} onClick={toggleGuide} title={guide ? 'This is the binder’s guide: every agent here reads it first. Stop using it as the guide' : 'Make this the binder’s guide: every agent here reads it first'} aria-label="Binder guide"><BookMarked size={15} /></button>
      <button type="button" className={`icon-button${note.locked ? ' on' : ''}`} aria-pressed={!!note.locked} disabled={!!note.locked && !mayChange} onClick={toggleLock} title={lockTitle} aria-label={note.locked ? 'Locked' : 'Lock'}>{note.locked ? <Lock size={15} /> : <LockOpen size={15} />}</button>
      <button type="button" className={`icon-button${open ? ' on' : ''}`} onClick={openReview} title={open ? `${open} proposed change${open === 1 ? '' : 's'} to review` : 'Versions and proposals'} aria-label="Versions and proposals"><History size={15} />{open > 0 && <i className="waiting num">{open}</i>}</button>
      {guide && note.text.length > guideMost && <span className="note-guide-long" title={`Agents are given the first ${guideMost.toLocaleString()} characters, and can read the rest`}>Long for a guide</span>}
      {review && <NoteReview note={note} mayChange={mayChange} opening={review} onClose={() => setReview(undefined)} />}
    </>
  )
}
