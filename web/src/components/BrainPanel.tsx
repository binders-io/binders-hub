import { useEffect, useState } from 'react'
import { Check } from 'lucide-react'
import { call } from '../data/api'
import { attempt } from './Toast'
import { Option, Segmented } from './HubOptionsPanel'

// The hub's brain: the model that sums up what phones and Macs capture and answers questions from the binders, and
// the embeddings that find passages by what they mean. An admin's to set; everyone sees what's in use.

type Provider = 'off' | 'anthropic' | 'openai'

interface BrainView {
  provider: Provider
  model?: string
  baseUrl?: string
  summarize: boolean
  embeddingsBaseUrl?: string
  embeddingsModel?: string
  apiKeySet?: boolean
  usesAnthropicKey?: boolean
  embeddingsKeySet?: boolean
  locked?: Record<string, string>
  inUse?: string
  embeddingsInUse?: string
  needs?: string
  embeddingsNeeds?: string
}

interface IndexStats {
  sources: number
  passages: number
  withVectors: number
}

type Field = 'model' | 'baseUrl' | 'embeddingsBaseUrl' | 'embeddingsModel'

export function BrainPanel() {
  const [brain, setBrain] = useState<BrainView>()
  const [admin, setAdmin] = useState(false)
  const [index, setIndex] = useState<IndexStats>()
  const [saved, setSaved] = useState<string>()
  const [apiKey, setApiKey] = useState('')
  const [embeddingsKey, setEmbeddingsKey] = useState('')

  useEffect(() => {
    void call<{ brain: BrainView; admin: boolean; index?: IndexStats }>('GET', '/api/brain').then((r) => {
      setBrain(r.brain)
      setAdmin(r.admin)
      setIndex(r.index)
    }).catch(() => {})
  }, [])

  if (!brain) return null

  const save = async (fields: Record<string, unknown>, what: string) => {
    const result = await attempt(() => call<{ brain: BrainView }>('PATCH', '/api/brain', fields))
    if (!result) return false
    setBrain(result.brain)
    setSaved(what)
    window.setTimeout(() => setSaved(undefined), 1500)
    return true
  }
  const locked = brain.locked ?? {}
  const off = (key: string) => !admin || !!locked[key]
  const note = (key: string) => (locked[key] ? <span className="option-lock">Set on the hub by {locked[key]}</span> : saved === key ? <span className="option-saved"><Check size={12} strokeWidth={3} /> Saved</span> : null)
  const field = (key: Field, label: string, placeholder: string) => (
    <label className="field">
      <span className="field-label">{label} {note(key)}</span>
      <input id={`brain-${key}`} className="mono" defaultValue={brain[key] ?? ''} placeholder={placeholder} disabled={off(key)} autoComplete="off" spellCheck={false}
        onBlur={(e) => e.target.value.trim() !== (brain[key] ?? '') && void save({ [key]: e.target.value.trim() }, key)} />
    </label>
  )
  const keyField = (name: 'apiKey' | 'embeddingsKey', value: string, set: (v: string) => void, isSet: boolean | undefined, placeholder: string) => (
    <div className="field">
      <label className="field-label" htmlFor={`brain-${name}`}>Key {note(name)}</label>
      <div className="brain-key">
        <input id={`brain-${name}`} type="password" className="mono" value={value} onChange={(e) => set(e.target.value)} disabled={off(name)} autoComplete="new-password"
          placeholder={isSet ? 'Set. Type a new one to replace it' : placeholder} />
        <button type="button" className="button" disabled={off(name) || !value.trim()} onClick={() => void save({ [name]: value.trim() }, name).then((ok) => ok && set(''))}>Save</button>
        {isSet && !locked[name] && <button type="button" className="button" disabled={!admin} onClick={() => void save({ [name]: '' }, name)}>Clear</button>}
      </div>
    </div>
  )

  return (
    <div className="options">
      {!admin && <p className="setup-note">Only the hub’s admins can change these.</p>}

      <Option title="In use" detail="What the brain does now, and how much of this binder it has read.">
        <p className="option-status">
          {brain.inUse ? <>Summing up and answering with <b className="mono">{brain.inUse}</b>.</> : 'No model: the brain finds passages by their words, and doesn’t sum up or answer.'}
          {' '}{brain.embeddingsInUse ? <>Finding by meaning with <b className="mono">{brain.embeddingsInUse}</b>.</> : 'Finding by words only.'}
        </p>
        {brain.needs && <p className="option-status option-error">The model needs: {brain.needs}</p>}
        {brain.embeddingsNeeds && <p className="option-status option-error">Embeddings need: {brain.embeddingsNeeds}</p>}
        {index && <p className="option-status num">This binder: {index.sources} note{index.sources === 1 ? '' : 's'} and cards read, in {index.passages} passages{brain.embeddingsInUse ? `, ${index.withVectors} of them found by meaning` : ''}.</p>}
      </Option>

      {admin && <>
        <Option title="The hub’s model" detail="Sums up the conversations and meetings phones and Macs send, and answers questions from the binders, citing the notes and cards it used. Claude runs at Anthropic with the hub’s key; a server of your own, such as Ollama, LM Studio or vLLM, keeps the words on your machines." aside={note('provider')}>
          <Segmented id="brain-provider" value={brain.provider} disabled={off('provider')} onChange={(provider) => void save({ provider }, 'provider')}
            choices={[['off', 'Off'], ['anthropic', 'Claude'], ['openai', 'A server of your own']]} />
          {brain.provider === 'anthropic' && <>
            {field('model', 'Model', 'claude-opus-5-5')}
            {keyField('apiKey', apiKey, setApiKey, brain.apiKeySet && !brain.usesAnthropicKey, 'sk-ant-…')}
            {brain.usesAnthropicKey && <span className="field-hint">Using the hub’s ANTHROPIC_API_KEY until a key is saved here.</span>}
          </>}
          {brain.provider === 'openai' && <>
            {field('baseUrl', 'Its address', 'http://localhost:11434/v1')}
            {field('model', 'Model', 'qwen3:32b')}
            {keyField('apiKey', apiKey, setApiKey, brain.apiKeySet, 'None needed for most servers on your own machines')}
          </>}
        </Option>

        <Option title="Summing up" detail="A conversation or meeting sent to the hub gets a summary at the top of its note: what it was about, what was decided, and who said they’d do what. Distill can then turn the note into cards." aside={note('summarize')}>
          <Segmented id="brain-summarize" value={brain.summarize ? 'on' : 'off'} disabled={off('summarize') || brain.provider === 'off'} onChange={(on) => void save({ summarize: on === 'on' }, 'summarize')} choices={[['on', 'On'], ['off', 'Off']]} />
        </Option>

        <Option title="Finding by meaning" detail="Optional. An embeddings model finds the passages that mean what a question asks, even in other words. Any server that speaks OpenAI’s embeddings API works: Ollama, LM Studio, OpenAI or Voyage. Without one, the brain finds passages by their words.">
          {field('embeddingsBaseUrl', 'Its address', 'http://localhost:11434/v1')}
          {field('embeddingsModel', 'Model', 'nomic-embed-text')}
          {keyField('embeddingsKey', embeddingsKey, setEmbeddingsKey, brain.embeddingsKeySet, 'None needed for most servers on your own machines')}
        </Option>
      </>}
    </div>
  )
}
