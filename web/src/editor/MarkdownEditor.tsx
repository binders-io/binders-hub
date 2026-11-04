import { controlPaste, noteOf, pictureDrops } from './pictures'
import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'
import { autocompletion, completionKeymap } from '@codemirror/autocomplete'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { languages } from '@codemirror/language-data'
import { HighlightStyle, syntaxHighlighting, indentOnInput } from '@codemirror/language'
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search'
import { ChangeSet, Compartment, EditorState, Prec, Transaction } from '@codemirror/state'
import { EditorView, drawSelection, keymap, placeholder } from '@codemirror/view'
import { tags } from '@lezer/highlight'
import { blocks, redraw } from './blocks'
import { formattingKeys } from './commands'
import { livePreview } from './livePreview'
import { linkHost, showMarkdown, type LinkHost } from './options'
import { slashCompletions } from './slash'
import { linkCompletions, wikiLinks } from './wikiLinks'
import { setMarks, workMarks, type Marks } from './workMarks'
import type { LiveNote } from '../data/liveNote'
import type { TextEdit } from '../../../shared/noteDoc.ts'

// Colours come from the page's tokens, so the editor is black on white or white on black with everything else.
const highlight = HighlightStyle.define([
  { tag: tags.strong, fontWeight: '700' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.strikethrough, textDecoration: 'line-through', color: 'var(--muted)' },
  { tag: tags.processingInstruction, color: 'var(--faint)' },
  { tag: tags.url, color: 'var(--faint)' },
  { tag: tags.link, color: 'var(--text)' },
  { tag: tags.quote, color: 'var(--text-2)' },
  { tag: tags.monospace, fontFamily: 'var(--mono)' },
  // Code inside fenced blocks: quiet, shades of the text colour, with one tint for strings.
  { tag: tags.keyword, color: 'var(--text)', fontWeight: '600' },
  { tag: [tags.string, tags.special(tags.string)], color: 'var(--green)' },
  { tag: tags.comment, color: 'var(--faint)', fontStyle: 'italic' },
  { tag: [tags.number, tags.bool, tags.null], color: 'var(--blue)' },
  { tag: [tags.typeName, tags.className], color: 'var(--text)' },
  { tag: [tags.function(tags.variableName), tags.propertyName], color: 'var(--text-2)' },
])

export interface EditorHandle {
  view: () => EditorView | undefined
}

interface Props {
  text: string
  /** Your edit: the Automerge changes it made to the note's document, or only the text before the document is here. */
  onChange: (text: string, changes?: string[]) => void
  /** The note's live document: once it's here, the editor shows its text and turns what you type into its changes. */
  live?: LiveNote
  links: LinkHost
  marks: Marks
  raw: boolean
  /** The note it shows, so pasted pictures are kept with its binder. */
  noteId?: string
  /** Shown, not changed: a note someone else has locked. Set from the start: the parent keys it by this too. */
  readOnly?: boolean
}

/** The note as Markdown, shown rendered. The parent keys it by note, so each note gets its own editor and history. */
export const MarkdownEditor = forwardRef<EditorHandle, Props>(function MarkdownEditor({ text, onChange, live, links, marks, raw, noteId, readOnly }, ref) {
  const host = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView>(undefined)
  const change = useRef(onChange)
  change.current = onChange
  const liveRef = useRef(live)
  liveRef.current = live
  const linksRef = useRef(links)
  linksRef.current = links
  const compartments = useRef({ raw: new Compartment() })

  useImperativeHandle(ref, () => ({ view: () => view.current }), [])

  useEffect(() => {
    // The link host reads the latest notes each time it's asked, so new notes show without rebuilding the editor.
    const stableLinks: LinkHost = {
      titles: () => linksRef.current.titles(),
      exists: (title) => linksRef.current.exists(title),
      open: (title) => linksRef.current.open(title),
    }
    const editor = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: text,
        extensions: [
          history(),
          drawSelection(),
          indentOnInput(),
          EditorView.lineWrapping,
          markdown({ base: markdownLanguage, codeLanguages: languages, addKeymap: true }),
          syntaxHighlighting(highlight),
          highlightSelectionMatches(),
          compartments.current.raw.of(showMarkdown.of(raw)),
          linkHost.of(stableLinks),
          livePreview,
          wikiLinks,
          blocks,
          workMarks,
          pictureDrops,
          noteOf.of(noteId ?? ''),
          EditorState.readOnly.of(!!readOnly),
          EditorView.editable.of(!readOnly),
          Prec.high(controlPaste),
          autocompletion({ override: [linkCompletions, slashCompletions], icons: false, closeOnBlur: true, activateOnTyping: true }),
          keymap.of([...formattingKeys, ...completionKeymap, ...searchKeymap, ...historyKeymap, ...defaultKeymap, indentWithTab]),
          placeholder('Start with a title, then write. Type / for headings, lists, tables and diagrams, and [[ to link a note.'),
          EditorView.updateListener.of((update) => {
            // A change that came from the hub isn't sent back to it.
            const yours = update.transactions.filter((t) => t.docChanged && !t.annotation(Transaction.remote))
            if (!yours.length) return
            const text = update.state.doc.toString()
            const doc = liveRef.current
            if (!doc?.ready) return change.current(text)
            // Each of your edits, in order, made to the note's document as it goes.
            const edits: TextEdit[] = []
            for (const t of yours) t.changes.iterChanges((fromA, toA, fromB, _toB, inserted) => edits.push({ from: fromB, to: fromB + toA - fromA, insert: inserted.toString() }))
            const made = doc.edit(edits)
            if (made) change.current(text, [made])
          }),
          EditorView.contentAttributes.of({ 'aria-label': 'Note', spellcheck: 'true' }),
        ],
      }),
    })
    view.current = editor
    editor.dispatch({ effects: setMarks.of(marks) })
    // A new note opens with the caret ready.
    if (!text.replace(/^#\s*$/m, '').trim()) {
      editor.dispatch({ selection: { anchor: editor.state.doc.length } })
      editor.focus()
    }
    // Diagrams follow the theme.
    const retheme = () => editor.dispatch({ effects: redraw.of(null) })
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    media.addEventListener('change', retheme)
    window.addEventListener('binders-theme', retheme)
    return () => {
      media.removeEventListener('change', retheme)
      window.removeEventListener('binders-theme', retheme)
      editor.destroy()
      view.current = undefined
    }
    // One editor per note: the parent keys this component by the note's id.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Before the note's document is here, someone else's change comes as the note's text: only what differs goes in.
  useEffect(() => {
    if (!view.current || live?.ready) return
    showText(view.current, text)
  }, [text, live])

  // Once it's here, the document says what changed, edit by edit, so your caret stays where you were typing.
  useEffect(() => {
    if (!live) return
    const shown = (edits: TextEdit[] | undefined, after: string) => {
      const editor = view.current
      if (!editor) return
      if (edits) {
        let changes = ChangeSet.empty(editor.state.doc.length)
        try {
          for (const e of edits) changes = changes.compose(ChangeSet.of(e, changes.newLength))
          editor.dispatch({ changes, annotations: [Transaction.remote.of(true), Transaction.addToHistory.of(false)] })
        } catch {
          // Out of step: the text as the document has it puts that right.
        }
      }
      showText(editor, after)
    }
    if (live.ready) shown(undefined, live.text!)
    return live.subscribe(shown)
  }, [live])

  useEffect(() => {
    view.current?.dispatch({ effects: setMarks.of(marks) })
  }, [marks])

  useEffect(() => {
    view.current?.dispatch({ effects: compartments.current.raw.reconfigure(showMarkdown.of(raw)) })
  }, [raw])

  return <div className="md-editor" ref={host} />
})

/** The editor shows `text`: only what differs goes in, as a teammate's change, so your caret and undo history stay. */
function showText(editor: EditorView, text: string) {
  const current = editor.state.doc.toString()
  if (current === text) return
  let start = 0
  while (start < current.length && start < text.length && current[start] === text[start]) start++
  let endOld = current.length
  let endNew = text.length
  while (endOld > start && endNew > start && current[endOld - 1] === text[endNew - 1]) {
    endOld--
    endNew--
  }
  editor.dispatch({ changes: { from: start, to: endOld, insert: text.slice(start, endNew) }, annotations: [Transaction.remote.of(true), Transaction.addToHistory.of(false)] })
}
