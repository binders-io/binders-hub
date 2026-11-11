import { guideTemplate } from '../../../shared/guide.ts'
import type { NoteProposal } from '../../../shared/notes.ts'
import { createElement, useEffect, useState, type DragEvent, type ReactNode } from 'react'
import { ArrowUpRight, BookPlus, ChevronRight, CloudUpload, FilePlus, LoaderCircle, FileText, BookMarked, Lock, Folder as FolderIcon, FolderOpen, FolderCog, FolderInput, FolderPlus, Link2, Pencil, Search, Settings2, Trash2, X } from 'lucide-react'
import { MenuButton } from '../kit'
import { copyNoteLink, sendAndSumItems, useSendTargets } from './NoteControls'
import { openMenu, type MenuItem } from './ContextMenu'
import { FolderRuleDialog } from './FolderRules'
import { attempt, failure, toast } from './Toast'
import type { Folder, Note } from '../data/model'
import { sameFields, useActions, useHub, useNoteSearch, type NotesSaved } from '../data/store'
import { headOf, textOf } from '../data/noteText'
import { go, href } from '../route'
import { useUI } from '../ui'
import { useMayChangeBinder } from '../screens/settings/access'

const collapsedKey = 'binders-hub-collapsed'
const noProposals: NoteProposal[] = []

const sameRow = sameFields<Note>('id', 'title', 'binderId', 'folderId', 'saving', 'locked', 'captured')
const sameRows = (a: Note[], b: Note[]) => a.length === b.length && a.every((note, index) => sameRow(note, b[index]))

/**
 * When a captured note was recorded, for the order of a folder of captures: the time on the line under its title, which
 * the hub writes (a note that's been summed up or added to since still says when it was heard), else when it last changed.
 */
const recordedAt = (note: Note) => {
  const heard = /^_[^\n]*?(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}) UTC/m.exec(headOf(note))
  return heard ? `${heard[1]}T${heard[2]}` : note.editedAt
}

function readCollapsed(): Set<string> {
  try {
    return new Set(JSON.parse(window.localStorage.getItem(collapsedKey) ?? '[]') as string[])
  } catch {
    return new Set()
  }
}

/**
 * What a save did, in a line a person reads as "saved" and "on GitHub": the commit's own words are for `detail`, which
 * says where each binder's notes went.
 */
export function savedWords(saved: NotesSaved) {
  const done = saved.committed ? `${saved.committed} note${saved.committed === 1 ? '' : 's'} saved` : 'Every note was already saved'
  const pushed = saved.binders.filter((b) => b.push && !b.push.error)
  const failed = saved.binders.find((b) => b.push?.error)
  const where = pushed.map((b) => `${b.push!.to ?? b.repo ?? 'its repo'}${b.push!.branch ? ` (${b.push!.branch})` : ''}`).join(', ')
  if (failed) return { ok: false, text: `${done}, but not on GitHub: pushing to ${failed.push!.to ?? failed.repo ?? 'its repo'} failed: ${failed.push!.error}`, detail: where && `Pushed to ${where}.` }
  if (pushed.length) return { ok: true, text: `${done} to GitHub`, detail: `Pushed to ${where}.` }
  return { ok: true, text: `${done}, but not on GitHub yet. Set a repo for these notes in Settings → GitHub.`, detail: '' }
}

/** Save all, and ⌘S: commits every note now rather than when typing pauses, and pushes them. Shows how many wait. */
export function SaveAll() {
  const store = useActions()
  const [busy, setBusy] = useState(false)
  const waiting = useHub((state) => state.notes.filter((n) => n.saving || n.committing).length)
  const save = async () => {
    if (busy) return
    setBusy(true)
    const saved = await attempt(() => store.saveNotes())
    setBusy(false)
    if (!saved) return
    const { ok, text, detail } = savedWords(saved)
    // Which repo and branch is for whoever wants it: one press away.
    const options = detail ? { action: { label: 'Where to', run: () => toast(detail) } } : {}
    if (ok) toast(text, options)
    else failure(text, options)
  }
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && event.code === 'KeyS') {
        event.preventDefault()
        void save()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })
  const title = `${waiting ? `${waiting} note${waiting === 1 ? '' : 's'} waiting for typing to pause. ` : ''}Save all: commit every note now and push it (⌘S)`
  return (
    <button type="button" className={`icon-button save-all${waiting ? ' waiting' : ''}`} onClick={() => void save()} disabled={busy} aria-label="Save all notes" title={title}>
      {busy ? <LoaderCircle size={16} className="spin" /> : <CloudUpload size={16} />}
      {waiting > 0 && !busy && <span className="save-count num">{waiting}</span>}
    </button>
  )
}

/** The binder's folders and notes as a tree, as Finder shows them. Drag a note onto a folder to move it. */
export function NoteTree({ currentId }: { currentId: string }) {
  const store = useActions()
  // A reader browses, opens and searches: nothing here makes, moves, renames or deletes.
  const may = useMayChangeBinder()
  const binders = useHub((state) => state.binders)
  const folders = useHub((state) => state.folders)
  const proposals = useHub((state) => state.proposals)
  const noteProposals = useHub((state) => state.noteProposals ?? noProposals)
  const reviewing = (noteId: string) => noteProposals.filter((p) => p.noteId === noteId && p.state === 'open').length
  const guides = new Set(binders.flatMap((b) => (b.guideNoteId ? [b.guideNoteId] : [])))
  const ui = useUI()
  const sendTargets = useSendTargets()
  const [filter, setFilter] = useState('')
  // What the hub finds in the notes' texts, which this browser mostly doesn't hold.
  const found = useNoteSearch(filter)
  // Typing changes a note's text, which the tree only reads to search it.
  const notes = useHub((state) => state.notes, filter ? Object.is : sameRows)
  const [collapsed, setCollapsed] = useState(readCollapsed)
  const [renaming, setRenaming] = useState<string>()
  const [dropOn, setDropOn] = useState<string>()
  const [newBinder, setNewBinder] = useState<string>()
  const [ruling, setRuling] = useState<string>()
  const ruled = useHub((state) => (state.folderRules ?? []).filter((r) => r.enabled).map((r) => r.folderId).join())
  const mayRule = useHub((state) => state.me?.role === 'owner' || state.me?.role === 'admin')
  const current = notes.find((n) => n.id === currentId)

  const toggle = (id: string, open?: boolean) => {
    setCollapsed((was) => {
      const next = new Set(was)
      if (open ?? next.has(id)) next.delete(id)
      else next.add(id)
      try {
        window.localStorage.setItem(collapsedKey, JSON.stringify([...next]))
      } catch {
        // Kept for this tab only.
      }
      return next
    })
  }


  const newNote = (binderId: string, folderId?: string) => {
    if (folderId) toggle(folderId, true)
    toggle(binderId, true)
    go({ screen: 'notes', id: store.addNote(binderId, folderId) })
  }
  const newFolder = (binderId: string, parentId?: string) => {
    if (parentId) toggle(parentId, true)
    toggle(binderId, true)
    setRenaming(store.addFolder(binderId, parentId))
  }

  // A note or a folder dropped here moves into it: a folder, or the top of a binder.
  const dropProps = (key: string, binderId: string, folderId?: string) => ({
    onDragOver: (event: DragEvent) => {
      if (!may || !event.dataTransfer.types.includes('text/note') && !event.dataTransfer.types.includes('text/folder')) return
      event.preventDefault()
      event.stopPropagation()
      setDropOn(key)
    },
    onDragLeave: () => setDropOn((on) => (on === key ? undefined : on)),
    onDrop: (event: DragEvent) => {
      event.stopPropagation()
      const note = event.dataTransfer.getData('text/note')
      const folder = event.dataTransfer.getData('text/folder')
      setDropOn(undefined)
      if (note) store.moveNote(note, binderId, folderId)
      if (folder && folder !== folderId) store.moveFolder(folder, binderId, folderId)
      if (folderId) toggle(folderId, true)
    },
  })

  // Right-click menus, as on the Mac: the same things the row's buttons do, and a few more.
  const icon = (component: typeof FilePlus) => createElement(component, { size: 14 })
  const folderPath = (folderId?: string) => {
    const names: string[] = []
    let folder = folders.find((f) => f.id === folderId)
    while (folder) {
      names.unshift(folder.name)
      folder = folders.find((f) => f.id === folder!.parentId)
    }
    return names
  }
  // Moving without dragging, which a phone or a keyboard can't do: anywhere but where it is, and never a folder into itself.
  const moveItems = (here: { binderId: string; folderId?: string }, move: (binderId: string, folderId?: string) => void, moving?: Folder): MenuItem[] => {
    const within = (folder?: Folder): boolean => !!folder && (folder.id === moving?.id || within(folders.find((f) => f.id === folder.parentId)))
    const places = binders.flatMap((b) => [
      { binderId: b.id, folderId: undefined as string | undefined, label: b.name },
      ...folders.filter((f) => f.binderId === b.id && !within(f)).map((f) => ({ binderId: b.id, folderId: f.id, label: [b.name, ...folderPath(f.id)].join(' / ') })),
    ]).filter((place) => place.binderId !== here.binderId || place.folderId !== here.folderId)
    return places.length ? [{ label: 'Move to', icon: icon(FolderInput), submenu: places.map((place) => ({ label: place.label, onSelect: () => move(place.binderId, place.folderId) })) }] : []
  }
  const noteMenu = (note: Note): MenuItem[] => may ? [
    { label: 'Open', icon: icon(ArrowUpRight), onSelect: () => go({ screen: 'notes', id: note.id }) },
    { label: 'Copy link', icon: icon(Link2), onSelect: () => copyNoteLink(note.id) },
    { separator: true },
    { label: 'New note beside it', icon: icon(FilePlus), onSelect: () => newNote(note.binderId, note.folderId) },
    ...moveItems({ binderId: note.binderId, folderId: note.folderId }, (binderId, folderId) => store.moveNote(note.id, binderId, folderId)),
    // Its words as they are now: the list's own copy leaves out what's typed since.
    ...sendAndSumItems(store.current().notes.find((n) => n.id === note.id) ?? note, sendTargets),
    { separator: true },
    { label: 'Delete', icon: icon(Trash2), danger: true, confirm: 'Delete the note? Press again', onSelect: () => store.deleteNote(note.id) },
  ] : [
    { label: 'Open', icon: icon(ArrowUpRight), onSelect: () => go({ screen: 'notes', id: note.id }) },
    { label: 'Copy link', icon: icon(Link2), onSelect: () => copyNoteLink(note.id) },
  ]
  const folderMenu = (folder: Folder): MenuItem[] => [
    { label: 'New note', icon: icon(FilePlus), onSelect: () => newNote(folder.binderId, folder.id) },
    { label: 'New folder', icon: icon(FolderPlus), onSelect: () => newFolder(folder.binderId, folder.id) },
    { label: 'Rename', icon: icon(Pencil), onSelect: () => setRenaming(folder.id) },
    ...(mayRule ? [{ label: ruled.split(',').includes(folder.id) ? 'Rules (on)' : 'Rules', icon: icon(FolderCog), onSelect: () => setRuling(folder.id) }] : []),
    ...moveItems({ binderId: folder.binderId, folderId: folder.parentId }, (binderId, parentId) => store.moveFolder(folder.id, binderId, parentId), folder),
    { separator: true },
    { label: 'Delete', icon: icon(Trash2), danger: true, confirm: 'Delete it? What’s in it moves up', onSelect: () => store.deleteFolder(folder.id) },
  ]
  const projectMenu = (binderId: string): MenuItem[] => [
    ...(may ? [{ label: 'New note', icon: icon(FilePlus), onSelect: () => newNote(binderId) }] : []),
    ...(binders.find((b) => b.id === binderId)?.guideNoteId ? [{ label: 'Open its guide', icon: icon(BookMarked), onSelect: () => go({ screen: 'notes', id: binders.find((b) => b.id === binderId)!.guideNoteId! }) }] : may ? [{ label: 'Add a guide for agents', icon: icon(BookMarked), onSelect: () => {
      const binder = binders.find((b) => b.id === binderId)
      const id = store.addNote(binderId, undefined, guideTemplate(binder?.name ?? 'This binder'))
      store.updateBinder(binderId, { guideNoteId: id })
      go({ screen: 'notes', id })
    } }] : []),
    ...(may ? [{ label: 'New folder', icon: icon(FolderPlus), onSelect: () => newFolder(binderId) }, { separator: true as const }] : []),
    { label: 'Binder settings', icon: icon(Settings2), onSelect: () => go({ screen: 'settings', id: 'general' }) },
  ]

  const waiting = (note: Note) => proposals.filter((p) => p.noteId === note.id && p.state === 'new').length
  /** Where a new note or folder from the top of the list goes: beside the note you're on, else in the binder you're in. */
  const here = () => current?.binderId ?? (ui.binder !== 'all' ? ui.binder : binders[0].id)

  /** A row's ⋯: its right-click menu, on hover with a mouse and always there for a finger or a keyboard. */
  const more = (name: string, items: () => MenuItem[]) => <MenuButton className="tree-more" label={`Actions for ${name}`} items={items} />

  const noteRow = (note: Note, depth: number, path?: string) => (
    <div key={note.id} className="tree-item">
      <a
        href={href({ screen: 'notes', id: note.id })}
        className={`tree-row note-row${note.id === currentId ? ' on' : ''}`}
        style={{ paddingLeft: 12 + depth * 16 }}
        draggable={may}
        onDragStart={(event) => event.dataTransfer.setData('text/note', note.id)}
        onContextMenu={(event) => openMenu(event, noteMenu(note))}
      >
        {guides.has(note.id) ? <BookMarked size={16} className="tree-icon" aria-label="The binder’s guide" /> : <FileText size={16} className="tree-icon" />}
        <span className="tree-label">
          <b>{note.title || 'Untitled'}</b>
          {path && <em>{path}</em>}
        </span>
        {waiting(note) > 0 && <i className="waiting num">{waiting(note)}</i>}
        {note.locked && <Lock size={11} className="tree-lock" aria-label="Locked" />}
        {reviewing(note.id) > 0 && <i className="waiting num" title="Suggested changes to review">{reviewing(note.id)}</i>}
        {note.saving && <i className="saving-dot" title="Saving" />}
      </a>
      {more(note.title || 'Untitled', () => noteMenu(note))}
    </div>
  )

  const count = (binderId: string, folderId: string): number =>
    notes.filter((n) => n.folderId === folderId).length + folders.filter((f) => f.binderId === binderId && f.parentId === folderId).reduce((sum, f) => sum + count(binderId, f.id), 0)

  const folderRows = (folder: Folder, depth: number): ReactNode => {
    const open = !collapsed.has(folder.id)
    const children = folders.filter((f) => f.parentId === folder.id)
    // A folder of captures has today's on top; every other is by title.
    const inside = notes.filter((n) => n.folderId === folder.id)
    inside.sort(inside.some((n) => n.captured) ? (a, b) => recordedAt(b).localeCompare(recordedAt(a)) || a.title.localeCompare(b.title) : (a, b) => a.title.localeCompare(b.title))
    return (
      <div key={folder.id} role="group">
        <div className={`tree-row folder-row${dropOn === folder.id ? ' drop' : ''}`} style={{ paddingLeft: 4 + depth * 16 }} {...dropProps(folder.id, folder.binderId, folder.id)}
          onContextMenu={(event) => may && renaming !== folder.id && openMenu(event, folderMenu(folder))}
          draggable={may && renaming !== folder.id} onDragStart={(event) => { event.stopPropagation(); event.dataTransfer.setData('text/folder', folder.id); event.dataTransfer.effectAllowed = 'move' }}>
          <button className="tree-chevron" onClick={() => toggle(folder.id)} aria-expanded={open} aria-label={open ? `Close ${folder.name}` : `Open ${folder.name}`}>
            <ChevronRight size={13} style={{ transform: open ? 'rotate(90deg)' : 'none' }} />
          </button>
          {open ? <FolderOpen size={16} className="tree-icon" /> : <FolderIcon size={16} className="tree-icon" />}
          {renaming === folder.id ? (
            <input
              id={`rename-${folder.id}`}
              className="tree-rename"
              autoFocus
              defaultValue={folder.name}
              onFocus={(event) => event.target.select()}
              onBlur={(event) => { store.renameFolder(folder.id, event.target.value); setRenaming(undefined) }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') event.currentTarget.blur()
                if (event.key === 'Escape') setRenaming(undefined)
              }}
            />
          ) : (
            <button className="tree-label folder-name" onClick={() => toggle(folder.id)} onDoubleClick={() => may && setRenaming(folder.id)} title={may ? 'Double-click to rename' : undefined}>
              <b>{folder.name}</b>
            </button>
          )}
          <span className="tree-count num">{count(folder.binderId, folder.id)}</span>
          {may && renaming !== folder.id && more(folder.name, () => folderMenu(folder))}
        </div>
        {open && (
          <>
            {children.sort((a, b) => a.name.localeCompare(b.name)).map((child) => folderRows(child, depth + 1))}
            {inside.map((note) => noteRow(note, depth + 1))}
          </>
        )}
      </div>
    )
  }

  const pathOf = (note: Note) => [binders.find((b) => b.id === note.binderId)?.name, ...folderPath(note.folderId)].join(' / ')

  const words = filter.toLowerCase().split(/\s+/).filter(Boolean)
  const matches = words.length
    ? notes.filter((n) => {
        // The words may be one in the title and another in the text. A note without its text here has how it starts.
        const text = `${n.title} ${pathOf(n)} ${textOf(n) ?? headOf(n)}`.toLowerCase()
        return words.every((w) => text.includes(w)) || found.has(n.id)
      })
    : []

  return (
    <nav className="note-tree" aria-label="Notes">
      <div className="tree-tools">
        <label className="tree-filter">
          <Search size={14} aria-hidden="true" />
          <input id="note-filter" placeholder="Filter notes" value={filter} onChange={(event) => setFilter(event.target.value)} onKeyDown={(event) => event.key === 'Escape' && setFilter('')} />
          {filter && <button type="button" onClick={() => setFilter('')} aria-label="Clear filter"><X size={14} /></button>}
        </label>
        {may && <button type="button" className="icon-button" onClick={() => binders[0] && newNote(here(), current?.folderId)} disabled={!binders.length} aria-label="New note" title="New note (N, or ⌥⌘N)"><FilePlus size={16} /></button>}
        {may && <button type="button" className="icon-button" onClick={() => binders[0] && newFolder(here(), current?.folderId)} disabled={!binders.length} aria-label="New folder" title="New folder, beside the note you’re on"><FolderPlus size={16} /></button>}
        {may && <SaveAll />}
        {may && !binders.length && <button type="button" className="icon-button" onClick={() => setNewBinder('')} aria-label="Start its notes" title="Start its notes"><BookPlus size={16} /></button>}
      </div>
      {newBinder !== undefined && (
        <form className="tree-new-binder" onSubmit={(event) => { event.preventDefault(); if (newBinder.trim()) store.addBinder(newBinder); setNewBinder(undefined) }}>
          <input id="new-binder" autoFocus value={newBinder} onChange={(e) => setNewBinder(e.target.value)} onBlur={() => !newBinder.trim() && setNewBinder(undefined)} onKeyDown={(e) => e.key === 'Escape' && setNewBinder(undefined)} placeholder="New part’s name" />
        </form>
      )}

      {words.length ? (
        <div className="tree-results">
          {matches.map((note) => noteRow(note, 0, pathOf(note)))}
          {!matches.length && <p className="tree-empty">No note matches “{filter}”.</p>}
        </div>
      ) : (
        binders.filter((b) => ui.binder === 'all' || b.id === ui.binder).map((binder) => {
          const open = !collapsed.has(binder.id)
          return (
            <div key={binder.id} className="tree-binder">
              <div className={`tree-row binder-row${dropOn === binder.id ? ' drop' : ''}`} {...dropProps(binder.id, binder.id)} onContextMenu={(event) => openMenu(event, projectMenu(binder.id))}>
                <button className="tree-chevron" onClick={() => toggle(binder.id)} aria-expanded={open} aria-label={open ? `Close ${binder.name}` : `Open ${binder.name}`}>
                  <ChevronRight size={13} style={{ transform: open ? 'rotate(90deg)' : 'none' }} />
                </button>
                <button className="tree-label" onClick={() => toggle(binder.id)}><b>{binder.name}</b></button>
                {more(binder.name, () => projectMenu(binder.id))}
              </div>
              {open && (
                <>
                  {folders.filter((f) => f.binderId === binder.id && !f.parentId).sort((a, b) => a.name.localeCompare(b.name)).map((f) => folderRows(f, 0))}
                  {notes.filter((n) => n.binderId === binder.id && !n.folderId).map((note) => noteRow(note, 0))}
                </>
              )}
            </div>
          )
        })
      )}
      {ruling && <FolderRuleDialog key={ruling} folderId={ruling} onClose={() => setRuling(undefined)} />}
    </nav>
  )
}
