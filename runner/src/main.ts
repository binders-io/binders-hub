#!/usr/bin/env node
import { parseArgs } from 'node:util'
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Runner } from './runner.ts'
import { daemonCommand, subcommands, usage } from './daemon.ts'
import { agentCommand } from './desk.ts'

// binders-runner: keeps one agent working on what Binders gives it.
//
//   BINDERS_TOKEN=bnd_… binders-runner --hub http://localhost:5173 --workspace ~/code/my-repo
//
// The token is the agent's, from Binders' Agents page; it's read from BINDERS_TOKEN so it isn't in the shell's history.
// Which tool runs, how much access it has, its model and time limit are the agent's runner settings, on the Agents page.

// An agent's own binders command, from the small script its run has on its PATH (desk.ts).
if (process.argv[2] === 'agent') process.exit(await agentCommand(process.argv.slice(3)))

// binders add / list / logs / start / stop / restart / remove: agents in the background (daemon.ts).
const sub = process.argv[2]
if (sub && (subcommands.has(sub) || sub === 'help')) {
  if (sub === 'help') {
    console.log(usage)
    process.exit(0)
  }
  try {
    process.exit(await daemonCommand(process.argv.slice(2), (hub, token) => new Runner({ hubUrl: hub, token, workspace: process.cwd(), log: () => {} }).identity()))
  } catch (error) {
    console.error((error as Error).message)
    process.exit(1)
  }
}

const { values } = parseArgs({
  options: {
    hub: { type: 'string', default: process.env.BINDERS_URL ?? 'http://localhost:5173' },
    workspace: { type: 'string' },
    machine: { type: 'string' },
    once: { type: 'boolean', default: false },
    'idle-minutes': { type: 'string' },
    'token-file': { type: 'string' },
    name: { type: 'string' },
    help: { type: 'boolean', default: false },
  },
})

if (values.help) {
  console.log(`binders-runner: keeps one Binders agent working.

  BINDERS_TOKEN=bnd_… binders-runner [--hub URL] [--workspace DIR] [--machine NAME] [--idle-minutes N] [--once]

  --hub        the Binders web app's address (BINDERS_URL, or http://localhost:5173)
  --workspace  where the agent works: a repo (each card in a worktree of its own) or a folder of repos (the folder
               itself). Without it, the agent's settings on the Agents page say, else this folder.
  --machine    the name it shows as running on (this computer's)
  --idle-minutes  minutes without a word from the agent before its run is stopped as stuck (15; the agent's
               settings can say otherwise)
  --once       take one card, then stop
  --token-file read the token from this file, not BINDERS_TOKEN (as binders add runs it)

To keep agents running in the background instead: binders add --token bnd_… (binders help).

The tool it runs (Claude Code, Codex or your own command), its access, model and time limit are the agent's
runner settings, on Binders' Agents page.`)
  process.exit(0)
}

const token = values['token-file'] ? readFileSync(values['token-file'], 'utf8').trim() : process.env.BINDERS_TOKEN
if (!token) {
  console.error('Set BINDERS_TOKEN to the agent’s token from Binders’ Agents page.')
  process.exit(1)
}

// Run as the single file the hub hands out, the runner keeps itself current: this process stays as a small supervisor
// and runs the runner itself as a child. When the hub has a newer runner and the child is idle, the child replaces
// the file and exits with 75; the supervisor starts it again, on the new code. Ctrl-C stops both.
const file = import.meta.url.endsWith('.mjs') ? fileURLToPath(import.meta.url) : undefined
const restart = 75
if (file && !process.env.BINDERS_RUNNER_WORKER) {
  let stopping = false
  // One id for the runner across its restarts, so the hub doesn't take the restarted one for a second runner.
  const id = Math.random().toString(16).slice(2, 14)
  for (;;) {
    const code = await new Promise<number>((done) => {
      const child = spawn(process.execPath, [file, ...process.argv.slice(2)], { stdio: 'inherit', env: { ...process.env, BINDERS_RUNNER_WORKER: '1', BINDERS_RUNNER_ID: id } })
      // Ctrl-C reaches the child too (one process group): it puts its cards back and stops. Another signal is passed on.
      const onInt = () => { stopping = true }
      const onTerm = () => { stopping = true; child.kill('SIGTERM') }
      process.on('SIGINT', onInt)
      process.on('SIGTERM', onTerm)
      child.on('exit', (exit, signal) => {
        process.off('SIGINT', onInt)
        process.off('SIGTERM', onTerm)
        done(exit ?? (signal ? 1 : 0))
      })
    })
    if (code === restart && !stopping) continue
    process.exit(code)
  }
}

const runner = new Runner({ hubUrl: values.hub!, token, workspace: values.workspace ?? process.cwd(), workspaceGiven: !!values.workspace, machine: values.machine, selfUpdate: file, idleMinutes: values['idle-minutes'] ? Math.max(1, Number(values['idle-minutes'])) || undefined : undefined })
const stop = () => {
  console.log('Stopping: the card in hand is put back if it isn’t finished.')
  runner.stop()
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)

try {
  await runner.start(values.once)
  // Replaced by a newer runner: the supervisor starts it again.
  if (runner.updated) process.exit(restart)
} catch (error) {
  console.error((error as Error).message)
  process.exit(1)
}
