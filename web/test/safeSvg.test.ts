// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { safeSvg } from '../src/editor/safeSvg'
import { keepDrawing } from '../src/editor/blocks'

// Mermaid sanitizes what it draws, with securityLevel strict. This is the second lock on the door, and it has to let
// through what Mermaid draws: a stock DOMPurify takes every label out of a flowchart.

const label = '<g class="node"><foreignObject width="50" height="20"><div xmlns="http://www.w3.org/1999/xhtml" style="display:inline-block"><span class="nodeLabel"><p>Hello label</p></span></div></foreignObject></g>'
const drawing = (inside: string) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><style>.node{fill:red}</style>${inside}</svg>`

const put = (svg: string) => {
  const box = document.createElement('div')
  box.replaceChildren(safeSvg(svg))
  return box
}

describe('a diagram made safe', () => {
  it('keeps what a diagram is made of: labels in foreignObject, and its styles', () => {
    const box = put(drawing(label))
    expect(box.textContent).toContain('Hello label')
    expect(box.querySelector('foreignObject')).not.toBeNull()
    expect(box.querySelector('style')?.textContent).toContain('fill:red')
    expect(box.querySelector('svg')?.getAttribute('viewBox')).toBe('0 0 10 10')
  })

  it('takes out script, however it comes', () => {
    const box = put(`<svg xmlns="http://www.w3.org/2000/svg" onload="window.hit=1"><script>window.hit=2</script><foreignObject><img src="x" onerror="window.hit=3"><iframe src="javascript:window.hit=4"></iframe></foreignObject><a href="javascript:window.hit=5"><text>click</text></a></svg>`)
    const html = box.innerHTML
    expect(html).not.toMatch(/onload|onerror|<script|<iframe|javascript:/i)
    expect(box.textContent).toContain('click')
  })

  it('gives nodes to put in the page, not text to parse', () => {
    expect(safeSvg(drawing(label))).toBeInstanceOf(DocumentFragment)
  })
})

describe('the diagrams kept', () => {
  it('keeps the latest, dropping the one unused longest', () => {
    const kept = new Map<string, number>()
    keepDrawing(kept, 'a', 1, 2)
    keepDrawing(kept, 'b', 2, 2)
    keepDrawing(kept, 'a', 1, 2)
    keepDrawing(kept, 'c', 3, 2)
    expect([...kept.keys()]).toEqual(['a', 'c'])
  })
})
