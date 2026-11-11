import { useState } from 'react'
import { Check, LoaderCircle, Zap } from 'lucide-react'
import { call } from '../../data/api'
import { attempt } from '../../components/Toast'
import type { ViewProps } from '../../../../shared/view.ts'
import { Thing } from './Thing'

// Something the hub is ready to do, once the person presses its button. Everything in it is the hub's: what it would
// do, in the hub's own words, the things it would act on as they stand, and the button's name. A model only said which
// thing it meant. Pressing sends the offer's id and nothing else, and the hub checks again before it acts; an offer is
// good for a few minutes, and for the one person it was made for. It's one card: what it would do, what it's about, and
// the two buttons, with the main one last.

export function Offer({ id, what, button, heavy, about, more }: ViewProps<'Offer'>) {
  const [busy, setBusy] = useState(false)
  const [said, setSaid] = useState<string>()
  const answer = async (go: boolean) => {
    setBusy(true)
    const done = await attempt(() => call<{ said: string }>('POST', '/api/brain/do', { id, go }))
    setBusy(false)
    if (done) setSaid(done.said)
  }
  return (
    <section className={`view-offer${heavy ? ' heavy' : ''}${said ? ' answered' : ''}`} aria-label={button}>
      <div className="view-offer-head">
        <span className="view-offer-icon" aria-hidden="true"><Zap size={15} /></span>
        <p className="view-offer-what">{what}</p>
      </div>
      {about?.length ? (
        <div className="view-offer-about">
          {about.map((thing) => <Thing key={`${thing.binder}:${thing.kind}:${thing.id}`} {...thing} />)}
          {more ? <p className="view-offer-more">and {more} more</p> : null}
        </div>
      ) : null}
      {said ? (
        <p className="view-offer-did" role="status"><Check size={14} aria-hidden="true" /> {said}</p>
      ) : (
        <div className="view-offer-foot">
          <span className="view-offer-note">{heavy ? 'This can’t easily be taken back. ' : ''}Nothing changes until you press.</span>
          <div className="view-offer-buttons">
            <button type="button" className="button" disabled={busy} onClick={() => void answer(false)}>Not now</button>
            <button type="button" className={`button primary${heavy ? ' danger' : ''}`} disabled={busy} onClick={() => void answer(true)}>
              {busy ? <LoaderCircle size={14} className="spin" aria-hidden="true" /> : null} {button}
            </button>
          </div>
        </div>
      )}
    </section>
  )
}
