import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, screen, within } from '@testing-library/react'
import { Agents } from '../src/screens/Agents'
import { hubState, me, mount, standInHub } from './harness'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

/** The commits choice in the agent form: its buttons, and the hint under them. */
async function commitsChoice(you: unknown) {
  standInHub(hubState, you)
  await mount(<Agents />)
  fireEvent.click(screen.getByRole('button', { name: /Set up an agent/ }))
  const group = await screen.findByRole('radiogroup', { name: /Commits and pull requests by/ }).catch(() => document.getElementById('runner-commit-as')!)
  return { buttons: within(group).getAllByRole('radio') as HTMLButtonElement[], dialog: group.closest('[role="dialog"]') ?? document.body }
}

describe('who an agent’s commits are by', () => {
  it('is each agent’s own choice until the hub’s admins fix it', async () => {
    const { buttons } = await commitsChoice(me)
    expect(buttons.every((b) => !b.disabled)).toBe(true)
    fireEvent.click(buttons[1])
    expect(buttons[1].getAttribute('aria-checked')).toBe('true')
  })

  it('shows the admins’ choice, and can’t be changed, once they fix it', async () => {
    const { buttons, dialog } = await commitsChoice({ ...me, agentCommits: 'app' })
    expect(buttons.every((b) => b.disabled)).toBe(true)
    expect(buttons.find((b) => b.getAttribute('aria-checked') === 'true')?.textContent).toBe('The Binders app')
    expect(dialog.textContent).toContain('Set by the hub’s admins: the hub’s GitHub App and its bot.')
  })
})
