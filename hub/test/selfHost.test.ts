import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { MemoryKV } from '../src/kv.ts'
import { nearby } from '../src/server.ts'
import { firstSpaceIn } from '../src/spaces.ts'

describe('a hub on someone’s own server', () => {
  it('keeps the first binder its store has, and has none to keep when new', async () => {
    const kv = new MemoryKV()
    assert.equal(await firstSpaceIn(kv), undefined)
    await kv.set('spaces', JSON.stringify([
      { id: '~sam', name: 'Notes', createdAt: '', createdBy: 'sam', members: [], personal: 'sam' },
      { id: 'harbor', name: 'Harbor', createdAt: '', createdBy: 'hub', members: [] },
      { id: 'mobile', name: 'Mobile', createdAt: '', createdBy: 'sam', members: [] },
    ]))
    assert.equal(await firstSpaceIn(kv), 'harbor')
  })

  it('believes forwarded addresses only from proxies on the machine or a private network', () => {
    for (const a of ['127.0.0.1', '::1', '::ffff:10.0.0.4', '172.18.0.3', '192.168.1.9', 'fd12:3456::1', 'fe80::1']) assert.ok(nearby(a), a)
    for (const a of ['8.8.8.8', '172.32.0.1', '::ffff:1.2.3.4', '2001:db8::1', undefined]) assert.ok(!nearby(a), String(a))
  })
})
