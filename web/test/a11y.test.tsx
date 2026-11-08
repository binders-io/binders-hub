// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import axe from 'axe-core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { card, hubState, me, mount, note, settle, standInHub } from './harness'
import App from '../src/App'
import { phoneQuery } from '../src/components/bits'

// Every screen against axe's rules, and every text tone against every surface it sits on. Contrast has its own test:
// jsdom lays nothing out, so axe can't see it.

const state = () => hubState({
  notes: [note('n1', '# A note\n\nIts words.')],
  cards: [card('c1', 'ready', { title: 'Fix the login' }), card('c2', 'working', { title: 'Being built', agentId: 'a1', progress: 0.4, doing: 'Reading' }), card('c3', 'blocked', { title: 'Which way?', needsYou: 'Left or right?' })],
})

const app = { name: 'Binder', slug: 'binder', owner: 'team', ownerType: 'Organization', htmlUrl: '', installations: [] }

const violations = async () => {
  const { violations: found } = await axe.run(document.body, { rules: { 'color-contrast': { enabled: false } } })
  return found.flatMap((v) => v.nodes.map((n) => `${v.id}: ${n.target.join(' ')}`))
}

const open = async (hash: string) => {
  window.location.hash = hash
  await mount(<App />)
  await settle(200)
}

beforeEach(() => {
  standInHub(state)
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  window.location.hash = ''
})

describe('axe', () => {
  it.each(['#/home', '#/flow', '#/notes/n1', '#/changes', '#/delivery', '#/agents', '#/settings', '#/account', '#/work/c3'])('finds nothing on %s', async (hash) => {
    await open(hash)
    expect(await violations()).toEqual([])
  })

  it('finds nothing in the palette', async () => {
    await open('#/home')
    fireEvent.keyDown(window, { key: 'k', metaKey: true })
    await screen.findByRole('combobox')
    expect(await violations()).toEqual([])
  })

  it('finds nothing in the Claude Code dialog, which has the command with the hub in it', async () => {
    await open('#/home')
    fireEvent.click(screen.getByRole('button', { name: 'Add to Claude Code' }))
    const dialog = await screen.findByRole('dialog', { name: 'Add the hub to Claude Code' })
    expect(dialog.querySelector('pre')?.textContent).toBe(`claude mcp add --transport http --scope user binders-hub ${window.location.origin}/mcp`)
    expect(await violations()).toEqual([])
  })

  it('finds nothing with the GitHub pill up', async () => {
    standInHub(state, { ...me, github: { app, token: false } })
    await open('#/home')
    const pill = screen.getByRole('link', { name: 'GitHub not connected' })
    expect(pill.getAttribute('href')).toContain('account')
    expect(screen.getByRole('link', { name: 'Your account' }).className).toContain('unlinked')
    expect(await violations()).toEqual([])
  })

  it('shows no GitHub pill once you’re connected, or with no app to connect to', async () => {
    standInHub(state, { ...me, github: { app, token: true } })
    await open('#/home')
    expect(screen.queryByRole('link', { name: 'GitHub not connected' })).toBeNull()
    cleanup()
    standInHub(state)
    await open('#/home')
    expect(screen.queryByRole('link', { name: 'GitHub not connected' })).toBeNull()
  })
})

describe('the palette', () => {
  const opened = async () => {
    await open('#/home')
    fireEvent.keyDown(window, { key: 'k', metaKey: true })
    return screen.findByRole('combobox', { name: 'Search or ask your binders' })
  }

  /** A hub whose search finds this passage, and which records what it was asked. */
  const answering = () => {
    const stand = vi.mocked(fetch).getMockImplementation()!
    const asked: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })
      if (url === '/api/brain/search') return json({ sources: [{ n: 1, kind: 'note', id: 'n1', title: 'A note', text: '# Heading\n\nWords that mean the same.' }], searchedBy: 'words and meaning' })
      if (url === '/api/brain/ask') {
        asked.push((JSON.parse(String(init?.body)) as { question: string }).question)
        return json({ sources: [], searchedBy: 'words' })
      }
      return stand(url, init)
    }))
    return asked
  }

  it('finds passages by what they mean, with their words under the title', async () => {
    answering()
    const box = await opened()
    fireEvent.change(box, { target: { value: 'same meaning' } })
    const option = await screen.findByRole('option', { name: /Words that mean the same/ })
    expect(option.textContent).toContain('A note')
    expect(option.textContent).not.toContain('#')
    expect(await violations()).toEqual([])
  })

  it('puts Ask first for a question, and Enter asks it on the Ask screen', async () => {
    const asked = answering()
    const box = await opened()
    fireEvent.change(box, { target: { value: 'why did we pick Redis?' } })
    expect((await screen.findAllByRole('option'))[0].textContent).toContain('Ask: why did we pick Redis?')
    fireEvent.keyDown(box, { key: 'Enter' })
    await waitFor(() => expect(asked).toEqual(['why did we pick Redis?']))
    expect(window.location.hash).toBe('#/ask')
  })

  it('keeps a title first for words that aren’t a question', async () => {
    answering()
    const box = await opened()
    fireEvent.change(box, { target: { value: 'login' } })
    const options = await screen.findAllByRole('option')
    expect(options[0].textContent).toContain('Fix the login')
    expect(options.some((o) => o.textContent?.includes('Ask: login'))).toBe(true)
  })

  it('says which option is chosen while focus stays in the box', async () => {
    const box = await opened()
    expect(document.activeElement).toBe(box)
    const chosen = () => document.getElementById(box.getAttribute('aria-activedescendant')!)
    expect(chosen()?.getAttribute('aria-selected')).toBe('true')
    const first = chosen()
    fireEvent.keyDown(box, { key: 'ArrowDown' })
    expect(chosen()).not.toBe(first)
    expect(chosen()?.getAttribute('aria-selected')).toBe('true')
  })

  it('groups its options under their names', async () => {
    await opened()
    expect(within(screen.getByRole('listbox')).getByRole('group', { name: 'Go to' })).toBeTruthy()
  })

  it('points the box at its list', async () => {
    const box = await opened()
    expect(box.getAttribute('aria-controls')).toBe(screen.getByRole('listbox').id)
    expect(box.getAttribute('aria-expanded')).toBe('true')
  })

  it('says how many it found, and offers to ask when no title matches', async () => {
    const box = await opened()
    fireEvent.change(box, { target: { value: 'nothing like this' } })
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('1 result'))
    expect(screen.getByRole('option').textContent).toContain('Ask: nothing like this')
    expect(box.getAttribute('aria-activedescendant')).toBe('palette-option-0')
  })

  it('closes on Escape', async () => {
    await opened()
    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('combobox')).toBeNull())
  })
})

describe('on a phone', () => {
  it('has search in the top bar, as the sidebar is behind a menu', async () => {
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: query === phoneQuery, media: query, addEventListener() {}, removeEventListener() {} }))
    await open('#/home')
    fireEvent.click(within(document.querySelector('.topbar') as HTMLElement).getByRole('button', { name: 'Search or ask' }))
    expect(await screen.findByRole('combobox')).toBeTruthy()
  })
})

describe('text contrast', () => {
  const css = readFileSync(join(import.meta.dirname, '../src/index.css'), 'utf8')
  const block = (start: string) => {
    const from = css.indexOf(start)
    return Object.fromEntries([...css.slice(from, css.indexOf('\n}', from)).matchAll(/--([\w-]+):\s*(#[0-9a-f]{3,6})\b/gi)].map(([, name, value]) => [name, value]))
  }
  const dark = block(':root {')
  const light = { ...dark, ...block(':root[data-theme="light"] {') }

  const luminance = (hex: string) => {
    const channels = hex.slice(1).match(/../g)!.map((pair) => parseInt(pair, 16) / 255)
    const [r, g, b] = channels.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
    return 0.2126 * r + 0.7152 * g + 0.0722 * b
  }
  const contrast = (a: string, b: string) => {
    const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x)
    return (high + 0.05) / (low + 0.05)
  }
  const failing = (theme: Record<string, string>) => ['text', 'text-2', 'muted', 'faint'].flatMap((tone) =>
    ['bg', 'bg-raised', 'surface', 'surface-2', 'surface-3', 'pop-solid', 'column'].filter((surface) => theme[surface] && theme[tone] && contrast(theme[tone], theme[surface]) < 4.5).map((surface) => `${tone} on ${surface}: ${contrast(theme[tone], theme[surface]).toFixed(2)}`))

  it('reads the themes it’s checking', () => {
    expect(dark.faint).toBeTruthy()
    expect(light.faint).not.toBe(dark.faint)
  })

  it('keeps 4.5:1 on every surface in the dark theme', () => expect(failing(dark)).toEqual([]))
  it('keeps 4.5:1 on every surface in the light theme', () => expect(failing(light)).toEqual([]))
})
