import { describe, expect, it } from 'vitest'
import { nameFor } from '../src/data/store'

// People shown by their GitHub profile's name, or their login without an Enterprise Managed User's known shortcode.

describe('nameFor', () => {
  const agents = [{ id: 'agent-1', name: 'Claude Code' }] as Parameters<typeof nameFor>[0]['agents']
  const me = { people: { 'jdoe_acme': { name: 'Jane Doe' } }, emu: ['acme'] }

  it('shows an agent by its name and the hub as Binders', () => {
    expect(nameFor({ agents, me }, 'agent-1')).toBe('Claude Code')
    expect(nameFor({ agents, me }, 'hub')).toBe('Binders')
  })

  it('shows a person by their profile’s name, else their login without a known shortcode', () => {
    expect(nameFor({ agents, me }, 'jdoe_acme')).toBe('Jane Doe')
    expect(nameFor({ agents, me }, 'bo_acme')).toBe('bo')
    expect(nameFor({ agents, me }, 'bo_other')).toBe('bo_other')
    expect(nameFor({ agents }, 'bo_acme'), 'nothing known: the login as it is').toBe('bo_acme')
  })
})
