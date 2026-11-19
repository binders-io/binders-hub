import { execFile, spawn } from 'node:child_process'
import type { EventEmitter } from 'node:events'
import { promisify } from 'node:util'

// An agent kept to the Binders app, on a Mac: `binders set NAME --while-app-open on` has its service run
// `binders-runner while-app-open …` instead of the runner itself. This waits for the app to be open, runs the runner
// while it is, and asks it to stop when the app quits, as its service stopping does: a card kept running through
// restarts carries on, for the next runner to pick up. Then it waits for the app again.

/**
 * Whether the Binders app is open, from `ps -axo command=`: the app as people open it, which runs with no arguments.
 * The `Binders --mcp` that AI tools start from the same app is a server of theirs, not the app open.
 */
export function appOpenIn(commands: string) {
  return commands.split('\n').some((line) => /\/Binders\.app\/Contents\/MacOS\/Binders$/.test(line.trim()))
}

/** Whether the Binders app is open on this Mac now. */
export async function appOpen() {
  const { stdout } = await promisify(execFile)('ps', ['-axo', 'command='], { maxBuffer: 16 * 1024 * 1024 }).catch(() => ({ stdout: '' }))
  return appOpenIn(stdout)
}

/** The runner it runs, as far as this needs it. */
export interface Child {
  kill: (signal: NodeJS.Signals) => void
  exited: Promise<number>
}

/** The runner, as the service would have run it: this same file, with the rest of the arguments. */
function startRunner(args: string[]): Child {
  const child = spawn(process.execPath, [process.argv[1], ...args], { stdio: 'inherit' })
  return {
    kill: (signal) => { child.kill(signal) },
    exited: new Promise((done) => child.on('exit', (code, signal) => done(code ?? (signal ? 1 : 0)))),
  }
}

/**
 * Runs the runner only while the Binders app is open. Ctrl-C, or its service stopping, passes on to the runner and ends
 * this too; the runner ending by itself while the app is open ends this with its code, for the service to start again.
 */
export async function whileAppOpen(args: string[], deps: { open?: () => Promise<boolean>; start?: (args: string[]) => Child; every?: number; log?: (line: string) => void; signals?: EventEmitter } = {}): Promise<number> {
  const open = deps.open ?? appOpen
  const start = deps.start ?? startRunner
  const every = deps.every ?? 5_000
  const log = deps.log ?? ((line: string) => console.log(`${new Date().toISOString()} ${line}`))
  const signals = deps.signals ?? process
  let child: Child | undefined
  let stopping = false
  let wake = () => {}
  const nap = () => new Promise<void>((done) => {
    const timer = setTimeout(done, every)
    wake = () => { clearTimeout(timer); done() }
  })
  const onSignal = (signal: NodeJS.Signals) => () => {
    stopping = true
    child?.kill(signal)
    wake()
  }
  const onInt = onSignal('SIGINT')
  const onTerm = onSignal('SIGTERM')
  signals.on('SIGINT', onInt)
  signals.on('SIGTERM', onTerm)
  try {
    for (;;) {
      let said = false
      while (!stopping && !(await open())) {
        if (!said) log('Waiting for the Binders app to open.')
        said = true
        await nap()
      }
      if (stopping) return 0
      log('The Binders app is open: starting.')
      const running = start(args)
      child = running
      let ended = false
      let closed = false
      const watching = (async () => {
        while (!ended) {
          await nap()
          if (ended || stopping) return
          if (!(await open())) {
            closed = true
            log('The Binders app quit: stopping until it opens again.')
            running.kill('SIGTERM')
            return
          }
        }
      })()
      const code = await running.exited
      ended = true
      child = undefined
      wake()
      await watching
      if (stopping || !closed) return code
    }
  } finally {
    signals.off('SIGINT', onInt)
    signals.off('SIGTERM', onTerm)
  }
}
