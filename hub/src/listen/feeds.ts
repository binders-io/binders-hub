import type { Heard } from '../../../shared/listen.ts'
import { heardMost } from '../../../shared/listen.ts'

// A feed the hub reads: RSS, Atom or JSON Feed, each item as something heard. Read by hand, as the three are small and
// a feed is words from outside: nothing in one is run, and its markup is taken out, leaving the words.

const entities: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: '\'', nbsp: ' ', '#39': '\'' }

/** Words as they read: character entities turned back, numeric ones too. */
export function unescape(text: string) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all: string, name: string) => {
    if (name[0] === '#') {
      const code = name[1].toLowerCase() === 'x' ? parseInt(name.slice(2), 16) : Number(name.slice(1))
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : ''
    }
    return entities[name.toLowerCase()] ?? all
  })
}

/** What an element holds, whether it's wrapped as CDATA or escaped: markup taken out, the words left. */
export function wordsOf(raw: string | undefined) {
  if (!raw) return ''
  const inner = raw.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_all, held: string) => held)
  // Escaped markup (the usual way a description carries HTML) is markup once unescaped: taken out the same way.
  const once = /<[a-z!/]/i.test(inner) ? inner : unescape(inner)
  return unescape(once
    .replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr)\b[^>]*>/gi, '\n')
    .replace(/<[^>]*>/g, ' '))
    .replace(/[ \t\r\f\v]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

const first = (xml: string, name: string) => new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}\\s*>`, 'i').exec(xml)?.[1]
const all = (xml: string, name: string) => [...xml.matchAll(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}\\s*>`, 'gi'))].map((found) => found[1])

/** A date as the hub keeps it, when what a feed gave reads as one. */
function dateOf(text: string | undefined) {
  const at = text ? Date.parse(wordsOf(text)) : Number.NaN
  return Number.isNaN(at) ? undefined : new Date(at).toISOString()
}

/** Only an address on the web: a feed's links go in notes, so nothing else is taken for one. */
function linkOf(text: string | undefined) {
  const link = text ? unescape(text.trim()) : ''
  return /^https?:\/\/[^\s<>"']+$/i.test(link) ? link.slice(0, 2000) : undefined
}

export interface Feed {
  title?: string
  items: Heard[]
}

const clip = (text: string, most: number) => (text.length > most ? `${text.slice(0, most - 1)}…` : text)

function item(fields: { id?: string; link?: string; title?: string; text?: string; at?: string; author?: string }): Heard | undefined {
  const title = fields.title ? clip(fields.title.replace(/\s+/g, ' ').trim(), 200) : undefined
  const text = clip(fields.text ?? '', heardMost)
  const sourceId = (fields.id || fields.link || (title && fields.at ? `${title}\u0000${fields.at}` : '')).slice(0, 1000)
  if (!sourceId || (!title && !text)) return undefined
  return { sourceId, ...(fields.at ? { at: fields.at } : {}), ...(fields.author ? { sender: { name: clip(fields.author, 120) } } : {}), ...(title ? { title } : {}), text, ...(fields.link ? { url: fields.link } : {}) }
}

function fromJson(body: string): Feed | undefined {
  let feed: { title?: unknown; items?: unknown }
  try {
    feed = JSON.parse(body) as { title?: unknown; items?: unknown }
  } catch {
    return undefined
  }
  if (!feed || !Array.isArray(feed.items)) return undefined
  const words = (value: unknown) => (typeof value === 'string' ? value : undefined)
  const items = (feed.items as Record<string, unknown>[]).flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return []
    const authors = Array.isArray(entry.authors) ? entry.authors : entry.author ? [entry.author] : []
    const author = words((authors[0] as { name?: unknown } | undefined)?.name)
    const made = item({
      id: words(entry.id) ?? (typeof entry.id === 'number' ? String(entry.id) : undefined),
      link: linkOf(words(entry.url) ?? words(entry.external_url)),
      title: words(entry.title),
      text: words(entry.content_text) ?? wordsOf(words(entry.content_html) ?? words(entry.summary)),
      at: dateOf(words(entry.date_published) ?? words(entry.date_modified)),
      author,
    })
    return made ? [made] : []
  })
  return { ...(typeof feed.title === 'string' ? { title: clip(feed.title, 120) } : {}), items }
}

function fromXml(body: string): Feed | undefined {
  const atom = /<feed\b/i.test(body) && /<entry\b/i.test(body)
  const rss = /<(rss|rdf:RDF)\b/i.test(body) || /<channel\b/i.test(body)
  if (!atom && !rss && !/<feed\b/i.test(body)) return undefined
  const entries = all(body, atom ? 'entry' : 'item')
  // The feed's own title is the one before its first item.
  const head = body.slice(0, body.search(atom ? /<entry\b/i : /<item\b/i) >>> 0)
  const title = wordsOf(first(head, 'title'))
  const items = entries.flatMap((xml) => {
    const href = /<link\b[^>]*\brel=["']alternate["'][^>]*\bhref=["']([^"']+)["']/i.exec(xml)?.[1] ?? /<link\b[^>]*\bhref=["']([^"']+)["'][^>]*\brel=["']alternate["']/i.exec(xml)?.[1] ?? /<link\b(?![^>]*\brel=)[^>]*\bhref=["']([^"']+)["']/i.exec(xml)?.[1] ?? /<link\b[^>]*\bhref=["']([^"']+)["']/i.exec(xml)?.[1]
    const author = wordsOf(first(first(xml, 'author') ?? '', 'name') ?? first(xml, 'dc:creator') ?? first(xml, 'author'))
    const made = item({
      id: wordsOf(first(xml, atom ? 'id' : 'guid')),
      link: linkOf(atom ? href : wordsOf(first(xml, 'link')) || href),
      title: wordsOf(first(xml, 'title')),
      text: wordsOf(first(xml, 'content:encoded') ?? first(xml, 'content') ?? first(xml, 'description') ?? first(xml, 'summary')),
      at: dateOf(first(xml, atom ? 'updated' : 'pubDate') ?? first(xml, 'published') ?? first(xml, 'dc:date')),
      author: author || undefined,
    })
    return made ? [made] : []
  })
  return { ...(title ? { title: clip(title, 120) } : {}), items }
}

/** A feed's items, newest as the feed gives them. Undefined when what was read isn't a feed the hub knows. */
export function readFeed(body: string): Feed | undefined {
  const text = body.replace(/^﻿/, '').trimStart()
  return text.startsWith('{') ? fromJson(text) : fromXml(text)
}
