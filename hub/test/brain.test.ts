import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import Anthropic from '@anthropic-ai/sdk'
import { MemoryKV } from '../src/kv.ts'
import { BrainIndex, passages, words } from '../src/brain/index.ts'
import { firstWords } from '../src/brain/captures.ts'
import { ClaudeModel, OpenAICompatibleEmbedder, OpenAICompatibleModel, OpenAICompatibleSpeaker, OpenAICompatibleTranscriber, BrainUnavailable } from '../src/brain/models.ts'
import { speakersByOverlap, withTranscript } from '../src/brain/captures.ts'

/** A stand-in embeddings model: a vector per word it knows, so texts sharing a meaning-word come out near. */
function standInEmbedder(key = 'stand-in|v1') {
  const meanings: Record<string, number> = { car: 0, automobile: 0, vehicle: 0, invoice: 1, bill: 1, payment: 1, garden: 2, tomato: 2 }
  const calls: string[][] = []
  return {
    key,
    calls,
    embed: async (texts: string[]) => {
      calls.push(texts)
      return texts.map((t) => {
        const v = new Float32Array(4)
        for (const w of t.toLowerCase().match(/\p{L}+/gu) ?? []) if (w in meanings) v[meanings[w]] += 1
        v[3] = 0.01
        const length = Math.hypot(...v)
        return v.map((x) => x / length)
      })
    },
  }
}

describe('the brain’s index of a binder', () => {
  it('cuts a note into passages at paragraph ends, each under the heading it sits in', () => {
    const text = `# Plan\n\nIntro line.\n\n## Costs\n\n${'Money talk. '.repeat(120)}\n\nLast words.`
    const cut = passages(text, 400)
    assert.ok(cut.length >= 3)
    assert.ok(cut.every((p) => p.length <= 400 + 20), 'no passage runs much over the size')
    assert.ok(cut.slice(1).some((p) => p.startsWith('## Costs')), 'a passage under a heading starts with it')
    assert.deepEqual(words('The Invoices are PAID, twice!'), ['invoice', 'paid', 'twice'])
    assert.equal(firstWords('**[00:00] You:** we need new tyres\n\n**[00:12] Speaker 2:** sam will book'), 'we need new tyres sam will book', 'a transcript’s marks aren’t a title')
  })

  it('finds passages by their words, best first, and forgets a removed note', async () => {
    const index = new BrainIndex(new MemoryKV())
    await index.put({ kind: 'note', id: 'n1', title: 'Garden', text: 'Tomatoes need water every morning in July.' })
    await index.put({ kind: 'note', id: 'n2', title: 'Billing', text: 'The invoice for October is late. Payment terms are thirty days.' })
    await index.put({ kind: 'card', id: 'c1', title: 'Send the October invoice', text: 'Ask finance for the October invoice and send it.', context: 'To do' })
    const found = await index.search('october invoice', 5)
    assert.deepEqual(found.map((h) => h.id).sort(), ['c1', 'n2'])
    assert.equal(found[0].kind === 'card' ? found[0].context : 'To do', 'To do')
    assert.deepEqual(await index.search('october invoice', 5, { keep: (kind) => kind === 'note' }).then((h) => h.map((x) => x.id)), ['n2'])
    await index.remove('note', 'n2')
    assert.deepEqual((await index.search('invoice', 5)).map((h) => h.id), ['c1'])
  })

  it('finds by meaning with an embeddings model, keeps vectors whose words didn’t change, and reads back after a restart', async () => {
    const kv = new MemoryKV()
    const embedder = standInEmbedder()
    const index = new BrainIndex(kv)
    await index.put({ kind: 'note', id: 'cars', title: 'Fleet', text: 'Our automobile needs new tyres.\n\nThe vehicle is booked for Tuesday.' }, embedder)
    await index.put({ kind: 'note', id: 'money', title: 'Accounts', text: 'The bill is paid.' }, embedder)
    const [query] = await embedder.embed(['car'])
    const near = await index.search('car', 3, { vector: query, embedKey: embedder.key })
    assert.equal(near[0].id, 'cars', 'no word in common, found by meaning')
    // A changed paragraph alone is embedded again.
    embedder.calls.length = 0
    await index.put({ kind: 'note', id: 'cars', title: 'Fleet', text: 'Our automobile needs new tyres.\n\nThe vehicle is booked for Friday.' }, embedder)
    assert.ok(embedder.calls.flat().length <= 1)
    assert.equal(await index.put({ kind: 'note', id: 'cars', title: 'Fleet', text: 'Our automobile needs new tyres.\n\nThe vehicle is booked for Friday.' }, embedder), false, 'unchanged: nothing done')
    await index.flush()
    const again = new BrainIndex(kv)
    assert.deepEqual(await again.stats(), { sources: 2, passages: (await index.stats()).passages, withVectors: (await index.stats()).withVectors })
    assert.equal((await again.search('car', 1, { vector: query, embedKey: embedder.key }))[0].id, 'cars')
    // Another embeddings model: its vectors aren't comparable, so those sources need new ones.
    assert.deepEqual((await again.withoutVectors('other|v2')).map((s) => s.id).sort(), ['cars', 'money'])
  })

  it('indexes the words when embedding fails, and says so', async () => {
    const index = new BrainIndex(new MemoryKV())
    const failing = { key: 'down|v1', embed: async () => { throw new Error('embeddings down') } }
    await assert.rejects(index.put({ kind: 'note', id: 'n', title: 'Notes', text: 'Quarterly numbers look good.' }, failing), /embeddings down/)
    assert.equal((await index.search('quarterly', 1))[0].id, 'n')
    assert.deepEqual((await index.withoutVectors('down|v1')).map((s) => s.id), ['n'])
  })
})

/** A message as Anthropic streams it: the events the SDK reads back into the message. */
function streamed(message: Record<string, unknown>) {
  const content = (message.content as Record<string, unknown>[]) ?? []
  const events: [string, unknown][] = [['message_start', { type: 'message_start', message: { ...message, content: [], stop_reason: null } }]]
  content.forEach((block, index) => {
    const text = String(block.text ?? '')
    events.push(['content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } }])
    events.push(['content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text } }])
    events.push(['content_block_stop', { type: 'content_block_stop', index }])
  })
  events.push(['message_delta', { type: 'message_delta', delta: { stop_reason: message.stop_reason, stop_sequence: null }, usage: { output_tokens: 10 } }])
  events.push(['message_stop', { type: 'message_stop' }])
  return events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('')
}

/** A stand-in HTTP server: answers each request with what `reply` returns, and keeps what it was sent. */
async function standIn(reply: (path: string, body: Record<string, unknown>, request: IncomingMessage) => { status?: number; body: unknown }) {
  const seen: { path: string; body: Record<string, unknown>; headers: IncomingMessage['headers'] }[] = []
  const server: Server = createServer((request, response) => {
    let raw = ''
    request.on('data', (chunk) => { raw += chunk })
    request.on('end', () => {
      const body = raw ? JSON.parse(raw) as Record<string, unknown> : {}
      seen.push({ path: request.url ?? '', body, headers: request.headers })
      const answer = reply(request.url ?? '', body, request)
      // A streamed request gets its message as events, as Anthropic sends it.
      if (body.stream === true && (answer.status ?? 200) === 200) {
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        response.end(streamed(answer.body as Record<string, unknown>))
        return
      }
      response.writeHead(answer.status ?? 200, { 'content-type': 'application/json' })
      response.end(JSON.stringify(answer.body))
    })
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return { url, seen, close: () => new Promise<void>((done) => server.close(() => done())) }
}

const message = (content: unknown[], extra: Record<string, unknown> = {}) => ({
  id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5-5', stop_reason: 'end_turn', stop_sequence: null,
  usage: { input_tokens: 10, output_tokens: 10 }, content, ...extra,
})

describe('the brain’s settings', () => {
  it('sends a key only where it was meant to go', async () => {
    const { BrainSettingsStore } = await import('../src/brain/settings.ts')
    const { Sealer } = await import('../src/secrets.ts')
    const kv = new MemoryKV()
    // A key the environment sets goes only to the address it sets too.
    const fixedKey = await new BrainSettingsStore(kv, new Sealer('s'), { BRAIN_API_KEY: 'env-key' }).load()
    const local = await fixedKey.set({ provider: 'openai', baseUrl: 'http://elsewhere.test/v1', model: 'm' })
    assert.equal(local.inUse, undefined)
    assert.match(local.needs ?? '', /BRAIN_BASE_URL/)
    // Under Claude, an address saved in Settings is never used; without any key, no client is made.
    const anthropic = await new BrainSettingsStore(new MemoryKV(), new Sealer('s'), { ANTHROPIC_API_KEY: 'env-anthropic' }).load()
    await anthropic.set({ provider: 'openai', baseUrl: 'http://elsewhere.test/v1', model: 'qwen3', apiKey: 'saved-key' })
    const switched = await anthropic.set({ provider: 'anthropic' })
    assert.equal(switched.baseUrl, '', 'another provider: the old address goes')
    assert.equal(switched.model, '')
    assert.equal(switched.usesAnthropicKey, true, 'and the key saved for the old one with it')
    assert.equal(switched.inUse, 'claude-opus-5-5 (Anthropic)')
    const none = await new BrainSettingsStore(new MemoryKV(), new Sealer('s'), {}).load()
    assert.equal((await none.set({ provider: 'anthropic' })).needs, 'Its Anthropic key.')
    assert.equal(none.model(), undefined)
    // A server of your own can be chosen before its address is given.
    assert.equal((await none.set({ provider: 'openai' })).needs, 'The address of the server.')
  })

  it('keeps every model on the hub’s own network with local AI only, and sets up transcription and speech', async () => {
    const { BrainSettingsStore, onOwnNetwork } = await import('../src/brain/settings.ts')
    const { Sealer } = await import('../src/secrets.ts')
    for (const near of ['http://localhost:8080', 'http://127.0.0.1:1', 'http://192.168.1.20/v1', 'http://10.2.3.4', 'http://172.20.0.5', 'http://100.64.0.2:8000', 'http://gpu-box:9000', 'http://mac.local', 'http://[::1]:8000', 'http://[fd00::1]/v1']) {
      assert.ok(onOwnNetwork(near), near)
    }
    for (const far of ['https://api.openai.com/v1', 'http://8.8.8.8', 'http://172.32.0.1', 'https://models.example.com']) assert.ok(!onOwnNetwork(far), far)
    const store = await new BrainSettingsStore(new MemoryKV(), new Sealer('s'), { ANTHROPIC_API_KEY: 'env-anthropic' }).load()
    await store.set({ provider: 'anthropic' })
    assert.ok(store.model(), 'Claude, with local AI only off')
    const local = await store.set({ localOnly: true })
    assert.equal(store.model(), undefined)
    assert.match(local.needs ?? '', /Local AI only is on, and Claude runs at Anthropic/)
    assert.match((await store.set({ provider: 'openai', baseUrl: 'https://models.example.com/v1', model: 'm' })).needs ?? '', /isn’t on the hub’s own network/)
    assert.equal((await store.set({ baseUrl: 'http://10.0.0.5:8000/v1' })).inUse, 'm (10.0.0.5:8000)')
    // Transcription and speech: each its own server, its key sealed, refused outside the network while local only.
    const voice = await store.set({ transcriptionBaseUrl: 'http://gpu-box:8080/v1', transcriptionModel: 'whisper-large-v3', transcriptionKey: 'tk', speechBaseUrl: 'https://voices.example.com/v1', speechModel: 'kokoro' })
    assert.equal(voice.transcriptionInUse, 'whisper-large-v3 (gpu-box:8080)')
    assert.equal(voice.transcriptionKeySet, true)
    assert.ok(store.transcriber())
    assert.match(voice.speechNeeds ?? '', /isn’t on the hub’s own network/)
    assert.equal(store.speaker(), undefined)
    const off = await store.set({ localOnly: false, speechVoice: 'af_heart' })
    assert.equal(off.speechInUse, 'kokoro, af_heart (voices.example.com)')
    assert.equal(JSON.stringify(off).includes('tk'), false, 'a key is never shown')
    // A key the environment sets for transcription goes only to the address it sets too.
    const fixed = await new BrainSettingsStore(new MemoryKV(), new Sealer('s'), { TRANSCRIPTION_API_KEY: 'env-tk' }).load()
    assert.match((await fixed.set({ transcriptionBaseUrl: 'http://elsewhere.test/v1', transcriptionModel: 'w' })).transcriptionNeeds ?? '', /TRANSCRIPTION_BASE_URL/)
    await assert.rejects(fixed.set({ transcriptionKey: 'other' }), /TRANSCRIPTION_API_KEY/)
  })
})

describe('transcripts written down again', () => {
  it('names each stretch for the voice whose turns overlap it most, and puts a better transcript in place of the old', () => {
    const named = speakersByOverlap([{ start: 0, end: 3, text: 'a' }, { start: 3.5, end: 6, text: 'b' }, { start: 20, end: 21, text: 'c' }], [{ start: 0, end: 3.2, speaker: 'S1' }, { start: 3.2, end: 7, speaker: 'S2' }])
    assert.deepEqual(named.map((s) => s.speaker), ['S1', 'S2', 'S2'])
    const note = '# Van\n\n_Conversation_\n\n## Summary\n\nThey talked.\n\n## Transcript\n\n**[00:00] You:** new tires\n'
    const again = withTranscript(note, '**[00:00] You:** new tyres')
    assert.equal(again, '# Van\n\n_Conversation_\n\n## Summary\n\nThey talked.\n\n## Transcript\n\n**[00:00] You:** new tyres\n')
    assert.match(withTranscript('# Van\n\n## Transcript\n\nold\n\n## Notes\n\nmine\n', 'new'), /## Transcript\n\nnew\n\n## Notes\n\nmine/)
  })
})

describe('the models the hub calls', () => {
  const closers: (() => Promise<void>)[] = []
  after(async () => { for (const close of closers) await close() })

  it('asks Claude with the passages as documents to cite, and reads which ones each stretch of the answer rests on', async () => {
    const server = await standIn(() => ({ body: message([
      { type: 'text', text: 'The invoice is late', citations: [{ type: 'char_location', cited_text: 'late', document_index: 1, document_title: 'Billing', start_char_index: 0, end_char_index: 4, file_id: null }] },
      { type: 'text', text: ', and ', citations: null },
      { type: 'text', text: 'it goes out on Friday.', citations: [{ type: 'char_location', cited_text: 'Friday', document_index: 0, document_title: 'Card', start_char_index: 0, end_char_index: 6, file_id: null }] },
    ]) }))
    closers.push(server.close)
    const model = new ClaudeModel({ model: 'claude-opus-5-5', client: new Anthropic({ apiKey: 'test-key', baseURL: server.url, maxRetries: 0 }) })
    const answer = await model.answer('When does the invoice go out?', [{ title: 'Card', text: 'Send it Friday.' }, { title: 'Billing', text: 'The invoice is late.', context: 'A note in Web' }])
    assert.equal(answer.text, 'The invoice is late, and it goes out on Friday.')
    assert.deepEqual(answer.parts.map((p) => p.sources), [[1], [], [0]])
    const sent = server.seen[0]
    assert.equal(sent.body.model, 'claude-opus-5-5')
    assert.equal(sent.body.fallbacks, 'default', 'a declined request is answered by the recommended fallback')
    assert.match(String(sent.headers['anthropic-beta']), /server-side-fallback-2026-07-01/)
    const content = (sent.body.messages as { content: { type: string; citations?: { enabled: boolean }; context?: string }[] }[])[0].content
    assert.deepEqual(content.map((b) => b.type), ['document', 'document', 'text'])
    assert.ok(content.slice(0, 2).every((b) => b.citations?.enabled))
    assert.equal(content[1].context, 'A note in Web')
  })

  it('sums up a capture into a title, a summary and lists, and says plainly when Claude declines or the key is refused', async () => {
    let next: { status?: number; body: unknown } = { body: message([{ type: 'text', text: JSON.stringify({ title: '“Tyres and the van”', summary: 'They talked about the van.', points: ['Tyres are worn', ''], decisions: [], followUps: ['Sam books the garage'] }) }]) }
    const server = await standIn(() => next)
    closers.push(server.close)
    const model = new ClaudeModel({ model: 'claude-opus-5-5', client: new Anthropic({ apiKey: 'test-key', baseURL: server.url, maxRetries: 0 }) })
    const summary = await model.summarize({ kind: 'conversation', text: 'we need tyres sam will book the garage' })
    assert.deepEqual(summary, { title: 'Tyres and the van', summary: 'They talked about the van.', points: ['Tyres are worn'], decisions: [], followUps: ['Sam books the garage'] })
    assert.match(String((server.seen[0].body.messages as { content: string }[])[0].content), /<transcript>/)
    assert.equal((server.seen[0].body.output_config as { format?: { type: string } }).format?.type, 'json_schema')
    assert.equal(server.seen[0].body.stream, true, 'a summary streams: a long meeting outlasts a request')
    next = { body: message([], { stop_reason: 'refusal', stop_details: { type: 'refusal', category: null, explanation: null } }) }
    await assert.rejects(model.summarize({ kind: 'meeting', text: 'x' }), BrainUnavailable)
    next = { body: message([{ type: 'text', text: '{"title": "Cut' }], { stop_reason: 'max_tokens' }) }
    await assert.rejects(model.summarize({ kind: 'meeting', text: 'x' }), /ran past the length/)
    next = { status: 401, body: { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } } }
    await assert.rejects(model.answer('q', [{ title: 't', text: 'x' }]), /refused the hub’s key/)
  })

  it('leaves the fallback out for a model that doesn’t take it', async () => {
    const server = await standIn(() => ({ body: message([{ type: 'text', text: 'Fine.', citations: null }], { model: 'claude-haiku-5-5' }) }))
    closers.push(server.close)
    const model = new ClaudeModel({ model: 'claude-haiku-5-5', client: new Anthropic({ apiKey: 'test-key', baseURL: server.url, maxRetries: 0 }) })
    await model.answer('q', [{ title: 't', text: 'x' }])
    assert.equal(server.seen[0].body.fallbacks, undefined)
  })

  it('talks out loud with a model of your own: the conversation as turns, what it found with the last, no thinking first', async () => {
    // A server that won't take being told not to think (OpenAI's own refuses fields it doesn't know): asked again plainly.
    const server = await standIn((_path, body) => (body.chat_template_kwargs ? { status: 400, body: { error: 'unknown field' } } : { body: { choices: [{ message: { content: '<think>let me see</think>On Thursdays, says your note on plumbing.' } }] } }))
    closers.push(server.close)
    const model = new OpenAICompatibleModel({ baseURL: `${server.url}/v1`, model: 'local-model' })
    const reply = await model.talk([{ role: 'assistant', text: 'Hi.' }, { role: 'user', text: 'Hello' }, { role: 'assistant', text: 'Hi, what’s up?' }, { role: 'user', text: 'When does the plumber come?' }], [{ title: 'Plumbing', text: 'Thursdays', context: 'A note in Personal' }])
    assert.equal(reply, 'On Thursdays, says your note on plumbing.')
    assert.deepEqual(server.seen.map((s) => Boolean(s.body.chat_template_kwargs)), [true, false])
    const messages = server.seen[1].body.messages as { role: string; content: string }[]
    assert.deepEqual(messages.map((m) => m.role), ['system', 'user', 'assistant', 'user'], 'starting with what the person said')
    assert.match(messages[0].content, /out loud/)
    assert.equal(messages.at(-1)!.content, '<documents>\nPlumbing (A note in Personal)\nThursdays\n</documents>\n\nWhen does the plumber come?')
  })

  it('talks to a model on a server of your own, reading [n] citations and JSON summaries, and embeds with it', async () => {
    const server = await standIn((path, body) => {
      if (path.endsWith('/embeddings')) return { body: { data: (body.input as string[]).map((_, index) => ({ index, embedding: [3, 4] })).reverse() } }
      const system = String((body.messages as { content: string }[])[0].content)
      if (system.includes('JSON')) return { body: { choices: [{ message: { content: '<think>hmm</think>Here: {"title":"Standup","summary":"Short.","points":[],"decisions":["Ship Friday"],"followUps":[]}' } }] } }
      return { body: { choices: [{ message: { content: 'It ships Friday [2].\n\nAsk Sam [1, 9].' } }] } }
    })
    closers.push(server.close)
    const model = new OpenAICompatibleModel({ baseURL: `${server.url}/v1/`, model: 'local-model' })
    assert.equal((await model.summarize({ kind: 'meeting', text: 'standup' })).decisions[0], 'Ship Friday')
    const answer = await model.answer('when?', [{ title: 'Sam', text: 'Sam knows' }, { title: 'Plan', text: 'Friday' }])
    assert.deepEqual(answer.parts.map((p) => [p.text.trim(), p.sources]), [['It ships Friday.', [1]], ['Ask Sam.', [0]]])
    assert.equal(server.seen.find((s) => s.path === '/v1/chat/completions')?.headers.authorization, undefined, 'no key, no header')
    const embedder = new OpenAICompatibleEmbedder({ baseURL: `${server.url}/v1`, model: 'embed-model', apiKey: 'local-key' })
    const [v] = await embedder.embed(['hello'], 'query')
    assert.deepEqual([...v].map((x) => Math.round(x * 10) / 10), [0.6, 0.8], 'vectors come back at length one')
    assert.equal(server.seen.at(-1)?.headers.authorization, 'Bearer local-key')
    assert.equal(server.seen.at(-1)?.body.input_type, undefined, 'only Voyage is told documents from questions')
  })

  it('writes down audio and reads words out with servers of your own', async () => {
    const seen: { path: string; type: string; body: Buffer; authorization?: string }[] = []
    const server = createServer((request, response) => {
      const chunks: Buffer[] = []
      request.on('data', (chunk: Buffer) => chunks.push(chunk))
      request.on('end', () => {
        seen.push({ path: request.url ?? '', type: String(request.headers['content-type'] ?? ''), body: Buffer.concat(chunks), authorization: request.headers.authorization })
        if (request.url === '/v1/audio/transcriptions') {
          response.writeHead(200, { 'content-type': 'application/json' })
          response.end(JSON.stringify({ text: 'Hello there. Book it.', segments: [{ start: 0, end: 1.5, text: ' Hello there.' }, { start: 1.5, end: 2.5, text: ' Book it.' }] }))
        } else if (request.url === '/v1/audio/speech') {
          response.writeHead(200, { 'content-type': 'audio/mpeg' })
          response.end(Buffer.from('mp3 bytes'))
        } else {
          response.writeHead(401)
          response.end()
        }
      })
    })
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
    closers.push(() => new Promise<void>((done) => server.close(() => done())))
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`
    const heard = await new OpenAICompatibleTranscriber({ baseURL: url, model: 'whisper-large-v3', apiKey: 'tk' }).transcribe(new Uint8Array([1, 2, 3]), 'audio/mp4', 'en')
    assert.deepEqual(heard.segments.map((s) => s.text), ['Hello there.', 'Book it.'])
    const form = seen[0].body.toString('latin1')
    assert.match(seen[0].type, /^multipart\/form-data/)
    assert.match(form, /name="model"\r\n\r\nwhisper-large-v3/)
    assert.match(form, /name="response_format"\r\n\r\nverbose_json/)
    assert.match(form, /name="language"\r\n\r\nen/)
    assert.match(form, /filename="audio.m4a"/)
    assert.equal(seen[0].authorization, 'Bearer tk')
    const spoken = await new OpenAICompatibleSpeaker({ baseURL: url, model: 'kokoro', voice: 'af_heart' }).speak('Hi [1].')
    assert.equal(spoken.audio.toString(), 'mp3 bytes')
    assert.equal(spoken.mime, 'audio/mpeg')
    assert.deepEqual(JSON.parse(seen[1].body.toString()), { model: 'kokoro', input: 'Hi [1].', voice: 'af_heart', response_format: 'mp3' })
    await assert.rejects(new OpenAICompatibleSpeaker({ baseURL: `${url}/nowhere`, model: 'k' }).speak('x'), BrainUnavailable)
  })
})
