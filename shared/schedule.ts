// Scheduled runs: a note run as a card, on a cron rule in a time zone. The note is the instructions; each time the
// schedule fires, the hub puts a card on the board with the note's words as they are then, for the agent it names
// (or any agent). Times are kept as cron (minute hour day-of-month month day-of-week), the presets people pick
// written as cron too, and worked out here so the hub and the web app agree on when the next run is.

export interface Schedule {
  id: string
  noteId: string
  binderId: string
  /** The agent its cards are meant for; none for the first one free. */
  agentId?: string
  cron: string
  /** An IANA time zone ("America/New_York"), the one the cron's times are in. */
  tz: string
  enabled: boolean
  createdAt: string
  createdBy: string
  /** When it last fired, and the card it made (or why it made none). */
  lastRun?: string
  lastCardId?: string
  lastSkipped?: string
}

type Field = { values: Set<number>; any: boolean }

const ranges: [number, number][] = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 6]]
const names: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6, jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 }

function field(text: string, [low, high]: [number, number], index: number): Field {
  const values = new Set<number>()
  const number = (s: string) => {
    const n = names[s.toLowerCase()] ?? (/^\d+$/.test(s) ? Number(s) : NaN)
    // Sunday is 0 or 7.
    const v = index === 4 && n === 7 ? 0 : n
    if (Number.isNaN(v) || v < low || v > high) throw new Error(`“${s}” isn’t a value from ${low} to ${high}.`)
    return v
  }
  for (const part of text.split(',')) {
    const [range, stepText] = part.split('/')
    const step = stepText === undefined ? 1 : Number(stepText)
    if (!Number.isInteger(step) || step < 1) throw new Error(`“${part}” has a step that isn’t a whole number.`)
    let from = low
    let to = high
    if (range !== '*') {
      const [a, b] = range.split('-')
      from = number(a)
      to = b === undefined ? (stepText === undefined ? from : high) : number(b)
      if (index === 4 && b !== undefined && b === '7') to = 6
    }
    if (from > to) throw new Error(`“${part}” runs backwards.`)
    for (let v = from; v <= to; v += step) values.add(v)
  }
  return { values, any: text === '*' }
}

/** A cron rule read, or why it can't be. */
export function parseCron(cron: string) {
  const parts = cron.trim().split(/\s+/)
  if (parts.length !== 5) throw new Error('A schedule is five fields: minute, hour, day of the month, month, day of the week.')
  const [minute, hour, day, month, weekday] = parts.map((p, i) => field(p, ranges[i], i))
  return { minute, hour, day, month, weekday }
}

/** A time zone the hub and browsers know, or why not. */
export function checkTimeZone(tz: string) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
  } catch {
    throw new Error(`“${tz}” isn’t a time zone.`)
  }
}

const formats = new Map<string, Intl.DateTimeFormat>()
/** The wall-clock time at `at` in `tz`. */
function wall(at: Date, tz: string) {
  let format = formats.get(tz)
  if (!format) {
    format = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', weekday: 'short' })
    formats.set(tz, format)
  }
  const parts = Object.fromEntries(format.formatToParts(at).map((p) => [p.type, p.value]))
  return { month: Number(parts.month), day: Number(parts.day), hour: Number(parts.hour) % 24, minute: Number(parts.minute), weekday: names[String(parts.weekday).toLowerCase().slice(0, 3)] }
}

/** The first time after `after` the rule fires, in its time zone; none within a year and a bit. */
export function nextRun(cron: string, tz: string, after: Date): Date | undefined {
  const rule = parseCron(cron)
  const minute = 60_000
  let t = new Date(Math.floor(after.getTime() / minute) * minute + minute)
  const end = after.getTime() + 400 * 86_400_000
  while (t.getTime() <= end) {
    const w = wall(t, tz)
    // Day of the month and day of the week: either, when both are given (as cron has it); else whichever is.
    const dayOk = rule.day.any && rule.weekday.any ? true
      : rule.day.any ? rule.weekday.values.has(w.weekday)
        : rule.weekday.any ? rule.day.values.has(w.day)
          : rule.day.values.has(w.day) || rule.weekday.values.has(w.weekday)
    if (!rule.month.values.has(w.month) || !dayOk) {
      // On to the next local midnight (or near it: a time zone's change of hour lands within the next pass).
      t = new Date(t.getTime() + ((23 - w.hour) * 60 + (60 - w.minute)) * minute)
      continue
    }
    if (!rule.hour.values.has(w.hour)) {
      t = new Date(t.getTime() + (60 - w.minute) * minute)
      continue
    }
    if (!rule.minute.values.has(w.minute)) {
      t = new Date(t.getTime() + minute)
      continue
    }
    return t
  }
  return undefined
}

export type Preset = { kind: 'hourly'; minute: number } | { kind: 'daily' | 'weekdays'; time: string } | { kind: 'weekly'; day: number; time: string } | { kind: 'cron'; cron: string }

export const weekdays = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

/** A preset as cron. */
export function presetCron(preset: Preset): string {
  const hm = (time: string) => {
    const [h, m] = time.split(':').map(Number)
    return `${m || 0} ${h || 0}`
  }
  switch (preset.kind) {
    case 'hourly': return `${preset.minute} * * * *`
    case 'daily': return `${hm(preset.time)} * * *`
    case 'weekdays': return `${hm(preset.time)} * * 1-5`
    case 'weekly': return `${hm(preset.time)} * * ${preset.day}`
    case 'cron': return preset.cron.trim()
  }
}

/** Cron as the preset it was made from, when it's one; else as cron. */
export function cronPreset(cron: string): Preset {
  const m = /^(\d{1,2}) (\*|\d{1,2}) \* \* (\*|1-5|[0-6])$/.exec(cron.trim())
  if (!m) return { kind: 'cron', cron }
  const [, minute, hour, days] = m
  if (hour === '*') return days === '*' ? { kind: 'hourly', minute: Number(minute) } : { kind: 'cron', cron }
  const time = `${hour.padStart(2, '0')}:${minute.padStart(2, '0')}`
  return days === '*' ? { kind: 'daily', time } : days === '1-5' ? { kind: 'weekdays', time } : { kind: 'weekly', day: Number(days), time }
}

/** When it runs, in words: "Weekdays at 09:00", "Every hour at :15", or the cron itself. */
export function describeCron(cron: string): string {
  const p = cronPreset(cron)
  switch (p.kind) {
    case 'hourly': return `Every hour at :${String(p.minute).padStart(2, '0')}`
    case 'daily': return `Every day at ${p.time}`
    case 'weekdays': return `Weekdays at ${p.time}`
    case 'weekly': return `Every ${weekdays[p.day]} at ${p.time}`
    case 'cron': return `Cron ${p.cron}`
  }
}
