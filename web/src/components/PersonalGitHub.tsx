import { useEffect, useState, type FormEvent } from 'react'
import { AnimatePresence } from 'motion/react'
import { ArrowUpRight, Check } from 'lucide-react'
import { call } from '../data/api'
import { attempt, toast } from './Toast'
import { ConfirmButton } from './ConfirmButton'
import { Github } from './Github'
import { Dialog, Row, Rows, Section, Status } from '../kit'

type Personal = { repo?: string; suggested: string; oauth: boolean; oauthApp: { set: boolean; clientId?: string }; callback: string; connected: boolean }

/** A step's mark: its number while it's to do, a tick once it's done. */
const mark = (n: number, done: boolean) => (done ? <Check size={16} strokeWidth={2.5} /> : <span className="step-num">{n}</span>)

/**
 * Your personal binder's GitHub: your own OAuth App, kept for you alone (no other person or binder sees it), and your own
 * GitHub connected through it, so this binder's notes are kept in a private repo in your own account. Three steps, as
 * rows: make the OAuth App (a dialog: the link fills in GitHub's form, then its keys are pasted here), connect, make the
 * repo. Each says how it stands once done, with what undoes it.
 */
export function PersonalGitHub() {
  const [status, setStatus] = useState<Personal>()
  const [making, setMaking] = useState(false)
  useEffect(() => { void call<Personal>('GET', '/api/personal').then(setStatus).catch(() => {}) }, [])
  if (!status) return null
  const remove = () => void attempt(() => call<Personal>('DELETE', '/api/personal/oauth')).then((next) => next && setStatus(next))
  // The connection only shows as gone once the hub has said so; a refusal is shown, not swallowed.
  const disconnect = () => void attempt(async () => { await call('DELETE', '/api/me/personal-github'); return true }).then((done) => done && setStatus({ ...status, connected: false }))
  const makeRepo = () => void attempt(() => call<Personal>('POST', '/api/personal/repo')).then((next) => next && setStatus(next))
  const step = !status.oauthApp.set ? 1 : !status.connected ? 2 : 3
  return (
    <Section title="Your notes on GitHub"
      lead={status.repo ? `They sync to ${status.repo}, private, in your account.` : 'Kept in a private repo in your own account, in three steps.'}
      more={<p>Your personal binder is yours alone, and so is this: your own OAuth App and your own GitHub, used only to keep this binder’s notes in a private repo in your account. No other binder or person sees them.</p>}>
      <Rows label="Your notes on GitHub">
        <Row icon={mark(1, step > 1)} title="Your OAuth App"
          meta={status.oauthApp.set ? `Set: ${status.oauthApp.clientId}. Taking it away takes the connection too.` : 'Made on GitHub, filled in for this hub, for you alone.'}
          status={status.oauthApp.set ? <Status tone="ok">Set</Status> : undefined}
          onPress={status.oauthApp.set ? undefined : () => setMaking(true)}
          trailing={status.oauthApp.set ? <ConfirmButton className="button small" question="Take away your OAuth App and your GitHub connection? Press again" onConfirm={remove}>Take it away</ConfirmButton> : undefined} />
        <Row icon={mark(2, step > 2)} title="Your GitHub" disabled={step < 2}
          meta={status.connected ? 'Connected through your OAuth App.' : step === 2 ? `GitHub asks to let your OAuth App reach your repos, so the hub can make ${status.suggested}.` : 'Connected once your OAuth App is set.'}
          status={status.connected ? <Status tone="ok">Connected</Status> : undefined}
          trailing={status.connected
            ? <ConfirmButton className="button small" question="Disconnect it? Press again" onConfirm={disconnect}>Disconnect</ConfirmButton>
            : step === 2 ? <a className="button small primary" href="/auth/github?personal=1"><Github size={14} />Connect my GitHub</a> : 'none'} />
        <Row icon={mark(3, !!status.repo)} title="Your notes repo" disabled={step < 3 && !status.repo}
          meta={status.repo ? `Notes sync to ${status.repo}.` : step === 3 ? `Made in your account: ${status.suggested}, private.` : 'Made once you’re connected.'}
          trailing={status.repo
            ? <a className="button small" href={`https://github.com/${status.repo}`} target="_blank" rel="noreferrer">Open<ArrowUpRight size={13} aria-hidden="true" /></a>
            : step === 3 ? <button type="button" className="button small primary" onClick={makeRepo}>Make it</button> : 'none'} />
      </Rows>
      <AnimatePresence>
        {making && <OAuthAppDialog key="oauth" callback={status.callback} onClose={() => setMaking(false)} onSet={(next) => { setStatus(next); setMaking(false) }} />}
      </AnimatePresence>
    </Section>
  )
}

/** Making your OAuth App: whose it is, the link that fills in GitHub's form, and its two keys pasted back. */
function OAuthAppDialog({ callback, onClose, onSet }: { callback: string; onClose: () => void; onSet: (status: Personal) => void }) {
  const [clientId, setClientId] = useState('')
  const [secret, setSecret] = useState('')
  const [owner, setOwner] = useState<'me' | 'org'>('me')
  const [org, setOrg] = useState('')
  const homepage = new URL(callback).origin
  // GitHub's new OAuth App form, filled in: its name, homepage and callback come with the link.
  const form = new URL(owner === 'org' && org.trim() ? `https://github.com/organizations/${encodeURIComponent(org.trim())}/settings/applications/new` : 'https://github.com/settings/applications/new')
  form.searchParams.set('oauth_application[name]', `Binders personal (${new URL(homepage).host})`)
  form.searchParams.set('oauth_application[url]', homepage)
  form.searchParams.set('oauth_application[callback_url]', callback)
  const save = (event: FormEvent) => {
    event.preventDefault()
    void attempt(() => call<Personal>('PUT', '/api/personal/oauth', { clientId, clientSecret: secret })).then((next) => {
      if (!next) return
      toast('Your OAuth App is set. Connect your GitHub next.')
      onSet(next)
    })
  }
  return (
    <Dialog title="Your OAuth App" onClose={onClose} footer={<button type="submit" form="oauth-app" className="button primary" disabled={!clientId.trim() || !secret.trim()}>Keep it for me</button>}>
      <form id="oauth-app" className="form personal-oauth" onSubmit={save}>
        <ol className="personal-steps">
          <li>
            <span>Make it on GitHub, filled in for this hub, under</span>
            <div className="personal-owner" role="radiogroup" aria-label="Whose OAuth App">
              <label className="check"><input type="radio" id="oauth-owner-me" name="oauth-owner" checked={owner === 'me'} onChange={() => setOwner('me')} /> your account</label>
              <label className="check"><input type="radio" id="oauth-owner-org" name="oauth-owner" checked={owner === 'org'} onChange={() => setOwner('org')} /> an organization</label>
            </div>
            {owner === 'org' && <input id="oauth-org" className="input" aria-label="The organization’s GitHub name" value={org} onChange={(e) => setOrg(e.target.value)} placeholder="its GitHub name" autoComplete="off" spellCheck={false} />}
            <a className="button" href={form.toString()} target="_blank" rel="noreferrer" onClick={(e) => { if (owner === 'org' && !org.trim()) e.preventDefault() }}>Create it on GitHub<ArrowUpRight size={13} aria-hidden="true" /></a>
          </li>
          <li>On GitHub: <b>Register application</b>, then <b>Generate a new client secret</b>.</li>
          <li>Paste its Client ID and the secret here.</li>
        </ol>
        <label className="field">
          <span className="field-label">Client ID</span>
          <input id="oauth-client-id" value={clientId} onChange={(e) => setClientId(e.target.value)} autoComplete="off" spellCheck={false} />
        </label>
        <label className="field">
          <span className="field-label">Client secret</span>
          <input id="oauth-client-secret" type="password" value={secret} onChange={(e) => setSecret(e.target.value)} autoComplete="new-password" />
        </label>
      </form>
    </Dialog>
  )
}
