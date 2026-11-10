import { useLayoutEffect, useRef, useState, type RefObject } from 'react'
import type { ViewProps } from '../../../../shared/view.ts'

// A chart in a view, drawn by hand as SVG: bars, a line, or a donut. Colours come from the --view-s1 to --view-s8 tokens
// in view.css, which hold their contrast on the page in both themes. Colour never carries the meaning alone: a chart
// with more than one series has a legend, the values are written on the marks where there's room, and every chart has a
// table of the same numbers that only a screen reader sees. Text is measured by estimate, and cut with an ellipsis
// before it could leave the drawing.

type ChartProps = ViewProps<'Chart'>
interface Data {
  kind: ChartProps['kind']
  title?: string | null
  labels: string[]
  series: { name: string; values: number[] }[]
  unit: string
}

const slots = 8
const color = (slot: number) => `var(--view-s${(slot % slots) + 1})`
const finite = (value: number) => (Number.isFinite(value) ? value : 0)

let numbers: Intl.NumberFormat | undefined
/** A value as words, with its unit after it: a space between unless the unit is a mark such as %. */
function show(value: number, unit: string) {
  numbers ??= new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 })
  return `${numbers.format(value)}${unit && /^\p{L}/u.test(unit) ? ' ' : ''}${unit}`
}

/** About how wide some text is, in pixels. */
const wide = (text: string, size: number) => text.length * size * 0.58

/** The text, cut with an ellipsis to fit in `room` pixels. */
function fit(text: string, room: number, size: number) {
  const most = Math.max(1, Math.floor(room / (size * 0.58)))
  return text.length <= most ? text : `${text.slice(0, Math.max(1, most - 1))}…`
}

/** Round numbers from below `low` to above `high`, about `count` of them. */
function niceTicks(low: number, high: number, count: number) {
  const raw = (high - low || 1) / count
  const power = 10 ** Math.floor(Math.log10(raw))
  const lead = raw / power
  const step = (lead <= 1 ? 1 : lead <= 2 ? 2 : lead <= 5 ? 5 : 10) * power
  const ticks: number[] = []
  const last = Math.ceil(high / step) * step
  for (let value = Math.floor(low / step) * step, i = 0; value <= last + step / 2 && i < 30; value += step, i++) ticks.push(Number(value.toFixed(10)))
  return ticks
}

/** The chart as it's drawn: only as many values as every series and the labels have in common. */
function tidy(props: ChartProps): Data | undefined {
  const series = props.series ?? []
  const count = Math.min(props.labels?.length ?? 0, ...series.map((s) => s.values?.length ?? 0))
  if (!count || !series.length) return undefined
  return {
    kind: props.kind,
    title: props.title,
    labels: props.labels.slice(0, count),
    series: series.map((s) => ({ name: s.name, values: s.values.slice(0, count).map(finite) })),
    unit: props.unit ?? '',
  }
}

/** How wide the box is, as it's resized. Before it's measured, and where nothing measures, a size that suits most. */
function useWidth(box: RefObject<HTMLElement | null>) {
  const [width, setWidth] = useState(480)
  useLayoutEffect(() => {
    const element = box.current
    if (!element) return
    const measure = () => {
      const now = element.getBoundingClientRect().width
      if (now > 0) setWidth(Math.round(now))
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const watch = new ResizeObserver(measure)
    watch.observe(element)
    return () => watch.disconnect()
  }, [box])
  return Math.min(640, Math.max(220, width))
}

/** A bar with its far end rounded and its end on the baseline square. */
function barPath(from: number, to: number, y: number, height: number) {
  const length = Math.abs(to - from)
  if (length < 0.5) return ''
  const r = Math.min(4, length, height / 2)
  if (to > from) return `M${from} ${y}H${to - r}A${r} ${r} 0 0 1 ${to} ${y + r}V${y + height - r}A${r} ${r} 0 0 1 ${to - r} ${y + height}H${from}Z`
  return `M${from} ${y}H${to + r}A${r} ${r} 0 0 0 ${to} ${y + r}V${y + height - r}A${r} ${r} 0 0 0 ${to + r} ${y + height}H${from}Z`
}

const size = 11.5

/** Bars from one baseline, one row for each label, side by side when there are several series. */
function Bars({ data, width, name }: { data: Data; width: number; name: string }) {
  const { labels, series, unit } = data
  const all = series.flatMap((s) => s.values)
  const written = labels.length * series.length <= 24
  let low = Math.min(0, ...all)
  let high = Math.max(0, ...all)
  if (high === low) high = low + 1
  if (!written) {
    const ticks = niceTicks(low, high, 4)
    low = ticks[0]
    high = ticks[ticks.length - 1]
  }
  const ticks = written ? [] : niceTicks(low, high, 4)
  const labelRoom = Math.min(width * 0.34, Math.max(...labels.map((l) => wide(l, size))) + 4)
  const widest = Math.max(...all.map((v) => wide(show(v, unit), size)))
  const left = labelRoom + 10 + (written && Math.min(0, ...all) < 0 ? widest + 8 : 0)
  const right = width - (written ? widest + 10 : 12)
  const span = Math.max(40, right - left)
  const x = (value: number) => left + ((value - low) / (high - low)) * span
  const barHeight = series.length === 1 ? 16 : 12
  const group = series.length * barHeight + (series.length - 1) * 3
  const gap = 12
  const top = 4
  const rows = labels.length * group + (labels.length - 1) * gap
  const axis = written ? 0 : 22
  const height = top + rows + axis + 4
  return (
    <svg role="img" aria-label={name} width={width} height={height} viewBox={`0 0 ${width} ${height}`} className="view-svg">
      {ticks.map((tick) => (
        <g key={tick}>
          <line x1={x(tick)} x2={x(tick)} y1={top} y2={top + rows} className={tick === 0 ? 'zero' : 'grid'} />
          <text x={x(tick)} y={top + rows + 16} textAnchor="middle">{fit(show(tick, unit), 60, size)}</text>
        </g>
      ))}
      {written ? <line x1={x(0)} x2={x(0)} y1={top} y2={top + rows} className="zero" /> : null}
      {labels.map((label, row) => {
        const y = top + row * (group + gap)
        return (
          <g key={row}>
            <text x={labelRoom} y={y + group / 2} dy=".35em" textAnchor="end">{fit(label, labelRoom, size)}<title>{label}</title></text>
            {series.map((one, index) => {
              const value = one.values[row]
              const barY = y + index * (barHeight + 3)
              const end = x(value)
              return (
                <g key={index}>
                  <path d={barPath(x(0), end, barY, barHeight)} style={{ fill: color(index) }}><title>{`${label}, ${one.name}: ${show(value, unit)}`}</title></path>
                  {written ? <text x={value < 0 ? end - 5 : end + 5} y={barY + barHeight / 2} dy=".35em" textAnchor={value < 0 ? 'end' : 'start'} className="value">{show(value, unit)}</text> : null}
                </g>
              )
            })}
          </g>
        )
      })}
    </svg>
  )
}

/** One line for each series across the labels. A single value is a dot, with no line to draw. */
function Lines({ data, width, name }: { data: Data; width: number; name: string }) {
  const { labels, series, unit } = data
  const count = labels.length
  const all = series.flatMap((s) => s.values)
  let low = Math.min(...all)
  let high = Math.max(...all)
  if (low === high) {
    low = Math.min(0, low)
    high = Math.max(0, high)
    if (low === high) high = 1
  }
  const ticks = niceTicks(low, high, 4)
  low = ticks[0]
  high = ticks[ticks.length - 1]
  const single = series.length === 1
  const ending = single ? show(series[0].values[count - 1], unit) : ''
  const left = Math.max(Math.max(...ticks.map((t) => wide(show(t, unit), size))) + 10, Math.min(wide(labels[0], size) / 2, 40))
  const right = Math.max(single ? wide(ending, size) + 14 : 12, Math.min(wide(labels[count - 1], size) / 2, 40))
  const height = width >= 360 ? 200 : 180
  const top = 10
  const bottom = 26
  const span = Math.max(40, width - left - right)
  const x = (index: number) => (count === 1 ? left + span / 2 : left + (index / (count - 1)) * span)
  const y = (value: number) => top + ((high - value) / (high - low)) * (height - top - bottom)
  // Labels are kept from touching: every few of them when they're close, each cut to the room it has.
  const slot = count === 1 ? span : span / (count - 1)
  const every = Math.max(1, Math.ceil((Math.max(...labels.map((l) => Math.min(wide(l, size), 90))) + 8) / slot))
  const marked = count <= 12
  return (
    <svg role="img" aria-label={name} width={width} height={height} viewBox={`0 0 ${width} ${height}`} className="view-svg">
      {ticks.map((tick) => (
        <g key={tick}>
          <line x1={left} x2={left + span} y1={y(tick)} y2={y(tick)} className={tick === 0 ? 'zero' : 'grid'} />
          <text x={left - 8} y={y(tick)} dy=".35em" textAnchor="end">{show(tick, unit)}</text>
        </g>
      ))}
      {labels.map((label, index) => (index % every === 0 ? <text key={index} x={x(index)} y={height - 8} textAnchor="middle">{fit(label, slot * every - 6, size)}<title>{label}</title></text> : null))}
      {series.map((one, index) => (
        <g key={index} style={{ color: color(index) }}>
          {count > 1 ? <polyline points={one.values.map((v, i) => `${x(i)},${y(v)}`).join(' ')} className="line" /> : null}
          {one.values.map((value, i) => (marked || i === count - 1 ? <circle key={i} cx={x(i)} cy={y(value)} r={4} className="view-dot"><title>{`${labels[i]}, ${one.name}: ${show(value, unit)}`}</title></circle> : null))}
        </g>
      ))}
      {single ? <text x={x(count - 1) + 9} y={y(series[0].values[count - 1])} dy=".35em" className="value">{ending}</text> : null}
    </svg>
  )
}

const arc = (cx: number, cy: number, radius: number, angle: number) => `${cx + radius * Math.cos(angle)} ${cy + radius * Math.sin(angle)}`

/** A donut of the first series: each positive value a share of their total. The legend beside it names each share. */
function Donut({ data, width, name }: { data: Data; width: number; name: string }) {
  const { labels, series, unit } = data
  const values = series[0].values
  const folded = labels.length > slots
  const shown = (folded ? labels.slice(0, slots - 1) : labels).map((label, index) => ({ label, value: values[index], slot: index }))
  const rest = folded ? values.slice(slots - 1).filter((v) => v > 0).reduce((sum, v) => sum + v, 0) : 0
  const parts = folded ? [...shown, { label: `Other (${labels.length - slots + 1} more)`, value: rest, slot: -1 }] : shown
  const total = parts.reduce((sum, part) => sum + Math.max(0, part.value), 0)
  const side = Math.min(width, 176)
  const middle = side / 2
  const outer = middle - 2
  const inner = outer * 0.64
  const drawn = parts.filter((part) => part.value > 0)
  const slices = drawn.map((part, index) => {
    const before = drawn.slice(0, index).reduce((sum, one) => sum + one.value, 0)
    return { part, from: -Math.PI / 2 + (before / total) * Math.PI * 2, to: -Math.PI / 2 + ((before + part.value) / total) * Math.PI * 2 }
  })
  const centre = show(total, unit)
  const centreSize = Math.min(18, Math.floor((inner * 1.7) / (centre.length * 0.6)))
  return (
    <div className="view-donut">
      {total > 0 ? (
        <svg role="img" aria-label={name} width={side} height={side} viewBox={`0 0 ${side} ${side}`} className="view-svg">
          {slices.length === 1 ? (
            <circle cx={middle} cy={middle} r={(outer + inner) / 2} strokeWidth={outer - inner} className="ring" style={{ stroke: slices[0].part.slot < 0 ? 'var(--view-other)' : color(slices[0].part.slot) }}><title>{`${slices[0].part.label}: ${show(slices[0].part.value, unit)}`}</title></circle>
          ) : (
            slices.map(({ part, from, to }, index) => {
              const large = to - from > Math.PI ? 1 : 0
              return (
                <path key={index} className="slice" d={`M${arc(middle, middle, outer, from)}A${outer} ${outer} 0 ${large} 1 ${arc(middle, middle, outer, to)}L${arc(middle, middle, inner, to)}A${inner} ${inner} 0 ${large} 0 ${arc(middle, middle, inner, from)}Z`} style={{ fill: part.slot < 0 ? 'var(--view-other)' : color(part.slot) }}>
                  <title>{`${part.label}: ${show(part.value, unit)}`}</title>
                </path>
              )
            })
          )}
          {centreSize >= 9 ? (
            <g className="centre">
              <text x={middle} y={middle - 2} textAnchor="middle" style={{ fontSize: centreSize }} className="value">{centre}</text>
              <text x={middle} y={middle + 13} textAnchor="middle">total</text>
            </g>
          ) : null}
        </svg>
      ) : (
        <p className="view-chart-none">Nothing to draw: no value is above zero.</p>
      )}
      <ul className="view-legend share">
        {parts.map((part, index) => (
          <li key={index}>
            <i style={{ background: part.slot < 0 ? 'var(--view-other)' : color(part.slot) }} aria-hidden="true" />
            <span className="view-legend-name">{part.label}</span>
            <span className="view-legend-value">{show(part.value, unit)}</span>
            <span className="view-legend-share">{part.value > 0 && total > 0 ? (part.value / total < 0.005 ? '<1%' : `${Math.round((part.value / total) * 100)}%`) : ''}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

const kindNames = { bar: 'Bar chart', line: 'Line chart', donut: 'Donut chart' } as const

/** What the chart shows, in a sentence, for whoever can't see it. */
function nameOf(data: Data) {
  const { kind, title, labels, series, unit } = data
  const first = labels[0]
  const last = labels[labels.length - 1]
  const what = kind === 'donut' ? `${series[0].name}, shared among ${labels.length} label${labels.length === 1 ? '' : 's'}` : `${series.map((s) => s.name).join(', ')}, ${labels.length} value${labels.length === 1 ? '' : 's'} each`
  const range = labels.length > 1 ? `, from ${first} to ${last}` : `, at ${first}`
  return `${kindNames[kind]}${title ? `: ${title}` : ''}. ${what}${range}${unit ? `, in ${unit}` : ''}.`
}

export function Chart(props: ChartProps) {
  const box = useRef<HTMLDivElement>(null)
  const width = useWidth(box)
  const data = tidy(props)
  if (!data) return null
  const name = nameOf(data)
  const many = data.series.length > 1 && data.kind !== 'donut'
  return (
    <figure className={`view-chart ${data.kind}`}>
      {data.title ? <figcaption>{data.title}</figcaption> : null}
      <div ref={box} className="view-chart-plot">
        {data.kind === 'donut' ? <Donut data={data} width={width} name={name} /> : data.kind === 'line' ? <Lines data={data} width={width} name={name} /> : <Bars data={data} width={width} name={name} />}
      </div>
      {many ? (
        <ul className="view-legend">
          {data.series.map((one, index) => (
            <li key={index}>
              <i style={{ background: color(index) }} aria-hidden="true" />
              <span className="view-legend-name">{one.name}</span>
            </li>
          ))}
        </ul>
      ) : null}
      <table className="view-sr">
        <caption>{data.title ?? kindNames[data.kind]}</caption>
        <thead>
          <tr>
            <th scope="col">Label</th>
            {data.series.map((one, index) => <th key={index} scope="col">{one.name}</th>)}
          </tr>
        </thead>
        <tbody>
          {data.labels.map((label, row) => (
            <tr key={row}>
              <th scope="row">{label}</th>
              {data.series.map((one, index) => <td key={index}>{show(one.values[row], data.unit)}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  )
}
