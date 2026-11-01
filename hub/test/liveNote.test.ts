import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Hub } from '../src/hub.ts'
import { MemoryLog } from '../src/log.ts'
import { save, type TextEdit } from '../../shared/noteDoc.ts'
import { titleOf } from '../../shared/notes.ts'
import type { Change, Entry, Outgoing } from '../../shared/state.ts'
import { LiveNote, type Waiting } from '../../web/src/data/liveNote.ts'
import { seed, until } from './helpers.ts'

// The web app's editor and the hub together: each "browser" here is the web app's own LiveNote with an editor's text
// and caret beside it, sending what it types the way the store does and hearing the hub's live feed.

const paragraph = '# First note\n\nThe board is slow to load.\n'

let made = 0

function browser(hub: Hub, login: string, noteId = 'n1') {
  const tab = `tab-${login}`
  const outbox: Outgoing[] = []
  const missed: Entry[] = []
  let deaf = false
  let offline = false
  let text = ''
  let caret = 0
  const waiting = (): Waiting => {
    const w: Waiting = { changes: [], whole: false }
    for (const { change } of outbox) {
      if (change.type === 'note.put' && change.note.id === noteId) Object.assign(w, { created: change.note.text, changes: [], whole: false })
      if (change.type === 'note.edit' && change.id === noteId) {
        if (change.changes) w.changes.push(...change.changes)
        else w.whole = true
      }
    }
    return w
  }
  const live = new LiveNote(noteId, { fetchDoc: async () => { const doc = offline ? undefined : hub.noteDoc(noteId); return doc && save(doc) }, waiting })
  // The editor: the document's edits go in one after another, and the caret moves with what's typed before it.
  live.subscribe((edits, after) => {
    for (const e of edits ?? []) {
      text = text.slice(0, e.from) + e.insert + text.slice(e.to)
      if (e.from < caret) caret = e.to <= caret ? caret + e.insert.length - (e.to - e.from) : e.from + e.insert.length
    }
    if (edits) assert.equal(text, after, 'the edits take the editor to the document’s text')
    text = after
  })
  hub.on('entries', (entries) => {
    if (deaf) return missed.push(...entries)
    const mine = (entry: Entry) => entry.client.endsWith(`:${tab}`)
    for (const entry of entries) {
      const change = entry.change
      if (change.type === 'note.edit' && change.changes) live.hear(change.changes)
      else if (change.type === 'note.put' && !mine(entry)) void live.reset()
    }
  })
  const queue = (change: Change) => outbox.push({ id: `${login}-${++made}`, change })
  return {
    live,
    get text() { return text },
    get caret() { return caret },
    put(first: string) {
      queue({ type: 'note.put', note: { id: noteId, title: titleOf(first), binderId: 'b1', editedAt: 'now', editors: [login], text: first } })
      text = first
    },
    /** Puts the caret just after `before`'s first match, or at `at`. */
    click(before: string) {
      caret = text.indexOf(before) + before.length
    },
    /** Types at the caret, as the editor would: an Automerge change once the document is here, else the whole text. */
    type(words: string) {
      const edits: TextEdit[] = [{ from: caret, to: caret, insert: words }]
      text = text.slice(0, caret) + words + text.slice(caret)
      caret += words.length
      const change = live.edit(edits)
      queue({ type: 'note.edit', id: noteId, text, title: titleOf(text), by: login, at: 'now', ...(change ? { changes: [change] } : {}) })
    },
    async send() {
      await hub.submit(login, tab, outbox.splice(0))
    },
    deafen() { deaf = true },
    /** Shows the note as the store has it, before the document is here. */
    show(shown: string) { text = shown },
    set offline(value: boolean) { offline = value },
  }
}

describe('the web app’s editor on Automerge', () => {
  it('two people typing in the same paragraph both keep their words, and their carets stay where they were typing', async () => {
    const hub = new Hub(new MemoryLog())
    await hub.start(seed())
    await hub.record({ kind: 'hub' }, { type: 'note.edit', id: 'n1', text: paragraph, title: titleOf(paragraph), by: 'you', at: 'now' })
    const ann = browser(hub, 'ann')
    const ben = browser(hub, 'ben')
    await Promise.all([ann.live.open(), ben.live.open()])
    assert.equal(ann.text, paragraph)
    assert.equal(ben.text, paragraph)

    ann.click('The board')
    ben.click('is ')
    // Both type before either hears the other.
    ann.type(' on the home page')
    ben.type('far too ')
    ann.type(',')
    await Promise.all([ann.send(), ben.send()])

    const merged = '# First note\n\nThe board on the home page, is far too slow to load.\n'
    await until(() => ann.text === merged && ben.text === merged)
    assert.equal(hub.state.notes.find((n) => n.id === 'n1')!.text, merged)
    assert.equal(ann.caret, merged.indexOf(', is') + 1, 'Ann’s caret is still after her comma')
    assert.equal(ben.caret, merged.indexOf('slow'), 'Ben’s caret moved on with Ann’s words before it')

    // And on: each keeps typing where they are.
    ann.type(' really')
    ben.type('very ')
    await ben.send()
    await ann.send()
    const again = '# First note\n\nThe board on the home page, really is far too very slow to load.\n'
    await until(() => ann.text === again && ben.text === again)
    assert.equal(hub.state.notes.find((n) => n.id === 'n1')!.text, again)
  })

  it('a note made in this tab starts its document as the hub will, so what you type before the hub has it goes in', async () => {
    const hub = new Hub(new MemoryLog())
    await hub.start(seed())
    const ann = browser(hub, 'ann', 'n-new')
    ann.put('# ')
    await ann.live.open()
    assert.ok(ann.live.ready)
    ann.click('# ')
    ann.type('Plans')
    await ann.send()
    assert.equal(hub.state.notes.find((n) => n.id === 'n-new')!.text, '# Plans')
  })

  it('what was typed as the whole text before the document came goes first, and the document comes after', async () => {
    const hub = new Hub(new MemoryLog())
    await hub.start(seed())
    await hub.record({ kind: 'hub' }, { type: 'note.edit', id: 'n1', text: paragraph, title: titleOf(paragraph), by: 'you', at: 'now' })
    const ann = browser(hub, 'ann')
    ann.offline = true
    ann.show(paragraph)
    await ann.live.open()
    assert.ok(!ann.live.ready)
    ann.click('slow')
    ann.type(' and stuck')
    ann.offline = false
    // Back: the document waits until the whole text has gone, so the words don't go twice.
    await new Promise((done) => setTimeout(done, 1200))
    assert.ok(!ann.live.ready)
    await ann.send()
    await until(() => ann.live.ready, 3000)
    assert.equal(ann.text, '# First note\n\nThe board is slow and stuck to load.\n')
    ann.type('!')
    await ann.send()
    assert.equal(hub.state.notes.find((n) => n.id === 'n1')!.text, '# First note\n\nThe board is slow and stuck! to load.\n')
    ann.live.close()
  })

  it('after missing the live feed, the hub’s document is merged in and what you typed meanwhile stays', async () => {
    const hub = new Hub(new MemoryLog())
    await hub.start(seed())
    await hub.record({ kind: 'hub' }, { type: 'note.edit', id: 'n1', text: paragraph, title: titleOf(paragraph), by: 'you', at: 'now' })
    const ann = browser(hub, 'ann')
    const ben = browser(hub, 'ben')
    await Promise.all([ann.live.open(), ben.live.open()])
    ann.deafen()
    ben.click('slow')
    ben.type(' (again)')
    await ben.send()
    ann.click('# First note')
    ann.type('!')
    await ann.live.refresh()
    assert.equal(ann.text, '# First note!\n\nThe board is slow (again) to load.\n')
    await ann.send()
    assert.equal(hub.state.notes.find((n) => n.id === 'n1')!.text, ann.text)
  })
})
