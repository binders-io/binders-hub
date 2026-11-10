// @vitest-environment jsdom
import { cleanup, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { hubState, mount, standInHub } from './harness'
import { Notes } from '../src/screens/Notes'

// A hub with no binder yet: what Notes says to do.

vi.mock('../src/editor/MarkdownEditor', () => ({ MarkdownEditor: () => null }))
vi.mock('../src/editor/Toolbar', () => ({ Toolbar: () => null }))

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('Notes with no binder', () => {
  it('says where to make one: the switcher at the top left, not Settings', async () => {
    standInHub(() => hubState({ binders: [], notes: [], cards: [], proposals: [] }))
    await mount(<Notes id="" />)
    expect(screen.getByText('Make a binder first: “New binder…” is in the switcher at the top left.')).toBeTruthy()
    expect(screen.queryByText(/in Settings/)).toBeNull()
  })
})
