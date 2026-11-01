import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

describe('Codex on another provider', () => {
  it('takes provider/model as that provider for the run, and a plain model as it is', async () => {
    const { Runner } = await import('../src/runner.ts')
    const runner = new Runner({ hubUrl: 'http://hub.test', token: 'bnd_x', workspace: '/tmp' }) as unknown as { commandFor: (settings: object, key: string, dir: string, mcp: string | undefined, prompt: string) => { args: string[] } }
    const settings = { tool: 'codex', access: 'full', timeoutMinutes: 10, worktrees: false }
    const routed = runner.commandFor({ ...settings, model: 'foundry/gpt-5.3-codex' }, 'k', '/tmp', undefined, 'Go').args
    assert.deepEqual(routed.slice(routed.indexOf('-c'), routed.indexOf('-c') + 6), ['-c', 'model_provider="foundry"', '-m', 'gpt-5.3-codex', '--disable', 'plugins'])
    const quiet = (runner as unknown as { commandFor: (settings: object, key: string, dir: string, mcp: string | undefined, prompt: string, quiet: string[]) => { args: string[] } }).commandFor({ ...settings, model: 'foundry/deepseek' }, 'k', '/tmp', undefined, 'Go', ['rea', 'my server']).args
    assert.ok(quiet.includes('mcp_servers.rea.enabled=false') && quiet.includes('mcp_servers."my server".enabled=false'), 'the user’s own MCP servers off for another provider')
    const plain = runner.commandFor({ ...settings, model: 'gpt-5-codex' }, 'k', '/tmp', undefined, 'Go').args
    assert.ok(plain.includes('gpt-5-codex') && !plain.some((a) => a.startsWith('model_provider')))
  })

  it('names the hub’s MCP server so it can’t merge into the Mac app’s "binders" server', async () => {
    const { Runner } = await import('../src/runner.ts')
    const runner = new Runner({ hubUrl: 'http://hub.test', token: 'bnd_x', workspace: '/tmp' }) as unknown as { commandFor: (settings: object, key: string, dir: string, mcp: string | undefined, prompt: string) => { args: string[] } }
    const args = runner.commandFor({ tool: 'codex', access: 'full', timeoutMinutes: 10, worktrees: false }, 'k', '/tmp', undefined, 'Go').args
    assert.ok(args.includes('mcp_servers.binders_hub.url="http://hub.test/mcp"'))
    assert.ok(!args.some((a) => a.startsWith('mcp_servers.binders.')))
  })
})

describe('why an agent stopped', () => {
  it('gives what Codex said went wrong, and skips another MCP server’s sign-in noise', async () => {
    const { stoppedWith } = await import('../src/runner.ts')
    const { StreamReader } = await import('../src/stream.ts')
    const noise = 'ERROR rmcp::transport::worker: worker quit with fatal: Transport channel closed, when AuthRequired(…)'
    const reader = new StreamReader()
    assert.equal(stoppedWith({ exit: { code: 1 }, errors: `a real problem\n${noise}\n`, reader }, 'https://hub.test'), 'The agent stopped with exit code 1: a real problem.')
    reader.line(JSON.stringify({ type: 'turn.failed', error: { message: 'The model gpt-x does not exist.' } }))
    assert.equal(stoppedWith({ exit: { code: 1 }, errors: noise, reader }, 'https://hub.test'), 'The agent stopped with exit code 1: The model gpt-x does not exist.')
    const wrapped = new StreamReader()
    wrapped.line(JSON.stringify({ type: 'error', message: '{\n  "error": {\n    "message": "Invalid schema for function \'send_message\'.",\n    "type": "invalid_request_error"\n  }\n}' }))
    assert.equal(stoppedWith({ exit: { code: 1 }, errors: '', reader: wrapped }, 'https://hub.test'), 'The agent stopped with exit code 1: Invalid schema for function \'send_message\'.')
  })
})

describe('Codex’s providers', () => {
  it('names the providers in its config, not OpenAI’s own', async () => {
    const { codexProviders } = await import('../src/runner.ts')
    const { mkdtemp, writeFile } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const home = await mkdtemp(join(tmpdir(), 'codex-home-'))
    await writeFile(join(home, 'config.toml'), 'model = "x"\n[model_providers.foundry]\nname = "Foundry"\n[model_providers."local-llm"]\n[model_providers.openai]\n[mcp_servers.binders]\n')
    assert.deepEqual(await codexProviders(home), ['foundry', 'local-llm'])
    assert.deepEqual(await codexProviders(join(home, 'none')), [])
  })
})

describe('Claude Code with Binders’ tools', () => {
  it('allows the hub’s tools up front at every access, headless and in a terminal', async () => {
    const { Runner } = await import('../src/runner.ts')
    const runner = new Runner({ hubUrl: 'http://hub.test', token: 'bnd_x', workspace: '/tmp' }) as unknown as {
      commandFor: (settings: object, key: string, dir: string, mcp: string | undefined, prompt: string) => { args: string[] }
      interactiveFor: (settings: object, dir: string, mcp: string | undefined) => { args: string[] }
    }
    for (const access of ['full', 'auto', 'edits']) {
      const settings = { tool: 'claude', access, timeoutMinutes: 60 }
      assert.ok(runner.commandFor(settings, 'k', '/tmp', '/tmp/mcp.json', 'Go').args.includes('--allowedTools=mcp__binders_hub'), access)
      assert.ok(runner.interactiveFor(settings, '/tmp', '/tmp/mcp.json').args.includes('--allowedTools=mcp__binders_hub'), access)
    }
  })
})

describe('the reasoning a person asks for', () => {
  it('sets Codex’s reasoning effort and Claude Code’s thinking budget, and leaves each tool’s own default when none is asked', async () => {
    const { Runner } = await import('../src/runner.ts')
    const runner = new Runner({ hubUrl: 'http://hub.test', token: 'bnd_x', workspace: '/tmp' }) as unknown as { commandFor: (settings: object, key: string, dir: string, mcp: string | undefined, prompt: string) => { args: string[]; env: Record<string, string> } }
    const codex = runner.commandFor({ tool: 'codex', access: 'full', timeoutMinutes: 60, effort: 'low' }, 'k', '/tmp', undefined, 'Go').args
    assert.ok(codex.join(' ').includes('model_reasoning_effort="low"'))
    assert.ok(!runner.commandFor({ tool: 'codex', access: 'full', timeoutMinutes: 60 }, 'k', '/tmp', undefined, 'Go').args.join(' ').includes('model_reasoning_effort'))
    assert.equal(runner.commandFor({ tool: 'claude', access: 'full', timeoutMinutes: 60, effort: 'high' }, 'k', '/tmp', undefined, 'Go').env.MAX_THINKING_TOKENS, '32000')
    assert.equal(runner.commandFor({ tool: 'claude', access: 'full', timeoutMinutes: 60 }, 'k', '/tmp', undefined, 'Go').env.MAX_THINKING_TOKENS, undefined)
  })
})
