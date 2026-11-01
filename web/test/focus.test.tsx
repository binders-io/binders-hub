// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { card, hubState, mount, settle, standInHub } from './harness'
import App from '../src/App'
import { phoneQuery } from '../src/components/bits'
import { ContextMenuHost, openMenu } from '../src/components/ContextMenu'
import { Dialog } from '../src/components/Dialog'
import { Toast, toast } from '../src/components/Toast'

// Where focus goes: someone on a keyboard or a screen reader is wherever it is, so it never gets lost or left behind.

const asPhone = () => vi.stubGlobal('matchMedia', (query: string) => ({ matches: query === phoneQuery, media: query, addEventListener() {}, removeEventListener() {} }))

function WithDialog() {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button onClick={() => setOpen(true)}>Open it</button>
      {open && (
        <Dialog title="A form" onClose={() => setOpen(false)}>
          <input aria-label="Its name" autoFocus />
          <button>Save</button>
        </Dialog>
      )}
    </>
  )
}

const tab = (shiftKey = false) => fireEvent.keyDown(document.activeElement!, { key: 'Tab', shiftKey })

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  window.location.hash = ''
})

describe('a dialog', () => {
  const opened = () => {
    render(<WithDialog />)
    const opener = screen.getByRole('button', { name: 'Open it' })
    opener.focus()
    fireEvent.click(opener)
    return opener
  }

  it('says it’s modal', () => {
    opened()
    expect(screen.getByRole('dialog', { name: 'A form' }).getAttribute('aria-modal')).toBe('true')
  })

  it('keeps a field’s autoFocus', () => {
    opened()
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Its name' }))
  })

  it('takes focus itself when nothing inside asks for it', () => {
    render(<Dialog title="Plain" onClose={() => {}}><button>Save</button></Dialog>)
    expect(document.activeElement).toBe(screen.getByRole('dialog', { name: 'Plain' }))
  })

  it('wraps Tab from its last control to its first', () => {
    opened()
    screen.getByRole('button', { name: 'Save' }).focus()
    tab()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Close' }))
  })

  it('wraps Shift+Tab from its first control to its last', () => {
    opened()
    screen.getByRole('button', { name: 'Close' }).focus()
    tab(true)
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Save' }))
  })

  it('brings Tab back if focus got out', () => {
    opened()
    screen.getByRole('button', { name: 'Open it' }).focus()
    tab()
    expect(screen.getByRole('dialog').contains(document.activeElement)).toBe(true)
  })

  it('gives focus back to what opened it on Escape', async () => {
    const opener = opened()
    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(document.activeElement).toBe(opener)
  })

  it('leaves Tab to the dialog above it', () => {
    render(
      <>
        <Dialog title="Under" onClose={() => {}}><button>Below</button></Dialog>
        <Dialog title="Over" onClose={() => {}}><button>Above</button></Dialog>
      </>,
    )
    const above = screen.getByRole('button', { name: 'Above' })
    above.focus()
    tab(true)
    tab(true)
    expect(screen.getByRole('dialog', { name: 'Over' }).contains(document.activeElement)).toBe(true)
  })
})

describe('a right-click menu', () => {
  const items = (picked: () => void) => [{ label: 'Copy link', onSelect: picked }, { heading: 'Move to' }, { label: 'Done', onSelect: () => {} }]
  const Opener = ({ picked }: { picked: () => void }) => <button onClick={(event) => openMenu(event, items(picked))}>Actions</button>

  const opened = async (picked = () => {}) => {
    render(<><Opener picked={picked} /><ContextMenuHost /></>)
    const opener = screen.getByRole('button', { name: 'Actions' })
    opener.focus()
    fireEvent.click(opener)
    await screen.findByRole('menu')
    return opener
  }

  it('gives focus back on Escape', async () => {
    const opener = await opened()
    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
    expect(document.activeElement).toBe(opener)
  })

  it('gives focus back when an item is chosen, before the item runs, so the item can move it on', async () => {
    let focusedThen: Element | null = null
    const opener = await opened(() => { focusedThen = document.activeElement })
    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy link' }))
    expect(focusedThen).toBe(opener)
  })

  it('keeps its headings out of the items', async () => {
    await opened()
    expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toEqual(['Copy link', 'Done'])
    expect(screen.getByText('Move to').getAttribute('role')).toBe('presentation')
  })
})

describe('a toast', () => {
  it('has its live region in the page before there’s anything to say, or a screen reader may not read it', async () => {
    render(<Toast />)
    const region = screen.getByRole('alert')
    expect(region.textContent).toBe('')
    toast('The hub refused that.')
    await waitFor(() => expect(region.textContent).toBe('The hub refused that.'))
  })

  it('says it once', async () => {
    render(<Toast />)
    toast('The hub refused that.')
    await screen.findAllByText('The hub refused that.')
    const spoken = screen.getAllByText('The hub refused that.').filter((el) => !el.closest('[aria-hidden="true"]'))
    expect(spoken).toHaveLength(1)
  })
})

describe('moving between screens', () => {
  const state = () => hubState({ cards: [card('c1', 'ready', { title: 'Fix the login' }), card('c2', 'blocked', { title: 'Which way?', needsYou: 'Left or right?' })] })
  beforeEach(() => {
    standInHub(state)
  })
  const screenLink = (name: string) => within(screen.getAllByRole('navigation', { name: 'Screens' })[0]).getByRole('link', { name: new RegExp(name) })
  const opened = async () => {
    window.location.hash = '#/home'
    await mount(<App />)
    await settle(50)
  }
  const goTo = async (hash: string) => {
    window.location.hash = hash
    await settle(100)
  }

  it('names the page after the screen', async () => {
    await opened()
    expect(document.title).toBe('Home · Binders Hub')
    await goTo('#/agents')
    await waitFor(() => expect(document.title).toBe('Agents · Binders Hub'))
  })

  it('names the page after the card that’s open', async () => {
    await opened()
    await goTo('#/work/c1')
    await waitFor(() => expect(document.title).toBe('Fix the login · Binders Hub'))
  })

  it('moves focus to the new screen’s heading, not on first opening', async () => {
    await opened()
    expect(document.activeElement).toBe(document.body)
    screenLink('Agents').focus()
    await goTo('#/agents')
    expect(document.activeElement?.textContent).toBe('Agents')
  })

  it('leaves focus in a field the screen already put it in', async () => {
    await opened()
    const field = document.createElement('input')
    document.querySelector('.screen')!.append(field)
    field.focus()
    await goTo('#/agents')
    expect(document.activeElement).not.toBe(screen.getByText('Agents', { selector: '.topbar *' }))
    field.remove()
  })

  it('has one main heading on a card: the card’s', async () => {
    await opened()
    await goTo('#/work/c1')
    await screen.findByRole('heading', { level: 1, name: 'Fix the login' })
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1)
  })

  it('puts focus in the reply box of a card that asks you something', async () => {
    await opened()
    await goTo('#/work/c2')
    await waitFor(() => expect(document.activeElement?.id).toBe('card-reply'))
  })

  it('leaves it alone on a touchscreen, where that opens the keyboard and scrolls past the card’s title', async () => {
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: query === '(hover: none)', media: query, addEventListener() {}, removeEventListener() {} }))
    await opened()
    await goTo('#/work/c2')
    await screen.findByRole('heading', { level: 1, name: 'Which way?' })
    expect(document.activeElement?.id).not.toBe('card-reply')
  })

  it('has one main landmark on a card', async () => {
    await opened()
    await goTo('#/work/c1')
    await screen.findByRole('heading', { level: 1, name: 'Fix the login' })
    expect(screen.getAllByRole('main')).toHaveLength(1)
  })

  it('offers a way past the sidebar first, into the screen', async () => {
    await opened()
    const skip = screen.getByRole('button', { name: 'Skip to the content' })
    expect(skip.compareDocumentPosition(screenLink('Home')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    fireEvent.click(skip)
    expect(document.activeElement).toBe(document.querySelector('.screen'))
    expect(window.location.hash).toBe('#/home')
  })
})

describe('the phone’s menu', () => {
  beforeEach(() => {
    standInHub()
    asPhone()
  })
  const opened = async () => {
    window.location.hash = '#/home'
    await mount(<App />)
    await settle(50)
    const button = screen.getByRole('button', { name: 'Menu' })
    button.focus()
    fireEvent.click(button)
    return button
  }

  it('is a modal dialog, with focus inside and the page behind it out of reach', async () => {
    await opened()
    const menu = screen.getByRole('dialog', { name: 'Menu' })
    expect(menu.getAttribute('aria-modal')).toBe('true')
    expect(document.activeElement).toBe(menu)
    expect(document.querySelector('.main')!.hasAttribute('inert')).toBe(true)
    expect(document.querySelector('.tabbar')!.hasAttribute('inert')).toBe(true)
  })

  it('closes on Escape and gives focus back to its button', async () => {
    const button = await opened()
    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(document.activeElement).toBe(button)
    expect(document.querySelector('.main')!.hasAttribute('inert')).toBe(false)
  })
})
