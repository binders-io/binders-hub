// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { hubState, mount, standInHub } from './harness'
import { BinderSwitcher } from '../src/components/BinderSwitcher'

const parts = () => hubState({ binders: [{ id: 'b1', name: 'First part' }, { id: 'b2', name: 'Second part' }] })

beforeEach(() => { standInHub(parts) })
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('where you are', () => {
  it('names the part you’re in, and all of them when you’re in all of them', async () => {
    await mount(<BinderSwitcher binder="b2" onPick={() => {}} />)
    expect(screen.getAllByText('Second part').length).toBeGreaterThan(0)
    cleanup()
    standInHub(parts)
    await mount(<BinderSwitcher binder="all" onPick={() => {}} />)
    expect(screen.getByText('All 2 parts')).toBeTruthy()
  })

  it('opens the list, picks one, and closes', async () => {
    const onPick = vi.fn()
    await mount(<BinderSwitcher binder="b1" onPick={onPick} />)
    const opener = screen.getByRole('button', { expanded: false })
    act(() => opener.click())
    expect(opener.getAttribute('aria-expanded')).toBe('true')
    fireEvent.click(screen.getByText('Second part'))
    expect(onPick).toHaveBeenCalledWith('b2')
    expect(opener.getAttribute('aria-expanded')).toBe('false')
  })

  it('closes on Escape, and on a click elsewhere', async () => {
    await mount(<BinderSwitcher binder="b1" onPick={() => {}} />)
    const opener = screen.getByRole('button', { expanded: false })
    act(() => opener.click())
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(opener.getAttribute('aria-expanded')).toBe('false')
    act(() => opener.click())
    fireEvent.mouseDown(document.body)
    expect(opener.getAttribute('aria-expanded')).toBe('false')
  })
})
