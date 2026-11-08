import { useEffect, useRef } from 'react'
import { motion } from 'motion/react'

/** An agent's session as Claude Code shows it: your words after ›, what it says after a dot, tool output under ⎿. The dot it writes is an emoji on an iPhone: it's drawn as ●. */
export function Terminal({ lines, working, doing }: { lines: string[]; working: boolean; doing?: string }) {
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    box.current?.scrollTo({ top: box.current.scrollHeight, behavior: 'smooth' })
  }, [lines.length])

  return (
    <div className="terminal mono" ref={box}>
      {lines.map((line, index) => {
        const kind = line.startsWith('›') ? 'you' : line.startsWith('⏺') ? (/^⏺ [A-Z][a-zA-Z]+\(/.test(line) ? 'tool' : 'said') : 'out'
        return (
          <motion.div key={index} className={`t-line ${kind}`} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25 }}>
            {kind === 'tool' ? <><span className="t-dot">●</span> <b>{line.slice(2, line.indexOf('('))}</b>{line.slice(line.indexOf('('))}</> : kind === 'said' ? <><span className="t-dot said">●</span>{line.slice(1)}</> : line}
          </motion.div>
        )
      })}
      {working && (
        <div className="t-line working">
          <span className="t-star">✻</span> {doing ?? 'Working'}… <span className="t-hint">esc to interrupt</span>
        </div>
      )}
    </div>
  )
}
