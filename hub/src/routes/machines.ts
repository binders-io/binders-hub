import { readFile } from 'node:fs/promises'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { mcpServer } from '../mcp.ts'
import { personServer } from '../mcpPerson.ts'
import { verify } from '../webhooks.ts'
import { handleWebhook } from '../jira.ts'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { Context } from './context.ts'

// What machines reach: the runner and its installer, agents and people over MCP, and GitHub's webhooks.

export async function machineRoutes(app: FastifyInstance, context: Context) {
  const { spaces, auth, options, backFor, isAdmin } = context
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

  // MCP for agents and people ----------------------------------------------------------------------------------------

  /** The binder a request names, for /<binder>/mcp: the one its path says, or none for the hub's /mcp. */
  const namedSpace = (request: FastifyRequest) => (request.params as { space?: string }).space

  /** A 401 that tells an MCP client where to sign in: the hub's OAuth server, for a person token. */
  const unauthorized = (reply: FastifyReply, request: FastifyRequest) => {
    const named = namedSpace(request)
    const metadata = new URL(`/.well-known/oauth-protected-resource${named ? `/${named}/mcp` : ''}`, options.publicUrl).toString()
    return reply.code(401).header('www-authenticate', `Bearer realm="binders", resource_metadata="${metadata}"`).send({ jsonrpc: '2.0', error: { code: -32001, message: 'This hub doesn’t know that token. An agent uses the token from its Agents page; a person connects with OAuth, through the browser.' }, id: null })
  }

  /** Runs one MCP server for this request: stateless, a server per call. */
  const serve = async (request: FastifyRequest, reply: FastifyReply, server: ReturnType<typeof mcpServer>) => {
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
    reply.hijack()
    reply.raw.on('close', () => {
      void transport.close()
      void server.close()
    })
    await server.connect(transport)
    await transport.handleRequest(request.raw, reply.raw, request.body)
  }

  const mcp = async (request: FastifyRequest, reply: FastifyReply) => {
    const token = /^Bearer\s+(.+)$/i.exec(request.headers.authorization ?? '')?.[1]
    const named = namedSpace(request)
    // An agent's token: the runner's, for work it takes. A token made before the hub held several Binders is the first's.
    const agent = await auth.agentFor(token)
    if (agent) {
      const space = spaces.get(agent.space ?? spaces.list()[0]?.id ?? '')
      if (!space || (named && named !== space.id) || !space.hub.state.agents.some((a) => a.id === agent.id && !a.revoked)) return unauthorized(reply, request)
      return serve(request, reply, mcpServer(space.hub, space.actions, agent.id, { issueToken: (id) => auth.issueAgentToken(id, space.id), publicUrl: options.publicUrl }))
    }
    // A person's token: signed in through OAuth, acting as themselves in the binder the connection is for.
    const person = await auth.personFor(token)
    // An app's token is for /api: only a token made for MCP is a connection to a binder.
    if (!person || person.kind !== 'mcp') return unauthorized(reply, request)
    const mine = spaces.forPerson(person.user.login, isAdmin(person.user.login))
    // A connection is for the one binder the person allowed. It never moves to another, as every binder's log calls its
    // binder the same: a client that was removed from this one would write in the next one without knowing.
    const refused = (message: string) => reply.code(403).send({ jsonrpc: '2.0', error: { code: -32002, message }, id: null })
    if (named && named !== person.space) return refused(`This connection is for another binder. To use ${named}, connect to its address and allow it.`)
    const target = mine.find((s) => s.info.id === person.space)
    if (!target) return refused(`@${person.user.login} isn’t in the binder this connection is for.`)
    const space = spaces.get(target.info.id)
    if (!space) return unauthorized(reply, request)
    // The binder as its log has it: a space's one binder is "main" (or "notes" for a personal one), whatever its address.
    // A person's connection is for this binder, so the tools go by its id and name, as the board does.
    const binder = space.hub.state.binders[0]
    return serve(request, reply, personServer(space.hub, space.actions, {
      binder: { id: binder?.id ?? target.info.id, name: binder?.name ?? target.info.name },
      binders: [{ id: binder?.id ?? target.info.id, name: binder?.name ?? target.info.name, role: target.role }],
      login: person.user.login,
      name: person.user.name,
    }))
  }
  // The hub's own, for an agent's token and a person's; and a binder's, for a person connecting to one binder.
  app.post('/mcp', mcp)
  app.post('/:space/mcp', mcp)
  const notHere = async (_request: FastifyRequest, reply: FastifyReply) => reply.code(405).header('allow', 'POST').send({ error: 'This MCP server answers POST.' })
  app.get('/mcp', notHere)
  app.delete('/mcp', notHere)
  app.get('/:space/mcp', notHere)
  app.delete('/:space/mcp', notHere)

  // Jira's webhook, for this binder: its secret in the query string, which the hub's log leaves out.
  app.post('/webhooks/jira/:space', async (request, reply) => {
    const { space } = request.params as { space: string }
    const { secret } = request.query as { secret?: unknown }
    const binder = spaces.get(space)
    const jira = binder?.jira
    if (!binder || !jira || !binder.jiraIssues || typeof secret !== 'string' || !(await jira.knowsSecret(secret))) return reply.code(404).send({ error: 'No such Jira webhook.' })
    const body = request.body as Record<string, unknown> | undefined
    if (!body || typeof body !== 'object') return reply.code(400).send({ error: 'A Jira webhook posts JSON.' })
    try {
      return { ok: true, result: await handleWebhook(binder.hub, jira, binder.jiraIssues, body) }
    } catch (error) {
      return reply.code(500).send({ error: (error as Error).message })
    }
  })

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
