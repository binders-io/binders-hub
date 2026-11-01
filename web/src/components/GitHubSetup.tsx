import { useEffect, useState, type FormEvent } from 'react'
import { AlertTriangle, ArrowUpRight, Check, LoaderCircle } from 'lucide-react'
import { call } from '../data/api'
import { useStore } from '../data/store'
import { Github } from './Github'
import { attempt } from './Toast'
import { connectHref } from '../data/space'
import type { Me } from '../data/model'

/** The binder's name, for the app's: app names are unique across GitHub. */
const here = (me?: Me) => me?.spaces.find((s) => s.id === me.space)?.name

type Lack = { permission: string; level: 'read' | 'write'; for: string }
type Health = {
  app: { name: string; slug: string; owner: string; ownerType: string; url: string; settingsUrl: string }
  missing: Lack[]
  installations: { account: string; gone?: boolean; selection?: 'all' | 'selected'; repos?: number; url?: string; suspended?: boolean; pending?: Lack[] }[]
}

/** An app another binder made on an organization, which this one may use instead of making its own. */
type Offer = { binder: { id: string; name: string }; app: { name: string; slug: string; owner: string; htmlUrl: string; installations: string[] } }

const words = (p: string) => p.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase())

/**
 * This binder's GitHub: a GitHub App, its own or, on an organization, one another binder there made. One made on a
 * person's own account serves only the binder it was made for. Until there's one, the two steps that make and install
 * it (GitHub's manifest flow makes the app and hands its keys back; installing it picks the repos), after offering an
 * organization's app that a binder this person runs has already. Once there is, how it stands as GitHub says now: the
 * app, what it lacks of what the hub needs and where to fix that, and each installation with its repos and any
 * permission its account hasn't accepted yet.
 */
export function GitHubSetup() {
  const { state } = useStore()
  const me = state.me
  if (!me) return null
  const github = me.github
  if (github.mode === 'manual') return <p className="setup-note">This hub’s GitHub is set up by hand on the hub, through its GITHUB_* settings. Change it there.</p>
  return (
    <div className="setup">
      {github.local && (
        <p className="setup-note">
          People reach this hub at <b className="mono">{me.publicUrl}</b>, which GitHub can’t send events to, so the app is made without a webhook.
          Issues and merging work; checks and deployments won’t arrive. For those, put the hub behind a public address and set PUBLIC_URL to it.
        </p>
      )}
      {github.lost && (
        <p className="setup-note gh-lost">
          <AlertTriangle size={14} /> The app this binder used, from the <b>{me.spaces.find((s) => s.id === github.lost!.from)?.name ?? github.lost.from}</b> binder, is gone: {github.lost.why}. This binder doesn’t reach GitHub through it any more. Use another, or make it an app of its own.
        </p>
      )}
      {github.app && (github.app.installations.length || github.app.borrowedFrom) ? <Overview me={me} /> : <Steps me={me} />}
    </div>
  )
}

function Steps({ me }: { me: Me }) {
  const github = me.github
  const app = github.app
  const [owner, setOwner] = useState<'me' | 'org'>('org')
  const [org, setOrg] = useState('')
  // App names are unique across GitHub, so the default carries who it's for.
  const [name, setName] = useState(() => `Binders for ${here(me) ?? me.user.login}`.slice(0, 34))
  const [busy, setBusy] = useState(false)
  // Organizations' apps from binders this person runs, which this one may use rather than making one more.
  const [offers, setOffers] = useState<Offer[]>([])
  useEffect(() => {
    if (!github.admin || app) return
    void call<{ apps: Offer[] }>('GET', '/api/github/reusable').then((r) => setOffers(r.apps)).catch(() => setOffers([]))
  }, [github.admin, app])
  const reuse = async (offer: Offer) => {
    setBusy(true)
    const done = await attempt(async () => { await call('POST', '/api/github/app/reuse', { from: offer.binder.id }); return true })
    setBusy(false)
    if (done) window.location.reload()
  }
  // The organization typed in has an app already: say so, rather than make a second.
  const sameOrg = owner === 'org' ? offers.find((o) => o.app.owner.toLowerCase() === org.trim().toLowerCase()) : undefined
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
  return (
    <ol className="setup-steps">
      <li className={app ? 'done' : 'now'}>
        <span className="step-mark">{app ? <Check size={13} strokeWidth={3} /> : 1}</span>
        <div>
          <h3>Make this binder’s GitHub App</h3>
          {app ? (
            <p><b>{app.name}</b> on <b>@{app.owner}</b>. <a href={app.htmlUrl} target="_blank" rel="noreferrer">Open it on GitHub <ArrowUpRight size={11} /></a></p>
          ) : github.admin ? (
            <form className="setup-form" onSubmit={create}>
              {offers.length > 0 && (
                <div className="gh-offers">
                  {offers.map((offer) => (
                    <p key={offer.binder.id}>
                      <b>@{offer.app.owner}</b> has <b>{offer.app.name}</b> already, made for the <b>{offer.binder.name}</b> binder{offer.app.installations.length ? `, installed on ${offer.app.installations.map((a) => `@${a}`).join(', ')}` : ''}. If this binder works in @{offer.app.owner} too, use it here rather than make another.{' '}
                      <button type="button" className="button primary" disabled={busy} onClick={() => void reuse(offer)}><Github size={14} /> Use {offer.app.name}</button>
                    </p>
                  ))}
                  <p className="faint">Or make this binder an app of its own:</p>
                </div>
              )}
              <p>GitHub makes the app with everything Binders needs and hands its keys straight back here. Make it on the organization whose repos this binder works in: other binders in that organization can use it too. One made on your own account serves this binder alone.</p>
              <div className="owner-choice" role="radiogroup" aria-label="Whose app">
                <label className="check"><input type="radio" name="owner" id="owner-org" checked={owner === 'org'} onChange={() => setOwner('org')} /> An organization</label>
                {owner === 'org' && <input id="owner-org-name" className="mono" value={org} onChange={(e) => setOrg(e.target.value)} placeholder="organization" required />}
                {sameOrg && <span className="faint">@{sameOrg.app.owner} has an app already: <button type="button" className="text-button" disabled={busy} onClick={() => void reuse(sameOrg)}>use {sameOrg.app.name}</button>.</span>}
                <label className="check"><input type="radio" name="owner" id="owner-me" checked={owner === 'me'} onChange={() => setOwner('me')} /> My account</label>
              </div>
              <label className="field">
                <span className="field-label">The app’s name on GitHub</span>
                <input id="app-name" value={name} maxLength={34} onChange={(e) => setName(e.target.value)} />
              </label>
              <button className="button primary" disabled={busy || !name.trim() || (owner === 'org' && !org.trim())}><Github size={15} /> Create on GitHub</button>
            </form>
          ) : (
            <p>Not yet. This binder’s owners and admins set it up.</p>
          )}
        </div>
      </li>
      <li className={app ? 'now' : 'later'}>
        <span className="step-mark">2</span>
        <div>
          <h3>Install it on the repos</h3>
          {app ? (
            <>
              <p>Pick the repos this binder works with. GitHub brings you back here.</p>
              <a className="button primary" href={app.installUrl}>Install on GitHub</a>
            </>
          ) : <p>After the app is made.</p>}
        </div>
      </li>
    </ol>
  )
}

function Overview({ me }: { me: Me }) {
  const app = me.github.app!
  const lender = app.borrowedFrom ? me.spaces.find((s) => s.id === app.borrowedFrom)?.name ?? app.borrowedFrom : undefined
  const [health, setHealth] = useState<Health | null>()
  const [sure, setSure] = useState(false)
  useEffect(() => { void call<{ health?: Health }>('GET', '/api/github/health').then((r) => setHealth(r.health ?? null)).catch(() => setHealth(null)) }, [])
  const forget = async () => {
    if (await attempt(async () => { await call('DELETE', '/api/github/app'); return true })) window.location.reload()
  }
  const endLoan = async (to: string) => {
    if (await attempt(async () => { await call('DELETE', `/api/github/app/loans/${encodeURIComponent(to)}`); return true })) window.location.reload()
  }
  const nameOf = (id: string) => me.spaces.find((s) => s.id === id)?.name ?? id
  const problems = health ? health.missing.length + health.installations.reduce((n, i) => n + (i.pending?.length ?? 0) + (i.gone || i.suspended ? 1 : 0), 0) : 0
  return (
    <>
      <section className="settings-card gh-app">
        <Github size={22} />
        <div>
          <b>{app.name}</b>
          <span className="faint">
            {lender
              ? <>The <b>{lender}</b> binder’s GitHub App, on the organization @{app.owner}, used here too. Its permissions and installations are changed from {lender}.</>
              : app.ownerType === 'Organization'
                ? <>This binder’s GitHub App, on the organization @{app.owner}. Its owners and admins may lend it to other binders in @{app.owner}, which reach only @{app.owner}’s installation.</>
                : <>This binder’s GitHub App, on @{app.owner}’s own account: it serves this binder alone.</>}
          </span>
        </div>
        <a className="button" href={app.htmlUrl} target="_blank" rel="noreferrer">On GitHub <ArrowUpRight size={12} /></a>
      </section>

      {health === undefined && <p className="faint"><LoaderCircle size={13} className="spin" /> Asking GitHub how it stands…</p>}
      {health === null && <p className="setup-note">GitHub didn’t say how the app stands just now. The rest still works; look again later.</p>}
      {health && problems > 0 && (
        <ul className="gh-problems">
          {health.missing.map((m) => (
            <li key={m.permission}>
              <AlertTriangle size={15} />
              <span>The app doesn’t ask for <b>{words(m.permission)} ({m.level === 'write' ? 'read and write' : 'read'})</b>, which {m.for} needs.{' '}
                {me.github.admin ? <>Add it in <a href={health.app.settingsUrl} target="_blank" rel="noreferrer">the app’s permissions <ArrowUpRight size={11} /></a>, then accept it where it’s installed.</> : 'Its owners and admins add it.'}</span>
            </li>
          ))}
          {health.installations.flatMap((i) => [
            ...(i.gone ? [<li key={`${i.account}-gone`}><AlertTriangle size={15} /><span>It’s no longer installed on <b>@{i.account}</b>. <a href={app.installUrl}>Install it again</a>.</span></li>] : []),
            ...(i.suspended ? [<li key={`${i.account}-suspended`}><AlertTriangle size={15} /><span>Its installation on <b>@{i.account}</b> is suspended. <a href={i.url} target="_blank" rel="noreferrer">Unsuspend it</a>.</span></li>] : []),
            ...(i.pending ?? []).map((p) => (
              <li key={`${i.account}-${p.permission}`}>
                <AlertTriangle size={15} />
                <span><b>@{i.account}</b> hasn’t accepted <b>{words(p.permission)} ({p.level === 'write' ? 'read and write' : 'read'})</b> yet, which {p.for} needs. An owner of @{i.account} accepts it <a href={i.url} target="_blank" rel="noreferrer">on the installation <ArrowUpRight size={11} /></a>.</span>
              </li>
            )),
          ])}
        </ul>
      )}
      {health && problems === 0 && <p className="gh-fine"><Check size={14} /> It has every permission the hub needs, accepted where it’s installed.</p>}
      {me.github.token
        ? <p className="gh-fine"><Check size={14} /> You’re connected to it, so you link its repos to agents, approve and merge as yourself.</p>
        : (
          <div className="gh-you">
            <AlertTriangle size={15} />
            <span>You’re not connected to it yet. The app being here lets the hub work in its repos; connecting lets you link repos to agents, approve and merge, as yourself. Sign in to GitHub as your @{app.owner} account first.</span>
            <a className="button primary" href={connectHref}><Github size={14} /> Connect</a>
          </div>
        )}

      <h3 className="settings-sub">Where it’s installed</h3>
      <ul className="status-list">
        {(health?.installations ?? app.installations.map((account): Health['installations'][number] => ({ account }))).map((i) => (
          <li key={i.account} className={i.gone ? '' : 'ok'}>
            <span className="status-icon"><Check size={13} strokeWidth={3} /></span>
            <div>
              <b>@{i.account}</b>
              <span>{i.repos !== undefined ? `${i.repos} repo${i.repos === 1 ? '' : 's'}${i.selection === 'all' ? ', all of them' : ', chosen'}` : 'Its repos'} · their issues, pull requests and notes are this binder’s to work with.</span>
            </div>
            {i.url && <a className="button" href={i.url} target="_blank" rel="noreferrer">Change repos</a>}
          </li>
        ))}
      </ul>

      {!lender && !!app.lentTo?.length && (
        <>
          <h3 className="settings-sub">Lent to</h3>
          <ul className="status-list">
            {app.lentTo.map((loan) => (
              <li key={loan.binder} className="ok">
                <span className="status-icon"><Check size={13} strokeWidth={3} /></span>
                <div>
                  <b>{nameOf(loan.binder)}</b>
                  <span>Lent by @{loan.by} on {new Date(loan.at).toLocaleDateString()} · its people sign in through this app and reach @{app.owner}’s repos with it, while @{loan.by} runs this binder.</span>
                </div>
                {me.github.admin && <button className="button" onClick={() => void endLoan(loan.binder)}>Stop lending</button>}
              </li>
            ))}
          </ul>
        </>
      )}

      {me.github.admin && (
        <p className="setup-note">
          Each binder’s repo is set in Settings → Binder, from the repos above.{' '}
          {sure
            ? lender
              ? <><b>Stop using it?</b> This binder stops reaching GitHub through {lender}’s app; {lender} keeps it. <button className="text-button danger" onClick={() => void forget()}>Stop using it</button> <button className="text-button" onClick={() => setSure(false)}>Keep it</button></>
              : <><b>Forget this app?</b> This binder stops using it{app.shareable ? ', and so do the other binders that use it' : ''}; it stays on GitHub until you delete it there. <button className="text-button danger" onClick={() => void forget()}>Forget it</button> <button className="text-button" onClick={() => setSure(false)}>Keep it</button></>
            : <button className="text-button" onClick={() => setSure(true)}>{lender ? 'Stop using this app…' : 'Forget this app…'}</button>}
        </p>
      )}
    </>
  )
}
