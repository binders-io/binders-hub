import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

/**
 * The app's whole stylesheet as the browser gets it: app.css is a list of @import lines, one file per area, so a test
 * that reads the rules reads them all, in their order, wherever a rule now lives.
 */
export function appCss(file = resolve(import.meta.dirname, '../src/app.css')): string {
  const text = readFileSync(file, 'utf8')
  return text.replace(/^@import '([^']+)';$/gm, (_, path: string) => appCss(join(dirname(file), path)))
}
