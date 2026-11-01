import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { setTimeout as sleep } from 'node:timers/promises'

// A stand-in agent, for trying the hub without running a real one: it connects over MCP with an agent's token, waits
// for a card, takes it, reports a few steps as a coding agent would, and finishes it with a pull request.
//
//   BINDERS_TOKEN=bnd_… npm run stand-in            (HUB_URL defaults to http://localhost:5173)
//   PULL_REQUEST=acme/web#12 to name the pull request it "opened"; NO_PR=1 to finish without one.

const url = new URL('/mcp', process.env.HUB_URL ?? 'http://localhost:5173')
const token = process.env.BINDERS_TOKEN
if (!token) {
  console.error('Set BINDERS_TOKEN to the token Binders showed when you set the agent up.')
  process.exit(1)
}

const client = new Client({ name: 'binders-stand-in', version: '1.0.0' })
await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { authorization: `Bearer ${token}` } } }))

async function call(name: string, args: Record<string, unknown> = {}) {
  const result = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean }
  const text = result.content[0]?.text ?? ''
  if (result.isError) throw new Error(`${name}: ${text}`)
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

const me = await call('whoami')
console.log(`Connected as ${me.name}.`)
await call('update_profile', { runs_on: 'Stand-in script' })

console.log('Waiting for work…')
let card = await call('wait_for_work', { timeout_seconds: 50 })
while (card === 'nothing yet') card = await call('wait_for_work', { timeout_seconds: 50 })
console.log(`Taking “${card.title}”.`)
await call('claim_task', { id: card.id })

const plan = ['Read what the card asks', 'Make the change', 'Run the tests', 'Open a pull request']
const report = async (done: number, doing: string, steps: { tool: string; text: string; result?: string }[], said?: string) => {
  await call('report_progress', { id: card.id, doing, progress: done / plan.length, plan: plan.map((text, i) => ({ text, done: i < done })), steps, said })
  console.log(`  ${doing}`)
  await sleep(2500)
}

await report(0, 'Reading the brief', [{ tool: 'Read', text: 'README.md', result: '84 lines' }], `I’ll start from the brief: ${card.brief || card.title}`)
await report(1, 'Making the change', [{ tool: 'Read', text: 'src/server.ts', result: '212 lines' }, { tool: 'Edit', text: 'src/server.ts', result: '+18 −2' }])
await report(2, 'Running the tests', [{ tool: 'Bash', text: 'npm test', result: '✓ 24 passed' }])
await report(3, 'Opening the pull request', [{ tool: 'Bash', text: 'git push origin stand-in/work', result: 'branch pushed' }])

const pull = process.env.NO_PR ? undefined : process.env.PULL_REQUEST ?? 'acme/web#12'
const done = await call('complete_task', { id: card.id, summary: 'Made the change, with a test. Ready for review.', pull_request: pull })
console.log(`Finished: the card is now ${done.stage}.`)
await client.close()
