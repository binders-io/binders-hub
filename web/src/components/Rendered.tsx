import type { ReactNode } from 'react'
import { GFM, parser } from '@lezer/markdown'
import type { SyntaxNode } from '@lezer/common'

// Markdown to read, not to edit: an answer from the brain, a passage of a note. It's parsed by the parser the editor uses
// and built as React elements, so nothing in the words can become HTML or run. Lines stay lines, as people write them in
// notes and as models write them in answers.

const markdown = parser.configure(GFM)

const open = ''
const close = ''

/** A citation, in Markdown given to Rendered: it comes out as what `cite` makes of its number. */
export const citeMark = (n: number) => `${open}${n}${close}`
const citeMarks = new RegExp(`${open}(\\d+)${close}`, 'g')

const safeLink = (url: string) => /^(https?:|mailto:|#|\/)/i.test(url.trim())

const entities: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: '\'', nbsp: ' ', hellip: '…', mdash: '—', ndash: '–' }
function entity(text: string) {
  const name = text.slice(1, -1)
  if (name in entities) return entities[name]
  const code = name.startsWith('#x') || name.startsWith('#X') ? Number.parseInt(name.slice(2), 16) : name.startsWith('#') ? Number.parseInt(name.slice(1), 10) : Number.NaN
  return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : text
}

const marks = new Set(['EmphasisMark', 'HeaderMark', 'LinkMark', 'CodeMark', 'StrikethroughMark', 'QuoteMark', 'ListMark', 'TaskMarker', 'TableDelimiter', 'CodeInfo', 'LinkTitle', 'LinkLabel'])

interface Context {
  text: string
  cite?: (n: number) => ReactNode
  compact: boolean
}

function children(node: SyntaxNode) {
  const out: SyntaxNode[] = []
  for (let child = node.firstChild; child; child = child.nextSibling) out.push(child)
  return out
}

/** Words, with each line its own line and each citation in its place. */
function words(text: string, context: Context, key: string): ReactNode[] {
  const out: ReactNode[] = []
  text.split('\n').forEach((line, i) => {
    if (i) out.push(<br key={`${key}-br${i}`} />)
    const shown = i ? line.replace(/^[ \t]+/, '') : line
    let at = 0
    for (const found of shown.matchAll(citeMarks)) {
      if (found.index > at) out.push(shown.slice(at, found.index))
      out.push(<span key={`${key}-c${i}-${found.index}`}>{context.cite?.(Number(found[1]))}</span>)
      at = found.index + found[0].length
    }
    if (at < shown.length) out.push(shown.slice(at))
  })
  return out
}

function inline(node: SyntaxNode, context: Context, from = node.from, to = node.to): ReactNode[] {
  const out: ReactNode[] = []
  let at = from
  const gap = (end: number) => {
    if (end > at) out.push(...words(context.text.slice(at, end), context, `${at}`))
  }
  for (const child of children(node)) {
    if (child.to <= from || child.from >= to) continue
    gap(child.from)
    at = child.to
    if (marks.has(child.name)) continue
    const key = child.from
    const slice = context.text.slice(child.from, child.to)
    switch (child.name) {
      case 'Emphasis':
        out.push(<em key={key}>{inline(child, context)}</em>)
        break
      case 'StrongEmphasis':
        out.push(<strong key={key}>{inline(child, context)}</strong>)
        break
      case 'Strikethrough':
        out.push(<s key={key}>{inline(child, context)}</s>)
        break
      case 'InlineCode': {
        const parts = children(child).filter((c) => c.name === 'CodeMark')
        const code = parts.length >= 2 ? context.text.slice(parts[0].to, parts[parts.length - 1].from) : slice
        out.push(<code key={key}>{code.length > 2 && code.startsWith(' ') && code.endsWith(' ') ? code.slice(1, -1) : code}</code>)
        break
      }
      case 'Link':
      case 'Image': {
        const url = child.getChild('URL')
        const address = url ? context.text.slice(url.from, url.to) : ''
        const marksIn = children(child).filter((c) => c.name === 'LinkMark')
        const inner = marksIn.length >= 2 ? inline(child, context, marksIn[0].to, marksIn[1].from) : []
        // A picture isn't fetched: a note's words don't get to call out from someone's browser.
        if (!address || !safeLink(address)) out.push(<span key={key}>{inner.length ? inner : words(slice, context, `${key}`)}</span>)
        else out.push(<a key={key} href={address} target={address.startsWith('#') ? undefined : '_blank'} rel="noreferrer">{inner.length ? inner : address}</a>)
        break
      }
      case 'Autolink':
      case 'URL': {
        const address = child.name === 'URL' ? slice : slice.replace(/^<|>$/g, '')
        out.push(safeLink(address) ? <a key={key} href={address} target="_blank" rel="noreferrer">{address}</a> : address)
        break
      }
      case 'Escape':
        out.push(slice.slice(1))
        break
      case 'Entity':
        out.push(entity(slice))
        break
      case 'HardBreak':
        out.push(<br key={key} />)
        break
      default:
        // What has words in it goes on; raw HTML and the like has no parts, and is shown as it's written.
        if (child.firstChild) out.push(<span key={key}>{inline(child, context)}</span>)
        else out.push(...words(slice, context, `${key}`))
    }
  }
  gap(to)
  return out
}

function codeOf(node: SyntaxNode, context: Context) {
  const parts = node.getChildren('CodeText')
  const code = parts.map((p) => context.text.slice(p.from, p.to)).join('\n')
  return node.name === 'CodeBlock' ? code.replace(/^ {1,4}/gm, '') : code
}

function heading(level: number, node: SyntaxNode, context: Context): ReactNode {
  // Without its # and the space after it, or the === under it.
  let from = node.from
  let to = node.to
  for (const mark of node.getChildren('HeaderMark')) {
    if (mark.from === node.from) from = mark.to
    else to = mark.from
  }
  while (from < to && /\s/.test(context.text[from])) from++
  while (to > from && /\s/.test(context.text[to - 1])) to--
  const content = inline(node, context, from, to)
  if (context.compact) return <p key={node.from} className="md-compact-heading">{content}</p>
  const Tag = `h${Math.min(level + 2, 6)}` as 'h3'
  return <Tag key={node.from}>{content}</Tag>
}

function blocks(node: SyntaxNode, context: Context): ReactNode[] {
  return children(node).flatMap((child): ReactNode[] => {
    if (marks.has(child.name)) return []
    const key = child.from
    const atx = /^ATXHeading(\d)$/.exec(child.name)
    if (atx) return [heading(Number(atx[1]), child, context)]
    const setext = /^SetextHeading(\d)$/.exec(child.name)
    if (setext) return [heading(Number(setext[1]), child, context)]
    switch (child.name) {
      case 'Paragraph':
        return [<p key={key}>{inline(child, context)}</p>]
      case 'BulletList':
        return [<ul key={key}>{blocks(child, context)}</ul>]
      case 'OrderedList': {
        const first = child.getChild('ListItem')?.getChild('ListMark')
        const start = first ? Number.parseInt(context.text.slice(first.from, first.to), 10) : 1
        return [<ol key={key} start={Number.isFinite(start) && start !== 1 ? start : undefined}>{blocks(child, context)}</ol>]
      }
      case 'ListItem':
        return [<li key={key} className={child.getChild('Task') ? 'md-task' : undefined}>{blocks(child, context)}</li>]
      case 'Task': {
        const marker = child.getChild('TaskMarker')
        const done = marker ? /x/i.test(context.text.slice(marker.from, marker.to)) : false
        return [<p key={key}><input type="checkbox" checked={done} disabled aria-label={done ? 'Done' : 'To do'} /> {inline(child, context)}</p>]
      }
      case 'Blockquote':
        return [<blockquote key={key}>{blocks(child, context)}</blockquote>]
      case 'FencedCode':
      case 'CodeBlock':
        return [<pre key={key}><code>{codeOf(child, context)}</code></pre>]
      case 'HorizontalRule':
        return [<hr key={key} />]
      case 'Table':
        return [(
          <div key={key} className="md-table" tabIndex={0} role="group" aria-label="Table">
            <table>
              <tbody>
                {children(child).filter((c) => c.name === 'TableHeader' || c.name === 'TableRow').map((row) => (
                  <tr key={row.from}>
                    {row.getChildren('TableCell').map((cell) => (row.name === 'TableHeader' ? <th key={cell.from}>{inline(cell, context)}</th> : <td key={cell.from}>{inline(cell, context)}</td>))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )]
      case 'LinkReference':
      case 'CommentBlock':
      case 'ProcessingInstructionBlock':
        return []
      default:
        return [<p key={key}>{words(context.text.slice(child.from, child.to), context, `${key}`)}</p>]
    }
  })
}

/** Markdown as it reads. `compact` is for a passage among others: smaller, with headings no bigger than a bold line. */
export function Rendered({ text, cite, compact = false, className }: { text: string; cite?: (n: number) => ReactNode; compact?: boolean; className?: string }) {
  const context: Context = { text, cite, compact }
  return <div className={`md${compact ? ' md-compact' : ''}${className ? ` ${className}` : ''}`}>{blocks(markdown.parse(text).topNode, context)}</div>
}
