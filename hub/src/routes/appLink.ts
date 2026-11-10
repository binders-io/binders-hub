import type { FastifyInstance } from 'fastify'
import { AppLinkSession, framesOf, type AudioCapture } from '../appLink.ts'
import { Refused } from '../hub.ts'
import { readBody, bodies } from '../schemas.ts'
import type { Context } from './context.ts'

/** The longest recording the hub takes in one go: hours of speech at the iPhone's AAC rate. */
const audioLimit = 100 * 1024 * 1024

// The hub as an iPhone's brain: the link the iPhone has with its Mac, as a WebSocket signed in as the person (their app
// token, which the /api hook has checked). Each frame is one JSON-RPC message, or several on lines of their own.

export async function appLinkRoutes(app: FastifyInstance, context: Context) {
  const { spaces, auth, brainSettings, webUrl, options, fail } = context
  // A recording's bytes as they came: only the audio route reads them, and every other route refuses a body like that.
  app.addContentTypeParser(/^audio\//, { parseAs: 'buffer', bodyLimit: audioLimit }, (_request, body, done) => done(null, body))
  const hubName = (() => {
    try {
      return new URL(options.publicUrl).host
    } catch {
      return 'Your hub'
    }
  })()

  app.get('/api/app/link', { websocket: true }, (socket, request) => {
    const user = request.user
    // Only an app's own token: a browser tab or an MCP client has no business here.
    if (!user || !request.personToken) {
      socket.close(4401, 'Sign in with the app.')
      return
    }
    const session = new AppLinkSession({
      spaces,
      login: user.login,
      settings: brainSettings,
      webUrl,
      githubIn: (id) => (spaces.info(id)?.personal ? Promise.resolve(undefined) : auth.githubFor(user.login, id)),
      hubName,
      version: process.env.BINDERS_COMMIT?.slice(0, 7) ?? 'dev',
      send: (message) => {
        if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message))
      },
    })
    socket.on('message', (data) => {
      for (const message of framesOf(String(data))) void session.handle(message)
    })
    const ping = setInterval(() => socket.readyState === socket.OPEN && socket.ping(), 25_000)
    socket.on('close', () => {
      clearInterval(ping)
      session.close()
    })
  })

  // A conversation's audio, for the hub to write down with its own transcription model; what it is comes in the
  // X-Binders-Capture header, as JSON. Answered at once: what came of it reaches the iPhone as the capture's outcome.
  app.post('/api/app/audio', { bodyLimit: audioLimit, config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (request, reply) => {
    try {
      const user = request.user
      if (!user || !request.personToken) return reply.code(401).send({ error: 'Sign in with the app.' })
      if (!Buffer.isBuffer(request.body) || !request.body.length) throw new Refused('Send the recording itself, as audio.')
      let described: unknown
      try {
        described = JSON.parse(decodeURIComponent(String(request.headers['x-binders-capture'] ?? '')))
      } catch {
        throw new Refused('Say what the recording is, in the X-Binders-Capture header.')
      }
      const read = readBody(bodies.audioCapture, described)
      if (read.wrong) throw new Refused(`That recording can’t be used: ${read.wrong}.`)
      const session = new AppLinkSession({ spaces, login: user.login, settings: brainSettings, webUrl, hubName, version: '', send: () => {} })
      const mime = String(request.headers['content-type'] ?? 'audio/mp4').split(';')[0]
      const { id } = await session.audio(read.body as AudioCapture, request.body, mime)
      return reply.code(202).send({ id, transcribing: true })
    } catch (error) {
      return fail(reply, error)
    }
  })

  // Words read out by the hub's speech model: for an answer to be heard, from the apps or a browser.
  app.post('/api/brain/speak', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (request, reply) => {
    try {
      if (!request.user) return reply.code(401).send({ error: 'Sign in first.' })
      const speaker = brainSettings?.speaker()
      if (!speaker) throw new Refused('This hub has no speech model.')
      const read = readBody(bodies.speak, request.body)
      if (read.wrong) throw new Refused(`That request can’t be used: ${read.wrong}.`)
      const { audio, mime } = await speaker.speak((read.body as { text: string }).text)
      return reply.type(mime).header('cache-control', 'no-store').send(audio)
    } catch (error) {
      return fail(reply, error)
    }
  })
}
