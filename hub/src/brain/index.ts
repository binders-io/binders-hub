import { createHash } from 'node:crypto'
import type { KV } from '../kv.ts'

// What a binder holds, cut into passages a question can be answered from: its notes and its cards. Each binder keeps
// its own, in its own store, so a search never reaches into another. A passage is found by its words (BM25, always)
// and, when the hub has an embeddings model, by what it means; the two lists are joined by rank. Everything is held in
// memory once read, and kept in the store a source at a time, so a note changing rewrites that note's passages alone.
// The store is a working copy the hub can lose: vectors also go to a VectorStore (files in the binder's repo), which
// gives them back before the model is asked.

export type SourceKind = 'note' | 'card'

/** Something to index: a note or a card, with the words to find it by. */
export interface IndexSource {
  kind: SourceKind
  id: string
  title: string
  text: string
  /** Where it is, for whoever reads a passage of it: "Inbox", "In progress". */
  context?: string
}

export interface Hit {
  kind: SourceKind
  id: string
  title: string
  context?: string
  /** The passage. */
  text: string
  /** Its place among the passages of its source, from 0. */
  part: number
  score: number
}

/** Where vectors are kept for the long term, each by a hash of what it was made from. */
export interface VectorStore {
  has(kind: SourceKind, id: string, embedKey: string): boolean
  read(kind: SourceKind, id: string, embedKey: string): Promise<Map<string, Float32Array>>
  write(kind: SourceKind, id: string, embedKey: string, vectors: { hash: string; vector: Float32Array }[]): Promise<void>
  remove(kind: SourceKind, id: string): Promise<void>
}

interface Chunk {
  text: string
  vector?: Float32Array
  /** Its number in the index's tables: the postings name passages by it. */
  slot: number
}

interface Stored {
  kind: SourceKind
  id: string
  title: string
  context?: string
  hash: string
  /** The embeddings model the vectors came from; none while they're still to be made. */
  embedKey?: string
  chunks: Chunk[]
}

interface Kept {
  kind: SourceKind
  id: string
  title: string
  context?: string
  hash: string
  embedKey?: string
  chunks: { text: string; v?: string }[]
}

const sourceKey = (kind: SourceKind, id: string) => `${kind}:${id}`
const keptKey = (key: string) => `brain:source:${key}`
const manifestKey = 'brain:sources'

const stopWords = new Set('a an and are as at be but by for from has have he her his i in is it its of on or our she so that the their them they this to was we were what when where which who will with you your'.split(' '))

/** A text's words, lower case, as BM25 counts them. */
export function words(text: string): string[] {
  return (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((w) => w.length > 1 && !stopWords.has(w)).map((w) => (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w))
}

/**
 * A text cut into passages of about `size` characters at paragraph ends, each starting with the heading it sits under,
 * so a passage read alone still says what it's about. A paragraph longer than `size` is cut at sentence ends.
 */
export function passages(text: string, size = 1200): string[] {
  const out: string[] = []
  let heading = ''
  let current = ''
  const flush = () => {
    const body = current.trim()
    if (body) out.push(heading && !body.startsWith(heading) ? `${heading}\n${body}` : body)
    current = ''
  }
  const pieces: string[] = []
  for (const paragraph of text.replace(/\r\n/g, '\n').split(/\n{2,}/)) {
    if (paragraph.length <= size) pieces.push(paragraph)
    else {
      let part = ''
      for (const sentence of paragraph.split(/(?<=[.!?])\s+/)) {
        if (part && part.length + sentence.length > size) {
          pieces.push(part)
          part = ''
        }
        // A sentence longer than a passage, cut where it must be.
        for (let i = 0; i < sentence.length; i += size) {
          const slice = sentence.slice(i, i + size)
          if (part.length + slice.length > size && part) {
            pieces.push(part)
            part = ''
          }
          part += (part ? ' ' : '') + slice
        }
      }
      if (part) pieces.push(part)
    }
  }
  for (const piece of pieces) {
    const line = piece.trim()
    if (!line) continue
    const titled = /^#{1,6}\s+(.+)/.exec(line)
    if (titled && !line.includes('\n')) {
      flush()
      heading = line
      continue
    }
    if (current && current.length + line.length > size) flush()
    current += (current ? '\n\n' : '') + line
  }
  flush()
  return out
}

function hashOf(source: IndexSource) {
  return createHash('sha256').update(`${source.title}\u0000${source.context ?? ''}\u0000${source.text}`).digest('base64url').slice(0, 22)
}

/** Each word of a passage once, with how often it's there, and how many words it has. */
function counted(text: string) {
  const terms = new Map<string, number>()
  const list = words(text)
  for (const w of list) terms.set(w, (terms.get(w) ?? 0) + 1)
  return { terms, length: list.length }
}

export function packed(vector: Float32Array) {
  return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength).toString('base64')
}

export function unpacked(text: string) {
  const bytes = Buffer.from(text, 'base64')
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  return new Float32Array(copy.buffer)
}

/** The text an embedding is made of: a passage, with what it's from, which helps it be found. */
export function embeddingText(title: string, passage: string) {
  return `${title}\n\n${passage}`
}

/** What a vector is known by among a source's kept vectors: what it was made from. */
export function vectorHash(title: string, passage: string) {
  return createHash('sha256').update(embeddingText(title, passage)).digest('base64url').slice(0, 22)
}

export class BrainIndex {
  private kv: KV
  private vectors?: VectorStore
  private sources = new Map<string, Stored>()
  /** Each word, and the passages it's in (by slot) with how often. */
  private postings = new Map<string, Map<number, number>>()
  /** By slot: each passage's source key, its place in it, how many words it has, and its words (to take it out again). */
  private slotSource: (string | undefined)[] = []
  private slotPart: number[] = []
  private slotLength: number[] = []
  private slotTerms: (string[] | undefined)[] = []
  private freeSlots: number[] = []
  private passageCount = 0
  private totalLength = 0
  private loading?: Promise<void>
  private writing: Promise<unknown> = Promise.resolve()
  /** Sources added or removed since the list of them was last kept. */
  private manifestChanged = false

  constructor(kv: KV, vectors?: VectorStore) {
    this.kv = kv
    this.vectors = vectors
  }

  /** Reads what's kept, once. */
  load() {
    this.loading ??= (async () => {
      let keys: string[] = []
      try {
        keys = JSON.parse((await this.kv.get(manifestKey)) ?? '[]') as string[]
      } catch {
        keys = []
      }
      for (let start = 0; start < keys.length; start += 100) {
        const batch = await Promise.all(keys.slice(start, start + 100).map((key) => this.kv.get(keptKey(key)).catch(() => undefined)))
        for (const raw of batch) {
          if (!raw) continue
          try {
            const kept = JSON.parse(raw) as Kept
            this.hold({ kind: kept.kind, id: kept.id, title: kept.title, context: kept.context, hash: kept.hash, embedKey: kept.embedKey, chunks: [] },
              kept.chunks.map((c) => ({ text: c.text, vector: c.v ? unpacked(c.v) : undefined })))
          } catch {
            // A source kept in a shape this hub can't read is indexed again when it next changes.
          }
        }
        // Many sources: let the hub answer between batches.
        await new Promise((done) => setImmediate(done))
      }
    })()
    return this.loading
  }

  /** Holds a source and its passages in the tables, in place of what it had. */
  private hold(stored: Omit<Stored, 'chunks'> & { chunks: Chunk[] }, chunks: { text: string; vector?: Float32Array }[]) {
    const key = sourceKey(stored.kind, stored.id)
    this.drop(key)
    stored.chunks = chunks.map((chunk, part) => {
      const slot = this.freeSlots.pop() ?? this.slotSource.length
      const { terms, length } = counted(embeddingText(stored.title, chunk.text))
      this.slotSource[slot] = key
      this.slotPart[slot] = part
      this.slotLength[slot] = length
      this.slotTerms[slot] = [...terms.keys()]
      this.passageCount++
      this.totalLength += length
      for (const [term, count] of terms) {
        let list = this.postings.get(term)
        if (!list) this.postings.set(term, (list = new Map()))
        list.set(slot, count)
      }
      return { text: chunk.text, vector: chunk.vector, slot }
    })
    this.sources.set(key, stored as Stored)
  }

  private drop(key: string) {
    const stored = this.sources.get(key)
    if (!stored) return
    for (const chunk of stored.chunks) {
      const slot = chunk.slot
      for (const term of this.slotTerms[slot] ?? []) {
        const list = this.postings.get(term)
        list?.delete(slot)
        if (list && !list.size) this.postings.delete(term)
      }
      this.totalLength -= this.slotLength[slot] ?? 0
      this.passageCount--
      this.slotSource[slot] = undefined
      this.slotTerms[slot] = undefined
      this.freeSlots.push(slot)
    }
    this.sources.delete(key)
  }

  /** Whether a source is indexed as it is now, vectors and all when an embeddings model is given. */
  async current(source: IndexSource, embedKey?: string) {
    await this.load()
    const stored = this.sources.get(sourceKey(source.kind, source.id))
    return Boolean(stored && stored.hash === hashOf(source) && (!embedKey || stored.embedKey === embedKey))
  }

  /**
   * Indexes a source as it is now. With `embed`, its passages get vectors: ones whose words didn't change keep theirs.
   * When embedding fails the words are indexed anyway, and the error is thrown after, so the caller can try again.
   */
  async put(source: IndexSource, embed?: { key: string; embed: (texts: string[]) => Promise<Float32Array[]> }) {
    await this.load()
    const key = sourceKey(source.kind, source.id)
    const hash = hashOf(source)
    const before = this.sources.get(key)
    if (before && before.hash === hash && (!embed || before.embedKey === embed.key)) {
      // Indexed before its vectors had a long-term home: they get one now.
      if (embed && !this.vectors?.has(source.kind, source.id, embed.key)) await this.keepVectors(source, embed.key, before.chunks.map((c) => ({ text: c.text, vector: c.vector })))
      return false
    }
    const texts = passages(source.text || source.title)
    const reusable = new Map<string, Float32Array>()
    if (before?.embedKey && (!embed || before.embedKey === embed.key)) for (const c of before.chunks) if (c.vector) reusable.set(c.text, c.vector)
    let failure: unknown
    let vectors: (Float32Array | undefined)[] = texts.map((t) => reusable.get(t))
    if (embed) {
      if (this.vectors && vectors.some((v) => !v)) {
        const kept = await this.vectors.read(source.kind, source.id, embed.key).catch(() => undefined)
        if (kept?.size) vectors = vectors.map((v, i) => v ?? kept.get(vectorHash(source.title, texts[i])))
      }
      const missing = texts.map((_, i) => (vectors[i] ? -1 : i)).filter((i) => i >= 0)
      if (missing.length) {
        try {
          const made = await embed.embed(missing.map((i) => embeddingText(source.title, texts[i])))
          missing.forEach((i, n) => { vectors[i] = made[n] })
        } catch (err) {
          failure = err
          vectors = texts.map(() => undefined)
        }
      }
    }
    const complete = vectors.every(Boolean)
    const stored = { kind: source.kind, id: source.id, title: source.title, context: source.context, hash, chunks: [] as Chunk[],
      embedKey: embed && !failure ? embed.key : !embed && complete ? before?.embedKey : undefined }
    this.hold(stored, texts.map((text, i) => ({ text, vector: vectors[i] })))
    if (!before) this.manifestChanged = true
    await this.keep(key, this.sources.get(key)!)
    if (embed && !failure && complete) await this.keepVectors(source, embed.key, texts.map((text, i) => ({ text, vector: vectors[i] })))
    if (failure) throw failure
    return true
  }

  /** A source's vectors in their long-term home. Failing leaves them in the store, and they go again when it next changes. */
  private async keepVectors(source: IndexSource, embedKey: string, chunks: { text: string; vector?: Float32Array }[]) {
    if (!this.vectors || !chunks.length || chunks.some((c) => !c.vector)) return
    await this.vectors.write(source.kind, source.id, embedKey, chunks.map((c) => ({ hash: vectorHash(source.title, c.text), vector: c.vector! }))).catch(() => undefined)
  }

  /** Forgets a source: the note or card is gone. */
  async remove(kind: SourceKind, id: string) {
    await this.load()
    await this.vectors?.remove(kind, id).catch(() => undefined)
    const key = sourceKey(kind, id)
    if (!this.sources.has(key)) return
    this.drop(key)
    this.manifestChanged = true
    this.writing = this.writing.then(() => this.kv.del(keptKey(key)).catch(() => undefined))
    await this.writing
  }

  private async keep(key: string, stored: Stored) {
    const kept: Kept = {
      kind: stored.kind,
      id: stored.id,
      title: stored.title,
      ...(stored.context ? { context: stored.context } : {}),
      hash: stored.hash,
      ...(stored.embedKey ? { embedKey: stored.embedKey } : {}),
      chunks: stored.chunks.map((c) => ({ text: c.text, ...(c.vector ? { v: packed(c.vector) } : {}) })),
    }
    this.writing = this.writing.then(() => this.kv.set(keptKey(key), JSON.stringify(kept)).catch(() => undefined))
    await this.writing
  }

  /**
   * Keeps the list of sources, when it changed: once for a run of changes, not once for each. A source kept but not yet
   * listed when the hub stops is indexed again when it starts, as everything is.
   */
  async flush() {
    if (!this.manifestChanged) return
    this.manifestChanged = false
    const keys = JSON.stringify([...this.sources.keys()])
    this.writing = this.writing.then(() => this.kv.set(manifestKey, keys).catch(() => undefined))
    await this.writing
  }

  /** The sources indexed, as "kind:id". */
  async keys() {
    await this.load()
    return [...this.sources.keys()]
  }

  /** Sources whose passages have no vectors from this embeddings model yet. */
  async withoutVectors(embedKey: string) {
    await this.load()
    return [...this.sources.values()].filter((s) => s.embedKey !== embedKey).map((s) => ({ kind: s.kind, id: s.id }))
  }

  async stats() {
    await this.load()
    let withVectors = 0
    for (const s of this.sources.values()) if (s.embedKey) withVectors += s.chunks.length
    return { sources: this.sources.size, passages: this.passageCount, withVectors }
  }

  /**
   * The passages that best answer `query`, best first: by its words, and by `vector` (the query's embedding from the
   * model `embedKey`) when given. `keep` says which sources may be shown at all.
   */
  async search(query: string, limit: number, options: { vector?: Float32Array; embedKey?: string; keep?: (kind: SourceKind, id: string) => boolean } = {}): Promise<Hit[]> {
    await this.load()
    const allowedSources = new Map<string, boolean>()
    const allowed = (key: string | undefined) => {
      if (!key) return false
      if (!options.keep) return true
      let ok = allowedSources.get(key)
      if (ok === undefined) {
        const stored = this.sources.get(key)
        ok = Boolean(stored && options.keep(stored.kind, stored.id))
        allowedSources.set(key, ok)
      }
      return ok
    }
    const ranked: number[][] = []
    // By words: BM25 over the passages.
    const terms = [...new Set(words(query))]
    if (terms.length && this.passageCount) {
      const average = this.totalLength / this.passageCount || 1
      const scores = new Map<number, number>()
      for (const term of terms) {
        const list = this.postings.get(term)
        if (!list) continue
        const idf = Math.log(1 + (this.passageCount - list.size + 0.5) / (list.size + 0.5))
        for (const [slot, count] of list) {
          if (!allowed(this.slotSource[slot])) continue
          const length = this.slotLength[slot] ?? average
          scores.set(slot, (scores.get(slot) ?? 0) + idf * (count * 2.2) / (count + 1.2 * (0.25 + 0.75 * length / average)))
        }
      }
      ranked.push([...scores.entries()].sort((a, b) => b[1] - a[1]).slice(0, 60).map(([slot]) => slot))
    }
    // By meaning: the passages whose vectors are nearest the query's.
    if (options.vector && options.embedKey) {
      const near: [number, number][] = []
      const query = options.vector
      for (const [key, stored] of this.sources) {
        if (stored.embedKey !== options.embedKey || !allowed(key)) continue
        for (const chunk of stored.chunks) {
          const v = chunk.vector
          if (!v || v.length !== query.length) continue
          let dot = 0
          for (let d = 0; d < v.length; d++) dot += v[d] * query[d]
          near.push([chunk.slot, dot])
        }
      }
      ranked.push(near.sort((a, b) => b[1] - a[1]).slice(0, 60).map(([slot]) => slot))
    }
    // Joined by rank (reciprocal rank fusion): a passage near the top of both lists beats one at the top of one.
    const fused = new Map<number, number>()
    for (const list of ranked) list.forEach((slot, rank) => fused.set(slot, (fused.get(slot) ?? 0) + 1 / (60 + rank)))
    const hits: Hit[] = []
    for (const [slot, score] of [...fused.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit)) {
      const stored = this.sources.get(this.slotSource[slot] ?? '')
      const part = this.slotPart[slot]
      const chunk = stored?.chunks[part]
      if (!stored || !chunk) continue
      hits.push({ kind: stored.kind, id: stored.id, title: stored.title, ...(stored.context ? { context: stored.context } : {}), text: chunk.text, part, score })
    }
    return hits
  }
}
