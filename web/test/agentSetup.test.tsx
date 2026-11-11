// @vitest-environment jsdom
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { accessLines } from '../../shared/agents.ts'
import { Agents } from '../src/screens/Agents'
import { Dialog } from '../src/components/Dialog'
import { RunnerSteps } from '../src/components/RunnerSteps'
import { agent, hubState, mount, settle, standInHub, standInRoute } from './harness'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

/** Add an agent, set up by hand: its step, in the dialog. */
const byHand = async () => {
  fireEvent.click(screen.getAllByRole('button', { name: 'Add an agent' })[0])
  const dialog = (await screen.findByRole('dialog', { name: 'Add an agent' })) as HTMLElement
  fireEvent.click(within(dialog).getByRole('button', { name: /Set one up by hand/ }))
  await within(dialog).findByRole('form', { name: 'Set up an agent' })
  return dialog
}
const setUp = async (agents = [agent]) => {
  standInHub(() => hubState({ agents }))
  await mount(<Agents />)
  return byHand()
}
const more = (dialog: HTMLElement) => dialog.querySelector('details.agent-more') as HTMLDetailsElement
const nameBox = () => document.getElementById('agent-name') as HTMLInputElement

describe('setting up an agent is short', () => {
  it('opens with the tool and a name from it, and nothing else is needed', async () => {
    const dialog = await setUp([])
    expect(nameBox().value).toBe('Claude Code')
    expect((within(dialog).getByRole('button', { name: 'Set up' }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('points at the binder’s repos in Settings → GitHub, as a link, when it has some', async () => {
    standInHub(() => hubState({ agents: [], binders: [{ id: 'b1', name: 'Binder', repos: ['acme/api', 'acme/web'] }] }))
    await mount(<Agents />)
    const dialog = await byHand()
    const link = within(dialog).getByRole('link', { name: 'Settings → GitHub', hidden: true })
    expect(link.getAttribute('href')).toBe('#/settings/github')
    expect(link.closest('.field-hint')!.textContent).toContain('Among its binder’s 2 repos (Settings → GitHub)')
  })

  it('numbers the name when this binder already has one, and follows the tool until it’s typed over', async () => {
    const dialog = await setUp([{ ...agent, name: 'Claude Code' }, { ...agent, id: 'a2', name: 'claude code 2' }, { ...agent, id: 'a3', name: 'Codex', revoked: true }])
    expect(nameBox().value).toBe('Claude Code 3')
    fireEvent.click(within(dialog).getByRole('radio', { name: /Codex/ }))
    expect(nameBox().value).toBe('Codex')
    fireEvent.change(nameBox(), { target: { value: 'Night shift' } })
    fireEvent.click(within(dialog).getByRole('radio', { name: /OpenCode/ }))
    expect(nameBox().value).toBe('Night shift')
  })

  it('sets it up with the name it was given and the usual settings, then shows its token', async () => {
    const dialog = await setUp([])
    const made = standInRoute('POST', '/api/agents', (body) => ({ agent: { ...agent, id: 'a9', name: (body as { name: string }).name }, token: 'bnd_secret' }))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Set up' }))
    expect(await screen.findByText('bnd_secret')).toBeTruthy()
    expect(made[0]).toMatchObject({ name: 'Claude Code', repos: [], skills: [], runner: { tool: 'claude', access: 'full', timeoutMinutes: 60 } })
  })

  it('keeps all the rest under More, closed for a new agent, with the experiments last under their own heading', async () => {
    const dialog = await setUp([])
    const fold = more(dialog)
    expect(fold.open).toBe(false)
    expect(fold.querySelector('summary')?.textContent?.trim()).toBe('More')
    for (const id of ['agent-repos', 'agent-skills', 'agent-workspace', 'runner-access', 'runner-model', 'runner-timeout', 'runner-parallel', 'runner-commit-as', 'runner-allow', 'runner-held', 'runner-cli']) expect(fold.querySelector(`#${id}`), id).toBeTruthy()
    // The tool and the name stay outside it.
    expect(fold.contains(nameBox())).toBe(false)
    const labels = [...fold.querySelectorAll('.field-label')].map((l) => l.textContent)
    expect(labels.indexOf('Experiments')).toBeGreaterThan(labels.indexOf('Commands it may run'))
    expect(labels.slice(labels.indexOf('Experiments') + 1)).toEqual(['Keep cards running through restarts', 'Talks to Binders through'])
    expect(fold.textContent).not.toMatch(/An experiment/)
    // Its summary opens it, and Tab can reach that.
    const summary = fold.querySelector('summary')!
    summary.focus()
    expect(document.activeElement).toBe(summary)
    fireEvent.click(summary)
    expect(fold.open).toBe(true)
  })

  describe('editing one', () => {
    const run = { tool: 'claude' as const, access: 'full' as const, timeoutMinutes: 60, worktrees: true, parallel: 3 }
    const opened = async (name: string, over: object) => {
      standInHub(() => hubState({ agents: [{ ...agent, name, ...over }] }))
      await mount(<Agents />)
      fireEvent.click(within(screen.getByRole('heading', { name }).closest('article')!).getByRole('button', { name: 'Edit' }))
      return more((await screen.findByRole('dialog', { name: `Edit ${name}` })) as HTMLElement).open
    }

    it('keeps More closed for an agent whose settings are the usual', async () => {
      expect(await opened('Plain', { runner: run })).toBe(false)
    })

    it('opens More for an agent whose settings aren’t', async () => {
      expect(await opened('Careful', { runner: { ...run, access: 'edits' } })).toBe(true)
      cleanup()
      expect(await opened('Picky', { runner: run, repos: ['o/r'] })).toBe(true)
      cleanup()
      expect(await opened('Slow', { runner: { ...run, timeoutMinutes: 120 } })).toBe(true)
      cleanup()
      expect(await opened('Experimenting', { runner: { ...run, cli: true } })).toBe(true)
    })
  })

  it('says in a line what each access level lets it do without asking', async () => {
    const dialog = await setUp([])
    const select = within(dialog).getByRole('combobox', { name: /Access/ }) as HTMLSelectElement
    expect(select.closest('label')?.textContent).toContain('runs commands and changes files on that machine without asking anyone')
    fireEvent.change(select, { target: { value: 'auto' } })
    expect(select.closest('label')?.textContent).toContain(accessLines.auto)
    fireEvent.change(select, { target: { value: 'edits' } })
    expect(select.closest('label')?.textContent).toContain(accessLines.edits)
    expect(accessLines.full).toMatch(/without asking anyone/)
  })

  it('shows each agent’s access in words on its card, under Details', async () => {
    const run = { tool: 'claude' as const, access: 'full' as const, timeoutMinutes: 60, worktrees: true }
    standInHub(() => hubState({ agents: [{ ...agent, name: 'Wide', runner: run }, { ...agent, id: 'a2', name: 'Narrow', runner: { ...run, access: 'edits' } }, { ...agent, id: 'a3', name: 'Middle', runner: { ...run, access: 'auto' } }] }))
    await mount(<Agents />)
    const card = (name: string) => screen.getByRole('heading', { name }).closest('article')!
    const access = (name: string) => card(name).querySelector('details .agent-details .agent-access')?.textContent
    expect(access('Wide')).toContain('Full access')
    expect(access('Narrow')).toContain('Edits only')
    expect(access('Middle')).toContain('Auto')
  })
})

describe('the token that is shown once', () => {
  const tokenDialog = async () => {
    const dialog = await setUp([])
    standInRoute('POST', '/api/agents', () => ({ agent: { ...agent, id: 'a9', name: 'Claude Code' }, token: 'bnd_secret' }))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Set up' }))
    await screen.findByText('bnd_secret')
    await settle(300)
    return screen.getByRole('dialog', { name: 'Start Claude Code' })
  }

  it('doesn’t close on a tap outside it or on Escape, only from its own button', async () => {
    const dialog = await tokenDialog()
    document.querySelectorAll('.scrim').forEach((scrim) => fireEvent.click(scrim))
    fireEvent.keyDown(window, { key: 'Escape' })
    await settle(300)
    expect(screen.getByText('bnd_secret')).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }))
    // It fades out first, which takes longer when the machine is busy.
    await waitFor(() => expect(screen.queryByText('bnd_secret')).toBeNull(), { timeout: 10_000 })
  })

  it('leaves every other dialog closing on a tap outside', async () => {
    function Plain() {
      const [open, setOpen] = useState(true)
      return open ? <Dialog title="Plain" onClose={() => setOpen(false)}><p>Inside</p></Dialog> : <p>Closed</p>
    }
    render(<Plain />)
    fireEvent.click(document.querySelector('.scrim')!)
    await act(async () => { await new Promise((done) => setTimeout(done, 300)) })
    expect(screen.getByText('Closed')).toBeTruthy()
  })
})

describe('the command to start the runner', () => {
  const steps = async (runner?: { workspace?: string }) => {
    standInHub()
    await mount(<RunnerSteps agent={{ ...agent, id: 'z1', runner: runner && { tool: 'claude', access: 'full', timeoutMinutes: 60, worktrees: true, ...runner } }} token="bnd_x" />)
    return () => document.querySelector('.command pre')!.textContent!
  }

  it('says to run it in the folder with the code, and has no folder in it, when none is set', async () => {
    const command = await steps()
    expect(screen.getByText('Run this in the folder with the code.')).toBeTruthy()
    expect(command()).toContain('add --token bnd_x')
    expect(command()).not.toContain('--workspace')
    expect(document.body.textContent).not.toContain('~/path/to/your/code')
    fireEvent.click(screen.getByRole('radio', { name: 'In this terminal' }))
    expect(screen.getByText('Run this in the folder with the code.')).toBeTruthy()
    expect(command()).not.toContain('--workspace')
    expect(command()).not.toContain('~/path/to/your/code')
  })

  it('keeps today’s command, and doesn’t say it, when the agent has a folder', async () => {
    const command = await steps({ workspace: '~/code/app' })
    expect(screen.queryByText('Run this in the folder with the code.')).toBeNull()
    expect(command()).toMatch(/add --token bnd_x --workspace ~\/code\/app$/)
    expect(document.body.textContent).toContain('It works in ~/code/app, as set for this agent.')
  })

  it('asks for Node 22', async () => {
    await steps()
    expect(screen.getByText(/needs Node 22 or newer/)).toBeTruthy()
    expect(document.body.textContent).not.toMatch(/Node 20/)
  })
})

describe('whose an agent is', () => {
  const sams = { ...agent, id: 'a2', name: 'Sam’s agent', owner: 'Sam' }
  const card = (name: string) => screen.getByRole('heading', { name }).closest('article') as HTMLElement

  it('says so on an agent that isn’t yours, since only its owner can start it or answer for it', async () => {
    standInHub(() => hubState({ agents: [agent, sams] }))
    await mount(<Agents />)
    expect(within(card('Sam’s agent')).getByText(/@Sam’s/)).toBeTruthy()
  })

  it('says nothing on your own, whatever the case of your name', async () => {
    standInHub(() => hubState({ agents: [agent, { ...agent, id: 'a3', name: 'Mine too', owner: 'YOU' }] }))
    await mount(<Agents />)
    expect(card('Agent').textContent).not.toMatch(/’s$|@/)
    expect(within(card('Mine too')).queryByText(/@/)).toBeNull()
  })

  it('says nothing while it isn’t known who you are', async () => {
    standInHub(() => hubState({ agents: [sams] }), null)
    await mount(<Agents />)
    expect(within(card('Sam’s agent')).queryByText(/@Sam/)).toBeNull()
  })
})
