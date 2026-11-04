import { after } from 'node:test'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { heldIn } from '../src/held.ts'

// Every temp folder of a test file's goes under one of its own, and whatever is still running in there when the file
// ends is stopped, however its tests went: a stand-in in a holder outlives its runner, as a real agent's is meant to.

// A Mac's temp folder is a long path, and a holder's socket has little room: /tmp, where there is one.
const root = mkdtempSync(join(existsSync('/tmp') ? '/tmp' : tmpdir(), 'b-'))
process.env.TMPDIR = root

/** Each folder of holders under the tests' temp folder. */
function holderRoots() {
  const roots = new Set<string>()
  for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
    if (entry.isFile() && entry.name === 'meta.json') roots.add(dirname(entry.parentPath))
  }
  return [...roots]
}

after(async () => {
  for (const found of holderRoots()) {
    for (const held of await heldIn(found)) {
      await held.stopAndWait(2000)
      await held.stopOrphan()
    }
  }
  rmSync(root, { recursive: true, force: true, maxRetries: 5 })
})
