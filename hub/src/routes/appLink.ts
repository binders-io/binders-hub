import type { FastifyInstance } from 'fastify'
import { AppLinkSession, framesOf } from '../appLink.ts'
import type { Context } from './context.ts'

// The hub as an iPhone's brain: the link the iPhone has with its Mac, as a WebSocket signed in as the person (their app
// token, which the /api hook has checked). Each frame is one JSON-RPC message, or several on lines of their own.

export async function appLinkRoutes(app: FastifyInstance, context: Context) {
  const { spaces, brainSettings, webUrl, options } = context
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
}
