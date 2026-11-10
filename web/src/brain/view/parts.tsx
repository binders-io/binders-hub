import { CircleAlert, CircleCheck, Info, TriangleAlert } from 'lucide-react'
import { useId, type ReactNode } from 'react'
import { useActions } from '@json-render/react'

// The small pieces the parts are made of, that are components in their own right: a tone shown in a picture and a word, a
// titled group, and the questions a view suggests.

export type Tone = 'plain' | 'good' | 'warn' | 'bad'

const toneIcons = { plain: Info, good: CircleCheck, warn: TriangleAlert, bad: CircleAlert } as const
const toneWords = { plain: 'Note', good: 'Good', warn: 'Warning', bad: 'Problem' } as const

/** The tone as a small picture and, for a screen reader, a word: colour is never all that says it. */
export function ToneMark({ tone, size = 16 }: { tone: Tone; size?: number }) {
  const Icon = toneIcons[tone]
  return (
    <>
      <Icon size={size} aria-hidden="true" className="view-tone-icon" />
      <span className="view-sr">{toneWords[tone]}: </span>
    </>
  )
}

export function Group({ title, children }: { title: string; children?: ReactNode }) {
  const id = useId()
  return (
    <section className="view-section" aria-labelledby={id}>
      <h4 id={id} className="view-section-title">{title}</h4>
      {children}
    </section>
  )
}

export function Suggestions({ questions }: { questions: string[] }) {
  const { execute } = useActions()
  return (
    <div className="view-suggest" role="group" aria-label="You could ask">
      {questions.slice(0, 4).map((question, index) => (
        <button key={index} type="button" className="view-chip" onClick={() => void execute({ action: 'ask', params: { question } })}>{question}</button>
      ))}
    </div>
  )
}

