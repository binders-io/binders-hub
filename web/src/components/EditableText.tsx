import { useEffect, useRef, useState } from 'react'
import { Pencil } from 'lucide-react'

/**
 * Words that can be changed where they stand: a button showing them, which opens a box to change them in. Leaving the
 * box or pressing Save keeps the change, Escape puts the old words back, and Enter keeps it too in a one-line box (⌘
 * or Ctrl with Enter in a long one, where Enter is a new line). Nothing is sent when nothing changed.
 */
export function EditableText({ label, value, onSave, multiline = false, required = false, placeholder }: {
  /** What these words are, as a name: "Title", "Brief". It names the box, and the button says to edit it. */
  label: string
  value: string
  onSave: (next: string) => void
  multiline?: boolean
  /** Can't be left empty: an empty one puts the old words back. */
  required?: boolean
  /** Said, faint, when there are no words. */
  placeholder?: string
}) {
  const [draft, setDraft] = useState<string>()
  const box = useRef<HTMLSpanElement>(null)
  const field = useRef<HTMLInputElement & HTMLTextAreaElement>(null)
  const opener = useRef<HTMLButtonElement>(null)
  // Set once the box is done with, so what leaving it and pressing Save both do happens once.
  const finished = useRef(true)
  const refocus = useRef(false)
  const editing = draft !== undefined

  useEffect(() => {
    if (editing) {
      field.current?.focus()
      field.current?.setSelectionRange(field.current.value.length, field.current.value.length)
    } else if (refocus.current) {
      refocus.current = false
      opener.current?.focus()
    }
  }, [editing])

  const finish = (keep: boolean) => {
    if (finished.current || draft === undefined) return
    finished.current = true
    refocus.current = true
    setDraft(undefined)
    const next = draft.trim()
    if (keep && next !== value.trim() && (next || !required)) onSave(next)
  }

  if (!editing) {
    return (
      <button type="button" ref={opener} className={`editable${value ? '' : ' empty'}`} title={`Edit the ${label.toLowerCase()}`} onClick={() => { finished.current = false; setDraft(value) }}>
        <span className="editable-text">{value || placeholder || `Add a ${label.toLowerCase()}`}</span>
        <Pencil size={12} aria-hidden="true" />
      </button>
    )
  }

  const shared = {
    ref: field,
    'aria-label': label,
    value: draft,
    onChange: (event: { target: { value: string } }) => setDraft(event.target.value),
  }
  return (
    <span className="edit-box" ref={box} onBlur={(event) => { if (!box.current?.contains(event.relatedTarget as Node | null)) finish(true) }}>
      {multiline
        ? <textarea {...shared} rows={Math.min(12, Math.max(4, draft.split('\n').length + 1))}
            onKeyDown={(event) => {
              if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); finish(false) }
              else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); finish(true) }
            }} />
        : <input {...shared} type="text"
            onKeyDown={(event) => {
              if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); finish(false) }
              else if (event.key === 'Enter') { event.preventDefault(); finish(true) }
            }} />}
      {/* A press on Save mustn't take focus off the box first, or leaving the box would be what keeps it. */}
      <button type="button" className="mini-button primary" onMouseDown={(event) => event.preventDefault()} onClick={() => finish(true)}>Save</button>
    </span>
  )
}
