import { useMemo, useState } from 'react'
import { AnimatePresence } from 'motion/react'
import { Bot, Cloud, FolderGit2, GitBranch, Inbox, KeyRound, Laptop, Lock, Mail, Plus, Search, Settings, Terminal, Trash2 } from 'lucide-react'
import { toast, failure } from '../components/Toast'
import { ConfirmButton } from '../components/ConfirmButton'
import { Dialog, Field } from '../components/Dialog'
import { DataTable, type Column } from './DataTable'
import { EmptyState } from './EmptyState'
import { Guided } from './Guided'
import { MenuButton } from './MenuButton'
import { More } from './More'
import { PageHeader } from './PageHeader'
import { Row, Rows } from './Rows'
import { Section } from './Section'
import { Skeleton } from './Skeleton'
import { Status, type Tone } from './Status'

/** A repo, invented, for the table: enough of them to need the filter and Show more. */
interface Repo { name: string; visibility: 'Private' | 'Public'; brief: 'Written' | 'Being written' | 'None'; changed: string }

const owners = ['acme', 'harbor', 'northwind', 'contoso']
const words = ['api', 'web', 'billing', 'emails', 'docs', 'search', 'mobile', 'infra', 'design', 'auth', 'reports', 'payments']
const briefTone: Record<Repo['brief'], Tone> = { Written: 'ok', 'Being written': 'running', None: 'off' }

function invent(count: number): Repo[] {
  return Array.from({ length: count }, (_, i) => ({
    name: `${owners[i % owners.length]}/${words[i % words.length]}${i >= words.length ? `-${Math.floor(i / words.length)}` : ''}`,
    visibility: i % 3 ? 'Private' : 'Public',
    brief: (['Written', 'Being written', 'None'] as const)[i % 7 === 0 ? 1 : i % 4 === 0 ? 2 : 0],
    changed: `${(i % 23) + 1} Nov`,
  }))
}

const columns: Column<Repo>[] = [
  { key: 'name', header: 'Repo', cell: (r) => <span className="kit-repo"><FolderGit2 size={15} aria-hidden="true" /> {r.name}</span>, text: (r) => r.name, phone: 'title', width: '42%' },
  { key: 'visibility', header: 'Who sees it', cell: (r) => <>{r.visibility === 'Private' && <Lock size={12} aria-hidden="true" />} {r.visibility}</>, text: (r) => r.visibility },
  { key: 'brief', header: 'Its brief', cell: (r) => <Status tone={briefTone[r.brief]}>{r.brief}</Status>, text: (r) => r.brief },
  { key: 'changed', header: 'Changed', cell: (r) => r.changed, align: 'end', phone: 'hidden', width: '110px' },
]

const tones: { tone: Tone; words: string }[] = [
  { tone: 'ok', words: 'Done' }, { tone: 'running', words: 'Running' }, { tone: 'waiting', words: 'Waiting on you' },
  { tone: 'review', words: 'In review' }, { tone: 'bad', words: 'Failed' }, { tone: 'off', words: 'Off' },
]

const swatches = ['bg', 'bg-raised', 'surface', 'surface-3', 'text', 'text-2', 'muted', 'faint', 'primary', 'green', 'blue', 'amber', 'violet', 'red']

/**
 * The style guide, at #/kit and linked from nowhere: every piece of the kit and every base class, in its states, in
 * whichever theme is on. It is what the look is checked against in pictures.
 */
export function KitPage() {
  const repos = useMemo(() => invent(2400), [])
  const [open, setOpen] = useState<'dialog' | 'small' | 'guided' | undefined>()
  const [hearing, setHearing] = useState(true)
  const [mode, setMode] = useState('Watch')
  const [tab, setTab] = useState('Pull requests')
  const [picked, setPicked] = useState<Repo>()

  return (
    <div className="page kit-page">
      <div className="page-column">
        <PageHeader eyebrow="Style guide" title="The kit" lead="Every piece a screen is made of, in its states, in this theme." action={<button type="button" className="button primary"><Plus size={16} />Add an agent</button>} />

        <Section title="Colour" lead="Colour is for state: green done, blue running, amber waiting on you, violet in review, red failed.">
          <div className="kit-swatches">
            {swatches.map((name) => <span key={name} className="kit-swatch"><i style={{ background: `var(--${name})` }} />--{name}</span>)}
          </div>
        </Section>

        <Section title="Type" lead="Nunito for titles, Nunito Sans for text. 12, 13, 14 for text; 16, 20, 26 for titles.">
          <div className="kit-type">
            <p className="page-title">Page title, 26</p>
            <p style={{ font: '800 var(--font-20)/var(--leading-20) var(--display)', margin: 0 }}>Dialog title, 20</p>
            <p className="section-title">Section title, 16</p>
            <p style={{ fontSize: 'var(--font-14)' }}>Text, 14: what most of the app says.</p>
            <p style={{ fontSize: 'var(--font-13)', color: 'var(--muted)' }}>Secondary, 13: a row’s line, a lead.</p>
            <p style={{ fontSize: 'var(--font-12)', color: 'var(--faint)' }}>Small, 12: a time, a count, a hint.</p>
            <p className="eyebrow">An eyebrow, rarely</p>
          </div>
        </Section>

        <Section title="Buttons" lead="One primary action a screen. One height a size, one radius, the same states everywhere.">
          <div className="kit-grid">
            <button type="button" className="button primary">Primary</button>
            <button type="button" className="button">Secondary</button>
            <button type="button" className="button quiet">Quiet</button>
            <button type="button" className="button danger">Danger</button>
            <button type="button" className="button danger primary">Delete for good</button>
            <button type="button" className="button" disabled>Disabled</button>
            <button type="button" className="button primary" disabled>Disabled</button>
          </div>
          <div className="kit-grid">
            <button type="button" className="button primary big">Big, 44</button>
            <button type="button" className="button primary"><Plus size={16} />With an icon</button>
            <button type="button" className="button small">Small, 28</button>
            <button type="button" className="mini-button primary">Mini, as small</button>
            <button type="button" className="mini-button">Mini</button>
            <ConfirmButton question="Remove it? Press again" onConfirm={() => toast('Removed')} className="button danger small"><Trash2 size={14} />Asks first</ConfirmButton>
          </div>
          <div className="kit-grid">
            <button type="button" className="icon-button" aria-label="Settings" data-tip="Settings"><Settings size={16} /></button>
            <button type="button" className="icon-button" aria-label="Search" data-tip="Search"><Search size={16} /></button>
            <button type="button" className="icon-button" aria-label="Disabled" disabled><Trash2 size={16} /></button>
            <MenuButton label="More for this" items={[{ label: 'Rename', onSelect: () => toast('Rename') }, { label: 'Copy link', onSelect: () => toast('Copied') }, { separator: true }, { label: 'Delete', danger: true, confirm: 'Delete it? Press again', onSelect: () => toast('Deleted') }]} />
            <button type="button" className="text-button">A text button</button>
            <button type="button" className="text-button" disabled>Disabled</button>
          </div>
        </Section>

        <div className="kit-two">
          <Section title="Fields" lead="A field is its name over a box as wide as the form.">
            <form className="form" onSubmit={(e) => e.preventDefault()}>
              <Field label="Name" hint="What people call it."><input defaultValue="Support mail" /></Field>
              <Field label="Where its notes go"><select defaultValue="b"><option value="a">Inbox</option><option value="b">From outside</option></select></Field>
              <Field label="An address" hint="It has to start with https://."><input placeholder="https://hooks.slack.com/services/…" aria-invalid="true" /></Field>
              <Field label="What it says"><textarea defaultValue="A line to every channel when something waits on someone." /></Field>
              <Field label="Can’t be changed"><input defaultValue="example/harbor" disabled /></Field>
              <label className="check"><input type="checkbox" defaultChecked /> Ask before merging</label>
              <div className="checks">
                <label className="check"><input type="radio" name="kit-who" defaultChecked /> Anyone</label>
                <label className="check"><input type="radio" name="kit-who" /> People in this binder</label>
              </div>
              <div className="form-actions"><button type="button" className="button">Cancel</button><button type="submit" className="button primary">Save</button></div>
            </form>
          </Section>

          <Section title="Choices" lead="On or off, one of a few, and views of one thing.">
            <div className="kit-grid column">
              <label className="switch"><input type="checkbox" checked={hearing} onChange={(e) => setHearing(e.target.checked)} /><span />Hearing</label>
              <label className="switch"><input type="checkbox" disabled /><span />Can’t be changed</label>
              <div className="segmented" role="group" aria-label="Hearing">
                {['Off', 'Watch', 'On'].map((m) => <button key={m} type="button" aria-pressed={mode === m} onClick={() => setMode(m)}>{m}</button>)}
              </div>
              <div className="tabs" role="group" aria-label="Views">
                {['Pull requests', 'Debrief', 'Challenge'].map((t) => <button key={t} type="button" aria-pressed={tab === t} onClick={() => setTab(t)}>{t}</button>)}
              </div>
              <div className="chips">
                <span className="chip">A chip</span>
                <span className="chip green"><i />Merged</span>
                <span className="chip amber"><i />Waiting</span>
                <span className="tag">react</span>
                <span className="tag mono">api</span>
              </div>
              <div className="kit-grid">{tones.map((t) => <Status key={t.tone} tone={t.tone}>{t.words}</Status>)}</div>
            </div>
          </Section>
        </div>

        <Section title="Listeners" lead="Things are rows: press one to change it." action={<button type="button" className="button small"><Plus size={14} />Add</button>}
          more={<p>Each thing a listener hears becomes a note in a folder here. A new one starts in Watch: the hub says what it would file and files nothing, until you turn it On.</p>}>
          <Rows label="Listeners">
            <Row icon={<Mail size={16} />} title="Support mail" meta="An address to post to · From outside" status={<Status tone="ok">On</Status>} onPress={() => toast('Opens Support mail')} />
            <Row icon={<Inbox size={16} />} title="Team channel" meta="An address to post to · Inbox" status={<Status tone="waiting">Watching</Status>} trailing={<MenuButton label="More for Team channel" items={[{ label: 'New secret', onSelect: () => toast('New secret') }, { label: 'Remove', danger: true, confirm: 'Remove it? Press again', onSelect: () => toast('Removed') }]} />} onPress={() => toast('Opens Team channel')} />
            <Row icon={<GitBranch size={16} />} title="Issues on example/harbor" meta="Opened on GitHub · Inbox" trailing={<label className="switch"><input type="checkbox" checked={hearing} onChange={(e) => setHearing(e.target.checked)} aria-label="Hearing issues" /><span /></label>} />
            <Row icon={<KeyRound size={16} />} title="The one this page is about" meta="Current" current onPress={() => {}} />
            <Row icon={<Lock size={16} />} title="Someone else’s" meta="Only its owner can change it" disabled onPress={() => {}} />
          </Rows>
        </Section>

        <Section title="Repos" lead={`A table that pages: ${repos.length.toLocaleString()} rows, 50 drawn at a time.`}>
          <DataTable label="Repos" columns={columns} rows={repos} rowKey={(r) => r.name} onRowPress={setPicked} rowLabel={(r) => `Open ${r.name}`} filter="Filter repos" />
        </Section>

        <div className="kit-two">
          <Section title="Loading">
            <DataTable label="Repos on their way" columns={columns} rows={[]} rowKey={(r) => r.name} loading />
            <div><Skeleton lines={3} /></div>
          </Section>
          <Section title="Empty">
            <EmptyState icon={<Bot size={20} />} title="No agents yet" line="An agent takes cards from the board and hands them back as pull requests." action={<button type="button" className="button primary small"><Plus size={14} />Add an agent</button>} />
          </Section>
        </div>

        <Section title="Over the page" lead="A dialog, the guided dialog, a toast, a menu. On a phone a dialog is a sheet from the bottom." card={false}>
          <div className="kit-grid">
            <button type="button" className="button" onClick={() => setOpen('dialog')}>A dialog</button>
            <button type="button" className="button" onClick={() => setOpen('small')}>A small dialog</button>
            <button type="button" className="button primary" onClick={() => setOpen('guided')}>The guided dialog</button>
            <button type="button" className="button" onClick={() => toast('Saved', { action: { label: 'Undo', run: () => toast('Undone') } })}>A toast</button>
            <button type="button" className="button" onClick={() => failure('The hub isn’t reachable')}>A failure</button>
          </div>
          <More summary="How dialogs behave"><p>Escape and the scrim close a dialog, and focus goes back to what opened it. Its header and footer stay put while its body scrolls.</p></More>
        </Section>
      </div>

      <AnimatePresence>
        {open === 'dialog' && (
          <Dialog key="dialog" title="Support mail" onClose={() => setOpen(undefined)} footer={<><button type="button" className="button danger dialog-foot-start">Remove</button><button type="button" className="button" onClick={() => setOpen(undefined)}>Cancel</button><button type="button" className="button primary" onClick={() => setOpen(undefined)}>Save</button></>}>
            <div className="form">
              <Field label="Name"><input defaultValue="Support mail" /></Field>
              <Field label="Where its notes go" hint="It's made at the top of the binder if it isn't there."><input defaultValue="From outside" /></Field>
              <Field label="Who has its address"><select defaultValue="anyone"><option value="anyone">Anyone</option><option value="people">Only people in this binder</option></select></Field>
            </div>
          </Dialog>
        )}
        {open === 'small' && (
          <Dialog key="small" size="small" title="Leave this binder?" onClose={() => setOpen(undefined)} footer={<><button type="button" className="button" onClick={() => setOpen(undefined)}>Stay</button><button type="button" className="button danger primary" onClick={() => setOpen(undefined)}>Leave</button></>}>
            <p style={{ margin: 0, color: 'var(--muted)' }}>You can come back if someone adds you again.</p>
          </Dialog>
        )}
        {open === 'guided' && (
          <Guided key="guided" title="Add an agent" question="What kind?" lead="Each way ends with an agent on the board, ready for cards." onClose={() => setOpen(undefined)}
            options={[
              { id: 'machine', icon: <Laptop size={18} />, name: 'A machine with your code', line: 'It runs Claude Code, Codex or another tool where your repos are.', recommended: true },
              { id: 'model', icon: <Cloud size={18} />, name: 'A model, with no machine', line: 'The hub runs it. It writes and answers, and can’t change code.' },
              { id: 'hand', icon: <Settings size={18} />, name: 'Set one up by hand', line: 'Its name, its repos and its skills, one by one.' },
              { id: 'claude', icon: <Terminal size={18} />, name: 'Connect Claude Code', line: 'Add this hub to Claude Code on your own computer.' },
            ]}
            steps={(option) => option === 'machine' ? [
              { title: 'Which machine?', lead: 'The one with your code on it.', content: <div className="form"><Field label="Its name"><input placeholder="Studio Mac" /></Field></div>, footer: (nav) => <button type="button" className="button primary" onClick={nav.next}>Next</button> },
              { title: 'Run this on it', content: <pre className="kit-pre">npx binders-runner join</pre>, footer: (nav) => <button type="button" className="button primary" onClick={nav.next}>It’s running</button> },
              { title: 'It joined', content: <EmptyState compact icon={<Bot size={18} />} title="Studio Mac is listening for work" />, footer: (nav) => <button type="button" className="button primary" onClick={nav.close}>Done</button> },
            ] : [
              { title: option === 'model' ? 'Which model?' : option === 'hand' ? 'Its name and repos' : 'Copy the command', content: <form className="form" onSubmit={(e) => { e.preventDefault(); setOpen(undefined) }}><Field label="Name"><input /></Field><div className="form-actions"><button type="submit" className="button primary">Add it</button></div></form> },
            ]} />
        )}
        {picked && (
          <Dialog key="repo" title={picked.name} onClose={() => setPicked(undefined)} footer={<button type="button" className="button primary" onClick={() => setPicked(undefined)}>Done</button>}>
            <p style={{ margin: 0, color: 'var(--muted)' }}>{picked.visibility} · its brief: {picked.brief.toLowerCase()} · changed {picked.changed}</p>
          </Dialog>
        )}
      </AnimatePresence>
    </div>
  )
}
