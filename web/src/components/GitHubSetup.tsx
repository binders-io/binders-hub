import { useEffect, useState, type FormEvent } from 'react'
import { AnimatePresence } from 'motion/react'
import { AlertTriangle, ArrowUpRight, Check, FolderGit2, Plus, Radio, UserRound } from 'lucide-react'
import { call } from '../data/api'
import { useStore } from '../data/store'
import { Github } from './Github'
import { attempt } from './Toast'
import { ConfirmButton } from './ConfirmButton'
import { connectHref } from '../data/space'
import type { Me } from '../data/model'
import { Dialog, EmptyState, Guided, Row, Rows, Section, Status, type GuidedOption, type GuidedStep } from '../kit'

/** The binder's name, for the app's: app names are unique across GitHub. */
const here = (me?: Me) => me?.spaces.find((s) => s.id === me.space)?.name

type Lack = { permission: string; level: 'read' | 'write'; for: string }
type Health = {
  app: { name: string; slug: string; owner: string; ownerType: string; url: string; settingsUrl: string }
  missing: Lack[]
  installations: { account: string; gone?: boolean; selection?: 'all' | 'selected'; repos?: number; url?: string; suspended?: boolean; pending?: Lack[] }[]
}

/** What the app reaches on each account it's installed on, as the hub has read it, and its repos' custom properties. */
interface RepoList {
  account: string
  kind?: 'User' | 'Organization'
  indexed: number
  total?: number
  complete: boolean
  reading: boolean
  failed: boolean
  properties?: 'listed' | 'organization' | 'denied' | 'failed' | 'none'
}
type Lists = { installations: RepoList[]; permissionsUrl?: string }

/**
 * Another binder's GitHub App, whose installations this one may use instead of making its own: those GitHub lets this
 * person reach (an organization they're in, or their own account). `hub`: the hub's first binder's, the hub's own app.
 */
export type Offer = { binder: { id: string; name: string }; hub?: boolean; app: { name: string; slug: string; owner: string; htmlUrl: string; installations: { account: string; type?: 'User' | 'Organization' }[] }; unreached?: string[] }

const words = (p: string) => p.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase())
const count = (n: number) => n.toLocaleString()
const plural = (n: number, one: string, many = `${one}s`) => `${count(n)} ${n === 1 ? one : many}`

/**
 * This binder's GitHub: a GitHub App, its own or another binder's (the hub's, usually), used through the installations
 * its people can reach. While something is still to do, a guided setup: use the hub's app or another binder's, by
 * installation, or make one of its own (GitHub's manifest flow makes the app and hands its keys back; installing it picks
 * the repos). Once it's set up, a short summary of how it stands, a row each: the app, your own connection to it, what it
 * reaches, and whether GitHub's news arrives. Each row opens what there is to see or do about it.
 */
export function GitHubSetup() {
  const { state } = useStore()
  const me = state.me
  if (!me) return null
  const github = me.github
  if (github.mode === 'manual') {
    return (
      <Section title="Connection">
        <Rows label="Connection">
          <Row icon={<Github size={16} />} title="Set up by hand on the hub" meta="Through its GITHUB_* settings. It’s changed there." status={<Status tone="ok">Connected</Status>} />
        </Rows>
      </Section>
    )
  }
  return (
    <>
      {github.lost && (
        <p className="setup-warning gh-lost" role="status">
          <AlertTriangle size={15} aria-hidden="true" />
          <span>The app this binder used, from the <b>{me.spaces.find((s) => s.id === github.lost!.from)?.name ?? github.lost.from}</b> binder, is gone: {github.lost.why}. This binder doesn’t reach GitHub through it any more. Use another, or make one of its own.</span>
        </p>
      )}
      {github.app && (github.app.installations.length || github.app.borrowedFrom) ? <Overview me={me} /> : <Setup me={me} />}
    </>
  )
}

/** Where GitHub's events can't reach this hub: said once, behind "How this works". */
function LocalNote({ me }: { me: Me }) {
  return (
    <p>
      People reach this hub at <b className="mono">{me.publicUrl}</b>, which GitHub can’t send events to, so the app is made without a webhook.
      Issues and merging work; checks and deployments won’t arrive. For those, put the hub behind a public address and set PUBLIC_URL to it.
    </p>
  )
}

/** Not set up yet: one button that opens the guided setup, or the one step left once the app is made. */
function Setup({ me }: { me: Me }) {
  const github = me.github
  const app = github.app
  const [open, setOpen] = useState(false)
  return (
    <Section title="Connection" more={github.local ? <LocalNote me={me} /> : undefined}>
      {app ? (
        <div className="gh-setup">
          <span className="gh-setup-icon" aria-hidden="true"><Github size={20} /></span>
          <div className="gh-setup-text">
            <p className="gh-setup-step"><span>Step 2 of 2</span><span className="gh-setup-bar" aria-hidden="true"><i className="done" /><i className="done" /></span></p>
            <h4>Install it on the repos</h4>
            <p><b>{app.name}</b> is made on @{app.owner}. Pick the repos this binder works with; GitHub brings you back here.</p>
            <div className="gh-setup-actions">
              {github.admin ? <a className="button primary" href={app.installUrl}><Github size={15} />Install on GitHub</a> : <span className="faint">This binder’s owners and admins install it.</span>}
              <a className="button quiet" href={app.htmlUrl} target="_blank" rel="noreferrer">Open it on GitHub<ArrowUpRight size={13} aria-hidden="true" /></a>
            </div>
          </div>
        </div>
      ) : (
        <EmptyState
          icon={<Github size={20} />}
          title="Not connected to GitHub yet"
          line={github.admin ? 'Its agents work in the repos its GitHub App reaches, and its cards and notes go to one of them.' : 'This binder’s owners and admins set it up.'}
          action={github.admin ? <button type="button" className="button primary" onClick={() => setOpen(true)}><Github size={15} />Set up GitHub</button> : undefined}
        />
      )}
      <AnimatePresence>{open && <SetupGuide key="setup" me={me} onClose={() => setOpen(false)} />}</AnimatePresence>
    </Section>
  )
}

/**
 * The guided setup: the hub's app or another binder's, by installation, or one of its own. Using another's shares no more
 * than that installation, and only the repos this binder links from it.
 */
function SetupGuide({ me, onClose }: { me: Me; onClose: () => void }) {
  const [offers, setOffers] = useState<Offer[]>()
  const [busy, setBusy] = useState(false)
  const [owner, setOwner] = useState<'me' | 'org'>('org')
  const [org, setOrg] = useState('')
  // App names are unique across GitHub, so the default carries who it's for.
  const [name, setName] = useState(() => `Binders for ${here(me) ?? me.user.login}`.slice(0, 34))
  useEffect(() => {
    void call<{ apps: Offer[] }>('GET', '/api/github/reusable').then((r) => setOffers(Array.isArray(r?.apps) ? r.apps : [])).catch(() => setOffers([]))
  }, [])
  const reuse = async (offer: Offer, account: string) => {
    setBusy(true)
    const done = await attempt(async () => { await call('POST', '/api/github/app/reuse', { from: offer.binder.id, accounts: [account] }); return true })
    setBusy(false)
    if (done) window.location.reload()
  }
  // The organization typed in has an installation already: say so, rather than make a second app.
  const typed = org.trim().toLowerCase()
  const sameOrg = owner === 'org' && typed ? offers?.find((o) => o.app.installations.some((i) => i.account.toLowerCase() === typed)) : undefined
  const create = async (event: FormEvent) => {
    event.preventDefault()
    setBusy(true)
    const started = await attempt(() => call<{ action: string; manifest: string }>('POST', '/api/github/app', { name, org: owner === 'org' ? org : undefined }))
    setBusy(false)
    if (!started) return
    // GitHub takes the manifest as a form posted to it: the browser goes there, and comes back when the app is made.
    const form = document.createElement('form')
    form.method = 'POST'
    form.action = started.action
    const field = document.createElement('input')
    field.type = 'hidden'
    field.name = 'manifest'
    field.value = started.manifest
    form.appendChild(field)
    document.body.appendChild(form)
    form.submit()
  }
  const found = offers ?? []
  const options: GuidedOption[] = [
    ...found.map((offer) => ({
      id: `offer:${offer.binder.id}`,
      icon: <Github size={18} />,
      name: offer.hub ? 'Use the hub’s GitHub App' : `Use ${offer.app.name}`,
      line: `Made for the ${offer.binder.name} binder. Through it, this binder reaches only the repos it links.`,
      recommended: offer.hub,
    })),
    { id: 'make', icon: <Plus size={18} />, name: 'Make one of its own', line: 'GitHub makes it with everything Binders needs, and hands its keys straight back here.', recommended: !found.length },
  ]
  const steps = (id: string): GuidedStep[] => {
    const offer = found.find((o) => `offer:${o.binder.id}` === id)
    if (offer) return [{ title: 'Where is it installed?', lead: 'Pick the account whose repos this binder works in.', content: <Offers offers={[offer]} busy={busy} reuse={(o, account) => void reuse(o, account)} /> }]
    return [{
      title: 'Whose app is it?',
      lead: 'Make it on the organization whose repos this binder works in.',
      content: (
        <form id="gh-make" className="form gh-make" onSubmit={(e) => void create(e)}>
          <fieldset className="field">
            <legend className="field-label">It belongs to</legend>
            <div className="gh-owner" role="radiogroup" aria-label="Whose app">
              <label className="check"><input type="radio" name="owner" id="owner-org" checked={owner === 'org'} onChange={() => setOwner('org')} /> An organization</label>
              <label className="check"><input type="radio" name="owner" id="owner-me" checked={owner === 'me'} onChange={() => setOwner('me')} /> My account</label>
            </div>
          </fieldset>
          {owner === 'org' && (
            <label className="field">
              <span className="field-label">The organization</span>
              <input id="owner-org-name" className="mono" value={org} onChange={(e) => setOrg(e.target.value)} placeholder="its name on GitHub" autoComplete="off" spellCheck={false} required />
              {sameOrg && <span className="field-hint">{sameOrg.app.name} is installed on @{org.trim()} already: <button type="button" className="text-button" disabled={busy} onClick={() => void reuse(sameOrg, org.trim())}>use it</button> rather than make another.</span>}
            </label>
          )}
          <label className="field">
            <span className="field-label">The app’s name on GitHub</span>
            <input id="app-name" value={name} maxLength={34} onChange={(e) => setName(e.target.value)} />
            <span className="field-hint">Other binders can use its installations on organizations their people are in; one on a person’s own account is shared only by them.</span>
          </label>
        </form>
      ),
      footer: <button type="submit" form="gh-make" className="button primary" disabled={busy || !name.trim() || (owner === 'org' && !org.trim())}><Github size={15} />Create on GitHub</button>,
    }]
  }
  if (!offers) return null
  return (
    <Guided title="Set up GitHub" question="Which GitHub App?" lead="Binders works in your repos through a GitHub App." options={options} steps={steps} onClose={onClose} start={found.length ? undefined : 'make'} />
  )
}

/**
 * The installations of other binders' apps this person can reach, the hub's own app first: one button each. Using one
 * shares no more than that installation, and only the repos this binder links from it.
 */
export function Offers({ offers, busy, reuse }: { offers: Offer[]; busy: boolean; reuse: (offer: Offer, account: string) => void }) {
  return (
    <div className="gh-offers">
      {offers.map((offer) => (
        <div key={offer.binder.id} className="gh-offer">
          <p className="gh-offer-name"><b>{offer.hub ? 'Use the hub’s GitHub App' : `Use ${offer.app.name}`}</b></p>
          <ul className="gh-installs">
            {offer.app.installations.map((i) => (
              <li key={i.account}>
                <span className="gh-install-text"><b>@{i.account}</b> <span className="faint">{i.type === 'User' ? 'your own account' : 'an organization you’re in'}</span></span>
                <button type="button" className="button small primary" disabled={busy} onClick={() => reuse(offer, i.account)}>Use it for @{i.account}</button>
              </li>
            ))}
          </ul>
          {!!offer.unreached?.length && (
            <p className="field-hint">Also installed on {offer.unreached.map((a) => `@${a}`).join(', ')}, which none of your GitHub sign-ins here shows you’re in. Connect the GitHub account that’s in {offer.unreached.length === 1 ? 'it' : 'them'} (in the {offer.binder.name} binder: Your account, from your picture at the top), then come back here.</p>
          )}
        </div>
      ))}
    </div>
  )
}

/** How a set-up app stands, as rows: the app, you, what it reaches, GitHub's news. */
function Overview({ me }: { me: Me }) {
  const github = me.github
  const app = github.app!
  const lender = app.borrowedFrom ? me.spaces.find((s) => s.id === app.borrowedFrom)?.name ?? app.borrowedFrom : undefined
  const [health, setHealth] = useState<Health | null>()
  const [lists, setLists] = useState<Lists>()
  const [open, setOpen] = useState<'app' | 'reach'>()
  useEffect(() => { void call<{ health?: Health }>('GET', '/api/github/health').then((r) => setHealth(r?.health ?? null)).catch(() => setHealth(null)) }, [])
  useEffect(() => {
    let current = true
    const read = () => void call<Partial<Lists>>('GET', '/api/github/lists').then((found) => {
      if (!current || !Array.isArray(found?.installations)) return
      setLists({ installations: found.installations, permissionsUrl: found.permissionsUrl })
      // While a list is being read, how far it's got, every few seconds.
      if (found.installations.some((i) => !i.complete && !i.failed)) window.setTimeout(read, 4000)
    }, () => {})
    read()
    return () => { current = false }
  }, [])

  const problems = health ? health.missing.length + health.installations.reduce((n, i) => n + (i.pending?.length ?? 0) + (i.gone || i.suspended ? 1 : 0), 0) : 0
  const appStatus = health === undefined ? <Status tone="off">Checking</Status>
    : health === null ? <Status tone="off" title="GitHub didn’t say how the app stands just now">Not known</Status>
      : problems ? <Status tone="waiting">{problems === 1 ? '1 to fix' : `${problems} to fix`}</Status>
        : <Status tone="ok">Ready</Status>

  const accounts = lender ? app.borrowedAccounts ?? [] : app.installations
  const reached = lists?.installations.reduce((n, l) => n + (l.total ?? l.indexed), 0)
  const reading = lists?.installations.some((l) => !l.complete && !l.failed)
  const failed = lists?.installations.some((l) => l.failed)
  const all = health?.installations.every((i) => i.selection === 'all')
  const reachTitle = reached !== undefined && lists?.installations.length ? `Reaches ${plural(reached, 'repo')}` : 'Its repos'
  const reachMeta = `On ${accounts.map((a) => `@${a}`).join(', ') || 'no account yet'}${health ? (all ? ', all of their repos' : ', the repos chosen there') : ''}`

  const polling = github.polling
  const news = polling?.webhookHeard ? 'Webhooks arrive as things happen on GitHub.' : polling?.active ? `Asked for every ${polling.everySeconds} seconds, as webhooks don’t reach this hub.` : 'Neither webhooks nor asking, as HUB_POLL is off on this hub.'

  return (
    <Section title="Connection" more={github.local ? <LocalNote me={me} /> : undefined}>
      <Rows label="Connection">
        <Row icon={<Github size={16} />} title={app.name}
          meta={lender ? `The ${lender} binder’s app, used here` : `This binder’s own app, on @${app.owner}`}
          status={appStatus} onPress={() => setOpen('app')} />
        <Row icon={<UserRound size={16} />} title="Your GitHub"
          meta={github.token ? 'You link repos, approve and merge as yourself.' : `Connect to approve and merge as yourself. Sign in to GitHub as your @${app.owner} account first.`}
          status={github.token ? <Status tone="ok">Connected</Status> : undefined}
          trailing={github.token ? 'none' : <a className="button small primary" href={connectHref}><Github size={14} />Connect</a>} />
        <Row icon={<FolderGit2 size={16} />} title={reachTitle} meta={reachMeta}
          status={reading ? <Status tone="running">Reading</Status> : failed ? <Status tone="bad">GitHub didn’t answer</Status> : undefined}
          onPress={() => setOpen('reach')} />
        {github.server && (
          <Row icon={<Radio size={16} />} title="GitHub’s news" meta={news}
            status={polling?.webhookHeard || polling?.active ? <Status tone="ok">Arriving</Status> : <Status tone="off">Off</Status>} />
        )}
      </Rows>
      <AnimatePresence>
        {open === 'app' && <AppDialog key="app" me={me} lender={lender} health={health} problems={problems} onClose={() => setOpen(undefined)} />}
        {open === 'reach' && <ReachDialog key="reach" me={me} health={health} lists={lists} onClose={() => setOpen(undefined)} />}
      </AnimatePresence>
    </Section>
  )
}

/** The app itself: whose it is, what it lacks of what the hub needs and where to fix it, who it's lent to, and forgetting it. */
function AppDialog({ me, lender, health, problems, onClose }: { me: Me; lender?: string; health: Health | null | undefined; problems: number; onClose: () => void }) {
  const app = me.github.app!
  const admin = me.github.admin
  const nameOf = (id: string) => me.spaces.find((s) => s.id === id)?.name ?? id
  // Borrowing: more installations of the same app this person can reach.
  const [more, setMore] = useState<Offer[]>([])
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (!lender || !admin) return
    void call<{ apps: Offer[] }>('GET', '/api/github/reusable').then((r) => setMore(Array.isArray(r?.apps) ? r.apps : [])).catch(() => setMore([]))
  }, [lender, admin])
  const forget = async () => {
    if (await attempt(async () => { await call('DELETE', '/api/github/app'); return true })) window.location.reload()
  }
  const endLoan = async (to: string) => {
    if (await attempt(async () => { await call('DELETE', `/api/github/app/loans/${encodeURIComponent(to)}`); return true })) window.location.reload()
  }
  const addInstall = async (offer: Offer, account: string) => {
    setBusy(true)
    const done = await attempt(async () => { await call('POST', '/api/github/app/reuse', { from: offer.binder.id, accounts: [account] }); return true })
    setBusy(false)
    if (done) window.location.reload()
  }
  return (
    <Dialog title={app.name} onClose={onClose} footer={(
      <>
        {admin && (lender
          ? <ConfirmButton className="button danger dialog-foot-start" question="Stop using it? Press again" detail={`This binder stops reaching GitHub through ${lender}’s app; ${lender} keeps it.`} onConfirm={() => void forget()}>Stop using this app</ConfirmButton>
          : <ConfirmButton className="button danger dialog-foot-start" question="Forget this app? Press again" detail={`This binder stops using it${app.shareable ? ', and so do the other binders that use it' : ''}; it stays on GitHub until you delete it there.`} onConfirm={() => void forget()}>Forget this app</ConfirmButton>)}
        <a className="button" href={app.htmlUrl} target="_blank" rel="noreferrer">On GitHub<ArrowUpRight size={13} aria-hidden="true" /></a>
        <button type="button" className="button primary" onClick={onClose}>Done</button>
      </>
    )}>
      <div className="gh-dialog">
        <p className="gh-dialog-lead">
          {lender
            ? <>The <b>{lender}</b> binder’s GitHub App, used here through its installation{(app.borrowedAccounts?.length ?? 0) === 1 ? '' : 's'} on {(app.borrowedAccounts ?? []).map((a) => `@${a}`).join(', ')}, for the repos this binder links. Its permissions and installations are changed from {lender}.</>
            : <>This binder’s own GitHub App, made on @{app.owner}. Other binders may use its installations on organizations their people are in, and reach only the repos they link; its installation on a person’s own account only that person may share.</>}
        </p>
        <div className="gh-dialog-part" aria-live="polite">
          <h3 className="gh-dialog-title">Permissions</h3>
          {health === undefined && <p className="faint">Asking GitHub how it stands…</p>}
          {health === null && <p className="faint">GitHub didn’t say how the app stands just now. The rest still works; look again later.</p>}
          {health && problems === 0 && <p className="gh-fine"><Check size={14} aria-hidden="true" /> It has every permission the hub needs, accepted where it’s installed.</p>}
          {health && problems > 0 && (
            <ul className="gh-problems">
              {health.missing.map((m) => (
                <li key={m.permission}>
                  <AlertTriangle size={15} aria-hidden="true" />
                  <span>The app doesn’t ask for <b>{words(m.permission)} ({m.level === 'write' ? 'read and write' : 'read'})</b>, which {m.for} needs.{' '}
                    {admin ? <>Add it in <a href={health.app.settingsUrl} target="_blank" rel="noreferrer">the app’s permissions <ArrowUpRight size={11} aria-hidden="true" /></a>, then accept it where it’s installed.</> : 'Its owners and admins add it.'}</span>
                </li>
              ))}
              {health.installations.flatMap((i) => [
                ...(i.gone ? [<li key={`${i.account}-gone`}><AlertTriangle size={15} aria-hidden="true" /><span>It’s no longer installed on <b>@{i.account}</b>. <a href={app.installUrl}>Install it again</a>.</span></li>] : []),
                ...(i.suspended ? [<li key={`${i.account}-suspended`}><AlertTriangle size={15} aria-hidden="true" /><span>Its installation on <b>@{i.account}</b> is suspended. <a href={i.url} target="_blank" rel="noreferrer">Unsuspend it</a>.</span></li>] : []),
                ...(i.pending ?? []).map((p) => (
                  <li key={`${i.account}-${p.permission}`}>
                    <AlertTriangle size={15} aria-hidden="true" />
                    <span><b>@{i.account}</b> hasn’t accepted <b>{words(p.permission)} ({p.level === 'write' ? 'read and write' : 'read'})</b> yet, which {p.for} needs. An owner of @{i.account} accepts it <a href={i.url} target="_blank" rel="noreferrer">on the installation <ArrowUpRight size={11} aria-hidden="true" /></a>.</span>
                  </li>
                )),
              ])}
            </ul>
          )}
        </div>
        {!lender && !!app.lentTo?.length && (
          <div className="gh-dialog-part">
            <h3 className="gh-dialog-title">Lent to</h3>
            <Rows label="Lent to">
              {app.lentTo.map((loan) => (
                <Row key={loan.binder} icon={<Check size={16} />} title={nameOf(loan.binder)}
                  meta={`Asked for by @${loan.by} on ${new Date(loan.at).toLocaleDateString()} · ${(loan.accounts ?? [app.owner]).map((a) => `@${a}`).join(', ')}`}
                  trailing={admin ? <button type="button" className="button small" onClick={() => void endLoan(loan.binder)}>Stop lending</button> : 'none'} />
              ))}
            </Rows>
          </div>
        )}
        {lender && more.length > 0 && (
          <div className="gh-dialog-part">
            <h3 className="gh-dialog-title">Use it for more</h3>
            <Offers offers={more} busy={busy} reuse={(offer, account) => void addInstall(offer, account)} />
          </div>
        )}
      </div>
    </Dialog>
  )
}

/** What the app reaches: each account it's installed on, its repos, how far the hub has read them, and their custom properties. */
function ReachDialog({ me, health, lists, onClose }: { me: Me; health: Health | null | undefined; lists?: Lists; onClose: () => void }) {
  const app = me.github.app!
  const installations = health?.installations ?? app.installations.map((account): Health['installations'][number] => ({ account }))
  const listOf = (account: string) => lists?.installations.find((l) => l.account.toLowerCase() === account.toLowerCase())
  const accounts = [...new Set([...installations.map((i) => i.account), ...(lists?.installations ?? []).map((l) => l.account)])]
  return (
    <Dialog title="What the app reaches" onClose={onClose} footer={<button type="button" className="button primary" onClick={onClose}>Done</button>}>
      <div className="gh-dialog">
        <p className="gh-dialog-lead">Its issues, pull requests and notes are this binder’s to work with. Which repos it reaches is changed on GitHub.</p>
        <ul className="gh-reach">
          {accounts.map((account) => {
            const i = installations.find((x) => x.account === account)
            const list = listOf(account)
            return (
              <li key={account}>
                <div className="gh-reach-head">
                  <b>@{account}</b>
                  {i?.url && <a className="button small" href={i.url} target="_blank" rel="noreferrer">Change repos<ArrowUpRight size={13} aria-hidden="true" /></a>}
                </div>
                <p>
                  {i?.repos !== undefined ? `${i.selection === 'all' ? `All ${count(i.repos)} of its repos` : `${plural(i.repos, 'repo')}, chosen on GitHub`}.` : ''}{' '}
                  {list && (list.complete
                    ? i?.repos !== undefined && i.repos === list.indexed
                      ? `Read with their topics${list.properties === 'listed' || list.properties === 'organization' ? ' and custom properties' : ''}.`
                      : `${plural(list.indexed, 'repo')} the app reaches${list.properties === 'listed' || list.properties === 'organization' ? ', with their topics and custom properties' : ', with their topics'}.`
                    : list.failed
                      ? `GitHub didn’t answer while its repos were read${list.indexed ? `, after ${count(list.indexed)}` : ''}. The hub tries again in a few minutes.`
                      : `Reading its repos from GitHub: ${count(list.indexed)}${list.total ? ` of ${count(list.total)}` : ''} so far.`)}
                </p>
                {list?.complete && list.kind !== 'User' && list.properties === 'denied' && (
                  <p className="field-hint">
                    GitHub didn’t give the app @{account}’s custom properties, if it uses any. To filter by them, the app needs Custom properties (read) under Organization permissions{lists?.permissionsUrl ? <>: <a href={lists.permissionsUrl} target="_blank" rel="noreferrer">its permissions on GitHub <ArrowUpRight size={11} aria-hidden="true" /></a></> : ''}. @{account} then accepts it, and the hub reads them within six hours.
                  </p>
                )}
              </li>
            )
          })}
        </ul>
      </div>
    </Dialog>
  )
}
