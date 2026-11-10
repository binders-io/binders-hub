import { useEffect, useState } from 'react'
import { call } from '../data/api'
import { attempt } from './Toast'
import { ConfirmButton } from './ConfirmButton'
import { ago } from './bits'
import { Saved } from '../screens/settings/shared'
import { useSaved } from '../screens/settings/access'

interface TellStatus {
  set: boolean
  host?: string
  last?: { at: string; ok: boolean; answered: string }
  retryAt?: string
  mayManage?: boolean
}

/**
 * Settings → How work flows: a channel this binder tells when something starts waiting on someone, by an address a person
 * pastes (an incoming webhook from Slack, or anything that takes a JSON post). The address is a secret: the hub keeps it
 * and never sends it back, so a person who may change it sees only where it goes, and a member only whether it's set.
 */
export function TellChannel() {
  const { saved, shown } = useSaved()
  const [status, setStatus] = useState<TellStatus>()
  const [address, setAddress] = useState('')
  const [trying, setTrying] = useState(false)
  /** What the last test came to, until the next thing is done. */
  const [tried, setTried] = useState<{ ok: boolean; answered: string }>()
  const load = () => void call<TellStatus>('GET', '/api/tell').then((next) => { if (typeof next?.set === 'boolean') setStatus(next) }).catch(() => undefined)
  useEffect(load, [])
  if (!status) return null

  const mayManage = status.mayManage === true
  const save = () => {
    if (!address.trim()) return
    setTried(undefined)
    void attempt(() => call<TellStatus>('PUT', '/api/tell', { url: address })).then((next) => {
      if (!next) return
      setStatus(next)
      setAddress('')
      saved('tell')
    })
  }
  const test = () => {
    setTrying(true)
    setTried(undefined)
    void attempt(() => call<{ ok: boolean; answered: string }>('POST', '/api/tell/test'))
      .then((done) => { if (done) setTried(done) })
      .finally(() => { setTrying(false); load() })
  }
  const stop = () => void attempt(() => call('DELETE', '/api/tell')).then((done) => {
    if (!done) return
    setTried(undefined)
    load()
  })

  const last = status.last
  return (
    <section className="settings-part" aria-labelledby="tell-title">
      <h3 className="settings-sub" id="tell-title">Tell a channel</h3>
      <p className="settings-part-detail">Posts a line to a channel each time something starts waiting on someone in this binder: a question from an agent, a card that stopped, a change set to approve.</p>
      {!mayManage ? (
        // Who can change it is said at the top of the page.
        <p className="faint">{status.set ? 'This binder tells a channel when something starts waiting.' : 'This binder doesn’t tell a channel.'}</p>
      ) : (
        <form className="form tell-form" noValidate onSubmit={(e) => { e.preventDefault(); save() }}>
          <label className="field" htmlFor="tell-address">
            <span className="field-label">Channel address</span>
            <input
              id="tell-address"
              className="mono"
              type="url"
              inputMode="url"
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              placeholder={status.set ? 'Paste a new address to change it' : 'https://hooks.slack.com/services/…'}
              aria-describedby="tell-hint"
              value={address}
              onChange={(e) => setAddress(e.target.value)}
            />
            <span className="field-hint" id="tell-hint">An incoming webhook from Slack, or any address that takes a JSON post. It has to start with https://. Once it’s saved it isn’t shown again.</span>
          </label>
          <div className="tell-actions">
            <button type="submit" className="button primary" disabled={!address.trim()}>Save</button>
            <button type="button" className="button" disabled={!status.set || trying} onClick={test}>{trying ? 'Sending…' : 'Send a test'}</button>
            <ConfirmButton question="Stop telling it? Press again" onConfirm={stop} disabled={!status.set}>Stop telling it</ConfirmButton>
            <Saved show={shown('tell')} />
          </div>
        </form>
      )}
      {mayManage && status.set && <p className="tell-status">Telling <span className="mono">{status.host}</span>.</p>}
      <div role="status">
        {tried && <p className={`tell-status${tried.ok ? '' : ' problem'}`}>{tried.ok ? 'The test arrived. ' : 'The test didn’t arrive. '}{tried.answered}</p>}
        {!tried && last && status.set && (
          <p className={`tell-status${last.ok ? '' : ' problem'}`}>
            {last.ok ? 'The last post worked' : 'The last post didn’t work'} {ago(last.at) === 'now' ? 'just now' : `${ago(last.at)} ago`}. {last.answered}
            {!last.ok && status.retryAt && <> It tries again at {new Date(status.retryAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}; what’s waiting is posted then.</>}
          </p>
        )}
      </div>
    </section>
  )
}
