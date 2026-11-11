import { useState } from 'react'
import { worksIn, type FolderRule } from '../../../shared/work.ts'
import { call } from '../data/api'
import { useStore } from '../data/store'
import { Dialog, Field } from './Dialog'
import { attempt, toast } from './Toast'

// A folder's rules: Distill what's finished in it, accept what comes of that up to some limits, and whether a note's work
// gets a change set of its own. A change set is always a person's to approve.

const sizes = ['S', 'M', 'L'] as const

export function FolderRuleDialog({ folderId, onClose }: { folderId: string; onClose: () => void }) {
  const { state } = useStore()
  const folder = state.folders.find((f) => f.id === folderId)
  const rule = (state.folderRules ?? []).find((r) => r.folderId === folderId)
  const agents = state.agents.filter((a) => !a.revoked && folder && worksIn(a, folder.binderId, state.binders))
  const [distill, setDistill] = useState(rule?.distill ?? false)
  const [agentId, setAgentId] = useState(rule?.agentId ?? '')
  const [quiet, setQuiet] = useState(rule?.quietMinutes ?? 10)
  const [accepts, setAccepts] = useState(!!rule?.accept)
  const [maxCards, setMaxCards] = useState(rule?.accept?.maxCards ?? 5)
  const [allowed, setAllowed] = useState<NonNullable<FolderRule['accept']>['sizes']>(rule?.accept?.sizes ?? ['S', 'M'])
  const [givenTo, setGivenTo] = useState<string[]>(rule?.accept?.agents ?? [])
  const [changeSet, setChangeSet] = useState<FolderRule['changeSet']>(rule?.changeSet ?? 'shared')
  const [busy, setBusy] = useState(false)

  const save = async () => {
    setBusy(true)
    const done = await attempt(() => call('PUT', `/api/folders/${folderId}/rule`, {
      enabled: true, distill, agentId: agentId || null, quietMinutes: quiet, changeSet,
      accept: distill && accepts ? { maxCards, sizes: allowed, agents: givenTo } : null,
    }))
    setBusy(false)
    if (done !== undefined) {
      toast('Rule saved.')
      onClose()
    }
  }
  const remove = async () => {
    const done = await attempt(() => call('DELETE', `/api/folders/${folderId}/rule`))
    if (done !== undefined) {
      toast('Rule removed.')
      onClose()
    }
  }

  const blocked = busy || (distill && accepts && (!agentId || !givenTo.length || !allowed.length))
  return (
    <Dialog title={`Rules for “${folder?.name ?? 'this folder'}”`} onClose={onClose} wide footer={(
      <>
        {rule && <button type="button" className="button danger dialog-foot-start" onClick={() => void remove()}>Remove the rule</button>}
        <button type="button" className="button" onClick={onClose}>Cancel</button>
        <button type="button" className="button primary" disabled={blocked} onClick={() => void save()}>Save</button>
      </>
    )}>
      <div className="rule-dialog">
        {rule?.failing && <p className="schedule-failing" role="status">{rule.failing}</p>}
        <p className="schedule-intro">These apply to notes in this folder and in folders inside it. Notes already here are left alone.</p>
        <div className="form rule-form">
          <label className="rule-check"><input id="rule-distill" type="checkbox" checked={distill} onChange={(e) => setDistill(e.target.checked)} /> <span><b>Distill notes automatically</b><span className="faint">Once for each note, when it’s finished. Editing it afterwards doesn’t distill it again.</span></span></label>
          {distill && (
            <div className="form-row">
              <Field label="Distilled by">
                <select id="rule-agent" value={agentId} onChange={(e) => setAgentId(e.target.value)}>
                  <option value="">Any agent (the first one free)</option>
                  {agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                </select>
              </Field>
              <Field label="Finished after (minutes with no edit)">
                <input id="rule-quiet" type="number" min={1} max={10080} value={quiet} onChange={(e) => setQuiet(Number(e.target.value))} />
              </Field>
            </div>
          )}
          {distill && <label className="rule-check"><input id="rule-accepts" type="checkbox" checked={accepts} onChange={(e) => setAccepts(e.target.checked)} /> <span><b>Accept work items without asking</b><span className="faint">They go straight to the agents you choose. Anything over these limits, or from a note another agent wrote, waits for a person. This needs one chosen agent to distill.</span></span></label>}
          {distill && accepts && (
            <>
              <div className="form-row">
                <Field label="Cards from one note, at most">
                  <input id="rule-max" type="number" min={1} max={20} value={maxCards} onChange={(e) => setMaxCards(Number(e.target.value))} />
                </Field>
                <fieldset className="rule-group">
                  <legend>Sizes</legend>
                  {sizes.map((size) => <label key={size}><input id={`rule-size-${size}`} type="checkbox" checked={allowed.includes(size)} onChange={(e) => setAllowed(e.target.checked ? [...allowed, size] : allowed.filter((s) => s !== size))} /> {size}</label>)}
                </fieldset>
              </div>
              <fieldset className="rule-group">
                <legend>Give the work to</legend>
                {agents.map((a) => <label key={a.id}><input id={`rule-agent-${a.id}`} type="checkbox" checked={givenTo.includes(a.id)} onChange={(e) => setGivenTo(e.target.checked ? [...givenTo, a.id] : givenTo.filter((id) => id !== a.id))} /> {a.name}</label>)}
              </fieldset>
              <p className="rule-warning">Notes can carry text from outside, such as scanner output or advisories. These agents will act on work nobody has read first, so choose ones with only the access they need. Their change sets still wait for a person to approve.</p>
            </>
          )}
          <Field label="Change sets">
            <select id="rule-change-set" value={changeSet} onChange={(e) => setChangeSet(e.target.value as FolderRule['changeSet'])}>
              <option value="shared">Add each note’s work to the open change set</option>
              <option value="own">Give each note its own change set</option>
            </select>
          </Field>
        </div>
      </div>
    </Dialog>
  )
}
