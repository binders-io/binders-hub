import type { WaitKind, Waiting } from '../../../shared/waiting.ts'

/**
 * What the rows are, in a line for the count: "2 questions · 1 to approve". The count is of rows, so each part counts
 * rows too and they add up to it. A row that stands for several things (a note's proposed cards, a card's findings)
 * counts as one and says how many it holds.
 */
export function whatWaits(rows: Waiting[]) {
  const of = (...kinds: WaitKind[]) => rows.filter((r) => kinds.includes(r.kind))
  const holds = (list: Waiting[]) => list.reduce((n, r) => n + r.count, 0)
  const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
  // "1 note with 9 proposed" when a row holds more than one thing, else just "1 proposed".
  const many = (list: Waiting[], what: string, within: string) => (holds(list) === list.length ? `${list.length} ${what}` : `${plural(list.length, within)} with ${holds(list)} ${what}`)
  const counts: [Waiting[], (list: Waiting[]) => string][] = [
    [of('question'), (l) => plural(l.length, 'question')],
    [of('stopped'), (l) => plural(l.length, 'stopped card')],
    [of('permission'), (l) => plural(l.length, 'permission')],
    [of('changeSet'), (l) => `${l.length} to approve`],
    [of('proposals'), (l) => many(l, 'proposed', 'note')],
    [of('noteChange'), (l) => plural(l.length, 'note change')],
    [of('findings'), (l) => many(l, 'to look at', 'card')],
    [of('promotion'), (l) => `${l.length} to promote`],
  ]
  return counts.filter(([list]) => list.length > 0).map(([list, say]) => say(list)).join(' · ')
}
