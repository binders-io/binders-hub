import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { Check, Copy, TriangleAlert } from 'lucide-react'
import { call } from '../../data/api'
import { loadListeners, type ListenerView, type ListenView } from '../../data/listen'
import type { ListenerKind } from '../../../../shared/listen.ts'
import { useHub } from '../../data/store'
import { useUI } from '../../ui'
import { ConfirmButton } from '../../components/ConfirmButton'
import { attempt } from '../../components/Toast'
import { Saved, WhoCan } from './shared'
import { useBinderAccess, useSaved } from './access'

type Mode = 'off' | 'watch' | 'on'

const kindName: Record<ListenerKind, string> = { post: 'An address to post to', feed: 'A feed the hub reads', github: 'GitHub issues' }
const kindHint: Record<ListenerKind, string> = {
  post: 'Another tool posts to an address the hub gives you.',
  feed: 'An RSS, Atom or JSON feed the hub reads every so often.',
  github: 'Issues opened in this binder’s repos that the hub didn’t make.',
}
const kinds: ListenerKind[] = ['post', 'feed', 'github']
const modes: [Mode, string][] = [['off', 'Off'], ['watch', 'Watch'], ['on', 'On']]

/** What the choice a listener is in means, in one line. */
const modeLine = (mode: Mode, folder: string) =>
  mode === 'off' ? 'It hears nothing.'
    : mode === 'watch' ? 'The hub says what it would file in Came in, and files nothing.'
      : `Each thing it hears becomes a note in ${folder}.`

/** A secret the hub has just made: said once, and kept only here until it's dismissed. */
interface NewSecret { id: string; name: string; address: string; secret: string }

/**
 * This binder's listeners: what brings things into it from outside, each in Off, Watch or On, with where its notes go.
 * Everyone here can read them; the hub says who may change them. A post address's secret is shown once, when it is made
 * or remade, and is held only in this component's state, never written down or put in an address.
 */
export function Listeners() {
  const { managers } = useBinderAccess()
  const binders = useHub((state) => state.binders)
  const { binder: shownBinder } = useUI()
  const { saved, shown } = useSaved()
  const [view, setView] = useState<ListenView>()
  const [failed, setFailed] = useState(false)
  const [secret, setSecret] = useState<NewSecret>()
  const several = binders.length > 1
  const load = () => void loadListeners().then((found) => { setView(found); setFailed(false) }).catch(() => setFailed(true))
  useEffect(load, [])
  if (!view) return failed ? <p className="faint">Couldn’t load the listeners. Try again in a moment.</p> : null
  const may = view.mayManage

  const replace = (listener: ListenerView) => setView((was) => was && { ...was, listeners: was.listeners.map((l) => (l.id === listener.id ? { ...l, ...listener } : l)) })
  const change = async (id: string, fields: Partial<Pick<ListenerView, 'mode' | 'folder' | 'from' | 'url' | 'everyMinutes'>>, key: string) => {
    const done = await attempt(() => call<{ listener: ListenerView }>('PUT', `/api/listen/${id}`, fields))
    if (!done?.listener) return false
    replace(done.listener)
    saved(`${id}-${key}`)
    return true
  }
  const remove = async (listener: ListenerView) => {
    const done = await attempt(async () => { await call('DELETE', `/api/listen/${listener.id}`); return true })
    if (!done) return
    setView((was) => was && { ...was, listeners: was.listeners.filter((l) => l.id !== listener.id) })
    setSecret((was) => (was?.id === listener.id ? undefined : was))
  }
  const remake = async (listener: ListenerView) => {
    const done = await attempt(() => call<{ secret: string }>('POST', `/api/listen/${listener.id}/secret`))
    if (done?.secret && listener.address) setSecret({ id: listener.id, name: listener.name, address: listener.address, secret: done.secret })
  }
  const added = (listener: ListenerView, made?: string) => {
    setView((was) => was && { ...was, listeners: [...was.listeners, listener] })
    if (made && listener.address) setSecret({ id: listener.id, name: listener.name, address: listener.address, secret: made })
  }
  const binderName = (id: string) => binders.find((b) => b.id === id)?.name ?? 'Another binder'

  return (
    <>
      <p className="listen-intro">
        Each thing a listener hears becomes a note in a folder here. A new
        one starts in Watch: the hub says what it would file and files nothing, until you turn it On.
      </p>
      <WhoCan may={may} managers={managers} />
      {secret && <SecretBlock key={secret.id + secret.secret} {...secret} onDone={() => setSecret(undefined)} />}
      <section className="settings-part">
        <h3 className="settings-sub">Your listeners</h3>
        {view.listeners.length ? (
          <ul className="binder-cards">
            {view.listeners.map((listener) => (
              <ListenerCard key={listener.id} listener={listener} may={may} where={several ? binderName(listener.binderId) : undefined}
                saved={(key) => <Saved show={shown(`${listener.id}-${key}`)} />}
                onChange={(fields, key) => change(listener.id, fields, key)} onRemove={() => void remove(listener)} onRemake={() => void remake(listener)} />
            ))}
          </ul>
        ) : <p className="faint">No listeners yet. Nothing comes into this binder from outside it.</p>}
      </section>
      {may && <AddListener binders={binders} first={shownBinder !== 'all' && binders.some((b) => b.id === shownBinder) ? shownBinder : binders[0]?.id} onAdded={added} />}
    </>
  )
}

function ListenerCard({ listener, may, where, saved, onChange, onRemove, onRemake }: {
  listener: ListenerView
  may: boolean
  /** The binder's name, when this binder has more than one. */
  where?: string
  saved: (key: string) => ReactNode
  onChange: (fields: Partial<Pick<ListenerView, 'mode' | 'folder' | 'from' | 'url' | 'everyMinutes'>>, key: string) => Promise<boolean>
  onRemove: () => void
  onRemake: () => void
}) {
  const id = `listen-${listener.id}`
  return (
    <li className="settings-card listen-card">
      <div className="listen-head">
        <div className="listen-title">
          <b className="listen-name">{listener.name}</b>
          <span className="listen-kind">{kindName[listener.kind]}{where ? ` · ${where}` : ''}</span>
        </div>
      </div>

      <div className="field">
        <span className="field-label" id={`${id}-mode-label`}>Hearing</span>
        {may ? (
          <div className="segmented listen-modes" role="radiogroup" aria-labelledby={`${id}-mode-label`}>
            {modes.map(([mode, label]) => (
              <button key={mode} type="button" role="radio" aria-checked={listener.mode === mode} className={listener.mode === mode ? 'on' : ''} onClick={() => listener.mode !== mode && void onChange({ mode }, 'mode')}>{label}</button>
            ))}
          </div>
        ) : <b className="listen-mode-name">{modes.find(([mode]) => mode === listener.mode)?.[1]}</b>}
        <span className="field-head"><span className="field-hint" id={`${id}-mode-line`}>{modeLine(listener.mode, listener.folder)}</span>{saved('mode')}</span>
      </div>

      {may ? (
        <SavedText id={`${id}-folder`} label="Folder" value={listener.folder} onSave={(folder) => onChange({ folder }, 'folder')} hint="Its notes go here. It’s made at the top of the binder if it isn’t there." saved={saved('folder')} />
      ) : <p className="listen-fact"><span className="field-label">Folder</span> {listener.folder}</p>}

      {listener.kind === 'post' && <PostPart listener={listener} may={may} onChange={onChange} saved={saved} />}
      {listener.kind === 'feed' && <FeedPart listener={listener} may={may} onChange={onChange} saved={saved} />}
      {listener.kind === 'github' && <p className="field-hint">It hears issues opened in this binder’s repos that the hub didn’t make. Someone in the Binder is heard, and anyone else is from outside.</p>}

      {may && (
        <div className="listen-actions">
          {listener.kind === 'post' && <ConfirmButton question="New secret? The old one stops. Press again" label={`New secret for ${listener.name}`} onConfirm={onRemake}>New secret</ConfirmButton>}
          <ConfirmButton className="button danger" question="Remove it? Press again" label={`Remove ${listener.name}`} onConfirm={onRemove}>Remove</ConfirmButton>
        </div>
      )}
    </li>
  )
}

/** An address to post to: who has it, and the address. */
function PostPart({ listener, may, onChange, saved }: { listener: ListenerView; may: boolean; onChange: (fields: { from: 'binder' | 'anyone' }, key: string) => Promise<boolean>; saved: (key: string) => ReactNode }) {
  const from = listener.from ?? 'anyone'
  const group = `listen-from-${listener.id}`
  return (
    <>
      {may ? (
        <fieldset className="field listen-from">
          <legend className="field-label">Who has its address</legend>
          <Choice name={group} id={`${group}-anyone`} checked={from === 'anyone'} label="Anyone" hint="What comes is from outside, and waits for someone here to let it through." onPick={() => void onChange({ from: 'anyone' }, 'from')} />
          <Choice name={group} id={`${group}-binder`} checked={from === 'binder'} label="Only people in this Binder" hint="What comes counts as said by someone here." onPick={() => void onChange({ from: 'binder' }, 'from')} />
          {saved('from')}
        </fieldset>
      ) : (
        <p className="listen-fact"><span className="field-label">Who has its address</span> {from === 'binder' ? 'Only people in this Binder' : 'Anyone'}</p>
      )}
      {listener.address && (
        <div className="copy-row">
          <span className="field-label" id={`listen-address-${listener.id}`}>Address</span>
          <div className="token-value mono" aria-labelledby={`listen-address-${listener.id}`}><span>{listener.address}</span><CopyButton text={listener.address} what="the address" /></div>
        </div>
      )}
    </>
  )
}

/** A feed the hub reads: its address, how often, and why it can't when it can't. */
function FeedPart({ listener, may, onChange, saved }: { listener: ListenerView; may: boolean; onChange: (fields: { url?: string; everyMinutes?: number }, key: string) => Promise<boolean>; saved: (key: string) => ReactNode }) {
  const id = `listen-${listener.id}`
  const every = listener.everyMinutes ?? 15
  return (
    <>
      {listener.failing && <p className="setup-warning listen-failing" role="status"><TriangleAlert size={15} aria-hidden="true" /><span>{listener.failing}</span></p>}
      {may ? (
        <>
          <SavedText id={`${id}-url`} label="Feed address" value={listener.url ?? ''} inputMode="url" mono onSave={(url) => onChange({ url }, 'url')} saved={saved('url')} />
          <SavedText id={`${id}-every`} label="Read it every (minutes)" value={String(every)} type="number" min={5} max={1440} hint="Between 5 minutes and a day (1440)." onSave={(text) => onChange({ everyMinutes: Number.isFinite(Number(text)) && text !== '' ? Number(text) : 0 }, 'every')} saved={saved('every')} />
        </>
      ) : (
        <>
          <p className="listen-fact"><span className="field-label">Feed address</span> <span className="mono">{listener.url}</span></p>
          <p className="listen-fact"><span className="field-label">Read every</span> {every} minutes</p>
        </>
      )}
    </>
  )
}

/** A radio button with its words beside it and a line under them. */
function Choice({ name, id, checked, label, hint, onPick }: { name: string; id: string; checked: boolean; label: string; hint: string; onPick: () => void }) {
  return (
    <div className="listen-choice">
      <input type="radio" name={name} id={id} checked={checked} onChange={onPick} aria-describedby={`${id}-hint`} />
      <label htmlFor={id}>{label}</label>
      <span className="field-hint" id={`${id}-hint`}>{hint}</span>
    </div>
  )
}

/**
 * A one-line field that keeps what's typed when it loses focus (or on Enter), and goes back to what the hub has if the
 * hub refuses it, whose words show as a toast.
 */
function SavedText({ id, label, value, onSave, hint, saved, type = 'text', mono, inputMode, min, max }: {
  id: string
  label: string
  value: string
  onSave: (value: string) => Promise<boolean>
  hint?: string
  saved: ReactNode
  type?: 'text' | 'number'
  mono?: boolean
  inputMode?: 'url'
  min?: number
  max?: number
}) {
  // What's being typed, until it's kept or refused: then the field shows the hub's again.
  const [draft, setDraft] = useState<string>()
  const text = draft ?? value
  const commit = async () => {
    const next = text.trim()
    if (next !== value) await onSave(next)
    setDraft(undefined)
  }
  return (
    <div className="field">
      <div className="field-head"><label className="field-label" htmlFor={id}>{label}</label>{saved}</div>
      <input id={id} type={type} className={mono ? 'mono' : undefined} value={text} inputMode={inputMode} min={min} max={max} autoComplete="off" spellCheck={false} aria-describedby={hint ? `${id}-hint` : undefined}
        onChange={(e) => setDraft(e.target.value)} onBlur={() => void commit()} onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur() }} />
      {hint && <span className="field-hint" id={`${id}-hint`}>{hint}</span>}
    </div>
  )
}

/** A button that puts words on the clipboard, and says so for a moment. */
function CopyButton({ text, what }: { text: string; what: string }) {
  const [copied, setCopied] = useState(false)
  const timer = useRef<number>(undefined)
  useEffect(() => () => window.clearTimeout(timer.current), [])
  const copy = async () => {
    try { await navigator.clipboard.writeText(text) } catch { /* Blocked: the words are on screen to select. */ }
    setCopied(true)
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setCopied(false), 1600)
  }
  return (
    <>
      <button type="button" className="button listen-copy" onClick={() => void copy()} aria-label={`Copy ${what}`}>{copied ? <Check size={13} aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />} {copied ? 'Copied' : 'Copy'}</button>
      <span className="sr-only" role="status">{copied ? `Copied ${what}` : ''}</span>
    </>
  )
}

/**
 * A new secret, shown once and kept on screen until it is dismissed: the secret, a line that it won't be shown again,
 * and a command to paste with the real address and secret in it. Focus lands on it, so a keyboard gets there at once.
 */
function SecretBlock({ name, address, secret, onDone }: NewSecret & { onDone: () => void }) {
  const block = useRef<HTMLElement>(null)
  useEffect(() => block.current?.focus(), [])
  const example = `curl -X POST "${address}" -H "Authorization: Bearer ${secret}" -H "Content-Type: application/json" -d '{"title":"Hello","text":"Sent from my script"}'`
  return (
    <section className="listen-secret" ref={block} tabIndex={-1} aria-label={`The secret for ${name}`}>
      <h3>The secret for {name}</h3>
      <div className="token-value mono"><span>{secret}</span><CopyButton text={secret} what="the secret" /></div>
      <p><b>It won’t be shown again.</b> Copy it now. If it’s lost, make a new one: the old one stops working.</p>
      <div className="copy-row">
        <span className="field-label">To try it</span>
        <div className="listen-code mono"><code>{example}</code></div>
        <div><CopyButton text={example} what="the command" /></div>
      </div>
      <p className="field-hint">A tool that can’t set a header can add <span className="mono">?key={secret}</span> to the address. The body can be JSON (<span className="mono">title</span>, <span className="mono">text</span>, <span className="mono">from</span>, <span className="mono">url</span>, <span className="mono">id</span>), a form, or plain text.</p>
      <div className="listen-actions"><button type="button" className="button primary" onClick={onDone}>I’ve copied it</button></div>
    </section>
  )
}

/** The form that makes a listener: what it listens to, its name, the binder and folder its notes go to, and a feed's address. */
function AddListener({ binders, first, onAdded }: { binders: { id: string; name: string }[]; first?: string; onAdded: (listener: ListenerView, secret?: string) => void }) {
  const id = useId()
  const [kind, setKind] = useState<ListenerKind>('post')
  const [name, setName] = useState('')
  const [binderId, setBinderId] = useState<string>()
  const [folder, setFolder] = useState('Inbox')
  const [url, setUrl] = useState('')
  const [making, setMaking] = useState(false)
  const chosen = binderId ?? first
  const ready = !!name.trim() && (kind !== 'feed' || !!url.trim()) && !making
  const create = async () => {
    setMaking(true)
    const done = await attempt(() => call<{ listener: ListenerView; secret?: string }>('POST', '/api/listen', {
      kind, name: name.trim(), ...(chosen ? { binderId: chosen } : {}), folder: folder.trim() || 'Inbox', ...(kind === 'feed' ? { url: url.trim() } : {}),
    }))
    setMaking(false)
    if (!done?.listener) return
    onAdded(done.listener, done.secret)
    setName('')
    setUrl('')
  }
  return (
    <section className="settings-part">
      <h3 className="settings-sub">Add a listener</h3>
      <form className="settings-card form listen-add" onSubmit={(e) => { e.preventDefault(); if (ready) void create() }}>
        <fieldset className="field listen-kinds">
          <legend className="field-label">What it listens to</legend>
          {kinds.map((k) => <Choice key={k} name={`${id}-kind`} id={`${id}-kind-${k}`} checked={kind === k} label={kindName[k]} hint={kindHint[k]} onPick={() => setKind(k)} />)}
        </fieldset>
        <label className="field"><span className="field-label">Name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Support mail" maxLength={60} autoComplete="off" />
        </label>
        {binders.length > 1 && (
          <label className="field"><span className="field-label">The binder its notes go in</span>
            <select value={chosen ?? ''} onChange={(e) => setBinderId(e.target.value)}>
              {binders.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          </label>
        )}
        <label className="field"><span className="field-label">Folder</span>
          <input value={folder} onChange={(e) => setFolder(e.target.value)} maxLength={80} autoComplete="off" />
          <span className="field-hint">Its notes go here. It’s made at the top of the binder if it isn’t there.</span>
        </label>
        {kind === 'feed' && (
          <label className="field"><span className="field-label">Feed address</span>
            <input className="mono" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com/feed.xml" inputMode="url" autoComplete="off" spellCheck={false} />
          </label>
        )}
        <div><button className="button primary" disabled={!ready}>Create</button></div>
      </form>
    </section>
  )
}
