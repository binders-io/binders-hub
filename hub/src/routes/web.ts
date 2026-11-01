import { stat } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import fastifyStatic from '@fastify/static'
import type { FastifyInstance } from 'fastify'
import type { Context } from './context.ts'

// The web app, for a hub with no Vite in front of it.

export async function webRoutes(app: FastifyInstance, context: Context) {
  const { options } = context
  // The web app, built: its files, and index.html for any other page a browser asks for (its screens are in the hash).
  // A file with a compressed copy beside it goes as that, to a browser that takes it: scripts are most of what it fetches.
  if (options.webDir) {
    const root = resolve(options.webDir)
    await app.register(fastifyStatic, { root, serve: false, preCompressed: true, cacheControl: false })
    const isFile = (path: string) => stat(path).then((found) => found.isFile(), () => false)
    app.setNotFoundHandler(async (request, reply) => {
      let path = ''
      try { path = decodeURIComponent(request.url.split('?')[0]) } catch { /* not a path */ }
      if ((request.method !== 'GET' && request.method !== 'HEAD') || /^\/(api|auth|setup|mcp|webhooks|runner)(\/|$)/.test(path)) return reply.code(404).send({ error: 'Not found.' })
      const file = resolve(root, `.${path}`)
      // Vite names what's in assets/ by its contents, so those never change; everything else is checked each time.
      if (file.startsWith(root + sep) && await isFile(file)) return reply.header('cache-control', path.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache').sendFile(file.slice(root.length + 1))
      // A file from before an update: the page asking for it reloads on a 404, and couldn't use index.html as a script.
      if (path.startsWith('/assets/')) return reply.code(404).send({ error: 'Not found.' })
      if (!await isFile(join(root, 'index.html'))) return reply.code(404).send({ error: 'The web app isn’t built here.' })
      return reply.header('cache-control', 'no-cache').sendFile('index.html')
    })
  }
}
