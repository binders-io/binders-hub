import { Fragment, useDeferredValue, useId, useMemo, useState, type MouseEvent, type ReactNode } from 'react'
import { ChevronRight, Search, X } from 'lucide-react'
import { sheetQuery, useMedia } from '../components/bits'
import { EmptyState } from './EmptyState'
import { Skeleton } from './Skeleton'

/** A column: its header, what its cell shows, and what it is on a phone. */
export interface Column<T> {
  key: string
  header: string
  cell: (row: T) => ReactNode
  /** Its words, for the filter box to match. A table filters by the columns that have this. */
  text?: (row: T) => string
  /** On a phone: the row's title, part of the line under it (the default), or left out. One column is the title. */
  phone?: 'title' | 'meta' | 'hidden'
  /** Its width on a wide window, as CSS: "40%", "140px". The others share what's left. */
  width?: string
  /** 'end' for numbers and dates. */
  align?: 'start' | 'end'
}

// What a click in a row that lands on one of these means is theirs, not the row's.
const ownClick = 'a, button, input, select, textarea, label, summary, [role="button"], [role="switch"], [role="menuitem"]'

/**
 * Rows of things with the same few facts each, for a list that may be long: a real table on a wide window (its header
 * kept in view, the whole row pressable, with a chevron to say so), and on a phone the same rows stacked, each its
 * title and a line of the rest. It draws a page at a time ("Show more"), so thousands of rows cost what one page does,
 * and the filter box searches all of them.
 */
export function DataTable<T>({ label, columns, rows, rowKey, onRowPress, rowLabel, empty, loading = false, filter, pageSize = 50 }: {
  /** The table's name, for a screen reader: "Repos". */
  label: string
  columns: Column<T>[]
  rows: T[]
  rowKey: (row: T) => string
  /** Pressing a row: open it, in a dialog on a wide window and a sheet on a phone. */
  onRowPress?: (row: T) => void
  /** What pressing a row does, said for it: "Open acme/web". The title column's words otherwise. */
  rowLabel?: (row: T) => string
  /** What shows when there are no rows at all: an EmptyState, usually. */
  empty?: ReactNode
  /** Skeleton rows in place of the rows, while they're on their way. */
  loading?: boolean
  /** A filter box over the table, with these words in it until something is typed: "Filter repos". */
  filter?: string
  /** How many rows a page draws. */
  pageSize?: number
}) {
  const phone = useMedia(sheetQuery)
  const [query, setQuery] = useState('')
  const [pages, setPages] = useState(1)
  // Typing stays quick over thousands of rows: the list follows the box a moment behind.
  const deferred = useDeferredValue(query)
  const filterId = useId()
  const titleColumn = columns.find((c) => c.phone === 'title') ?? columns[0]
  const words = useMemo(() => deferred.trim().toLowerCase().split(/\s+/).filter(Boolean), [deferred])
  const matching = useMemo(() => {
    if (!words.length) return rows
    const searched = columns.filter((c) => c.text)
    return rows.filter((row) => {
      const text = searched.map((c) => c.text!(row)).join(' ').toLowerCase()
      return words.every((word) => text.includes(word))
    })
  }, [rows, columns, words])
  const shown = matching.slice(0, pages * pageSize)
  const more = matching.length - shown.length
  const nameOf = (row: T) => rowLabel?.(row) ?? titleColumn.text?.(row)

  const changeQuery = (value: string) => {
    setQuery(value)
    setPages(1)
  }
  const pressRow = (event: MouseEvent, row: T) => {
    if ((event.target as Element).closest(ownClick)) return
    onRowPress?.(row)
  }

  const filterBox = filter && (
    <div className="data-table-filter">
      <Search size={15} aria-hidden="true" />
      <label htmlFor={filterId} className="sr-only">{filter}</label>
      <input id={filterId} className="input" type="search" placeholder={filter} value={query} onChange={(e) => changeQuery(e.target.value)} autoComplete="off" spellCheck={false} />
      {query && <button type="button" className="icon-button" aria-label="Clear the filter" onClick={() => changeQuery('')}><X size={14} /></button>}
    </div>
  )

  const nothing = !loading && !rows.length
  const nothingMatches = !loading && rows.length > 0 && !matching.length
  const status = loading ? 'Loading' : words.length ? `${matching.length} of ${rows.length} shown` : ''

  let body: ReactNode
  if (nothing) body = <div className="data-table-empty">{empty ?? <EmptyState compact title="Nothing here yet" />}</div>
  else if (nothingMatches) {
    body = (
      <div className="data-table-empty">
        <EmptyState compact title={`Nothing matches “${query.trim()}”`} action={<button type="button" className="button small" onClick={() => changeQuery('')}>Clear the filter</button>} />
      </div>
    )
  } else if (phone) {
    body = (
      <ul className="rows data-table-rows" aria-label={label} aria-busy={loading || undefined}>
        {loading
          ? Array.from({ length: 5 }, (_, i) => (
            <li key={i} className="rows-item"><div className="rows-main"><span className="rows-text"><Skeleton width="55%" height={13} /><Skeleton width="80%" height={11} /></span></div></li>
          ))
          : shown.map((row) => {
            const meta = columns.filter((c) => c !== titleColumn && (c.phone ?? 'meta') === 'meta')
            const inner = (
              <>
                <span className="rows-text">
                  <span className="rows-title">{titleColumn.cell(row)}</span>
                  {meta.length > 0 && <span className="rows-meta">{meta.map((c, i) => <Fragment key={c.key}>{i > 0 && <span className="data-table-dot" aria-hidden="true">·</span>}<span>{c.cell(row)}</span></Fragment>)}</span>}
                </span>
                {onRowPress && <ChevronRight size={16} className="rows-chevron" aria-hidden="true" />}
              </>
            )
            return (
              <li key={rowKey(row)} className={`rows-item${onRowPress ? ' pressable' : ''}`}>
                {onRowPress ? <button type="button" className="rows-main" onClick={() => onRowPress(row)}>{inner}</button> : <div className="rows-main">{inner}</div>}
              </li>
            )
          })}
      </ul>
    )
  } else {
    body = (
      <table className={`data-table-grid${onRowPress ? ' pressable' : ''}`} aria-busy={loading || undefined}>
        <caption className="sr-only">{label}</caption>
        <colgroup>
          {columns.map((c) => <col key={c.key} style={c.width ? { width: c.width } : undefined} />)}
          {onRowPress && <col className="data-table-go-col" />}
        </colgroup>
        <thead>
          <tr>
            {columns.map((c) => <th key={c.key} scope="col" className={c.align === 'end' ? 'end' : undefined}>{c.header}</th>)}
            {onRowPress && <th scope="col" className="data-table-go"><span className="sr-only">Open</span></th>}
          </tr>
        </thead>
        <tbody>
          {loading
            ? Array.from({ length: 5 }, (_, i) => (
              <tr key={i}>
                {columns.map((c, j) => <td key={c.key}><Skeleton width={j === 0 ? '70%' : '50%'} height={12} /></td>)}
                {onRowPress && <td />}
              </tr>
            ))
            : shown.map((row) => (
              <tr key={rowKey(row)} onClick={onRowPress ? (event) => pressRow(event, row) : undefined}>
                {columns.map((c) => (
                  <td key={c.key} className={c.align === 'end' ? 'end' : undefined}>
                    {/* The way in for a keyboard and a screen reader: the title is the row's button; a pointer has the whole row. */}
                    {onRowPress && c === titleColumn
                      ? <button type="button" className="data-table-open" onClick={() => onRowPress(row)} aria-label={nameOf(row)}>{c.cell(row)}</button>
                      : c.cell(row)}
                  </td>
                ))}
                {onRowPress && <td className="data-table-go" aria-hidden="true"><ChevronRight size={16} /></td>}
              </tr>
            ))}
        </tbody>
      </table>
    )
  }

  return (
    <div className="data-table">
      {filterBox}
      <p className="sr-only" role="status">{status}</p>
      {body}
      {more > 0 && (
        <div className="data-table-more">
          <span>{shown.length.toLocaleString()} of {matching.length.toLocaleString()}</span>
          <button type="button" className="button small" onClick={() => setPages(pages + 1)}>Show {Math.min(more, pageSize).toLocaleString()} more</button>
        </div>
      )}
    </div>
  )
}
