import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFeed, unescape, wordsOf } from '../src/listen/feeds.ts'
import { mayAccept, mayDistill, strengthOf, type NoteFrom } from '../../shared/listen.ts'

const rss = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel>
    <title>Acme status</title>
    <link>https://status.acme.test/</link>
    <item>
      <title>Payments are slow &amp; some fail</title>
      <link>https://status.acme.test/incidents/41</link>
      <guid isPermaLink="false">incident-41</guid>
      <pubDate>Mon, 09 Nov 2026 14:05:00 GMT</pubDate>
      <dc:creator>On call</dc:creator>
      <description>&lt;p&gt;Card payments take &lt;b&gt;longer&lt;/b&gt; than usual.&lt;/p&gt;&lt;p&gt;We&#39;re looking into it.&lt;/p&gt;</description>
    </item>
    <item>
      <title><![CDATA[All clear]]></title>
      <link>https://status.acme.test/incidents/40</link>
      <content:encoded><![CDATA[<p>Fixed.</p><script>alert('x')</script>]]></content:encoded>
      <description>Short.</description>
    </item>
  </channel>
</rss>`

const atom = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Releases of acme/web</title>
  <link href="https://github.test/acme/web/releases" rel="alternate"/>
  <entry>
    <id>tag:github.test,2008:Repository/1/v2.4.0</id>
    <updated>2026-11-08T10:00:00Z</updated>
    <link rel="self" href="https://github.test/acme/web/releases.atom"/>
    <link rel="alternate" type="text/html" href="https://github.test/acme/web/releases/tag/v2.4.0"/>
    <title>v2.4.0</title>
    <content type="html">&lt;ul&gt;&lt;li&gt;Annual plans&lt;/li&gt;&lt;li&gt;A faster board&lt;/li&gt;&lt;/ul&gt;</content>
    <author><name>maya</name></author>
  </entry>
</feed>`

describe('a feed the hub reads', () => {
  it('reads RSS: each item with its own id, link, date, sender and words', () => {
    const feed = readFeed(rss)!
    assert.equal(feed.title, 'Acme status')
    assert.deepEqual(feed.items[0], {
      sourceId: 'incident-41',
      at: '2026-11-09T14:05:00.000Z',
      sender: { name: 'On call' },
      title: 'Payments are slow & some fail',
      text: 'Card payments take longer than usual.\nWe\'re looking into it.',
      url: 'https://status.acme.test/incidents/41',
    })
  })

  it('takes the fuller words when an item has both, and nothing that would run', () => {
    const second = readFeed(rss)!.items[1]
    assert.equal(second.title, 'All clear')
    assert.equal(second.text, 'Fixed.')
    assert.equal(second.sourceId, 'https://status.acme.test/incidents/40', 'with no guid, its link names it')
  })

  it('reads Atom: the link people open, not the feed’s own', () => {
    const feed = readFeed(atom)!
    assert.equal(feed.title, 'Releases of acme/web')
    assert.deepEqual(feed.items, [{
      sourceId: 'tag:github.test,2008:Repository/1/v2.4.0',
      at: '2026-11-08T10:00:00.000Z',
      sender: { name: 'maya' },
      title: 'v2.4.0',
      text: 'Annual plans\nA faster board',
      url: 'https://github.test/acme/web/releases/tag/v2.4.0',
    }])
  })

  it('reads JSON Feed', () => {
    const feed = readFeed(JSON.stringify({ version: 'https://jsonfeed.org/version/1.1', title: 'Notes', items: [
      { id: 7, url: 'https://blog.test/7', title: 'Seven', content_html: '<p>Hello <em>there</em></p>', date_published: '2026-11-01T08:00:00Z', authors: [{ name: 'Sam' }] },
      { id: 'eight', content_text: 'Plain words.' },
      { title: 'No id, no words' },
    ] }))!
    assert.equal(feed.title, 'Notes')
    assert.deepEqual(feed.items, [
      { sourceId: '7', at: '2026-11-01T08:00:00.000Z', sender: { name: 'Sam' }, title: 'Seven', text: 'Hello there', url: 'https://blog.test/7' },
      { sourceId: 'eight', text: 'Plain words.' },
    ])
  })

  it('takes only a web address for a link', () => {
    const feed = readFeed('<rss><channel><item><guid>1</guid><title>x</title><link>javascript:alert(1)</link></item></channel></rss>')!
    assert.deepEqual(feed.items, [{ sourceId: '1', title: 'x', text: '' }])
  })

  it('leaves out an item with nothing to name it by, or nothing to say', () => {
    const feed = readFeed('<rss><channel><item><description>Words with no name</description></item><item><guid>2</guid></item><item><guid>3</guid><title>Kept</title></item></channel></rss>')!
    assert.deepEqual(feed.items.map((i) => i.sourceId), ['3'])
  })

  it('gives nothing for what isn’t a feed', () => {
    for (const not of ['', '<html><body>Sign in</body></html>', 'not found', '{"error":"no"}', '{broken']) assert.equal(readFeed(not), undefined)
    assert.deepEqual(readFeed('<rss><channel><title>Empty</title></channel></rss>'), { title: 'Empty', items: [] })
  })

  it('reads words as they’re meant: entities turned back, markup gone', () => {
    assert.equal(unescape('a &lt; b &amp;&amp; c &#x26; d &#8217; &unknown;'), 'a < b && c & d ’ &unknown;')
    assert.equal(wordsOf('<![CDATA[<h1>Title</h1><p>One<br>Two</p><style>p{}</style>]]>'), 'Title\nOne\nTwo')
    assert.equal(wordsOf(undefined), '')
  })
})

describe('how strongly something was said', () => {
  const member = (login: string) => login === 'maya'

  it('goes by the listener and who sent it, never by its words', () => {
    assert.equal(strengthOf({ kind: 'github' }, { sender: { login: 'maya' } }, member), 'heard')
    assert.equal(strengthOf({ kind: 'github' }, { sender: { login: 'stranger' } }, member), 'outside')
    assert.equal(strengthOf({ kind: 'github' }, { sender: { login: 'maya', bot: true } }, member), 'outside')
    assert.equal(strengthOf({ kind: 'github' }, {}, member), 'outside')
    assert.equal(strengthOf({ kind: 'post', from: 'binder' }, { sender: { name: 'Anyone at all' } }, member), 'heard')
    assert.equal(strengthOf({ kind: 'post', from: 'anyone' }, { sender: { login: 'maya' } }, member), 'outside')
    assert.equal(strengthOf({ kind: 'post' }, {}, member), 'outside')
    assert.equal(strengthOf({ kind: 'feed' }, { sender: { login: 'maya' } }, member), 'outside')
  })

  it('lets a rule distill what’s from outside only once someone let it through, and accept only what was asked', () => {
    const from = (strength: NoteFrom['strength'], passed = false): NoteFrom => ({ listener: 'l', name: 'L', kind: 'post', strength, ...(passed ? { passed: { by: 'maya', at: '2026-11-10T00:00:00Z' } } : {}) })
    assert.equal(mayDistill(undefined), true)
    assert.equal(mayDistill(from('heard')), true)
    assert.equal(mayDistill(from('outside')), false)
    assert.equal(mayDistill(from('outside', true)), true)
    assert.equal(mayAccept(undefined), true)
    assert.equal(mayAccept(from('asked')), true)
    assert.equal(mayAccept(from('heard')), false)
    assert.equal(mayAccept(from('outside', true)), false)
  })
})
