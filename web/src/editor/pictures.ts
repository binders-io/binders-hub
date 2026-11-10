import { spaceHeaders } from '../data/space'
import { EditorView, keymap } from '@codemirror/view'
import { Facet } from '@codemirror/state'

/** The note an editor shows, so its pictures are kept with its binder. */
export const noteOf = Facet.define<string, string | undefined>({ combine: (values) => values[0] })
import { HubError, isNetworkFailure, unreachable } from '../data/api'
import { failure } from '../components/Toast'

// Pictures in notes: pasted, dropped or picked, sent to the hub, and written into the note as Markdown where they land.

/** Sends a picture to the hub; its address in the note comes back. */
export async function uploadPicture(file: Blob, noteId?: string): Promise<string> {
  const response = await fetch(`/api/files${noteId ? `?note=${encodeURIComponent(noteId)}` : ''}`, { method: 'POST', credentials: 'same-origin', headers: { 'x-binders': '1', 'content-type': file.type, ...spaceHeaders }, body: file })
  const body = (await response.json().catch(() => ({}))) as { url?: string; error?: string }
  if (!response.ok || !body.url) throw new HubError(response.status, body.error ?? 'The picture couldn’t be saved.')
  return body.url
}

const describe = (file: File) => file.name.replace(/\.[a-z0-9]+$/i, '').replace(/[[\]]/g, '') || 'Picture'

/** Puts the pictures in at `at`, each on a line of its own, with a placeholder while each one sends. */
export async function insertPictures(view: EditorView, files: File[], at: number) {
  const pictures = files.filter((f) => f.type.startsWith('image/'))
  if (!pictures.length) return 0
  const waiting = pictures.map((file, i) => `![Sending ${describe(file)}…${i ? ` ${i + 1}` : ''}]()`)
  const line = view.state.doc.lineAt(at)
  const text = `${at > line.from && line.text.trim() ? '\n' : ''}${waiting.join('\n')}\n`
  view.dispatch({ changes: { from: at, insert: text }, selection: { anchor: at + text.length }, scrollIntoView: true })
  await Promise.all(pictures.map(async (file, i) => {
    let replacement = ''
    try {
      replacement = `![${describe(file)}](${await uploadPicture(file, view.state.facet(noteOf) || undefined)})`
    } catch (error) {
      // The browser's own words for a request that got no answer say nothing a person can use.
      failure(isNetworkFailure(error) ? unreachable : (error as Error).message)
    }
    // Found again by its text: the note may have changed while it sent.
    const from = view.state.doc.toString().indexOf(waiting[i])
    if (from >= 0) view.dispatch({ changes: { from, to: from + waiting[i].length + (replacement ? 0 : 1), insert: replacement } })
  }))
  return pictures.length
}

/** Opens the file picker for pictures, then puts them in at the caret. */
export function pickPictures(view: EditorView, from = view.state.selection.main.from, to = view.state.selection.main.to) {
  if (to > from) view.dispatch({ changes: { from, to, insert: '' } })
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = 'image/*'
  input.multiple = true
  input.onchange = () => void insertPictures(view, [...(input.files ?? [])], from)
  input.click()
}

/**
 * Control-V on a Mac: the browser doesn't paste with it (CodeMirror reads it as page down), so the clipboard is read
 * here, a picture going to the hub and text going in as typed.
 */
export async function pasteFromClipboard(view: EditorView) {
  const at = view.state.selection.main
  try {
    const items = await navigator.clipboard.read()
    const files: File[] = []
    for (const item of items) {
      const type = item.types.find((t) => t.startsWith('image/'))
      if (type) files.push(new File([await item.getType(type)], `Pasted picture.${type.split('/')[1]}`, { type }))
    }
    if (files.length) {
      if (at.to > at.from) view.dispatch({ changes: { from: at.from, to: at.to, insert: '' } })
      await insertPictures(view, files, at.from)
      return
    }
  } catch {
    // No permission for pictures, or none there: text instead.
  }
  const text = await navigator.clipboard.readText().catch(() => '')
  if (text) view.dispatch(view.state.replaceSelection(text), { scrollIntoView: true })
}

export const controlPaste = keymap.of([{ mac: 'Ctrl-v', run: (view) => { void pasteFromClipboard(view); return true } }])

const filesIn = (data: DataTransfer | null) => {
  const files = [...(data?.files ?? [])]
  // Some apps put a screenshot only in the items.
  if (!files.length) for (const item of data?.items ?? []) if (item.kind === 'file') { const f = item.getAsFile(); if (f) files.push(f) }
  return files.filter((f) => f.type.startsWith('image/'))
}

/** Paste and drop: pictures go to the hub instead of the browser opening them. */
export const pictureDrops = EditorView.domEventHandlers({
  paste(event, view) {
    const files = filesIn(event.clipboardData)
    if (!files.length) return false
    event.preventDefault()
    void insertPictures(view, files, view.state.selection.main.from)
    return true
  },
  drop(event, view) {
    const files = filesIn(event.dataTransfer)
    if (!files.length) return false
    event.preventDefault()
    const at = view.posAtCoords({ x: event.clientX, y: event.clientY }) ?? view.state.selection.main.from
    void insertPictures(view, files, at)
    return true
  },
})
