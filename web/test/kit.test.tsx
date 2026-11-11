// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import axe from 'axe-core'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Plus } from 'lucide-react'
import { DataTable, Dialog, EmptyState, Guided, MenuButton, More, PageHeader, Row, Rows, Section, Skeleton, Status, type Column } from '../src/kit'
import { ContextMenuHost } from '../src/components/ContextMenu'
import { sheetQuery } from '../src/components/bits'
import { KitPage } from '../src/kit/KitPage'
import { Toast } from '../src/components/Toast'

// The kit's pieces on their own: what each draws, how a keyboard and a screen reader get through it, and axe's rules
// on each. jsdom lays nothing out, so how they look is for the pictures of #/kit.

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const violations = async (skip: string[] = []) => {
  const { violations: found } = await axe.run(document.body, { rules: { 'color-contrast': { enabled: false }, ...Object.fromEntries(skip.map((rule) => [rule, { enabled: false }])) } })
  return found.flatMap((v) => v.nodes.map((n) => `${v.id}: ${n.target.join(' ')}`))
}

/** A phone held upright: dialogs are sheets and tables are rows. */
const asPhone = () => vi.stubGlobal('matchMedia', (query: string) => ({ matches: query === sheetQuery, media: query, addEventListener() {}, removeEventListener() {} }))

describe('the page header', () => {
  it('has the title as a heading under the top bar’s, its line, and its one action', async () => {
    render(<main><PageHeader eyebrow="This binder" title="Agents" lead="They take cards from the board." action={<button type="button" className="button primary">Add an agent</button>} /></main>)
    expect(screen.getByRole('heading', { level: 2, name: 'Agents' })).toBeTruthy()
    expect(screen.getByText('They take cards from the board.')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Add an agent' }).closest('.page-action')).toBeTruthy()
    expect(await violations()).toEqual([])
  })
})

describe('a section', () => {
  it('is a region named by its title, with its action, its How this works closed, and one card', async () => {
    render(<main><Section title="Listeners" lead="What comes in from outside." action={<button type="button" className="button small">Add</button>} more={<p>Each thing heard becomes a note.</p>}><p>Inside</p></Section></main>)
    const region = screen.getByRole('region', { name: 'Listeners' })
    expect(within(region).getByRole('heading', { level: 3 }).textContent).toBe('Listeners')
    expect(within(region).getByRole('button', { name: 'Add' })).toBeTruthy()
    const details = region.querySelector('details')!
    expect(details.open).toBe(false)
    expect(within(details).getByText('How this works')).toBeTruthy()
    expect(region.querySelectorAll('.section-card')).toHaveLength(1)
    expect(await violations()).toEqual([])
  })

  it('puts what it holds straight under it with no card when asked', () => {
    render(<Section title="Setup" card={false}><p>Steps</p></Section>)
    expect(document.querySelector('.section-card')).toBeNull()
  })
})

describe('rows', () => {
  const list = (press = vi.fn()) => {
    render(
      <main>
        <Rows label="Listeners">
          <Row title="Support mail" meta="An address to post to" status={<Status tone="ok">On</Status>} onPress={press} />
          <Row title="Team channel" meta="Watching" trailing={<MenuButton label="More for Team channel" items={[{ label: 'Remove', onSelect: () => {} }]} />} onPress={press} />
          <Row title="Docs" href="#/notes/n1" />
          <Row title="Read only" meta="Nothing to press" />
        </Rows>
        <ContextMenuHost />
      </main>,
    )
    return press
  }

  it('makes a row with somewhere to go one button, named by its words, with its own control beside it', async () => {
    const press = list()
    const row = screen.getByRole('button', { name: /^Support mail/ })
    expect(row.textContent).toContain('An address to post to')
    expect(row.querySelector('.rows-chevron')).toBeTruthy()
    row.focus()
    expect(document.activeElement).toBe(row)
    fireEvent.click(row)
    expect(press).toHaveBeenCalledTimes(1)
    // The ⋯ is its own target, outside the row's button.
    const more = screen.getByRole('button', { name: 'More for Team channel' })
    expect(screen.getByRole('button', { name: /^Team channel/ }).contains(more)).toBe(false)
    expect(screen.getByRole('link', { name: 'Docs' }).getAttribute('href')).toBe('#/notes/n1')
    expect(screen.queryByRole('button', { name: /Read only/ })).toBeNull()
    expect(await violations()).toEqual([])
  })
})

describe('a menu button', () => {
  it('opens the app’s menu under it, says it is open, and gives focus back when Escape closes it', async () => {
    const chosen = vi.fn()
    render(<><MenuButton label="More for Support mail" items={[{ label: 'Rename', onSelect: chosen }, { label: 'Delete', danger: true, onSelect: () => {} }]} /><ContextMenuHost /></>)
    const button = screen.getByRole('button', { name: 'More for Support mail' })
    expect(button.getAttribute('aria-haspopup')).toBe('menu')
    expect(button.getAttribute('aria-expanded')).toBe('false')
    button.focus()
    fireEvent.click(button)
    const menu = await screen.findByRole('menu')
    expect(button.getAttribute('aria-expanded')).toBe('true')
    expect(document.activeElement).toBe(within(menu).getByRole('menuitem', { name: 'Rename' }))
    fireEvent.keyDown(window, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(within(menu).getByRole('menuitem', { name: 'Delete' }))
    // A menu is drawn over the page, outside its landmarks, as a dialog is.
    expect(await violations(['region'])).toEqual([])
    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
    expect(button.getAttribute('aria-expanded')).toBe('false')
    expect(document.activeElement).toBe(button)
  })

  it('does what an item says and closes', async () => {
    const chosen = vi.fn()
    render(<><MenuButton label="More" items={() => [{ label: 'Rename', onSelect: chosen }]} /><ContextMenuHost /></>)
    fireEvent.click(screen.getByRole('button', { name: 'More' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Rename' }))
    expect(chosen).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
    expect(screen.getByRole('button', { name: 'More' }).getAttribute('aria-expanded')).toBe('false')
  })
})

interface Repo { name: string; visibility: string; changed: string }
const repos = (n: number): Repo[] => Array.from({ length: n }, (_, i) => ({ name: `acme/repo-${i}`, visibility: i % 2 ? 'Private' : 'Public', changed: `${i % 28 + 1} Nov` }))
const columns: Column<Repo>[] = [
  { key: 'name', header: 'Repo', cell: (r) => r.name, text: (r) => r.name, phone: 'title' },
  { key: 'visibility', header: 'Who sees it', cell: (r) => r.visibility, text: (r) => r.visibility },
  { key: 'changed', header: 'Changed', cell: (r) => r.changed, align: 'end', phone: 'hidden' },
]

describe('a table', () => {
  const table = (rows: Repo[], props: Partial<Parameters<typeof DataTable<Repo>>[0]> = {}) => {
    const press = vi.fn()
    render(<main><DataTable label="Repos" columns={columns} rows={rows} rowKey={(r) => r.name} onRowPress={press} rowLabel={(r) => `Open ${r.name}`} filter="Filter repos" {...props} /></main>)
    return press
  }

  it('is a real table, named, with its column headers, drawing a page of thousands of rows', async () => {
    table(repos(3000))
    const grid = screen.getByRole('table', { name: 'Repos' })
    expect(within(grid).getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['Repo', 'Who sees it', 'Changed', 'Open'])
    expect(within(grid).getAllByRole('row')).toHaveLength(51)
    expect(screen.getByText('50 of 3,000')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Show 50 more' }))
    expect(within(grid).getAllByRole('row')).toHaveLength(101)
    expect(await violations()).toEqual([])
  })

  it('opens a row from its title’s button, or from a click anywhere on it', () => {
    const press = table(repos(3))
    fireEvent.click(screen.getByRole('button', { name: 'Open acme/repo-1' }))
    expect(press).toHaveBeenLastCalledWith(expect.objectContaining({ name: 'acme/repo-1' }))
    fireEvent.click(screen.getByText('2 Nov'))
    expect(press).toHaveBeenCalledTimes(2)
  })

  it('filters every row, not just the page drawn, says how many it shows, and clears', async () => {
    table(repos(3000))
    fireEvent.change(screen.getByRole('searchbox', { name: 'Filter repos' }), { target: { value: 'repo-2999' } })
    await waitFor(() => expect(screen.getAllByRole('row')).toHaveLength(2))
    expect(screen.getByRole('status').textContent).toBe('1 of 3000 shown')
    fireEvent.change(screen.getByRole('searchbox', { name: 'Filter repos' }), { target: { value: 'nothing like it' } })
    expect(await screen.findByText('Nothing matches “nothing like it”')).toBeTruthy()
    fireEvent.click(screen.getAllByRole('button', { name: 'Clear the filter' })[1])
    await waitFor(() => expect(screen.getAllByRole('row')).toHaveLength(51))
  })

  it('shows skeleton rows while loading, and its empty state with no rows', async () => {
    table([], { loading: true })
    expect(screen.getByRole('table').getAttribute('aria-busy')).toBe('true')
    expect(document.querySelectorAll('.skeleton').length).toBeGreaterThan(0)
    cleanup()
    table([], { empty: <EmptyState title="No repos yet" line="Install the app on an organization." /> })
    expect(screen.getByText('No repos yet')).toBeTruthy()
    expect(screen.queryByRole('table')).toBeNull()
  })

  it('is a list of rows on a phone: the title, then the rest in a line, the hidden columns left out', async () => {
    asPhone()
    const press = table(repos(120))
    expect(screen.queryByRole('table')).toBeNull()
    const list = screen.getByRole('list', { name: 'Repos' })
    expect(within(list).getAllByRole('listitem')).toHaveLength(50)
    const first = within(list).getAllByRole('button')[0]
    expect(first.textContent).toContain('acme/repo-0')
    expect(first.textContent).toContain('Public')
    expect(first.textContent).not.toContain('Nov')
    fireEvent.click(first)
    expect(press).toHaveBeenCalledWith(expect.objectContaining({ name: 'acme/repo-0' }))
    expect(await violations()).toEqual([])
  })
})

describe('a dialog', () => {
  function Opener({ footer = false, back }: { footer?: boolean; back?: () => void }) {
    const [open, setOpen] = useState(false)
    return (
      <>
        <button type="button" onClick={() => setOpen(true)}>Open it</button>
        {open && (
          <Dialog title="Support mail" size="small" onClose={() => setOpen(false)} onBack={back} footer={footer ? <><button type="button" className="button">Cancel</button><button type="button" className="button primary">Save</button></> : undefined}>
            <label className="field"><span className="field-label">Name</span><input /></label>
          </Dialog>
        )}
      </>
    )
  }

  it('keeps its old props, takes a footer that stays outside the body, a size and a Back', async () => {
    const back = vi.fn()
    render(<Opener footer back={back} />)
    const opener = screen.getByRole('button', { name: 'Open it' })
    opener.focus()
    fireEvent.click(opener)
    const dialog = screen.getByRole('dialog', { name: 'Support mail' })
    expect(dialog.className).toContain('small')
    expect(dialog.querySelector('.dialog-body')!.contains(within(dialog).getByRole('button', { name: 'Save' }))).toBe(false)
    expect(within(dialog).getByRole('button', { name: 'Save' }).closest('footer')).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Back' }))
    expect(back).toHaveBeenCalled()
    expect(await violations()).toEqual([])
    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(document.activeElement).toBe(opener)
  })

  it('is the same dialog on a phone, drawn as a sheet', async () => {
    asPhone()
    render(<Opener footer />)
    fireEvent.click(screen.getByRole('button', { name: 'Open it' }))
    expect(screen.getByRole('dialog', { name: 'Support mail' }).getAttribute('aria-modal')).toBe('true')
    expect(await violations()).toEqual([])
  })
})

describe('the guided dialog', () => {
  function Add({ onClose = () => {}, start }: { onClose?: () => void; start?: string }) {
    return (
      <Guided title="Add an agent" question="What kind?" onClose={onClose} start={start}
        options={[
          { id: 'machine', icon: <Plus />, name: 'A machine with your code', line: 'It runs where your repos are.', recommended: true },
          { id: 'model', icon: <Plus />, name: 'A model, with no machine', line: 'The hub runs it.' },
        ]}
        steps={(id) => id === 'machine' ? [
          { title: 'Which machine?', content: <p>Pick one</p>, footer: (nav) => <button type="button" className="button primary" onClick={nav.next}>Next</button> },
          { title: 'Run this on it', content: <pre>npx join</pre>, footer: (nav) => <button type="button" className="button primary" onClick={nav.close}>Done</button> },
        ] : [
          { title: 'Which model?', content: <form><label className="field"><span className="field-label">Address</span><input /></label><div className="form-actions"><button type="submit" className="button primary">Add it</button></div></form> },
        ]} />
    )
  }

  it('starts with the choice: its question has focus, each way is a button named by its name and described by its line', async () => {
    render(<Add />)
    const question = screen.getByRole('heading', { name: 'What kind?' })
    expect(document.activeElement).toBe(question)
    const machine = screen.getByRole('button', { name: 'A machine with your code Recommended' })
    expect(machine.getAttribute('aria-describedby')).toBeTruthy()
    expect(document.getElementById(machine.getAttribute('aria-describedby')!)!.textContent).toBe('It runs where your repos are.')
    expect(screen.queryByRole('button', { name: 'Back' })).toBeNull()
    expect(await violations()).toEqual([])
  })

  it('goes through a line of steps with Back, the step’s heading taking focus, and says where it is', async () => {
    const close = vi.fn()
    render(<Add onClose={close} />)
    fireEvent.click(screen.getByRole('button', { name: /^A machine/ }))
    const step = screen.getByRole('heading', { name: 'Which machine?' })
    expect(document.activeElement).toBe(step)
    expect(screen.getByRole('status').textContent).toBe('Step 1 of 2: Which machine?')
    expect(screen.getByText('Step 1 of 2')).toBeTruthy()
    expect(await violations()).toEqual([])
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Run this on it' }))
    expect(screen.getByRole('status').textContent).toBe('Step 2 of 2: Run this on it')
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Which machine?' }))
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'What kind?' }))
    fireEvent.click(screen.getByRole('button', { name: /^A machine/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    fireEvent.click(screen.getByRole('button', { name: 'Done' }))
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('takes a form as a step, with its own buttons and no count for a single step', async () => {
    render(<Add />)
    fireEvent.click(screen.getByRole('button', { name: /^A model/ }))
    expect(screen.getByRole('heading', { name: 'Which model?' })).toBeTruthy()
    expect(screen.queryByText(/Step 1 of/)).toBeNull()
    expect(screen.getByRole('button', { name: 'Add it' })).toBeTruthy()
    expect(await violations()).toEqual([])
  })

  it('closes on Escape and from Close, as a dialog does, on any step', () => {
    const close = vi.fn()
    render(<Add onClose={close} start="machine" />)
    expect(screen.getByRole('heading', { name: 'Which machine?' })).toBeTruthy()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(close).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(close).toHaveBeenCalledTimes(2)
  })
})

describe('the small pieces', () => {
  it('draw an empty state, a status in words, a skeleton hidden from a screen reader, and How this works', async () => {
    render(
      <main>
        <EmptyState title="No agents yet" line="Add one to start." action={<button type="button" className="button">Add an agent</button>} />
        <Status tone="waiting">Waiting on you</Status>
        <Skeleton lines={3} />
        <More><p>The long words.</p></More>
      </main>,
    )
    expect(screen.getByText('No agents yet')).toBeTruthy()
    expect(screen.getByText('Waiting on you').className).toContain('waiting')
    expect(document.querySelector('.skeleton-lines')!.getAttribute('aria-hidden')).toBe('true')
    const summary = screen.getByText('How this works')
    fireEvent.click(summary)
    expect(summary.closest('details')!.open).toBe(true)
    expect(await violations()).toEqual([])
  })
})

describe('the style guide', () => {
  it('shows every piece, and passes axe', async () => {
    render(<main><KitPage /><ContextMenuHost /><Toast /></main>)
    expect(screen.getByRole('heading', { level: 2, name: 'The kit' })).toBeTruthy()
    for (const name of ['Buttons', 'Fields', 'Choices', 'Listeners', 'Repos']) expect(screen.getByRole('region', { name })).toBeTruthy()
    expect(within(screen.getByRole('table', { name: 'Repos' })).getAllByRole('row')).toHaveLength(51)
    expect(await violations()).toEqual([])
    fireEvent.click(screen.getByRole('button', { name: 'The guided dialog' }))
    expect(await screen.findByRole('dialog', { name: 'Add an agent' })).toBeTruthy()
    await act(async () => { await Promise.resolve() })
    expect(await violations()).toEqual([])
  })
})
