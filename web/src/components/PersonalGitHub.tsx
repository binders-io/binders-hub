import { useEffect, useState, type FormEvent } from 'react'
import { Check, ExternalLink, Lock } from 'lucide-react'
import { call } from '../data/api'
import { attempt, toast } from './Toast'
import { ConfirmButton } from './ConfirmButton'
import { Github } from './Github'

type Status = { repo?: string; suggested: string; oauth: boolean; oauthApp: { set: boolean; clientId?: string }; callback: string; connected: boolean }

/**
 * Your personal binder's GitHub: your own OAuth App, kept for you alone (no other person or binder sees it), and your own
 * GitHub connected through it, so this binder's notes are kept in a private repo in your own account. Three steps:
 * make the OAuth App (the link fills in GitHub's form), paste its keys, connect. Then the repo is made.
 */
export function PersonalGitHub() {
  const [status, setStatus] = useState<Status>()
  const [clientId, setClientId] = useState('')
  const [secret, setSecret] = useState('')
  const [owner, setOwner] = useState<'me' | 'org'>('me')
  const [org, setOrg] = useState('')
  useEffect(() => { void call<Status>('GET', '/api/personal').then(setStatus).catch(() => {}) }, [])
  if (!status) return null
  const save = (event: FormEvent) => {
    event.preventDefault()
    void attempt(() => call<Status>('PUT', '/api/personal/oauth', { clientId, clientSecret: secret })).then((next) => {
      if (!next) return
      setStatus(next)
      setSecret('')
      toast('Your OAuth App is set. Connect your GitHub next.')
    })
  }
  const remove = () => void attempt(() => call<Status>('DELETE', '/api/personal/oauth')).then((next) => next && setStatus(next))
  const homepage = new URL(status.callback).origin
  // GitHub's new OAuth App form, filled in: its name, homepage and callback come with the link.
  const form = new URL(owner === 'org' && org.trim() ? `https://github.com/organizations/${encodeURIComponent(org.trim())}/settings/applications/new` : 'https://github.com/settings/applications/new')
  form.searchParams.set('oauth_application[name]', `Binders personal (${new URL(homepage).host})`)
  form.searchParams.set('oauth_application[url]', homepage)
  form.searchParams.set('oauth_application[callback_url]', status.callback)
  const step = !status.oauthApp.set ? 1 : !status.connected ? 2 : 3
  return (
    <div className="setup">
      <p className="setup-note"><Lock size={12} /> Your personal binder is yours alone, and so is this: your own OAuth App and your own GitHub, used only to keep this binder’s notes in a private repo in your account. No other binder or person sees them.</p>
      <ol className="setup-steps">
        <li className={step > 1 ? 'done' : 'now'}>
          <span className="step-mark">{step > 1 ? <Check size={13} strokeWidth={3} /> : 1}</span>
          <div>
            <h3>Your OAuth App</h3>
            {status.oauthApp.set ? (
              <p>Set: <span className="mono">{status.oauthApp.clientId}</span>. <button className="text-button" onClick={remove}>Take it away</button> (and the connection made through it).</p>
            ) : (
              <form className="form" onSubmit={save}>
                <ol className="oauth-steps">
                  <li>
                    <span>Make it on GitHub, filled in for this hub, under</span>
                    <div className="oauth-owner">
                      <label className="check"><input type="radio" id="oauth-owner-me" name="oauth-owner" checked={owner === 'me'} onChange={() => setOwner('me')} /> your account</label>
                      <label className="check"><input type="radio" id="oauth-owner-org" name="oauth-owner" checked={owner === 'org'} onChange={() => setOwner('org')} /> an organization</label>
                      {owner === 'org' && <input id="oauth-org" value={org} onChange={(e) => setOrg(e.target.value)} placeholder="its GitHub name" autoComplete="off" spellCheck={false} />}
                    </div>
                    <a className="button" href={form.toString()} target="_blank" rel="noreferrer" onClick={(e) => { if (owner === 'org' && !org.trim()) e.preventDefault() }}>Create it on GitHub <ExternalLink size={12} /></a>
                  </li>
                  <li>On GitHub: <b>Register application</b>, then <b>Generate a new client secret</b>.</li>
                  <li>Paste its Client ID and the secret here.</li>
                </ol>
                <div className="form-row">
                  <input id="oauth-client-id" value={clientId} onChange={(e) => setClientId(e.target.value)} placeholder="Client ID" autoComplete="off" spellCheck={false} />
                  <input id="oauth-client-secret" type="password" value={secret} onChange={(e) => setSecret(e.target.value)} placeholder="Client secret" autoComplete="new-password" />
                </div>
                <div><button className="button primary" disabled={!clientId.trim() || !secret.trim()}>Keep it for me</button></div>
              </form>
            )}
          </div>
        </li>
        <li className={step > 2 ? 'done' : step === 2 ? 'now' : 'later'}>
          <span className="step-mark">{step > 2 ? <Check size={13} strokeWidth={3} /> : 2}</span>
          <div>
            <h3>Connect your GitHub</h3>
            {status.connected ? <p>Connected. <ConfirmButton className="text-button" question="Disconnect it? Press again" onConfirm={() => void call('DELETE', '/api/me/personal-github').then(() => setStatus({ ...status, connected: false }))}>Disconnect</ConfirmButton></p>
              : step === 2 ? <><p>GitHub asks to let your OAuth App reach your repos, so the hub can make {status.suggested} and push your notes to it.</p><a className="button primary" href="/auth/github?personal=1"><Github size={14} /> Connect my GitHub</a></>
              : <p>After your OAuth App is set.</p>}
          </div>
        </li>
        <li className={status.repo ? 'done' : step === 3 ? 'now' : 'later'}>
          <span className="step-mark">{status.repo ? <Check size={13} strokeWidth={3} /> : 3}</span>
          <div>
            <h3>Your notes repo</h3>
            {status.repo ? <p>Notes sync to <a href={`https://github.com/${status.repo}`} target="_blank" rel="noreferrer">{status.repo}</a>.</p>
              : step === 3 ? <><p>Made in your account: {status.suggested}, private.</p><button className="button primary" onClick={() => void attempt(() => call<Status>('POST', '/api/personal/repo')).then((next) => next && setStatus(next))}>Make it</button></>
              : <p>Made once you’re connected.</p>}
          </div>
        </li>
      </ol>
    </div>
  )
}
