import type { ReactNode } from 'react'

// A model's words as React nodes. Only **bold** and `code` are understood; everything else, including anything that looks
// like markup, stays as the plain text it is. Nothing here makes HTML from a string, so there is nothing to get past.

const marks = /\*\*([^*]+)\*\*|`([^`]+)`/g

/** The words with **bold** and `code` turned into elements. A mark that isn't closed stays as written. */
export function inline(text: string): ReactNode[] {
  const out: ReactNode[] = []
  let from = 0
  for (const found of text.matchAll(marks)) {
    const at = found.index
    if (at > from) out.push(text.slice(from, at))
    out.push(found[1] !== undefined ? <strong key={at}>{found[1]}</strong> : <code key={at}>{found[2]}</code>)
    from = at + found[0].length
  }
  if (from < text.length) out.push(text.slice(from))
  return out
}
