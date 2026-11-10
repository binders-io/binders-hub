import { useCallback, useEffect, useState } from 'react'
import type { PullRequest } from '../data/model'
import { call } from '../data/api'

// A pull request's diff, asked for when it's opened: the state has each file's name and counts, and its lines are most
// of what a page would otherwise download to show a board. A tab keeps the last few it opened.

type Files = PullRequest['files']

const kept = new Map<string, { sign: string; files: Files }>()
const keepMost = 12

/** Changes when the pull request's diff does, so one that moved on is asked for again. */
const signOf = (pull: PullRequest) => `${pull.head ?? ''}|${pull.files.map((f) => `${f.path}+${f.added}-${f.removed}`).join('|')}`

function keep(id: string, sign: string, files: Files) {
  kept.delete(id)
  kept.set(id, { sign, files })
  if (kept.size > keepMost) kept.delete(kept.keys().next().value!)
}

/** Lines a file shows before "Show the rest". */
const fileLines = 300

/** A pull request's files with their lines, once they're here. A state that came with its lines needs no asking. */
function useFiles(pull: PullRequest) {
  const sign = signOf(pull)
  const inState = pull.files.some((f) => f.lines.length > 0)
  const [got, setGot] = useState<{ sign: string; files: Files } | undefined>()
  const [failed, setFailed] = useState(false)
  const [tries, setTries] = useState(0)
  const known = kept.get(pull.id)
  const here = inState ? pull.files : known?.sign === sign ? known.files : got?.sign === sign ? got.files : undefined
  const asking = !here && pull.files.length > 0
  useEffect(() => {
    if (!asking) return
    let gone = false
    setFailed(false)
    call<{ files: Files }>('GET', `/api/pulls/${encodeURIComponent(pull.repo)}/${pull.number}/files`).then(
      ({ files }) => {
        keep(pull.id, sign, files)
        if (!gone) setGot({ sign, files })
      },
      () => {
        if (!gone) setFailed(true)
      },
    )
    return () => {
      gone = true
    }
  }, [asking, pull.id, pull.repo, pull.number, sign, tries])
  const again = useCallback(() => setTries((n) => n + 1), [])
  return { files: here, failed, again }
}

/** A pull request's files and their diffs. Until they're here, each file's name and counts. */
export function PullDiffs({ pull, boxed = false }: { pull: PullRequest; boxed?: boolean }) {
  const { files, failed, again } = useFiles(pull)
  if (!files) {
    return (
      <>
        {failed && (
          <div className="file-empty file-failed" role="alert">
            These changes didn’t load. <button type="button" className="text-button" onClick={again}>Try again</button>
          </div>
        )}
        {!failed && <div className="file-empty" role="status">Loading the changes…</div>}
        {pull.files.map((file) => (
          <div key={file.path} className={boxed ? 'pull file-card' : 'file'}><FileHead file={file} /></div>
        ))}
      </>
    )
  }
  return <>{files.map((file) => <FileDiff key={file.path} file={file} boxed={boxed} />)}</>
}

function FileHead({ file }: { file: Files[number] }) {
  return (
    <div className="file-head mono">
      <span>{file.path}</span>
      <span className="num"><span className="plus">+{file.added}</span> <span className="minus">−{file.removed}</span></span>
    </div>
  )
}

/** A file's diff: its first lines, and the rest when asked for. */
function FileDiff({ file, boxed }: { file: Files[number]; boxed: boolean }) {
  const [all, setAll] = useState(false)
  const lines = all ? file.lines : file.lines.slice(0, fileLines)
  return (
    <div className={boxed ? 'pull file-card' : 'file'}>
      <FileHead file={file} />
      <div className="diff mono">
        {lines.map((line, i) => (
          <div key={i} className={`d-line ${line.kind === '+' ? 'add' : line.kind === '-' ? 'del' : line.kind === '@' ? 'hunk' : ''}`}>
            <span className="d-sign">{line.kind === '@' ? '' : line.kind}</span>
            <span className="d-text">{line.text || ' '}</span>
          </div>
        ))}
      </div>
      {lines.length < file.lines.length && (
        <button type="button" className="file-more" onClick={() => setAll(true)}>Show the other {file.lines.length - lines.length} lines</button>
      )}
    </div>
  )
}
