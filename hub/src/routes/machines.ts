import { readFile } from 'node:fs/promises'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { mcpServer } from '../mcp.ts'
import { verify } from '../webhooks.ts'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { Context } from './context.ts'

// What machines reach: the runner and its installer, agents over MCP, and GitHub's webhooks.

export async function machineRoutes(app: FastifyInstance, context: Context) {
  const { spaces, auth, options, backFor } = context
  // The runner, as one file to download: code, no secrets, so no sign-in needed.
  app.get('/runner/binders-runner.mjs', async (_request, reply) => {
    try {
      const file = await readFile(new URL('../../../runner/dist/binders-runner.mjs', import.meta.url))
      return reply.type('text/javascript; charset=utf-8').header('cache-control', 'no-cache').send(file)
    } catch {
      return reply.code(404).type('text/plain').send('The runner isn’t built on this hub: run "npm run build" in runner/.')
    }
  })

  // The installer: the runner and its `binders` command on this machine, then `binders` with what's passed, so one line
  // sets an agent up in the background: curl -fsSL <hub>/install | sh -s -- add --token bnd_… --workspace ~/code/app
  app.get('/install', async (_request, reply) => reply.type('text/plain; charset=utf-8').header('cache-control', 'no-cache').send(installer(options.publicUrl)))

  // MCP for agents ---------------------------------------------------------------------------------------------------

  const mcp = async (request: FastifyRequest, reply: FastifyReply) => {
    const token = /^Bearer\s+(.+)$/i.exec(request.headers.authorization ?? '')?.[1]
    const agent = await auth.agentFor(token)
    // A token made before the hub held several Binders is the first's.
    const space = agent && spaces.get(agent.space ?? spaces.list()[0]?.id ?? '')
    const agentId = agent?.id
    if (!agentId || !space || !space.hub.state.agents.some((a) => a.id === agentId && !a.revoked)) {
      return reply.code(401).header('www-authenticate', 'Bearer realm="binders"').send({ jsonrpc: '2.0', error: { code: -32001, message: 'This hub doesn’t know that token. Set the agent up in Binders’ Agents page and use the token it shows.' }, id: null })
    }
    const server = mcpServer(space.hub, space.actions, agentId, { issueToken: (id) => auth.issueAgentToken(id, space.id), publicUrl: options.publicUrl })
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
    reply.hijack()
    reply.raw.on('close', () => {
      void transport.close()
      void server.close()
    })
    await server.connect(transport)
    await transport.handleRequest(request.raw, reply.raw, request.body)
  }
  app.post('/mcp', mcp)
  app.get('/mcp', async (_request, reply) => reply.code(405).header('allow', 'POST').send({ error: 'This MCP server answers POST.' }))
  app.delete('/mcp', async (_request, reply) => reply.code(405).header('allow', 'POST').send({ error: 'No sessions to end.' }))

  // GitHub's webhooks, with the raw body for the signature -------------------------------------------------------------

  await app.register(async (scope) => {
    scope.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_request, body, done) => done(null, body))
    const deliver = async (request: FastifyRequest, reply: FastifyReply) => {
      // Each Binder's app posts to its own path; the first's to the plain one.
      const space = backFor(request)
      const secret = space?.github.webhookSecret()
      if (!space || !secret) return reply.code(404).send({ error: 'Webhooks aren’t set up for that Binder.' })
      const raw = request.body as Buffer
      if (!verify(secret, raw, request.headers['x-hub-signature-256'] as string | undefined)) return reply.code(401).send({ error: 'Bad signature.' })
      // A real delivery: the webhook works, so asking GitHub can stand down.
      space.poller?.heardWebhook()
      const event = String(request.headers['x-github-event'] ?? '')
      if (event === 'ping') return { ok: true }
      const payload = JSON.parse(raw.toString('utf8'))
      const result = await space.webhooks.handle(event, payload)
      // Binders that use this one's app hear what it hears: each acts on its own repos.
      for (const other of spaces.all()) {
        if (other === space || other.github.borrowedFrom !== space.id) continue
        other.poller?.heardWebhook()
        await other.webhooks.handle(event, payload).catch((error: Error) => app.log.warn(`${other.id} couldn’t take a webhook from ${space.id}'s app: ${error.message}`))
      }
      return { ok: true, result }
    }
    scope.post('/webhooks/github', deliver)
    scope.post('/webhooks/github/:space', deliver)
  })
}

/** The shell script /install serves: installs or updates the runner and the `binders` command, then runs `binders`. */
export function installer(publicUrl: string) {
  const hub = publicUrl.replace(/\/$/, '').replace(/[^\w:/.@%+~-]/g, '')
  return `#!/bin/sh
# Binders: installs (or updates) the runner and its \`binders\` command for ${hub}, then runs binders with what was passed.
#   curl -fsSL ${hub}/install | sh -s -- add --token bnd_… --workspace ~/code/app
set -e
HUB="${hub}"
DIR="$HOME/.binders"
command -v node >/dev/null 2>&1 || { echo "Binders needs Node 20 or newer: https://nodejs.org, or: brew install node"; exit 1; }
MAJOR=$(node -p 'process.versions.node.split(".")[0]')
[ "$MAJOR" -ge 20 ] || { echo "Binders needs Node 20 or newer; this is $(node -v). brew upgrade node, or https://nodejs.org"; exit 1; }
mkdir -p "$DIR/bin"
curl -fsSL "$HUB/runner/binders-runner.mjs" -o "$DIR/binders-runner.mjs.new"
mv "$DIR/binders-runner.mjs.new" "$DIR/binders-runner.mjs"
NODE=$(command -v node)
printf '#!/bin/sh\\nBINDERS_URL="\${BINDERS_URL:-%s}" exec "%s" "$HOME/.binders/binders-runner.mjs" "$@"\\n' "$HUB" "$NODE" > "$DIR/bin/binders"
chmod +x "$DIR/bin/binders"
# On the PATH: linked into a folder the PATH already has and this user can write to; else, how to add it.
LINKED=""
for d in "$HOME/.local/bin" "$HOME/bin" /usr/local/bin /opt/homebrew/bin; do
  case ":$PATH:" in *":$d:"*) if [ -d "$d" ] && [ -w "$d" ]; then ln -sf "$DIR/bin/binders" "$d/binders"; LINKED="$d"; break; fi ;; esac
done
if [ -n "$LINKED" ]; then echo "✓ binders is installed ($LINKED/binders)"; else echo "✓ binders is installed in ~/.binders/bin. To type just binders: echo 'export PATH=\\"\\$HOME/.binders/bin:\\$PATH\\"' >> ~/.zshrc"; fi
if [ $# -gt 0 ]; then exec "$DIR/bin/binders" "$@"; fi
`
}
