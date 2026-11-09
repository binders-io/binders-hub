// @vitest-environment jsdom
import { useState } from 'react'
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { hubState, mount, settle, standInHub, standInRepos } from './harness'
import { Dialog } from '../src/components/Dialog'
import { RepoInput, leftOut } from '../src/components/RepoInput'

// As the hub gives them: one you can link, one GitHub will be asked about, one you can't.
const web = { fullName: 'acme/web', private: false, description: 'The site', topics: ['frontend'], properties: {}, linkable: true }
const api = { fullName: 'acme/api', private: true, topics: ['backend'], properties: { team: ['payments'] }, linkable: true }
const maybe = { fullName: 'acme/maybe', private: false, topics: ['backend'], properties: {} }
const docs = { fullName: 'acme/docs', private: false, topics: ['backend'], properties: {}, linkable: false, why: 'You can only read it, so it can’t be linked' }

const filters = {
  topics: [{ name: 'backend', count: 3 }, { name: 'frontend', count: 1 }],
  properties: [{ name: 'team', values: [{ value: 'payments', count: 1 }] }],
}

const answer = (repos: unknown[], over: object = {}) => ({ repos, total: repos.length, more: 0, topics: [], properties: [], failed: false, ...over })

function Picker({ single = false, start = [], within, binders }: { single?: boolean; start?: string[]; within?: string[]; binders?: string[] }) {
  const [value, setValue] = useState(start)
  return (
    <>
      <label htmlFor="repos">Repos</label>
      <RepoInput id="repos" single={single} value={value} within={within} binders={binders} onChange={setValue} />
      <p data-testid="chosen">{value.join(' ')}</p>
      <button>Elsewhere</button>
    </>
  )
}

const box = () => screen.getByRole<HTMLInputElement>('combobox', { name: 'Repos' })
const chosen = () => screen.getByTestId('chosen').textContent
const focusBox = () => act(() => box().focus())
const type = (text: string) => fireEvent.change(box(), { target: { value: text } })
const key = (name: string) => fireEvent.keyDown(box(), { key: name })
const choose = (label: string, value: string) => fireEvent.change(screen.getByRole('combobox', { name: label }), { target: { value } })

async function open(repos: (query: URLSearchParams) => unknown, picker = <Picker />, refuse: Record<string, string> = {}) {
  standInHub(() => hubState())
  const asked = standInRepos(repos, refuse)
  await mount(picker)
  focusBox()
  await settle(200)
  return asked
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('the list of repos', () => {
  it('shows what the hub found, and says why one can’t be linked', async () => {
    await open(() => answer([web, docs]))
    expect(screen.getByRole('option', { name: /acme\/web/ })).toBeTruthy()
    expect(screen.getByRole('option', { name: /acme\/docs/ }).textContent).toContain('You can only read it')
    expect(screen.getByRole('option', { name: /acme\/docs/ }).getAttribute('aria-disabled')).toBe('true')
    expect(screen.getByRole('option', { name: /acme\/web/ }).getAttribute('aria-disabled')).toBeNull()
  })

  it('leaves out what’s chosen already, whatever its case', async () => {
    await open(() => answer([web, api]), <Picker start={['ACME/web']} />)
    expect(screen.queryByRole('option', { name: /acme\/web/ })).toBeNull()
    expect(screen.getByRole('option', { name: /acme\/api/ })).toBeTruthy()
  })

  it('says when nothing matches', async () => {
    await open(() => answer([]))
    type('nothing')
    await settle(200)
    expect(screen.getByRole('status').textContent).toContain('nothing')
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('says it’s looking until the hub answers', async () => {
    let answered: (body: unknown) => void = () => {}
    await open(() => new Promise((done) => { answered = done }))
    expect(screen.getByRole('status').textContent).toMatch(/looking/i)
    await act(async () => { answered(answer([web])) })
    await screen.findByRole('option', { name: /acme\/web/ })
  })

  it('says how many it left out', async () => {
    await open(() => answer([web], { total: 812, more: 811 }))
    expect(screen.getByRole('status').textContent).toContain('812')
  })

  it('works with a hub that sends only repos', async () => {
    await open(() => ({ repos: [{ fullName: 'acme/web', private: false }], more: 0 }))
    expect(screen.getByRole('option', { name: /acme\/web/ })).toBeTruthy()
    expect(screen.queryByRole('combobox', { name: 'Filter by topic' })).toBeNull()
  })

  it('shows the answer to what’s typed now, though an older one arrives later', async () => {
    let older: (body: unknown) => void = () => {}
    await open((query) => (query.get('q') === 'old' ? new Promise((done) => { older = done }) : answer([web])))
    type('old')
    await settle(200)
    type('new')
    await screen.findByRole('option', { name: /acme\/web/ })
    await act(async () => { older(answer([api])) })
    await settle(20)
    expect(screen.queryByRole('option', { name: /acme\/api/ })).toBeNull()
    expect(screen.getByRole('option', { name: /acme\/web/ })).toBeTruthy()
  })
})

describe('when GitHub or the hub doesn’t answer', () => {
  it('says so when GitHub cut the list short, and keeps what it gave', async () => {
    await open(() => answer([web], { failed: true }))
    expect(screen.getByRole('status').textContent).toMatch(/didn’t answer/)
    expect(screen.getByRole('option', { name: /acme\/web/ })).toBeTruthy()
  })

  it('says so when the hub fails', async () => {
    await open(() => new Error('The hub is down'))
    expect(screen.getByRole('status').textContent).toMatch(/didn’t answer/)
  })

  it('offers to create what’s typed only when it could tell the name is free', async () => {
    let fails = true
    await open(() => (fails ? answer([], { failed: true }) : answer([])))
    type('billing')
    await settle(200)
    expect(screen.queryByRole('button', { name: /Create/ })).toBeNull()
    fails = false
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByRole('button', { name: /Create/ })).toBeTruthy()
  })

  it('asks again when told to try again', async () => {
    let fails = true
    await open(() => (fails ? answer([], { failed: true }) : answer([web])))
    fails = false
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await screen.findByRole('option', { name: /acme\/web/ })
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull()
  })
})

describe('picking a repo', () => {
  it('picks one by clicking', async () => {
    await open(() => answer([web, api]))
    fireEvent.mouseDown(screen.getByRole('option', { name: /acme\/api/ }))
    expect(chosen()).toBe('acme/api')
  })

  it('won’t pick one that can’t be linked, by clicking or Enter', async () => {
    await open(() => answer([docs]))
    fireEvent.mouseDown(screen.getByRole('option', { name: /acme\/docs/ }))
    key('Enter')
    expect(chosen()).toBe('')
  })

  it('picks one GitHub will be asked about', async () => {
    await open(() => answer([maybe]))
    fireEvent.mouseDown(screen.getByRole('option', { name: /acme\/maybe/ }))
    expect(chosen()).toBe('acme/maybe')
  })

  it('moves through the list with the arrow keys and picks with Enter', async () => {
    await open(() => answer([web, api]))
    expect(box().getAttribute('aria-activedescendant')).toBe(screen.getByRole('option', { name: /acme\/web/ }).id)
    key('ArrowDown')
    expect(box().getAttribute('aria-activedescendant')).toBe(screen.getByRole('option', { name: /acme\/api/ }).id)
    expect(screen.getByRole('option', { name: /acme\/api/ }).getAttribute('aria-selected')).toBe('true')
    key('Enter')
    expect(chosen()).toBe('acme/api')
  })

  it('takes a name GitHub doesn’t list, typed in whole', async () => {
    await open(() => answer([]))
    type('https://github.com/other/thing.git')
    key('Enter')
    expect(chosen()).toBe('other/thing')
  })

  it('takes the best match for what was typed faster than the hub answered, if it can be linked', async () => {
    await open((query) => (query.get('q') === 'docs' ? answer([docs, api]) : answer([])))
    type('docs')
    key('Enter')
    await waitFor(() => expect(chosen()).toBe('acme/api'))
  })

  it('keeps one for a binder, and offers no list once it has it', async () => {
    await open(() => answer([web, api]), <Picker single />)
    fireEvent.mouseDown(screen.getByRole('option', { name: /acme\/web/ }))
    expect(chosen()).toBe('acme/web')
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(screen.queryByRole('combobox', { name: 'Repos' })).toBeNull()
  })

  it('adds a repo only once, whatever its case', async () => {
    await open(() => answer([]), <Picker start={['acme/web']} />)
    type('ACME/WEB')
    key('Enter')
    expect(chosen()).toBe('acme/web')
  })
})

describe('opening the list', () => {
  it('brings it into view once there’s something in it, as a field low in a form opens past the fold', async () => {
    const shown: Element[] = []
    Element.prototype.scrollIntoView = function scrollIntoView() { shown.push(this) }
    await open(() => answer([web, api]))
    delete (Element.prototype as Partial<Element>).scrollIntoView
    expect(shown.at(-1)?.contains(screen.getByRole('listbox'))).toBe(true)
  })
})

describe('closing the list', () => {
  it('closes on Escape, and not the form around it', async () => {
    function Form() {
      const [shown, setShown] = useState(true)
      return shown ? <Dialog title="A form" onClose={() => setShown(false)}><Picker /></Dialog> : <p>Closed</p>
    }
    await open(() => answer([web]), <Form />)
    await screen.findByRole('option', { name: /acme\/web/ })
    key('Escape')
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(screen.queryByText('Closed')).toBeNull()
    key('Escape')
    await screen.findByText('Closed')
  })

  it('opens again on the arrow keys', async () => {
    await open(() => answer([web]))
    key('Escape')
    key('ArrowDown')
    expect(screen.getByRole('option', { name: /acme\/web/ })).toBeTruthy()
  })

  it('closes on a press elsewhere', async () => {
    await open(() => answer([web]))
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Elsewhere' }))
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('stays open when focus moves to a filter', async () => {
    await open(() => answer([web], filters))
    act(() => screen.getByRole('combobox', { name: 'Filter by topic' }).focus())
    expect(screen.getByRole('listbox')).toBeTruthy()
  })

  it('closes when focus moves past it', async () => {
    await open(() => answer([web]))
    act(() => screen.getByRole('button', { name: 'Elsewhere' }).focus())
    expect(screen.queryByRole('listbox')).toBeNull()
  })
})

describe('filtering by topic and custom property', () => {
  it('asks the hub for a topic', async () => {
    const asked = await open((query) => (query.get('topic') === 'backend' ? answer([api], filters) : answer([web, api], filters)))
    choose('Filter by topic', 'backend')
    await waitFor(() => expect(screen.queryByRole('option', { name: /acme\/web/ })).toBeNull())
    expect(asked.at(-1)?.get('topic')).toBe('backend')
  })

  it('asks the hub for a property and its value', async () => {
    const asked = await open(() => answer([web, api], filters))
    choose('Filter by custom property', JSON.stringify(['team', 'payments']))
    await waitFor(() => expect(asked.at(-1)?.get('property')).toBe('team'))
    expect(asked.at(-1)?.get('value')).toBe('payments')
  })

  it('says how many each choice gives', async () => {
    await open(() => answer([web], filters))
    expect(screen.getByRole('option', { name: 'backend (3)' })).toBeTruthy()
    expect(screen.getByRole('option', { name: 'team: payments (1)' })).toBeTruthy()
  })

  it('names the property in the choice, so a value like 1 says what it’s of once chosen', async () => {
    await open(() => answer([web], { properties: [{ name: 'tier', values: [{ value: '1', count: 2 }] }] }))
    const filter = screen.getByRole<HTMLSelectElement>('combobox', { name: 'Filter by custom property' })
    choose('Filter by custom property', JSON.stringify(['tier', '1']))
    expect(filter.selectedOptions[0].textContent).toBe('tier: 1 (2)')
  })

  it('takes the filter off again', async () => {
    const asked = await open(() => answer([web], filters))
    choose('Filter by topic', 'backend')
    await waitFor(() => expect(asked.at(-1)?.get('topic')).toBe('backend'))
    choose('Filter by topic', '')
    await waitFor(() => expect(asked.at(-1)?.get('topic')).toBeNull())
  })

  it('opens the list when a filter is chosen', async () => {
    await open(() => answer([web], filters))
    key('Escape')
    choose('Filter by topic', 'backend')
    await screen.findByRole('option', { name: /acme\/web/ })
  })

  it('says when nothing matches the filters', async () => {
    await open((query) => (query.get('topic') ? answer([], { topics: [{ name: 'backend', count: 0 }] }) : answer([web], filters)))
    choose('Filter by topic', 'backend')
    await waitFor(() => expect(screen.getByRole('status').textContent).toMatch(/filter/))
  })

  it('offers no filters for repos with no topics or properties', async () => {
    await open(() => answer([web]))
    expect(screen.queryByRole('combobox', { name: 'Filter by topic' })).toBeNull()
    expect(screen.queryByRole('combobox', { name: 'Filter by custom property' })).toBeNull()
  })

  it('offers only the filter there’s something to choose in', async () => {
    await open(() => answer([web], { topics: filters.topics }))
    expect(screen.getByRole('combobox', { name: 'Filter by topic' })).toBeTruthy()
    expect(screen.queryByRole('combobox', { name: 'Filter by custom property' })).toBeNull()
  })
})

describe('adding every match', () => {
  const matching = (query: URLSearchParams) => (query.get('topic') ? answer([web, api, maybe, docs], filters) : answer([web], filters))

  it('adds every match not known to be refused, once GitHub says each can be linked', async () => {
    const asked = await open(matching)
    choose('Filter by topic', 'backend')
    fireEvent.click(await screen.findByRole('button', { name: 'Add all 3' }))
    await waitFor(() => expect(chosen()).toBe('acme/web acme/api acme/maybe'))
    expect(asked.checked).toEqual([['acme/web', 'acme/api', 'acme/maybe']])
  })

  it('leaves out what GitHub won’t let be linked, and says which and why', async () => {
    await open(matching, <Picker />, { 'acme/maybe': 'you can only read it' })
    choose('Filter by topic', 'backend')
    fireEvent.click(await screen.findByRole('button', { name: 'Add all 3' }))
    await waitFor(() => expect(chosen()).toBe('acme/web acme/api'))
  })

  it('says what it left out in a few words, a few named', () => {
    expect(leftOut(2, [{ repo: 'acme/maybe', why: 'you can only read it' }])).toBe('Added 2. Left out acme/maybe: you can only read it.')
    const four = ['a', 'b', 'c', 'd'].map((n) => ({ repo: `acme/${n}`, why: 'you can only read it' }))
    expect(leftOut(0, four)).toBe('Added 0. Left out acme/a, acme/b, acme/c and 1 more: you can only read them.')
    expect(leftOut(1, [four[0], { repo: 'acme/e', why: 'GitHub doesn’t let you reach it' }])).toBe('Added 1. Left out acme/a, acme/e: GitHub said no to each.')
  })

  it('counts past what’s chosen already, and keeps it', async () => {
    await open(matching, <Picker start={['acme/web', 'acme/other']} />)
    choose('Filter by topic', 'backend')
    fireEvent.click(await screen.findByRole('button', { name: 'Add all 2' }))
    await waitFor(() => expect(chosen()).toBe('acme/web acme/other acme/api acme/maybe'))
  })

  it('puts focus back in the field, as the button goes', async () => {
    await open(matching)
    choose('Filter by topic', 'backend')
    fireEvent.click(await screen.findByRole('button', { name: 'Add all 3' }))
    await waitFor(() => expect(chosen()).toBe('acme/web acme/api acme/maybe'))
    expect(document.activeElement).toBe(box())
  })

  it('isn’t offered without a filter', async () => {
    await open(() => answer([web, api], filters))
    expect(screen.queryByRole('button', { name: /Add all/ })).toBeNull()
  })

  it('isn’t offered for a binder, which keeps one repo', async () => {
    const asked = await open(matching, <Picker single />)
    choose('Filter by topic', 'backend')
    await waitFor(() => expect(asked.at(-1)?.get('topic')).toBe('backend'))
    await settle(20)
    expect(screen.queryByRole('button', { name: /Add all/ })).toBeNull()
  })

  it('asks for a narrower filter past two hundred', async () => {
    const many = Array.from({ length: 201 }, (_, n) => ({ ...web, fullName: `acme/r${n}` }))
    await open((query) => (query.get('topic') ? answer(many, filters) : answer([web], filters)))
    choose('Filter by topic', 'backend')
    await screen.findByText(/narrow/i)
    expect(screen.queryByRole('button', { name: /Add all/ })).toBeNull()
  })

  it('takes two hundred', async () => {
    const many = Array.from({ length: 200 }, (_, n) => ({ ...web, fullName: `acme/r${n}` }))
    await open((query) => (query.get('topic') ? answer(many, filters) : answer([web], filters)))
    choose('Filter by topic', 'backend')
    expect(await screen.findByRole('button', { name: 'Add all 200' })).toBeTruthy()
  })
})

describe('an agent’s repos, among its binder’s', () => {
  it('asks the hub for its binders’ repos, filters and all', async () => {
    const asked = await open(() => answer([api], filters), <Picker within={['acme/api', 'acme/web']} binders={['b1']} />)
    expect(asked.at(-1)?.get('binders')).toBe('b1')
    expect(screen.getByRole('option', { name: /acme\/api/ })).toBeTruthy()
    expect(screen.getByRole('combobox', { name: 'Filter by topic' })).toBeTruthy()
  })

  it('asks for every binder’s, for an agent in them all', async () => {
    const asked = await open(() => answer([api]), <Picker within={['acme/api']} />)
    expect(asked.at(-1)?.get('binders')).toBe('*')
  })

  it('picks among them by name when the hub can’t answer', async () => {
    await open(() => new Error('The hub is down'), <Picker within={['acme/api', 'acme/web']} binders={['b1']} />)
    type('web')
    await settle(200)
    fireEvent.mouseDown(screen.getByRole('option', { name: /acme\/web/ }))
    expect(chosen()).toBe('acme/web')
  })

  it('takes nothing outside them, typed or not', async () => {
    await open(() => answer([]), <Picker within={['acme/api']} binders={['b1']} />)
    type('acme/other')
    key('Enter')
    expect(chosen()).toBe('')
    expect(screen.queryByRole('button', { name: /Create/ })).toBeNull()
  })
})

describe('who the list is for', () => {
  it('asks for a binder’s repos as a binder’s', async () => {
    const asked = await open(() => answer([web]), <Picker single />)
    expect(asked.at(-1)?.get('for')).toBe('binder')
  })

  it('asks for an agent’s repos as an agent’s', async () => {
    const asked = await open(() => answer([web]))
    expect(asked.at(-1)?.get('for')).toBeNull()
  })
})

describe('many chosen repos', () => {
  const many = Array.from({ length: 15 }, (_, n) => `acme/r${n}`)
  const chips = () => screen.queryAllByRole('button', { name: /^Remove acme/ }).length

  it('shows a few, and the rest when asked', async () => {
    await open(() => answer([]), <Picker start={many} />)
    expect(chips()).toBe(12)
    fireEvent.click(screen.getByRole('button', { name: 'Show all 15' }))
    expect(chips()).toBe(15)
    fireEvent.click(screen.getByRole('button', { name: 'Show fewer' }))
    expect(chips()).toBe(12)
  })

  it('removes them all together', async () => {
    await open(() => answer([]), <Picker start={many} />)
    fireEvent.click(screen.getByRole('button', { name: 'Remove all' }))
    expect(chosen()).toBe('')
  })

  it('won’t remove a hidden one with Backspace', async () => {
    await open(() => answer([]), <Picker start={many} />)
    key('Backspace')
    expect(chosen()).toBe(many.join(' '))
  })

  it('removes the last one with Backspace when they all show', async () => {
    await open(() => answer([]), <Picker start={['acme/a', 'acme/b']} />)
    key('Backspace')
    expect(chosen()).toBe('acme/a')
  })
})
