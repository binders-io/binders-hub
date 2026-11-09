import { FileText, MessageSquare, Sparkles } from 'lucide-react'

export type NoteView = 'note' | 'chat' | 'distill'

/**
 * On a phone there's no room for a note with its chat or Distill beside it, so each fills the screen and this switches
 * between them. It stays above all three, so there's always a way back to the note.
 */
export function NoteViews({ view, onChange, waiting }: { view: NoteView; onChange: (view: NoteView) => void; /** Proposed cards waiting on Distill. */ waiting: number }) {
  const views: { id: NoteView; label: string; icon: typeof FileText }[] = [
    { id: 'note', label: 'Note', icon: FileText },
    { id: 'chat', label: 'Chat', icon: MessageSquare },
    { id: 'distill', label: 'Distill', icon: Sparkles },
  ]
  return (
    <div className="note-views" role="group" aria-label="Show">
      {views.map(({ id, label, icon: Icon }) => {
        const count = id === 'distill' ? waiting : 0
        return (
          <button key={id} type="button" aria-pressed={view === id} aria-label={count ? `${label}, ${count} proposed` : label} onClick={() => onChange(id)}>
            <Icon size={14} /> {label}{count > 0 && <i className="waiting num">{count}</i>}
          </button>
        )
      })}
    </div>
  )
}
