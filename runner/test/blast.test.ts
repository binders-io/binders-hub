import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { blastRadius, blastSummary, isTest } from '../src/blast.ts'

describe('a change’s blast radius', () => {
  it('finds what the change touched, where else it’s used, and which tests mention it', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'binders-blast-'))
    await mkdir(join(repo, 'src'))
    await mkdir(join(repo, 'test'))
    // The code as the reviewer's folder has it.
    await writeFile(join(repo, 'src/lib.ts'), 'export function priceOf(item: Item) {\n  return item.cost * 2\n}\n\nexport function keepIt() {\n  return 1\n}\n')
    await writeFile(join(repo, 'src/cart.ts'), "import { legacyTotal, priceOf } from './lib'\n\nexport const total = (items: Item[]) => items.map(priceOf)\nexport const old = legacyTotal\n")
    await writeFile(join(repo, 'test/lib.test.ts'), "import { keepIt } from '../src/lib'\nkeepIt()\n")
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo })
    execFileSync('git', ['add', '.'], { cwd: repo })
    execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/acme/shop.git'], { cwd: repo })

    // The change: priceOf's body changed (its hunk's header names it), legacyTotal removed, discountOf added; and one
    // file in another repo of the change set.
    const files = [
      { path: 'acme/shop#4: src/lib.ts', diff: ['@@ export function priceOf(item: Item) {', '  2 -  return item.cost', '  2 +  return item.cost * 2', '@@ ', ' 9 -export function legacyTotal(items: Item[]) {', ' 10 -  return 0', ' 11 -}', ' 9 +export function discountOf(item: Item) {', ' 10 +  return 0', ' 11 +}'].join('\n') },
      { path: 'acme/api#2: src/routes.ts', diff: ['@@ ', '  1 +export function route() {}'].join('\n') },
    ]
    const blast = await blastRadius(files, repo, 'acme/shop')
    const by = Object.fromEntries(blast.symbols.map((s) => [s.name, s]))
    assert.deepEqual(blast.symbols.map((s) => [s.name, s.change]), [['legacyTotal', 'removed'], ['priceOf', 'changed'], ['discountOf', 'added']])
    assert.deepEqual(by.legacyTotal.uses.map((u) => `${u.file}:${u.line}`), ['src/cart.ts:1', 'src/cart.ts:4'], 'removed, and still used')
    assert.deepEqual(by.priceOf.uses.map((u) => u.file), ['src/cart.ts', 'src/cart.ts'])
    assert.equal(by.priceOf.tests.length, 0)
    assert.equal(blast.stillUsed, 1)
    assert.equal(blast.untested, 2, 'priceOf and discountOf: no test mentions them')
    assert.deepEqual(blast.elsewhere, ['acme/api'], 'a repo this machine doesn’t have')
    assert.match(blastSummary(blast), /legacyTotal \(removed, src\/lib\.ts\): src\/cart\.ts:1, src\/cart\.ts:4/)
  })

  it('tells tests by where they are and what they’re called', () => {
    for (const file of ['test/a.ts', 'src/a.test.ts', 'pkg/a_test.go', 'tests/test_a.py', 'BindersTests/AppTests.swift', '__tests__/x.js']) assert.ok(isTest(file), file)
    for (const file of ['src/a.ts', 'latest/a.ts', 'contest.ts']) assert.ok(!isTest(file), file)
  })
})
