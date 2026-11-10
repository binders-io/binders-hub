import { Circle, CircleCheck, CircleDot } from 'lucide-react'
import { defineRegistry } from '@json-render/react'
import { catalog } from './catalog'
import { Chart } from './Chart'
import { Diagram } from './Diagram'
import { inline } from './inline'
import { Group, Suggestions, ToneMark } from './parts'
import { Thing } from './Thing'

// One React component for each part a view may be made of. Every string in a view was written by a model, so each is
// drawn as text (with only **bold** and `code` understood, in inline.tsx) and none is ever made into markup.

const stepStates = {
  done: { icon: CircleCheck, word: 'Done' },
  now: { icon: CircleDot, word: 'Now' },
  next: { icon: Circle, word: 'Next' },
} as const

export const { registry } = defineRegistry(catalog, {
  components: {
    Stack: ({ children }) => <div className="view-stack">{children}</div>,
    Row: ({ children }) => <div className="view-row">{children}</div>,
    Section: ({ props, children }) => <Group title={props.title}>{children}</Group>,
    Text: ({ props }) => <p className="view-text">{inline(props.text)}</p>,
    Callout: ({ props }) => (
      <div className={`view-callout ${props.tone}`} role="note">
        <ToneMark tone={props.tone} />
        <div className="view-callout-words">
          {props.title ? <strong className="view-callout-title">{props.title}</strong> : null}
          <p>{inline(props.text)}</p>
        </div>
      </div>
    ),
    Stat: ({ props }) => {
      const tone = props.tone ?? 'plain'
      return (
        <div className={`view-stat ${tone}`}>
          <span className="view-stat-label">{tone === 'plain' ? null : <ToneMark tone={tone} size={13} />}{props.label}</span>
          <span className="view-stat-value">{props.value}</span>
          {props.detail ? <span className="view-stat-detail">{props.detail}</span> : null}
        </div>
      )
    },
    Facts: ({ props }) => (
      <dl className="view-facts">
        {props.rows.map((row, index) => (
          <div key={index}>
            <dt>{row.name}</dt>
            <dd>{inline(row.value)}</dd>
          </div>
        ))}
      </dl>
    ),
    List: ({ props }) => {
      const Tag = props.numbered ? 'ol' : 'ul'
      return (
        <Tag className="view-list">
          {props.items.map((item, index) => <li key={index}>{inline(item)}</li>)}
        </Tag>
      )
    },
    Steps: ({ props }) => (
      <ol className="view-steps">
        {props.items.map((item, index) => {
          const state = stepStates[item.state ?? 'next']
          const Icon = state.icon
          return (
            <li key={index} className={item.state ?? 'next'}>
              <Icon size={16} aria-hidden="true" className="view-step-icon" />
              <span className="view-step-words">
                <span className="view-step-title">{item.title}<span className="view-step-state">{item.state ? <><span className="view-sr">, </span>{state.word}</> : null}</span></span>
                {item.detail ? <span className="view-step-detail">{inline(item.detail)}</span> : null}
              </span>
            </li>
          )
        })}
      </ol>
    ),
    Table: ({ props }) => (
      <div className="view-table-wrap" role="region" tabIndex={0} aria-label="Table">
        <table className="view-table">
          <thead>
            <tr>{props.columns.map((column, index) => <th key={index} scope="col">{column}</th>)}</tr>
          </thead>
          <tbody>
            {props.rows.map((row, index) => (
              <tr key={index}>{props.columns.map((_, column) => <td key={column}>{row[column] ?? ''}</td>)}</tr>
            ))}
          </tbody>
        </table>
      </div>
    ),
    Chart: ({ props }) => <Chart {...props} />,
    Diagram: ({ props }) => <Diagram title={props.title} code={props.code} />,
    Thing: ({ props }) => <Thing {...props} />,
    Suggest: ({ props }) => <Suggestions questions={props.questions} />,
  },
  // The handler that does the asking is the page's own, given to the provider in BrainView, as only it has onAsk.
  actions: { ask: async () => {} },
})
