import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { loopLimits, runLoop, type LoopEvent, type LoopTurn, type Step, type StepModel, type Tool, type ToolSpec } from '../../shared/agent.ts'

const call = (id: string, name: string, input: unknown = {}) => ({ id, name, input })
const says = (text: string): Step => ({ text, calls: [], stop: 'end' })
const wants = (...calls: ReturnType<typeof call>[]): Step => ({ text: '', calls, stop: 'tools' })

/** A model that gives back each step it was scripted with, and keeps what it was asked each time. */
function scripted(...steps: (Step | ((turns: LoopTurn[]) => Step))[]) {
  const asked: { system: string; turns: LoopTurn[]; tools: ToolSpec[] }[] = []
  const model: StepModel = {
    label: 'scripted',
    step: async (input) => {
      asked.push({ system: input.system, turns: structuredClone(input.turns), tools: input.tools })
      const next = steps[Math.min(asked.length - 1, steps.length - 1)]
      return typeof next === 'function' ? next(input.turns) : next
    },
  }
  return { model, asked }
}

const tool = (name: string, run: (input: unknown) => Promise<string> | string): Tool => ({ spec: { name, description: `Does ${name}.`, input: { type: 'object', properties: {} } }, run: async (input) => run(input) })

describe('a model working in steps', () => {
  it('answers at once when it calls nothing', async () => {
    const { model, asked } = scripted(says('Forty-two.'))
    const outcome = await runLoop({ model, system: 'Be brief.', ask: 'What is it?', tools: [tool('look', () => 'x')] })
    assert.deepEqual(outcome, { text: 'Forty-two.', stopped: 'done', steps: 1, calls: [], usage: { in: 0, out: 0 } })
    assert.deepEqual(asked[0].turns, [{ role: 'user', text: 'What is it?' }])
    assert.equal(asked[0].system, 'Be brief.')
    assert.deepEqual(asked[0].tools.map((t) => t.name), ['look'])
  })

  it('runs the tools it calls, gives it what they returned, and goes on to its answer', async () => {
    const { model, asked } = scripted({ text: 'Let me look.', calls: [call('c1', 'read', { id: 'n1' }), call('c2', 'count')], stop: 'tools', raw: { own: 'blocks' }, usage: { in: 100, out: 20 } }, { ...says('It says pnpm, and there are 3.'), usage: { in: 150, out: 30 }, model: 'another-model' })
    const read: unknown[] = []
    const events: LoopEvent[] = []
    const outcome = await runLoop({ model, system: '', ask: 'Which package manager?', tools: [tool('read', (input) => { read.push(input); return 'We use pnpm.' }), tool('count', () => '3')], on: (event) => events.push(event) })
    assert.deepEqual(read, [{ id: 'n1' }])
    assert.equal(outcome.text, 'It says pnpm, and there are 3.')
    assert.equal(outcome.stopped, 'done')
    assert.equal(outcome.steps, 2)
    assert.deepEqual(outcome.usage, { in: 250, out: 50 })
    assert.equal(outcome.model, 'another-model')
    assert.deepEqual(outcome.calls.map((c) => [c.call.name, c.result.text]), [['read', 'We use pnpm.'], ['count', '3']])
    assert.deepEqual(asked[1].turns, [
      { role: 'user', text: 'Which package manager?' },
      { role: 'assistant', text: 'Let me look.', calls: [call('c1', 'read', { id: 'n1' }), call('c2', 'count')], raw: { own: 'blocks' } },
      { role: 'tool', results: [{ id: 'c1', name: 'read', text: 'We use pnpm.' }, { id: 'c2', name: 'count', text: '3' }] },
    ])
    assert.deepEqual(events.map((e) => e.type), ['said', 'call', 'result', 'call', 'result', 'said'])
  })

  it('tells the model why a tool failed, and lets it go on', async () => {
    const { model, asked } = scripted(wants(call('c1', 'read', { id: 'gone' })), says('That note is gone.'))
    const outcome = await runLoop({ model, system: '', ask: 'Read it', tools: [tool('read', () => { throw new Error('There is no note gone.') })] })
    assert.deepEqual(asked[1].turns[2], { role: 'tool', results: [{ id: 'c1', name: 'read', text: 'There is no note gone.', failed: true }] })
    assert.equal(outcome.text, 'That note is gone.')
  })

  it('runs no tool it wasn’t given, and says which there are', async () => {
    const { model, asked } = scripted(wants(call('c1', 'delete_everything'), call('c2', 'look')), says('Done looking.'))
    const ran: string[] = []
    await runLoop({ model, system: '', ask: 'Go', tools: [tool('look', () => { ran.push('look'); return 'seen' })] })
    assert.deepEqual(ran, ['look'])
    assert.deepEqual((asked[1].turns[2] as Extract<LoopTurn, { role: 'tool' }>).results[0], { id: 'c1', name: 'delete_everything', text: 'There is no tool called delete_everything. The tools are: look.', failed: true })
  })

  it('cuts a long result, saying how much was left out, and says so of an empty one', async () => {
    const { model, asked } = scripted(wants(call('c1', 'big'), call('c2', 'empty')), says('Read.'))
    await runLoop({ model, system: '', ask: 'Go', tools: [tool('big', () => 'x'.repeat(50)), tool('empty', () => '')], limits: { resultChars: 20 } })
    const results = (asked[1].turns[2] as Extract<LoopTurn, { role: 'tool' }>).results
    assert.equal(results[0].text, `${'x'.repeat(20)}\n(The rest was left out: 30 more characters.)`)
    assert.equal(results[1].text, '(Nothing.)')
  })

  it('runs only so many tools for one step', async () => {
    const { model, asked } = scripted(wants(call('c1', 'look'), call('c2', 'look'), call('c3', 'look')), says('Enough.'))
    let ran = 0
    await runLoop({ model, system: '', ask: 'Go', tools: [tool('look', () => { ran++; return 'seen' })], limits: { callsPerStep: 2 } })
    assert.equal(ran, 2)
    const results = (asked[1].turns[2] as Extract<LoopTurn, { role: 'tool' }>).results
    assert.equal(results.length, 3, 'every call gets an answer, as a model’s API expects')
    assert.match(results[2].text, /^Not run: at most 2 tools are run at once/)
    assert.equal(results[2].failed, true)
  })

  it('stops after its steps, and asks once more with no tools for an answer from what it found', async () => {
    const { model, asked } = scripted(wants(call('c1', 'look')), wants(call('c2', 'look')), says('From what I found: not much.'))
    const outcome = await runLoop({ model, system: '', ask: 'Go', tools: [tool('look', () => 'seen')], limits: { steps: 2 } })
    assert.equal(outcome.stopped, 'steps')
    assert.equal(outcome.text, 'From what I found: not much.')
    assert.equal(outcome.steps, 3)
    assert.deepEqual(asked[2].tools, [], 'the last ask has no tools to call')
    assert.match((asked[2].turns.at(-1) as Extract<LoopTurn, { role: 'user' }>).text, /Answer now from what you have found/)
  })

  it('stops when its time is up, the same way', async () => {
    let clock = 0
    const { model } = scripted(wants(call('c1', 'look')), says('Out of time, but here it is.'))
    const outcome = await runLoop({ model, system: '', ask: 'Go', tools: [tool('look', () => { clock += 5000; return 'seen' })], limits: { ms: 1000 }, now: () => clock })
    assert.equal(outcome.stopped, 'time')
    assert.equal(outcome.text, 'Out of time, but here it is.')
  })

  it('says when the model declined or was cut off', async () => {
    assert.equal((await runLoop({ model: scripted({ text: '', calls: [], stop: 'refused' }).model, system: '', ask: 'Go', tools: [] })).stopped, 'refused')
    assert.equal((await runLoop({ model: scripted({ text: 'Half an ans', calls: [], stop: 'length' }).model, system: '', ask: 'Go', tools: [] })).stopped, 'length')
  })

  it('has limits of its own when none are given', () => {
    assert.deepEqual(loopLimits, { steps: 8, ms: 120_000, resultChars: 8000, callsPerStep: 8 })
  })
})
