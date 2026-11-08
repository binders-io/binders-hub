// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { citeMark, Rendered } from '../src/components/Rendered'

afterEach(cleanup)

const shown = (text: string, compact = false) => render(<Rendered text={text} compact={compact} />).container

describe('Markdown to read', () => {
  it('shows bold, italics, code and strikethrough without their marks', () => {
    const page = shown('Some **bold**, *italic*, `code` and ~~gone~~ words.')
    expect(page.querySelector('strong')?.textContent).toBe('bold')
    expect(page.querySelector('em')?.textContent).toBe('italic')
    expect(page.querySelector('code')?.textContent).toBe('code')
    expect(page.querySelector('s')?.textContent).toBe('gone')
    expect(page.textContent).toBe('Some bold, italic, code and gone words.')
  })

  it('shows headings, lists inside lists, quotes and rules', () => {
    const page = shown('# Top\n\nWords.\n\n- One\n  - Inner\n- Two\n\n3. Third\n4. Fourth\n\n> Said\n\n---\n')
    expect(page.querySelector('h3')?.textContent).toBe('Top')
    expect(page.querySelectorAll('ul > li').length).toBe(3)
    expect(page.querySelector('ul ul li')?.textContent).toBe('Inner')
    expect(page.querySelector('ol')?.getAttribute('start')).toBe('3')
    expect(page.querySelector('blockquote')?.textContent).toBe('Said')
    expect(page.querySelector('hr')).toBeTruthy()
    expect(page.textContent).not.toMatch(/[#>]/)
  })

  it('shows tasks with their boxes, which only say what they are', () => {
    const page = shown('- [x] Done it\n- [ ] Not yet\n')
    const boxes = [...page.querySelectorAll('input')]
    expect(boxes.map((b) => b.checked)).toEqual([true, false])
    expect(boxes.every((b) => b.disabled)).toBe(true)
    expect(page.textContent).not.toContain('[x]')
  })

  it('shows a code block as it’s written, and a table as a table', () => {
    const page = shown('```ts\nconst a = 1\n  **not bold**\n```\n\n| A | B |\n|---|---|\n| 1 | **2** |\n')
    expect(page.querySelector('pre code')?.textContent).toBe('const a = 1\n  **not bold**')
    expect([...page.querySelectorAll('th')].map((c) => c.textContent)).toEqual(['A', 'B'])
    expect(page.querySelector('td strong')?.textContent).toBe('2')
  })

  it('keeps each line its own line, as people write them', () => {
    expect(shown('First line\nSecond line').querySelectorAll('br').length).toBe(1)
  })

  it('links only what’s safe to follow', () => {
    const page = shown('[good](https://example.com) [bad](javascript:alert(1)) https://auto.example.com')
    const links = [...page.querySelectorAll('a')]
    expect(links.map((a) => a.getAttribute('href'))).toEqual(['https://example.com', 'https://auto.example.com'])
    expect(links[0].getAttribute('rel')).toBe('noreferrer')
    expect(page.textContent).toContain('bad')
  })

  it('makes nothing of HTML in the words, and fetches no picture', () => {
    const page = shown('<script>window.hit = 1</script>\n\nWords <b onclick="x()">here</b>\n\n![a picture](https://example.com/p.png)')
    expect(page.querySelector('script')).toBeNull()
    expect(page.querySelector('b')).toBeNull()
    expect(page.querySelector('img')).toBeNull()
    expect(page.textContent).toContain('<script>')
    expect(page.querySelector('a')?.textContent).toBe('a picture')
  })

  it('puts citations where they’re marked, in the middle of a sentence and at the end of a list item', () => {
    render(<Rendered text={`Said here${citeMark(1)} and **there**${citeMark(2)}.\n\n- An item${citeMark(3)}\n`} cite={(n) => <button>{`cite ${n}`}</button>} />)
    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual(['cite 1', 'cite 2', 'cite 3'])
    expect(screen.getByRole('listitem').textContent).toBe('An itemcite 3')
  })

  it('makes a heading no bigger than a bold line in a passage', () => {
    const page = shown('# A heading\n\nIts words.', true)
    expect(page.querySelector('h3')).toBeNull()
    expect(page.querySelector('.md-compact-heading')?.textContent).toBe('A heading')
  })
})
