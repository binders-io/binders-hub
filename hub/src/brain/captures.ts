import type { KV } from '../kv.ts'
import type { CaptureKind, Summary, TimedText } from './models.ts'

// What a phone or Mac sends the hub when it captured something: a dictation, a conversation it heard, or a meeting,
// as words, or as its sound when the hub has a transcription model (written down, then let go: the hub keeps no audio). Each becomes a note in a binder's inbox folder, with the transcript under a heading of
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

/** The fewest words a note needs to be worth summing up. */
export const summaryMinWords = 25

/** Whether words are enough to be worth summing up. */
export const worthSumming = (text: string) => text.trim().split(/\s+/).length >= summaryMinWords

/** Whether a note has a summary under its heading already. */
export const hasSummary = (markdown: string) => markdown.includes(`\n${summaryHeading}\n`)

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

/** A title for a capture with none: its first words, without a transcript's marks (who spoke, and when). */
export function firstWords(text: string, most = 60) {
  const line = text.replace(/\*\*\[[^\]]*\][^*]*\*\*/g, ' ').replace(/[*_#`>]+/g, ' ').replace(/\s+/g, ' ').trim()
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

/** A stretch of a transcript and who said it: the device's label for the voice ("Speaker 1"), when it told voices apart. */
export interface SaidBy extends TimedText {
  speaker?: string
}

/** A transcript as a note keeps it: "**[02:15] Ana:** what was said", one stretch a paragraph, names as the device gave them. */
export function transcriptMarkdown(segments: SaidBy[], names: Record<string, string> = {}) {
  const lines: string[] = []
  for (const segment of segments) {
    const said = segment.text.trim()
    if (!said) continue
    const label = segment.speaker ?? ''
    const who = (names[label] || label || 'Someone').replace(/[*\n]+/g, ' ').trim().slice(0, 80) || 'Someone'
    const seconds = Math.max(0, Math.round(segment.start || 0))
    lines.push(`**[${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}] ${who}:** ${said}`)
  }
  return lines.join('\n\n')
}

/**
 * Who said each stretch the hub wrote down: the voice whose turns (as the device told voices apart) overlap it most,
 * or the nearest turn when none overlaps. Without turns, nobody is named.
 */
export function speakersByOverlap(segments: TimedText[], turns: { start: number; end: number; speaker: string }[]): SaidBy[] {
  if (!turns.length) return segments.map((s) => ({ ...s }))
  return segments.map((segment) => {
    const end = Math.max(segment.end, segment.start)
    let best: string | undefined
    let most = 0
    for (const turn of turns) {
      const overlap = Math.min(end, turn.end) - Math.max(segment.start, turn.start)
      if (overlap > most) {
        most = overlap
        best = turn.speaker
      }
    }
    if (!best) {
      const middle = (segment.start + end) / 2
      best = turns.reduce((near, turn) => (Math.abs((turn.start + turn.end) / 2 - middle) < Math.abs((near.start + near.end) / 2 - middle) ? turn : near)).speaker
    }
    return { ...segment, speaker: best }
  })
}

/** A captured note with its transcript put in again (written down better): what's under its heading, and nothing else. */
export function withTranscript(markdown: string, transcript: string) {
  const start = markdown.indexOf(`\n${transcriptHeading}\n`)
  if (start < 0) return `${markdown.replace(/\n+$/, '')}\n\n${transcriptHeading}\n\n${transcript.trim()}\n`
  const bodyStart = start + 1 + transcriptHeading.length
  const rest = markdown.slice(bodyStart)
  const next = rest.search(/\n## /)
  const after = next >= 0 ? rest.slice(next) : ''
  return `${markdown.slice(0, bodyStart)}\n\n${transcript.trim()}\n${after ? `${after.replace(/^\n?/, '\n')}` : ''}`
}

/** The words to sum up in a note as it reads now: what's under its transcript heading, or, with none, everything under its title. */
export function transcriptOf(markdown: string) {
  const start = markdown.indexOf(`\n${transcriptHeading}\n`)
  if (start < 0) return markdown.replace(/^#[^\n]*\n?/, '').trim()
  const rest = markdown.slice(start + 1 + transcriptHeading.length)
  const next = rest.search(/\n## /)
  return (next >= 0 ? rest.slice(0, next) : rest).trim()
}

// Where a person's captures go is theirs to say, and only theirs: kept in their own Binder's store, which nobody else
// reads. The Binder's id, or nothing for their own.
const homeKey = 'capture-home'

/** The Binder a person chose for what they capture, if they did. */
export const chosenHome = (kv: KV) => kv.get(homeKey).then((id) => id || undefined, () => undefined)

/** Chooses the Binder for what a person captures; none puts it back to their own. */
export const chooseHome = (kv: KV, id?: string) => (id ? kv.set(homeKey, id) : kv.del(homeKey))
