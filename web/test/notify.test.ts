import { describe, expect, it, vi } from 'vitest'
import { Notifier, routeOf, sameRows, type NotifyEnv } from '../src/data/notify'
import type { Waiting } from '../../shared/waiting.ts'

// What reaches a tab that isn't in front, against a browser that's stood in for: no real permission is asked.

const row = (id: string, over: Partial<Waiting> = {}): Waiting => ({ id, kind: 'question', for: 'you', about: { type: 'card', id }, binderId: 'b1', title: `Title ${id}`, detail: `Detail ${id}`, since: '2026-11-09T10:00:00.000Z', count: 1, ...over })

function browser(start: { permission?: NotificationPermission | 'unsupported'; remembered?: boolean; hidden?: boolean; answer?: NotificationPermission } = {}) {
  const state = { permission: start.permission ?? 'granted', remembered: start.remembered ?? true, hidden: start.hidden ?? true }
  const shown: { title: string; body: string; tag: string; click: () => void }[] = []
  const badges: number[] = []
  let asked = 0
  const env: NotifyEnv = {
    permission: () => state.permission,
    ask: async () => {
      asked += 1
      state.permission = start.answer ?? 'granted'
      return state.permission
    },
    hidden: () => state.hidden,
    show: (note, click) => { shown.push({ ...note, click }) },
    badge: (count) => { badges.push(count) },
    remembered: () => state.remembered,
    remember: (on) => { state.remembered = on },
  }
  return { env, state, shown, badges, asked: () => asked }
}

describe('what raises a notification', () => {
  it('stays quiet about what was there when the page loaded', () => {
    const b = browser()
    const notifier = new Notifier(b.env)
    notifier.update([row('a'), row('b')], true, () => {})
    expect(b.shown).toEqual([])
  })

  it('tells you of a row for you or for anyone that comes while the page is hidden, with its title and detail', () => {
    const b = browser()
    const notifier = new Notifier(b.env)
    notifier.update([row('a')], true, () => {})
    notifier.update([row('a'), row('b'), row('c', { for: 'anyone' })], true, () => {})
    expect(b.shown.map((n) => [n.title, n.body, n.tag])).toEqual([['Title b', 'Detail b', 'b'], ['Title c', 'Detail c', 'c']])
  })

  it('doesn’t tell you of what’s on others', () => {
    const b = browser()
    const notifier = new Notifier(b.env)
    notifier.update([], true, () => {})
    notifier.update([row('a', { for: 'others' })], true, () => {})
    expect(b.shown).toEqual([])
  })

  it('says nothing while the page is in front, and doesn’t say it later either', () => {
    const b = browser({ hidden: false })
    const notifier = new Notifier(b.env)
    notifier.update([], true, () => {})
    notifier.update([row('a')], true, () => {})
    b.state.hidden = true
    notifier.update([row('a')], true, () => {})
    expect(b.shown).toEqual([])
  })

  it('says it once, and again if it was dealt with and came back', () => {
    const b = browser()
    const notifier = new Notifier(b.env)
    notifier.update([], true, () => {})
    notifier.update([row('a')], true, () => {})
    notifier.update([row('a')], true, () => {})
    expect(b.shown).toHaveLength(1)
    notifier.update([], true, () => {})
    notifier.update([row('a')], true, () => {})
    expect(b.shown).toHaveLength(2)
  })

  it('counts the next look as a first one once the page it was watching is gone', () => {
    const b = browser()
    const notifier = new Notifier(b.env)
    notifier.update([], true, () => {})
    notifier.forget()
    notifier.update([row('a')], true, () => {})
    expect(b.shown).toEqual([])
  })

  it('says nothing until the hub has answered, and counts that first answer as what was there', () => {
    const b = browser()
    const notifier = new Notifier(b.env)
    notifier.update([], false, () => {})
    notifier.update([row('a')], false, () => {})
    expect(b.badges).toEqual([])
    notifier.update([row('a')], true, () => {})
    expect(b.shown).toEqual([])
    expect(b.badges).toEqual([1])
  })

  it('says nothing while the switch is off, or the browser has taken the permission back', () => {
    for (const start of [{ remembered: false }, { permission: 'denied' as const }, { permission: 'default' as const }, { permission: 'unsupported' as const }]) {
      const b = browser(start)
      const notifier = new Notifier(b.env)
      notifier.update([], true, () => {})
      notifier.update([row('a')], true, () => {})
      expect(b.shown).toEqual([])
    }
  })

  it('opens what it’s about when pressed, as the latest look had it', () => {
    const b = browser()
    const notifier = new Notifier(b.env)
    const first = vi.fn()
    const later = vi.fn()
    notifier.update([], true, first)
    notifier.update([row('a')], true, later)
    b.shown[0].click()
    expect(later).toHaveBeenCalledWith(expect.objectContaining({ id: 'a' }))
    expect(first).not.toHaveBeenCalled()
  })

  it('sets the icon’s count to what calls for you, whether or not notifications are on', () => {
    const b = browser({ remembered: false })
    const notifier = new Notifier(b.env)
    notifier.update([row('a'), row('b', { for: 'anyone' }), row('c', { for: 'others' })], true, () => {})
    notifier.update([], true, () => {})
    expect(b.badges).toEqual([2, 0])
  })
})

describe('the switch', () => {
  it('is off until pressed, and pressing it is when the browser is asked', async () => {
    const b = browser({ permission: 'default', remembered: false })
    const notifier = new Notifier(b.env)
    notifier.update([row('a')], true, () => {})
    expect(notifier.status()).toBe('off')
    expect(b.asked()).toBe(0)
    await notifier.turnOn()
    expect(b.asked()).toBe(1)
    expect(notifier.status()).toBe('on')
    expect(b.state.remembered).toBe(true)
  })

  it('stays off when the browser says no, and says why', async () => {
    const b = browser({ permission: 'default', remembered: false, answer: 'denied' })
    const notifier = new Notifier(b.env)
    await notifier.turnOn()
    expect(notifier.status()).toBe('denied')
    expect(b.state.remembered).toBe(false)
  })

  it('doesn’t ask again when the browser has already said yes', async () => {
    const b = browser({ remembered: false })
    const notifier = new Notifier(b.env)
    await notifier.turnOn()
    expect(b.asked()).toBe(0)
    expect(notifier.status()).toBe('on')
  })

  it('turns off, and the browser keeps the choice for next time', () => {
    const b = browser()
    const notifier = new Notifier(b.env)
    expect(notifier.status()).toBe('on')
    notifier.turnOff()
    expect(notifier.status()).toBe('off')
    expect(b.state.remembered).toBe(false)
  })

  it('tells a switch on screen when it changes', async () => {
    const b = browser({ remembered: false })
    const notifier = new Notifier(b.env)
    const heard = vi.fn()
    const stop = notifier.subscribe(heard)
    await notifier.turnOn()
    notifier.turnOff()
    stop()
    await notifier.turnOn()
    expect(heard).toHaveBeenCalledTimes(2)
  })

  it('is unsupported where the browser has no notifications', () => {
    expect(new Notifier(browser({ permission: 'unsupported' }).env).status()).toBe('unsupported')
  })
})

describe('where a row leads', () => {
  it('goes to the card, change set, note or delivery it’s about', () => {
    expect(routeOf(row('c1'))).toEqual({ screen: 'work', id: 'c1' })
    expect(routeOf(row('s1', { about: { type: 'changeSet', id: 's1' } }))).toEqual({ screen: 'changes', id: 's1' })
    expect(routeOf(row('n1', { about: { type: 'note', id: 'n1' } }))).toEqual({ screen: 'notes', id: 'n1' })
    expect(routeOf(row('e1', { about: { type: 'environment', id: 'e1' } }))).toEqual({ screen: 'delivery' })
  })
})

describe('telling two lists of rows apart', () => {
  it('is alike when each row says the same, even in new objects', () => {
    expect(sameRows([row('a')], [row('a')])).toBe(true)
    expect(sameRows([row('a')], [row('a', { detail: 'More' })])).toBe(false)
    expect(sameRows([row('a')], [row('a'), row('b')])).toBe(false)
  })
})
