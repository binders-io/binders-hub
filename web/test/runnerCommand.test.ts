import { describe, expect, it } from 'vitest'
import { runnerCommand } from '../src/components/RunnerSteps'

const base = { origin: 'https://hub.test', token: 'bnd_x' }

describe('the command to start a runner', () => {
  it('is the same as ever on a Mac or Linux', () => {
    expect(runnerCommand({ ...base, windows: false, how: 'background', where: '~/code' })).toBe('curl -fsSL https://hub.test/install | sh -s -- add --token bnd_x --workspace ~/code')
    expect(runnerCommand({ ...base, windows: false, how: 'terminal' })).toContain('BINDERS_TOKEN=bnd_x node ~/.binders/binders-runner.mjs --hub https://hub.test --workspace ~/path/to/your/code')
  })

  it('is PowerShell on Windows, which has no && in the version it comes with', () => {
    expect(runnerCommand({ ...base, windows: true, how: 'background', where: 'C:\\my code' })).toBe("& ([scriptblock]::Create((irm https://hub.test/install.ps1))) add --token bnd_x --workspace 'C:\\my code'")
    const terminal = runnerCommand({ ...base, windows: true, how: 'terminal', where: 'C:\\code' })
    expect(terminal).toContain("$env:BINDERS_TOKEN='bnd_x'; node $HOME/.binders/binders-runner.mjs --hub https://hub.test")
    expect(terminal).not.toContain('&&')
  })
})
