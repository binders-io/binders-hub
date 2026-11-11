import { useEffect, useState } from 'react'
import { AnimatePresence } from 'motion/react'
import { Megaphone } from 'lucide-react'
import { call } from '../data/api'
import { attempt } from './Toast'
import { ConfirmButton } from './ConfirmButton'
import { ago } from './bits'
import { Saved } from '../screens/settings/shared'
import { useSaved } from '../screens/settings/access'
import { Dialog, Row, Rows, Section, Status } from '../kit'

interface TellStatus {
  set: boolean
  host?: string
  last?: { at: string; ok: boolean; answered: string }
  retryAt?: string
  mayManage?: boolean
}

/** How the last post went, in a line, and when a failed one is tried again. */
function lastLine(status: TellStatus) {
  const last = status.last
  if (!last) return undefined
  const said = `${last.ok ? 'The last post worked' : 'The last post didn’t work'} ${ago(last.at) === 'now' ? 'just now' : `${ago(last.at)} ago`}. ${last.answered}`
  return !last.ok && status.retryAt ? `${said} It tries again at ${new Date(status.retryAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}; what’s waiting is posted then.` : said
}

/**
 * Settings → How work flows: a channel this binder tells when something starts waiting on someone, by an address a person
 * pastes (an incoming webhook from Slack, or anything that takes a JSON post). One row says where it posts, or that it
 * doesn't; for an owner or an admin it opens the address, a test and stopping. The address is a secret: the hub keeps it
 * and never sends it back, so a person who may change it sees only where it goes, and a member only whether it's set.
 */
export function TellChannel() {
  const [status, setStatus] = useState<TellStatus>()
  const [open, setOpen] = useState(false)
  const load = () => void call<TellStatus>('GET', '/api/tell').then((next) => { if (typeof next?.set === 'boolean') setStatus(next) }).catch(() => undefined)
  useEffect(load, [])
  if (!status) return null
  const mayManage = status.mayManage === true
  const failing = status.set && status.last && !status.last.ok
  return (
    <Section title="Tell a channel" id="tell-title" lead="A line to a channel each time something starts waiting on someone here: a question from an agent, a card that stopped, a change set to approve.">
      <Rows label="Tell a channel">
        {mayManage ? (
          <Row icon={<Megaphone size={16} />} title={status.set ? `Telling ${status.host}` : 'No channel yet'}
            meta={status.set ? lastLine(status) ?? 'Nothing posted yet.' : 'Paste an incoming webhook’s address, from Slack or anything that takes a JSON post.'}
            status={!status.set ? <Status tone="off">Off</Status> : failing ? <Status tone="bad">Failing</Status> : <Status tone="ok">On</Status>}
            onPress={() => setOpen(true)} />
        ) : (
          // Who can change it is said at the top of the page.
          <Row icon={<Megaphone size={16} />} title={status.set ? 'This binder tells a channel when something starts waiting.' : 'This binder doesn’t tell a channel.'}
            status={status.set ? <Status tone="ok">On</Status> : <Status tone="off">Off</Status>} />
        )}
      </Rows>
      <AnimatePresence>{open && <TellDialog key="tell" status={status} onChange={setStatus} reload={load} onClose={() => setOpen(false)} />}</AnimatePresence>
    </Section>
  )
}

/** The address, Save, a test, stopping, and how the last post or test went. */
function TellDialog({ status, onChange, reload, onClose }: { status: TellStatus; onChange: (next: TellStatus) => void; reload: () => void; onClose: () => void }) {
  const { saved, shown } = useSaved()
  const [address, setAddress] = useState('')
  const [trying, setTrying] = useState(false)
  /** What the last test came to, until the next thing is done. */
  const [tried, setTried] = useState<{ ok: boolean; answered: string }>()
  const save = () => {
    if (!address.trim()) return
    setTried(undefined)
    void attempt(() => call<TellStatus>('PUT', '/api/tell', { url: address })).then((next) => {
      if (!next) return
      onChange(next)
      setAddress('')
      saved('tell')
    })
  }
  const test = () => {
    setTrying(true)
    setTried(undefined)
    void attempt(() => call<{ ok: boolean; answered: string }>('POST', '/api/tell/test'))
      .then((done) => { if (done) setTried(done) })
      .finally(() => { setTrying(false); reload() })
  }
  const stop = () => void attempt(() => call('DELETE', '/api/tell')).then((done) => {
    if (!done) return
    setTried(undefined)
    reload()
  })
  const last = lastLine(status)
  return (
    <Dialog title="Tell a channel" onClose={onClose} footer={(
      <>
        {status.set && <ConfirmButton className="button danger dialog-foot-start" question="Stop telling it? Press again" onConfirm={stop}>Stop telling it</ConfirmButton>}
        {status.set && <button type="button" className="button" disabled={trying} onClick={test}>{trying ? 'Sending…' : 'Send a test'}</button>}
        <button type="submit" form="tell-form" className="button primary" disabled={!address.trim()}>Save</button>
      </>
    )}>
      <div className="tell-dialog">
        {status.set && <p className="tell-where">Telling <span className="mono">{status.host}</span>.</p>}
        <form id="tell-form" className="form tell-form" noValidate onSubmit={(e) => { e.preventDefault(); save() }}>
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
          <Saved show={shown('tell')} />
        </form>
        <div role="status">
          {tried && <p className={`tell-status${tried.ok ? '' : ' problem'}`}>{tried.ok ? 'The test arrived. ' : 'The test didn’t arrive. '}{tried.answered}</p>}
          {!tried && last && status.set && <p className={`tell-status${status.last!.ok ? '' : ' problem'}`}>{last}</p>}
        </div>
      </div>
    </Dialog>
  )
}
