import type { AnswerPart } from './models.ts'

// A model's view block, taken out of its words: the fenced block an answer may end with (see view.ts). Only text is
// handled here, so the models can use it before they read an answer's citations, which a view's lists of numbers look like.

const fence = /(^|\n)[ \t]*```+[ \t]*view\b[^\n]*\n([\s\S]*?)(?:\n[ \t]*```+[ \t]*(?=\n|$)|$)/i

/** A model's words without their view block, and the block as it was written. */
export function takeView(words: string): { words: string; raw?: string } {
  const found = fence.exec(words)
  if (!found) return { words }
  const before = words.slice(0, found.index).trimEnd()
  const after = words.slice(found.index + found[0].length).trim()
  return { words: `${before}${before && after ? '\n\n' : ''}${after}`, raw: found[2] }
}

/**
 * The same for an answer in parts, each with the sources it rests on: the block is cut out of the parts it runs
 * through, a part with nothing left goes, and what was said either side of it reads on as two paragraphs.
 */
export function takeViewFromParts(parts: AnswerPart[]): { parts: AnswerPart[]; raw?: string } {
  const found = fence.exec(parts.map((p) => p.text).join(''))
  if (!found) return { parts }
  const from = found.index
  const to = found.index + found[0].length
  const before: AnswerPart[] = []
  const after: AnswerPart[] = []
  let at = 0
  for (const part of parts) {
    const start = at
    at += part.text.length
    if (at <= from) before.push({ ...part })
    else if (start >= to) after.push({ ...part })
    else {
      const head = part.text.slice(0, Math.max(0, from - start))
      const tail = part.text.slice(Math.min(part.text.length, to - start))
      if (head.trim()) before.push({ ...part, text: head })
      if (tail.trim()) after.push({ ...part, text: tail })
    }
  }
  if (after[0]) after[0].text = after[0].text.replace(/^\s+/, '')
  const rest = after.filter((p) => p.text.trim())
  const last = before[before.length - 1]
  if (last) last.text = last.text.replace(/\s+$/, rest.length ? '\n\n' : '')
  return { parts: [...before, ...rest], raw: found[2] }
}
