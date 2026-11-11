// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup } from '@testing-library/react'
import { appCss } from './css'
import { defaultRunner } from '../../shared/work.ts'
import { Agents } from '../src/screens/Agents'
import { agent, hubState, mount, standInHub } from './harness'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

// The line under an agent's name says how it stands, and whose it is when it isn't yours; where it runs and with what is
// the line of facts under what it's doing. jsdom has no layout, so this reads that each piece is its own element and
// what app.css asks of them: whole, wrapping between them, and a separator after a piece, never before one.
describe('the line under an agent’s name', () => {
  const css = appCss()
  const rule = (selector: string) => css.split('\n').filter((line) => line.startsWith(`${selector} {`)).join(' ')

  it('has each piece on its own, with no separator written into the words', async () => {
    standInHub(() => hubState({ agents: [{ ...agent, owner: 'ana', lastSeen: new Date().toISOString(), runner: defaultRunner }] }))
    await mount(<Agents />)
    const pieces = [...document.querySelectorAll('.agent-meta > .agent-piece')].map((p) => p.textContent)
    expect(pieces).toEqual(['Online', '@ana’s'])
    expect(document.querySelector('.agent-meta')!.textContent).not.toContain('·')
    expect([...document.querySelectorAll('.agent-where > span')].map((p) => p.textContent)).toEqual(['Claude Code'])
    expect(document.querySelector('.agent-where')!.textContent).not.toContain('·')
  })

  it('keeps a piece whole, wraps between pieces, and puts the separator after a piece', () => {
    expect(rule('.agent-meta')).toMatch(/display: flex; flex-wrap: wrap/)
    expect(rule('.agent-piece')).toContain('white-space: nowrap')
    expect(rule('.agent-piece:not(:last-child)::after')).toContain('content: "·"')
    expect(rule('.agent-where > span:not(:last-child)::after')).toContain('content: "·"')
  })
})
