import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Actions } from '../src/actions.ts'
import { Hub } from '../src/hub.ts'
import { MemoryKV } from '../src/kv.ts'
import { MemoryLog } from '../src/log.ts'
import { Spaces, personalId, type Space } from '../src/spaces.ts'
import { Webhooks } from '../src/webhooks.ts'

describe('personal Binders', () => {
  it('makes one per person, theirs alone, reaching GitHub through its home Binder', async () => {
    const made: { id: string; home?: string }[] = []
    const make = async (id: string, info: { home?: string }): Promise<Space> => {
      made.push({ id, home: info.home })
      const hub = new Hub(new MemoryLog())
      await hub.start()
      const actions = new Actions(hub, undefined as never)
      return { id, hub, actions, webhooks: new Webhooks(hub, actions), github: undefined as never }
    }
    const spaces = await new Spaces(new MemoryKV(), make).load({ id: 'acme', name: 'Acme', members: [{ login: 'Ana', role: 'owner' }] })

    const first = await spaces.ensurePersonal('Ana', 'acme')
    assert.equal(first.made, true)
    assert.equal(first.info.id, '~ana')
    assert.equal(personalId('Ana'), '~ana')
    assert.deepEqual(made.at(-1), { id: '~ana', home: 'acme' })
    const again = await Promise.all([spaces.ensurePersonal('Ana', 'acme'), spaces.ensurePersonal('Ana', 'acme')])
    assert.ok(again.every((x) => !x.made), 'made once')
    assert.equal(spaces.list().filter((s) => s.personal).length, 1)

    assert.deepEqual(spaces.forPerson('Ana').map((s) => [s.info.id, s.role]), [['acme', 'owner'], ['~ana', 'owner']])
    assert.ok(!spaces.forPerson('root', true).some((s) => s.info.id === '~ana'), 'the hub’s admins don’t open someone’s personal Binder')
    await assert.rejects(spaces.setMember('~ana', 'bo', 'member', true), /alone/)
    await assert.rejects(spaces.ensurePersonal('not a login!', 'acme'), /GitHub login/)
  })
})
