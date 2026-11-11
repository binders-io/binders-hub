import { describe, expect, it } from 'vitest'
import { appCss } from './css'

// Mermaid lays a drawing out by measuring it as it goes. With less motion asked for, every element is given a very short
// transition, and a node it had just moved still measured as where it was: the drawing came out scattered across an
// enormous, empty canvas, its words squashed to nothing. Its working copy and what it draws are kept clear of that.

describe('a drawing, with less motion asked for', () => {
  it('has no transition for Mermaid to measure through', () => {
    const css = appCss()
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\s*\[id\^="dmermaid-"\], \[id\^="dmermaid-"\] \*, svg\[id\^="mermaid-"\], svg\[id\^="mermaid-"\] \* \{ transition: none !important; \}/)
  })
})
