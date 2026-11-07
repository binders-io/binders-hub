import type { CaptureKind, Summary } from './models.ts'

// What a phone or Mac sends the hub when it captured something: a dictation, a conversation it heard, or a meeting,
// as words (never the sound). Each becomes a note in a binder's inbox folder, with the transcript under a heading of
// its own, and the brain's summary above it when the hub has a model. The summary is the hub's to write again: it sits
// under its own heading, and the words people add elsewhere in the note are never touched.

export interface Capture {
  kind: CaptureKind
  /** The words: the transcript, or the dictated text. */
  text: string
  title?: string
  /** When it was recorded, as the device says (ISO 8601). */
  recordedAt?: string
  durationSeconds?: number
  /** The device it came from, as its person named it: "Ana’s iPhone". */
  device?: string
  /** Who was speaking, when the device could tell. */
  speakers?: string[]
}

export const summaryHeading = '## Summary'
export const transcriptHeading = '## Transcript'

const kindNames: Record<CaptureKind, string> = { dictation: 'Dictation', conversation: 'Conversation', meeting: 'Meeting', note: 'Note' }

function minutes(seconds: number) {
  if (seconds < 60) return `${Math.max(1, Math.round(seconds))} s`
  const m = Math.round(seconds / 60)
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`
}

/** The line under a capture's title: what it was, when, how long, from where. */
export function captureLine(capture: Capture, now = new Date()) {
  const when = capture.recordedAt && !Number.isNaN(Date.parse(capture.recordedAt)) ? new Date(capture.recordedAt) : now
  const parts = [kindNames[capture.kind], when.toISOString().slice(0, 16).replace('T', ' ') + ' UTC']
  if (capture.durationSeconds && capture.durationSeconds > 0) parts.push(minutes(capture.durationSeconds))
  if (capture.device) parts.push(`from ${capture.device.slice(0, 80)}`)
  if (capture.speakers?.length) parts.push(`with ${capture.speakers.slice(0, 12).join(', ')}`)
  return parts.join(' · ')
}

/** A title for a capture with none: its first words. */
export function firstWords(text: string, most = 60) {
  const line = text.replace(/\s+/g, ' ').trim()
  if (line.length <= most) return line || 'Captured'
  const cut = line.slice(0, most)
  return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), most / 2)).replace(/[,.;:!?-]+$/, '')}…`
}

/** A summary as Markdown, under its heading. */
export function summaryMarkdown(summary: Summary) {
  const list = (name: string, lines: string[]) => (lines.length ? `\n\n**${name}**\n\n${lines.map((l) => `- ${l.replace(/\n+/g, ' ')}`).join('\n')}` : '')
  return `${summaryHeading}\n\n${summary.summary}${list('Points', summary.points)}${list('Decisions', summary.decisions)}${list('Follow-ups', summary.followUps)}`
}

/**
 * The note a capture makes. Dictation is the person's own words, so it's the note itself; a conversation or meeting
 * keeps its transcript under a heading, for the summary to go above.
 */
export function captureNote(capture: Capture, title: string, now = new Date()) {
  const head = `# ${title.replace(/\n+/g, ' ').trim()}\n\n_${captureLine(capture, now)}_`
  if (capture.kind === 'dictation' || capture.kind === 'note') return `${head}\n\n${capture.text.trim()}\n`
  return `${head}\n\n${transcriptHeading}\n\n${capture.text.trim()}\n`
}

/**
 * A note with a summary put in, or put in again: under the line beneath the title, before the transcript. When the note
 * still starts with the title the hub chose for it (`retitleFrom`), that first line becomes the summary's title.
 */
export function withSummary(markdown: string, summary: Summary, retitleFrom?: string) {
  let text = markdown
  const first = text.split('\n', 1)[0]
  if (retitleFrom !== undefined && first === `# ${retitleFrom}`) text = `# ${summary.title.replace(/\n+/g, ' ')}${text.slice(first.length)}`
  const block = summaryMarkdown(summary)
  const start = text.indexOf(`\n${summaryHeading}\n`)
  if (start >= 0) {
    // Up to the next heading of the same level, or the end.
    const rest = text.slice(start + 1 + summaryHeading.length)
    const next = rest.search(/\n## /)
    const end = next >= 0 ? start + 1 + summaryHeading.length + next : text.length
    return `${text.slice(0, start + 1)}${block}\n${text.slice(end).replace(/^\n?/, '\n')}`.replace(/\n{3,}/g, '\n\n')
  }
  const transcript = text.indexOf(`\n${transcriptHeading}\n`)
  if (transcript >= 0) return `${text.slice(0, transcript + 1)}${block}\n\n${text.slice(transcript + 1)}`
  return `${text.replace(/\n+$/, '')}\n\n${block}\n`
}
