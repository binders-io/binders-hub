// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

// The renderer for a view: each part of shared/view.ts drawn as words and marks, never as markup a model wrote. Mermaid is
// stood in for, so a diagram's drawing and its failure can both be shown without loading it.

const mermaid = vi.hoisted(() => ({ draw: vi.fn() }))
vi.mock('../src/editor/blocks', () => ({ draw: (source: string) => mermaid.draw(source) }))

/** A view of one part, or of a stack of them. */
type Part = [type: string, props: Record<string, unknown>]
const view = (...parts: Part[]) => ({
  root: 'all',
  elements: {
    all: { type: 'Stack', props: {}, children: parts.map((_, i) => `p${i}`) },
    ...Object.fromEntries(parts.map(([type, props], i) => [`p${i}`, { type, props, children: [] }])),
  },
})

/** The renderer on a page whose address is this Binder's (/acme/), with the app's store around it. */
async function load() {
  vi.resetModules()
  window.history.pushState({}, '', '/acme/')
  const harness = await import('./harness')
  const { BrainView } = await import('../src/brain/view/BrainView')
  return { ...harness, BrainView }
}

/** Draws a view where there's no store, which is all most parts need. */
async function draw(given: unknown, onAsk?: (question: string) => void) {
  const { BrainView } = await load()
  return render(<BrainView view={given} onAsk={onAsk} />)
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  window.history.pushState({}, '', '/')
  window.location.hash = ''
})

describe('A view drawn from its parts', () => {
  it('puts a Section’s title over its children, and a Row’s children side by side', async () => {
    await draw({
      root: 'sec',
      elements: {
        sec: { type: 'Section', props: { title: 'Where it stands' }, children: ['row'] },
        row: { type: 'Row', props: {}, children: ['a', 'b'] },
        a: { type: 'Stat', props: { label: 'Open', value: '4' }, children: [] },
        b: { type: 'Stat', props: { label: 'Done', value: '9' }, children: [] },
      },
    })
    const section = screen.getByRole('region', { name: 'Where it stands' })
    expect(within(section).getByText('Open')).toBeTruthy()
    expect(within(section).getByText('Done')).toBeTruthy()
    expect(section.querySelector('.view-row')?.children.length).toBe(2)
  })

  it('shows a Text with its bold and its code as elements', async () => {
    const page = await draw(view(['Text', { text: 'Run **this** first, then `npm test`.' }]))
    expect(page.container.querySelector('strong')?.textContent).toBe('this')
    expect(page.container.querySelector('code')?.textContent).toBe('npm test')
    expect(page.container.querySelector('p')?.textContent).toBe('Run this first, then npm test.')
  })

  it('shows markup in a model’s words as the plain text it is', async () => {
    const page = await draw(view(['Text', { text: 'Hi <script>alert(1)</script> and <img src=x onerror=alert(1)> **ok**' }]))
    expect(page.container.querySelector('script')).toBeNull()
    expect(page.container.querySelector('img')).toBeNull()
    expect(page.container.querySelector('p')?.textContent).toBe('Hi <script>alert(1)</script> and <img src=x onerror=alert(1)> ok')
  })

  it('leaves a bold or code mark that is never closed as it was written', async () => {
    const page = await draw(view(['Text', { text: 'Half **open and `half' }]))
    expect(page.container.querySelector('strong')).toBeNull()
    expect(page.container.querySelector('p')?.textContent).toBe('Half **open and `half')
  })

  it('shows a Callout with its title, its words and its tone in words as well as colour', async () => {
    await draw(view(['Callout', { tone: 'warn', title: 'Heads up', text: 'The build is **slow**.' }]))
    const note = screen.getByRole('note')
    expect(note.classList.contains('warn')).toBe(true)
    expect(note.textContent).toContain('Warning: ')
    expect(note.querySelector('svg')).toBeTruthy()
    expect(within(note).getByText('Heads up')).toBeTruthy()
    expect(note.querySelector('strong.view-callout-title + p')?.textContent).toBe('The build is slow.')
  })

  it('shows a Stat’s label, value and detail', async () => {
    await draw(view(['Stat', { label: 'Cards in review', value: '12', detail: 'Two are waiting on you', tone: 'bad' }]))
    expect(screen.getByText('Cards in review')).toBeTruthy()
    expect(screen.getByText('12')).toBeTruthy()
    expect(screen.getByText('Two are waiting on you')).toBeTruthy()
    expect(screen.getByText('Problem:')).toBeTruthy()
  })

  it('shows Facts as a description list', async () => {
    const page = await draw(view(['Facts', { rows: [{ name: 'Owner', value: 'Sam' }, { name: 'Size', value: 'M' }] }]))
    expect([...page.container.querySelectorAll('dt')].map((t) => t.textContent)).toEqual(['Owner', 'Size'])
    expect([...page.container.querySelectorAll('dd')].map((t) => t.textContent)).toEqual(['Sam', 'M'])
  })

  it('shows a List as bullets, or as numbers when it is numbered', async () => {
    const page = await draw({
      root: 'all',
      elements: {
        all: { type: 'Stack', props: {}, children: ['a', 'b'] },
        a: { type: 'List', props: { items: ['One', 'Two'] }, children: [] },
        b: { type: 'List', props: { items: ['First', 'Second'], numbered: true }, children: [] },
      },
    })
    expect([...page.container.querySelectorAll('ul > li')].map((li) => li.textContent)).toEqual(['One', 'Two'])
    expect([...page.container.querySelectorAll('ol > li')].map((li) => li.textContent)).toEqual(['First', 'Second'])
  })

  it('shows each Step as done, now or next in words, in order', async () => {
    const page = await draw(view(['Steps', { items: [{ title: 'Plan', state: 'done' }, { title: 'Build', detail: 'Half way', state: 'now' }, { title: 'Ship', state: 'next' }] }]))
    const steps = [...page.container.querySelectorAll('ol > li')]
    expect(steps.map((li) => li.querySelector('.view-step-title')?.textContent)).toEqual(['Plan, Done', 'Build, Now', 'Ship, Next'])
    expect(steps.every((li) => li.querySelector('svg'))).toBe(true)
    expect(within(steps[1] as HTMLElement).getByText('Half way')).toBeTruthy()
  })

  it('shows a Table with a header for each column, and a short row with empty cells', async () => {
    await draw(view(['Table', { columns: ['Name', 'State', 'Owner'], rows: [['Fix header', 'Done', 'Sam'], ['Add search', 'Open']] }]))
    const table = screen.getByRole('table')
    expect(within(table).getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['Name', 'State', 'Owner'])
    expect(within(table).getAllByRole('columnheader').every((h) => h.getAttribute('scope') === 'col')).toBe(true)
    expect(within(table).getAllByRole('row').map((r) => r.querySelectorAll('td').length)).toEqual([0, 3, 3])
    expect(screen.getByRole('region', { name: 'Table' }).contains(table)).toBe(true)
  })

  it('has a Suggest press ask its question, and shows no more than four', async () => {
    const asked: string[] = []
    await draw(view(['Suggest', { questions: ['What is blocked?', 'Who is free?'] }]), (question) => asked.push(question))
    fireEvent.click(screen.getByRole('button', { name: 'Who is free?' }))
    expect(asked).toEqual(['Who is free?'])
    expect(screen.getAllByRole('button').length).toBe(2)
  })

  it('has a Suggest do nothing when nothing is listening', async () => {
    await draw(view(['Suggest', { questions: ['What is blocked?'] }]))
    expect(() => fireEvent.click(screen.getByRole('button', { name: 'What is blocked?' }))).not.toThrow()
  })
})

describe('A chart', () => {
  const sales = { kind: 'bar', title: 'Sales by day', labels: ['Mon', 'Tue', 'Wed'], series: [{ name: 'Revenue', values: [12, 0, 30] }], unit: 'k' }

  it('has a name that says what it shows, and its numbers in a table of the same', async () => {
    await draw(view(['Chart', sales]))
    const chart = screen.getByRole('img', { name: /Bar chart: Sales by day\. Revenue, 3 values each, from Mon to Wed, in k\./ })
    expect(chart.tagName.toLowerCase()).toBe('svg')
    const table = screen.getByRole('table')
    expect(within(table).getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['Label', 'Revenue'])
    expect(within(table).getAllByRole('row').slice(1).map((r) => r.textContent)).toEqual(['Mon12 k', 'Tue0 k', 'Wed30 k'])
  })

  it('writes the value on each bar, with its unit', async () => {
    const page = await draw(view(['Chart', sales]))
    expect([...page.container.querySelectorAll('svg text.value')].map((t) => t.textContent)).toEqual(['12 k', '0 k', '30 k'])
  })

  it('has a legend when there is more than one series, and none when there is one', async () => {
    const two = { ...sales, kind: 'line', series: [{ name: 'Revenue', values: [1, 2, 3] }, { name: 'Cost', values: [3, 2, 1] }] }
    const page = await draw(view(['Chart', two]))
    expect([...page.container.querySelectorAll('.view-legend li')].map((li) => li.textContent)).toEqual(['Revenue', 'Cost'])
    cleanup()
    const alone = await draw(view(['Chart', sales]))
    expect(alone.container.querySelector('.view-legend')).toBeNull()
  })

  it('uses the shorter length when a series has more or fewer values than there are labels', async () => {
    await draw(view(['Chart', { kind: 'bar', labels: ['A', 'B', 'C'], series: [{ name: 'One', values: [1, 2, 3] }, { name: 'Two', values: [4, 5] }] }]))
    expect(within(screen.getByRole('table')).getAllByRole('row').slice(1).map((r) => r.textContent)).toEqual(['A14', 'B25'])
  })

  it('draws zero, negative and single values without breaking', async () => {
    const page = await draw({
      root: 'all',
      elements: {
        all: { type: 'Stack', props: {}, children: ['zero', 'negative', 'one', 'dot'] },
        zero: { type: 'Chart', props: { kind: 'bar', labels: ['A', 'B'], series: [{ name: 'S', values: [0, 0] }] }, children: [] },
        negative: { type: 'Chart', props: { kind: 'line', labels: ['A', 'B', 'C'], series: [{ name: 'S', values: [-5, 3, -1] }] }, children: [] },
        one: { type: 'Chart', props: { kind: 'line', labels: ['Only'], series: [{ name: 'S', values: [7] }] }, children: [] },
        dot: { type: 'Chart', props: { kind: 'donut', labels: ['A', 'B'], series: [{ name: 'S', values: [0, -2] }] }, children: [] },
      },
    })
    expect(page.container.querySelectorAll('figure').length).toBe(4)
    expect(page.container.querySelectorAll('svg').length).toBe(3)
    expect(screen.getByText('Nothing to draw: no value is above zero.')).toBeTruthy()
    expect(page.container.innerHTML).not.toMatch(/NaN|Infinity/)
  })

  it('draws a donut with each value’s share in its legend', async () => {
    const page = await draw(view(['Chart', { kind: 'donut', title: 'Cards', labels: ['Done', 'Open'], series: [{ name: 'Cards', values: [3, 1] }], unit: 'cards' }]))
    expect(screen.getByRole('img', { name: /Donut chart: Cards/ })).toBeTruthy()
    expect([...page.container.querySelectorAll('.view-legend.share li')].map((li) => li.textContent)).toEqual(['Done3 cards75%', 'Open1 cards25%'])
    expect(page.container.querySelectorAll('svg path.slice').length).toBe(2)
  })
})

describe('A diagram', () => {
  it('shows its title and its source when Mermaid cannot draw it', async () => {
    mermaid.draw.mockRejectedValue(new Error('Parse error'))
    const page = await draw(view(['Diagram', { title: 'How it flows', code: 'flowchart TD\n A --> ' }]))
    await screen.findByText('This drawing couldn’t be drawn.')
    expect(screen.getByText('How it flows')).toBeTruthy()
    expect(page.container.querySelector('pre')?.textContent).toBe('flowchart TD\n A --> ')
  })

  it('puts the drawing in the page when Mermaid draws it, and asks for it with the source', async () => {
    mermaid.draw.mockResolvedValue(document.createRange().createContextualFragment('<svg data-testid="drawn"></svg>'))
    const page = await draw(view(['Diagram', { code: 'flowchart TD\n A --> B' }]))
    await screen.findByTestId('drawn')
    expect(mermaid.draw).toHaveBeenCalledWith('flowchart TD\n A --> B')
    expect(page.container.querySelector('.view-diagram-box.drawn')).toBeTruthy()
    expect(screen.queryByText('Drawing…')).toBeNull()
  })
})

describe('A thing from the board', () => {
  const thing = (props: Record<string, unknown>) => view(['Thing', { kind: 'card', binder: 'acme', id: 'c1', title: 'Title as given', detail: 'Detail as given', ...props }])

  it('shows the live card from the store when it is in this Binder and in the store', async () => {
    const { mount, standInHub, hubState, card, BrainView } = await load()
    standInHub(() => hubState({ cards: [card('c1', 'working', { title: 'Live title', agentId: 'a1', doing: 'Fixing the header' })] }))
    await mount(<BrainView view={thing({})} />)
    const link = await screen.findByRole('link', { name: /Live title/ })
    expect(link.textContent).toContain('Agents working · Agent · Fixing the header')
    expect(screen.queryByText('Title as given')).toBeNull()
    expect(link.getAttribute('href')).toBe('#/work/c1')
  })

  it('shows the title and detail as given when the store does not have it', async () => {
    const { mount, standInHub, hubState, BrainView } = await load()
    standInHub(() => hubState())
    await mount(<BrainView view={thing({ id: 'gone' })} />)
    const link = await screen.findByRole('link', { name: /Title as given/ })
    expect(link.textContent).toContain('Detail as given')
    expect(link.getAttribute('href')).toBe('#/work/gone')
  })

  it('shows the title and detail as given, and links to the other Binder, when it is in another one', async () => {
    const { mount, standInHub, hubState, card, BrainView } = await load()
    standInHub(() => hubState({ cards: [card('c1', 'ready', { title: 'Live title' })] }))
    await mount(<BrainView view={thing({ binder: 'other' })} />)
    const link = await screen.findByRole('link', { name: /Title as given/ })
    expect(screen.queryByText('Live title')).toBeNull()
    expect(link.getAttribute('href')).toBe('/other/#/work/c1')
  })

  it('shows a change set, an environment and an agent from the store', async () => {
    const { mount, standInHub, hubState, agent, BrainView } = await load()
    standInHub(() => hubState({
      agents: [agent],
      changeSets: [{ id: 's1', binderId: 'b1', number: 4, title: 'Search', summary: '', state: 'review', prIds: ['p1', 'p2'], noteIds: [] }],
      environments: [{ id: 'acme/web#prod', repo: 'acme/web', name: 'prod', url: '', version: 'v1.2', changeSetIds: [], state: 'healthy', deployedAt: 'then', needsApproval: false }],
    }))
    await mount(<BrainView view={view(['Thing', { kind: 'set', binder: 'acme', id: 's1', title: 'x' }], ['Thing', { kind: 'env', binder: 'acme', id: 'acme/web#prod', title: 'x' }], ['Thing', { kind: 'agent', binder: 'acme', id: 'a1', title: 'x' }])} />)
    expect((await screen.findByRole('link', { name: /Change set #4: Search/ })).textContent).toContain('In review · 2 pull requests')
    expect(screen.getByRole('link', { name: /acme\/web prod/ }).textContent).toContain('v1.2 · Healthy')
    expect(screen.getByRole('link', { name: /Agent/ }).textContent).toContain('not working on anything')
    expect(screen.queryByText('x')).toBeNull()
  })
})

describe('A view that cannot be shown', () => {
  it('draws nothing when readView rejects it', async () => {
    for (const bad of [undefined, null, 'text', { root: 'x', elements: {} }, { root: 'a', elements: { a: { type: 'Script', props: {}, children: [] } } }, { root: 'a', elements: { a: { type: 'Text', props: { text: 5 }, children: [] } } }]) {
      const page = await draw(bad)
      expect(page.container.innerHTML).toBe('')
      cleanup()
    }
  })

  it('leaves out a part it does not know and draws the rest', async () => {
    const page = await draw({
      root: 'all',
      elements: {
        all: { type: 'Stack', props: {}, children: ['bad', 'good'] },
        bad: { type: 'Script', props: { src: 'x' }, children: [] },
        good: { type: 'Text', props: { text: 'Still here' }, children: [] },
      },
    })
    expect(page.container.textContent).toBe('Still here')
  })
})

describe('An offer in a view', () => {
  const offer = { id: 'offer-1', what: 'Stop 2 cards: “Fix the header”, “Move the database”. They go to Proposed, where nothing picks them up.', button: 'Stop all 2', about: [{ kind: 'card', binder: 'acme', id: 'c-1', title: 'Fix the header', detail: 'In progress · Sonnet' }, { kind: 'card', binder: 'acme', id: 'c-2', title: 'Move the database', detail: 'Blocked · Sonnet' }], more: 3 }

  it('shows what the hub would do, the things it is about, and its button, and says nothing changes until it’s pressed', async () => {
    const { standInHub, mount, BrainView } = await load()
    standInHub()
    await mount(<BrainView view={view(['Offer', offer])} />)
    const card = screen.getByRole('region', { name: 'Stop all 2' })
    expect(within(card).getByText(/^Stop 2 cards: “Fix the header”/)).toBeTruthy()
    expect(within(card).getByRole('link', { name: /Fix the header/ })).toBeTruthy()
    expect(within(card).getByRole('link', { name: /Move the database/ })).toBeTruthy()
    expect(within(card).getByText('and 3 more')).toBeTruthy()
    expect(within(card).getByRole('button', { name: 'Stop all 2' })).toBeTruthy()
    expect(within(card).getByRole('button', { name: 'Not now' })).toBeTruthy()
    expect(within(card).getByText('Nothing changes until you press.')).toBeTruthy()
  })

  it('sends only the offer’s id when its button is pressed, and then says what the hub said in the buttons’ place', async () => {
    const { standInHub, standInRoute, mount, BrainView } = await load()
    standInHub()
    const pressed = standInRoute('POST', '/api/brain/do', () => ({ said: 'Stopped 2 cards. They’re in Proposed.' }))
    await mount(<BrainView view={view(['Offer', offer])} />)
    fireEvent.click(screen.getByRole('button', { name: 'Stop all 2' }))
    expect(await screen.findByText('Stopped 2 cards. They’re in Proposed.')).toBeTruthy()
    expect(pressed).toEqual([{ id: 'offer-1', go: true }])
    expect(screen.queryByRole('button', { name: 'Stop all 2' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Not now' })).toBeNull()
  })

  it('leaves it when Not now is pressed, and says so', async () => {
    const { standInHub, standInRoute, mount, BrainView } = await load()
    standInHub()
    const pressed = standInRoute('POST', '/api/brain/do', () => ({ said: 'All right, I’ve left it.' }))
    await mount(<BrainView view={view(['Offer', offer])} />)
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }))
    expect(await screen.findByText('All right, I’ve left it.')).toBeTruthy()
    expect(pressed).toEqual([{ id: 'offer-1', go: false }])
  })

  it('says a heavy one can’t easily be taken back, and draws one with nothing it’s about', async () => {
    await draw(view(['Offer', { id: 'offer-2', what: 'Approve change set #6. That merges its 14 pull requests as each is ready.', button: 'Approve and merge', heavy: true }]))
    const card = screen.getByRole('region', { name: 'Approve and merge' })
    expect(within(card).getByText('This can’t easily be taken back. Nothing changes until you press.')).toBeTruthy()
    expect(card.querySelector('.view-offer-about')).toBeNull()
  })

  it('draws nothing for an offer with no id or no button: what a model wrote for one never reaches the page as a button', async () => {
    const { container } = await draw(view(['Offer', { do: 'stop', refs: ['c1'] }], ['Text', { text: 'Still here.' }]))
    expect(screen.getByText('Still here.')).toBeTruthy()
    expect(container.querySelector('.view-offer')).toBeNull()
    expect(screen.queryByRole('button')).toBeNull()
  })
})

