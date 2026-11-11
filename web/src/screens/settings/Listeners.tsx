import { useEffect, useRef, useState, type ReactNode } from 'react'
import { AnimatePresence } from 'motion/react'
import { Check, Copy, Inbox, Plus, Rss, TriangleAlert, Webhook } from 'lucide-react'
import { call } from '../../data/api'
import { loadListeners, type ListenerView, type ListenView } from '../../data/listen'
import type { ListenerKind } from '../../../../shared/listen.ts'
import { useHub } from '../../data/store'
import { useUI } from '../../ui'
import { ConfirmButton } from '../../components/ConfirmButton'
import { attempt, toast } from '../../components/Toast'
import { Github } from '../../components/Github'
import { Dialog, EmptyState, Guided, Row, Rows, Section, Skeleton, Status, type GuidedOption, type GuidedStep } from '../../kit'
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

/** A listener's kind, as an icon. */
const kindIcon = (kind: ListenerKind, size = 16) => (kind === 'post' ? <Webhook size={size} /> : kind === 'feed' ? <Rss size={size} /> : <Github size={size} />)

/** Off, Watch or On, as a state. A feed it can't read is failing whatever it's in. */
function modeStatus(listener: ListenerView) {
  if (listener.failing) return <Status tone="bad" title={listener.failing}>Can’t read it</Status>
  if (listener.mode === 'on') return <Status tone="ok">On</Status>
  if (listener.mode === 'watch') return <Status tone="waiting">Watch</Status>
  return <Status tone="off">Off</Status>
}

/**
 * This binder's listeners: what brings things into it from outside, each a row in Off, Watch or On with where its notes
 * go, opening to change it. Add a listener is one button, guided: what kind, then its name and folder, then for an
 * address to post to, its secret. Everyone here can read them; the hub says who may change them. A post address's
 * secret is shown once, when it is made or remade, and is held only in this component's state, never written down or
 * put in an address: in the dialog it was made in, or on the page if that dialog is closed before it's dismissed.
 */
export function Listeners() {
  const { managers } = useBinderAccess()
  const binders = useHub((state) => state.binders)
  const { binder: shownBinder } = useUI()
  const { saved, shown } = useSaved()
  const [view, setView] = useState<ListenView>()
  const [failed, setFailed] = useState(false)
  const [secret, setSecret] = useState<NewSecret>()
  const [open, setOpen] = useState<string>()
  const [adding, setAdding] = useState(false)
  const several = binders.length > 1
  const load = () => void loadListeners().then((found) => { setView(found); setFailed(false) }).catch(() => setFailed(true))
  useEffect(load, [])
  if (!view) {
    return failed
      ? <EmptyState icon={<TriangleAlert size={20} />} title="Couldn’t load the listeners" line="The hub didn’t answer just now." action={<button type="button" className="button" onClick={load}>Try again</button>} />
      : <div className="section-card listen-loading" aria-busy="true"><Skeleton lines={3} /></div>
  }
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
    setOpen(undefined)
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
  const opened = view.listeners.find((l) => l.id === open)
  const addButton = <button type="button" className="button small" onClick={() => setAdding(true)}><Plus size={14} aria-hidden="true" />Add a listener</button>

  return (
    <div className="gh-sections">
      <WhoCan may={may} managers={managers} />
      {/* A secret whose dialog was closed before it was dismissed stays here, unmissable, until it is. */}
      {secret && !adding && open !== secret.id && <SecretBlock key={secret.id + secret.secret} {...secret} onDone={() => setSecret(undefined)} />}
      <Section title="Your listeners" lead="Each thing a listener hears becomes a note in a folder here." action={may && view.listeners.length ? addButton : undefined}
        more={<p>A new one starts in Watch: the hub says what it would file in Came in, and files nothing, until you turn it On. What comes from outside this binder waits for someone here to let it through before a folder’s rule starts work from it.</p>}>
        {view.listeners.length ? (
          <Rows label="Listeners">
            {view.listeners.map((listener) => (
              <Row key={listener.id} icon={kindIcon(listener.kind)} title={listener.name}
                meta={`Notes go to ${listener.folder}${several ? ` in ${binderName(listener.binderId)}` : ''} · ${kindName[listener.kind]}`}
                status={modeStatus(listener)} onPress={() => setOpen(listener.id)} />
            ))}
          </Rows>
        ) : <EmptyState compact icon={<Inbox size={18} />} title="No listeners yet" line="Nothing comes into this binder from outside it." action={may ? addButton : undefined} />}
      </Section>
      <AnimatePresence>
        {opened && (
          <ListenerDialog key={opened.id} listener={opened} may={may} where={several ? binderName(opened.binderId) : undefined}
            secret={secret?.id === opened.id ? secret : undefined} onSecretDone={() => setSecret(undefined)}
            saved={(key) => <Saved show={shown(`${opened.id}-${key}`)} />}
            onChange={(fields, key) => change(opened.id, fields, key)} onRemove={() => void remove(opened)} onRemake={() => void remake(opened)} onClose={() => setOpen(undefined)} />
        )}
        {adding && <AddListener key="add" binders={binders} first={shownBinder !== 'all' && binders.some((b) => b.id === shownBinder) ? shownBinder : binders[0]?.id} secret={secret} onAdded={added} onSecretDone={() => setSecret(undefined)} onClose={() => setAdding(false)} />}
      </AnimatePresence>
    </div>
  )
}

/** One listener: everything about it, to change for whoever may, and to read for anyone else. */
function ListenerDialog({ listener, may, where, secret, onSecretDone, saved, onChange, onRemove, onRemake, onClose }: {
  listener: ListenerView
  may: boolean
  /** The binder's name, when this binder has more than one. */
  where?: string
  /** Its new secret, while it's showing. */
  secret?: NewSecret
  onSecretDone: () => void
  saved: (key: string) => ReactNode
  onChange: (fields: Partial<Pick<ListenerView, 'mode' | 'folder' | 'from' | 'url' | 'everyMinutes'>>, key: string) => Promise<boolean>
  onRemove: () => void
  onRemake: () => void
  onClose: () => void
}) {
  const id = `listen-${listener.id}`
  if (secret) {
    return (
      <Dialog title={listener.name} onClose={onClose} closeOnlyFromButton footer={<button type="button" className="button primary" onClick={onSecretDone}>I’ve copied it</button>}>
        <SecretPart {...secret} />
      </Dialog>
    )
  }
  return (
    <Dialog title={listener.name} onClose={onClose} footer={(
      <>
        {may && <ConfirmButton className="button danger dialog-foot-start" question="Remove it? Press again" label={`Remove ${listener.name}`} onConfirm={onRemove}>Remove</ConfirmButton>}
        {may && listener.kind === 'post' && <ConfirmButton question="New secret? The old one stops. Press again" label={`New secret for ${listener.name}`} onConfirm={onRemake}>New secret</ConfirmButton>}
        <button type="button" className="button primary" onClick={onClose}>Done</button>
      </>
    )}>
      <div className="listen-card">
        <p className="listen-kind">{kindIcon(listener.kind, 14)}<span>{kindName[listener.kind]}{where ? ` · ${where}` : ''}</span></p>
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
      </div>
    </Dialog>
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
 * A new secret, shown once: the secret, a line that it won't be shown again, and a command to paste with the real address
 * and secret in it. Focus lands on it, so a keyboard gets there at once.
 */
function SecretPart({ name, address, secret }: NewSecret) {
  const block = useRef<HTMLElement>(null)
  useEffect(() => block.current?.focus(), [])
  const example = `curl -X POST "${address}" -H "Authorization: Bearer ${secret}" -H "Content-Type: application/json" -d '{"title":"Hello","text":"Sent from my script"}'`
  return (
    <section className="listen-secret" ref={block} tabIndex={-1} aria-label={`The secret for ${name}`}>
      <p className="listen-secret-once"><TriangleAlert size={15} aria-hidden="true" /><span><b>It won’t be shown again.</b> Copy it now. If it’s lost, make a new one: the old one stops working.</span></p>
      <div className="copy-row">
        <span className="field-label">The secret for {name}</span>
        <div className="token-value mono"><span>{secret}</span><CopyButton text={secret} what="the secret" /></div>
      </div>
      <div className="copy-row">
        <span className="field-label">To try it</span>
        <div className="listen-code mono"><code>{example}</code></div>
        <div><CopyButton text={example} what="the command" /></div>
      </div>
      <p className="field-hint">A tool that can’t set a header can add <span className="mono">?key={secret}</span> to the address. The body can be JSON (<span className="mono">title</span>, <span className="mono">text</span>, <span className="mono">from</span>, <span className="mono">url</span>, <span className="mono">id</span>), a form, or plain text.</p>
    </section>
  )
}

/** A secret whose dialog was closed before it was dismissed: on the page, with its own way to dismiss it. */
function SecretBlock(props: NewSecret & { onDone: () => void }) {
  return (
    <div className="listen-secret-page">
      <SecretPart {...props} />
      <div className="listen-actions"><button type="button" className="button primary" onClick={props.onDone}>I’ve copied it</button></div>
    </div>
  )
}

/**
 * Add a listener, guided: what it listens to, then its name, the binder and folder its notes go to, and a feed's address;
 * then, for an address to post to, the address and its secret, shown once.
 */
function AddListener({ binders, first, secret, onAdded, onSecretDone, onClose }: {
  binders: { id: string; name: string }[]
  first?: string
  secret?: NewSecret
  onAdded: (listener: ListenerView, secret?: string) => void
  onSecretDone: () => void
  onClose: () => void
}) {
  const [name, setName] = useState('')
  const [binderId, setBinderId] = useState<string>()
  const [folder, setFolder] = useState('Inbox')
  const [url, setUrl] = useState('')
  const [making, setMaking] = useState(false)
  const [made, setMade] = useState<string>()
  const chosen = binderId ?? first
  const create = async (kind: ListenerKind, next: () => void) => {
    setMaking(true)
    const done = await attempt(() => call<{ listener: ListenerView; secret?: string }>('POST', '/api/listen', {
      kind, name: name.trim(), ...(chosen ? { binderId: chosen } : {}), folder: folder.trim() || 'Inbox', ...(kind === 'feed' ? { url: url.trim() } : {}),
    }))
    setMaking(false)
    if (!done?.listener) return
    onAdded(done.listener, done.secret)
    setMade(done.listener.id)
    if (done.secret && done.listener.address) return next()
    toast(`${done.listener.name} is listening, in Watch.`)
    onClose()
  }
  const options: GuidedOption[] = kinds.map((k) => ({ id: k, icon: kindIcon(k, 18), name: kindName[k], line: kindHint[k], recommended: k === 'post' }))
  const steps = (kind: string): GuidedStep[] => {
    const k = kind as ListenerKind
    const ready = !!name.trim() && (k !== 'feed' || !!url.trim()) && !making
    const form: GuidedStep = {
      title: 'Its name and folder', lead: 'It starts in Watch: the hub says what it would file, and files nothing until you turn it On.',
      content: (nav) => (
        <form id="listen-add" className="form listen-add" onSubmit={(e) => { e.preventDefault(); if (ready) void create(k, nav.next) }}>
          <label className="field"><span className="field-label">Name</span>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder={k === 'feed' ? 'Release notes' : k === 'github' ? 'Repo issues' : 'Support mail'} maxLength={60} autoComplete="off" />
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
          {k === 'feed' && (
            <label className="field"><span className="field-label">Feed address</span>
              <input className="mono" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com/feed.xml" inputMode="url" autoComplete="off" spellCheck={false} />
            </label>
          )}
        </form>
      ),
      footer: <button type="submit" form="listen-add" className="button primary" disabled={!ready}>Create</button>,
    }
    if (k !== 'post') return [form]
    const shown = secret && secret.id === made ? secret : undefined
    return [form, {
      title: 'Its address and secret',
      content: shown ? <SecretPart {...shown} /> : <p className="faint">The secret was dismissed.</p>,
      footer: (nav) => <button type="button" className="button primary" onClick={() => { onSecretDone(); nav.close() }}>I’ve copied it</button>,
    }]
  }
  return <Guided title="Add a listener" question="What does it listen to?" options={options} steps={steps} onClose={onClose} />
}
