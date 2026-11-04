import { execFile, spawn } from 'node:child_process'
import { chmod, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { heldIn } from './held.ts'

// Agents in the background: `binders add` sets an agent up on this machine and keeps its runner going as a service of
// the user's (a LaunchAgent on a Mac, a systemd --user unit on Linux), which starts at login, starts again after a
// crash, and writes its log to ~/.binders/logs. `binders list` shows them, and logs, start, stop, restart and remove
// do what they say. What each one is (its hub, folder and name) is kept in ~/.binders/agents/<name>.json, its token
// beside it in a file only this user can read, never in the service's own settings.

const run = promisify(execFile)

export const subcommands = new Set(['add', 'list', 'ls', 'logs', 'start', 'stop', 'restart', 'remove', 'rm'])

const base = () => process.env.BINDERS_HOME ?? join(homedir(), '.binders')
const agentsDir = () => join(base(), 'agents')
const logsDir = () => join(base(), 'logs')
const runnerFile = () => join(base(), 'binders-runner.mjs')
const label = (name: string) => `io.binders.runner.${name}`
const plistOf = (name: string) => join(homedir(), 'Library', 'LaunchAgents', `${label(name)}.plist`)
const unitName = (name: string) => `binders-runner-${name}.service`
const unitOf = (name: string) => join(homedir(), '.config', 'systemd', 'user', unitName(name))
const logOf = (name: string) => join(logsDir(), `${name}.log`)
const tokenOf = (name: string) => join(agentsDir(), `${name}.token`)

export interface Saved {
  name: string
  /** The agent's name on the hub, and its id there. */
  agent: string
  agentId?: string
  hub: string
  workspace: string
  addedAt: string
}

/**
 * Why not to do this as root: a service of root's, made through sudo, leaves files only root can write and never reaches
 * its person's login. Someone who signs in as root on Linux has a service manager of their own, and stays welcome.
 */
export function refusedAsRoot(uid: number | undefined, os: NodeJS.Platform = process.platform, sudoUser = process.env.SUDO_USER) {
  if (uid !== 0 || (os !== 'darwin' && !sudoUser)) return undefined
  return `Run this as yourself, without sudo: an agent's service runs as the account that sets it up.${sudoUser ? ` If sudo left files behind: sudo chown -R "${sudoUser}" ~/.binders` : ''}`
}

type Platform = 'mac' | 'linux' | 'other'
const platform: Platform = process.platform === 'darwin' ? 'mac' : process.platform === 'linux' ? 'linux' : 'other'

const slug = (text: string) => text.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'agent'
const xml = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const home = (path: string) => (path.startsWith('~/') ? join(homedir(), path.slice(2)) : resolve(path))

async function saved(): Promise<Saved[]> {
  const names = await readdir(agentsDir()).catch(() => [] as string[])
  const all = await Promise.all(names.filter((n) => n.endsWith('.json')).map((n) => readFile(join(agentsDir(), n), 'utf8').then((t) => JSON.parse(t) as Saved).catch(() => undefined)))
  return all.filter((s): s is Saved => !!s).sort((a, b) => a.name.localeCompare(b.name))
}

async function one(name: string | undefined): Promise<Saved> {
  const all = await saved()
  if (!name) throw new Error(all.length ? `Which agent? ${all.map((s) => s.name).join(', ')}` : 'No agents on this machine yet: binders add --token … sets one up.')
  const found = all.find((s) => s.name === name) ?? all.find((s) => s.name.startsWith(name) || slug(s.agent) === slug(name))
  if (!found) throw new Error(`No agent “${name}” on this machine. binders list shows them.`)
  return found
}

// The service --------------------------------------------------------------------------------------------------------

// launchd's domains for this user, in order: the desktop session's (gui/<uid>), and the user's own (user/<uid>), which
// every session has. Over SSH, or in a terminal without a desktop session (the hub's agent terminal among them),
// launchd refuses gui/ with "125: Domain does not support specified action", so the service goes in user/ instead.
const domains = () => [`gui/${process.getuid!()}`, `user/${process.getuid!()}`]

/** Whether launchd refused a domain because this session doesn't have it. */
export const refusedDomain = (error: unknown) => {
  const e = error as { stderr?: string; message?: string } | undefined
  return /\b125\b|domain does not support/i.test(`${e?.stderr ?? ''} ${e?.message ?? String(error)}`)
}

type Launchctl = (args: string[]) => Promise<unknown>
const launchctl: Launchctl = (args) => run('launchctl', args)

/** Loads a service from its plist, into the first of this user's domains this session has. Says which. */
export async function bootstrap(plist: string, call: Launchctl = launchctl, all = domains()) {
  let refused: unknown
  for (const domain of all) {
    try {
      await call(['bootstrap', domain, plist])
      return domain
    } catch (error) {
      if (!refusedDomain(error)) throw error
      refused = error
    }
  }
  throw refused
}

/** The domain an agent's service is loaded in, if it is. */
async function loadedIn(name: string) {
  for (const domain of domains()) if (await run('launchctl', ['print', `${domain}/${label(name)}`]).then(() => true, () => false)) return domain
  return undefined
}

/** Takes an agent's service out of launchd, whichever domain it's in. */
const bootout = (name: string) => Promise.all(domains().map((d) => run('launchctl', ['bootout', `${d}/${label(name)}`]).catch(() => undefined)))

/** What the service runs: this Node, the runner file, and where to find the agent's token. */
function command(s: Saved) {
  return [process.execPath, runnerFile(), '--hub', s.hub, '--workspace', s.workspace, '--token-file', tokenOf(s.name), '--name', s.name]
}

/** The PATH the agent's tools are found on: this shell's, which has them, and the usual places. */
const path = () => [...new Set([...(process.env.PATH ?? '').split(':'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', join(homedir(), '.local/bin')].filter(Boolean))].join(':')

/**
 * Its systemd unit. KillMode=process: stopping it signals the runner alone, which stops what it should. By default
 * systemd also kills everything else it started, and a card's holder is there to outlive the runner.
 */
export function unitFor(s: Saved) {
  const quote = (a: string) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `"${a.replace(/(["\\$`])/g, '\\$1')}"`)
  return `[Unit]
Description=Binders runner: ${s.agent}

[Service]
ExecStart=${command(s).map(quote).join(' ')}
WorkingDirectory=${s.workspace}
Environment=PATH=${path()}
Restart=always
RestartSec=10
KillMode=process
StandardOutput=append:${logOf(s.name)}
StandardError=append:${logOf(s.name)}

[Install]
WantedBy=default.target
`
}

async function writeUnit(s: Saved) {
  await mkdir(join(homedir(), '.config', 'systemd', 'user'), { recursive: true })
  await writeFile(unitOf(s.name), unitFor(s))
  await run('systemctl', ['--user', 'daemon-reload'])
}

async function install(s: Saved) {
  await mkdir(logsDir(), { recursive: true })
  if (platform === 'mac') {
    const args = command(s).map((a) => `    <string>${xml(a)}</string>`).join('\n')
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${label(s.name)}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>WorkingDirectory</key><string>${xml(s.workspace)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${xml(path())}</string>
    <key>HOME</key><string>${xml(homedir())}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>${xml(logOf(s.name))}</string>
  <key>StandardErrorPath</key><string>${xml(logOf(s.name))}</string>
</dict>
</plist>
`
    await mkdir(join(homedir(), 'Library', 'LaunchAgents'), { recursive: true })
    await writeFile(plistOf(s.name), plist)
    await bootout(s.name)
    await bootstrap(plistOf(s.name))
    return
  }
  if (platform === 'linux') {
    await writeUnit(s)
    await run('systemctl', ['--user', 'enable', '--now', unitName(s.name)])
    return
  }
  throw new Error('Running agents in the background works on macOS and Linux. Here, start one in a terminal: BINDERS_TOKEN=… node ~/.binders/binders-runner.mjs --hub …')
}

/** Whether its service is running, and as which process. */
async function status(s: Saved): Promise<{ running: boolean; pid?: number; loaded: boolean }> {
  if (platform === 'mac') {
    const domain = await loadedIn(s.name)
    const out = domain ? await run('launchctl', ['print', `${domain}/${label(s.name)}`]).then((r) => r.stdout, () => '') : ''
    if (!out) return { running: false, loaded: false }
    const pid = Number(/\bpid = (\d+)/.exec(out)?.[1]) || undefined
    return { running: /\bstate = running\b/.test(out), pid, loaded: true }
  }
  if (platform === 'linux') {
    const out = await run('systemctl', ['--user', 'show', unitName(s.name), '-p', 'ActiveState', '-p', 'MainPID', '-p', 'LoadState']).then((r) => r.stdout, () => '')
    const pid = Number(/MainPID=(\d+)/.exec(out)?.[1]) || undefined
    return { running: /ActiveState=active/.test(out), pid, loaded: !/LoadState=not-found/.test(out) }
  }
  return { running: false, loaded: false }
}

async function start(s: Saved) {
  if (platform === 'mac') {
    const domain = await loadedIn(s.name)
    if (!domain) return install(s)
    await run('launchctl', ['kickstart', `${domain}/${label(s.name)}`])
  } else if (platform === 'linux') await run('systemctl', ['--user', 'start', unitName(s.name)])
}

async function stop(s: Saved) {
  // Taken out of launchd altogether: kept alive, a stopped one would only be started again.
  if (platform === 'mac') await bootout(s.name)
  else if (platform === 'linux') {
    // A unit set up before KillMode=process would take the cards a stop now leaves running.
    await writeUnit(s).catch(() => undefined)
    await run('systemctl', ['--user', 'stop', unitName(s.name)]).catch(() => undefined)
  }
}

async function restart(s: Saved) {
  if (platform === 'mac') {
    const domain = await loadedIn(s.name)
    if (!domain) return install(s)
    // Asked to go, so it can leave what it should and say so (kickstart -k doesn't ask): launchd keeps it alive.
    await run('launchctl', ['kill', 'SIGTERM', `${domain}/${label(s.name)}`]).catch(() => undefined)
    await run('launchctl', ['kickstart', `${domain}/${label(s.name)}`]).catch(() => undefined)
  } else if (platform === 'linux') {
    // A unit set up before KillMode=process would take its cards with it.
    await writeUnit(s)
    await run('systemctl', ['--user', 'restart', unitName(s.name)])
  }
}

/** Asks its runner to end what it's running for good: its cards go back on the board, as with Ctrl-C. */
async function endRunner(s: Saved) {
  const { running, pid } = await status(s)
  if (!running || !pid) return
  process.kill(pid, 'SIGINT')
  const until = Date.now() + 10_000
  const alive = () => {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }
  while (Date.now() < until && alive()) await new Promise((done) => setTimeout(done, 100))
}

/** Whatever is still in a holder, with no runner to come back to it, stopped and its cards given back. */
async function endHeld(s: Saved, handBack: HandBack) {
  if (!s.agentId) return
  const left = await heldIn(join(base(), 'held', s.agentId.replace(/[^\w-]/g, '').slice(0, 12)))
  const cards = left.filter((held) => held.meta.kind === 'card').map((held) => held.meta.key)
  for (const held of left) {
    await held.stopAndWait()
    if (held.meta.github) await rm(held.meta.github, { recursive: true, force: true })
    if (held.meta.config) await rm(held.meta.config, { force: true })
    await held.remove()
  }
  if (!cards.length) return
  const token = await readFile(tokenOf(s.name), 'utf8').then((text) => text.trim(), () => '')
  if (token) await handBack(s.hub, token, cards, 'Its runner was removed from this machine.').catch(() => undefined)
}

async function remove(s: Saved, handBack: HandBack) {
  await endRunner(s)
  await stop(s)
  await endHeld(s, handBack)
  if (platform === 'mac') await rm(plistOf(s.name), { force: true })
  if (platform === 'linux') {
    await run('systemctl', ['--user', 'disable', unitName(s.name)]).catch(() => undefined)
    await rm(unitOf(s.name), { force: true })
    await run('systemctl', ['--user', 'daemon-reload']).catch(() => undefined)
  }
  await rm(join(agentsDir(), `${s.name}.json`), { force: true })
  await rm(tokenOf(s.name), { force: true })
}

// The commands --------------------------------------------------------------------------------------------------------

function flags(args: string[]) {
  const out: Record<string, string | boolean> = {}
  const rest: string[] = []
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (!a.startsWith('--')) { rest.push(a); continue }
    const [key, inline] = a.slice(2).split('=', 2)
    if (inline !== undefined) out[key] = inline
    else if (args[i + 1] !== undefined && !args[i + 1].startsWith('--') && !['all', 'follow', 'f'].includes(key)) out[key] = args[++i]
    else out[key] = true
  }
  return { flags: out, rest }
}

const ago = (ms: number) => {
  const s = Math.round(ms / 1000)
  return s < 90 ? `${s}s` : s < 5400 ? `${Math.round(s / 60)}m` : s < 129600 ? `${Math.round(s / 3600)}h` : `${Math.round(s / 86400)}d`
}

/** Who a token is, as the hub says: the agent's name and id. */
type WhoAmI = (hub: string, token: string) => Promise<{ name: string; id?: string }>
type HandBack = (hub: string, token: string, cards: string[], why: string) => Promise<unknown>

export async function daemonCommand(argv: string[], whoami: WhoAmI, handBack: HandBack = async () => undefined): Promise<number> {
  const [sub, ...args] = argv
  const root = ['add', 'start', 'restart'].includes(sub) ? refusedAsRoot(process.getuid?.()) : undefined
  if (root) throw new Error(root)
  const { flags: f, rest } = flags(args)
  const all = f.all === true
  switch (sub) {
    case 'add': {
      const token = String(f.token ?? process.env.BINDERS_TOKEN ?? '')
      if (!/^bnd_/.test(token)) throw new Error('binders add needs the agent’s token: --token bnd_… (from its Start the runner on the Agents page).')
      const hub = String(f.hub ?? process.env.BINDERS_URL ?? '').replace(/\/$/, '')
      if (!/^https?:\/\//.test(hub)) throw new Error('binders add needs the hub: --hub https://…')
      const workspace = home(String(f.workspace ?? process.cwd()))
      if (!(await stat(workspace).then((x) => x.isDirectory(), () => false))) throw new Error(`${workspace} isn’t a folder.`)
      const me = await whoami(hub, token)
      const existing = (await saved()).find((s) => (me.id && s.agentId === me.id) || (s.agent === me.name && s.hub === hub))
      let name = existing?.name ?? (typeof f.name === 'string' ? slug(f.name) : slug(me.name))
      if (!existing) for (let n = 2; (await saved()).some((s) => s.name === name); n++) name = `${slug(me.name)}-${n}`
      const s: Saved = { name, agent: me.name, ...(me.id ? { agentId: me.id } : {}), hub, workspace, addedAt: existing?.addedAt ?? new Date().toISOString() }
      await mkdir(agentsDir(), { recursive: true, mode: 0o700 })
      await writeFile(tokenOf(name), token, { mode: 0o600 })
      await chmod(tokenOf(name), 0o600)
      await writeFile(join(agentsDir(), `${name}.json`), JSON.stringify(s, null, 2))
      await install(s)
      console.log(`✓ ${me.name} ${existing ? 'restarted' : 'is running'} in the background, in ${workspace}.`)
      console.log(`  binders list · binders logs ${name} -f · binders restart ${name} · binders remove ${name}`)
      if (platform === 'mac' && workspace.startsWith(join(homedir(), 'Documents'))) console.log('  macOS may ask once whether node may use your Documents folder: allow it, or the agent can’t read its code.')
      return 0
    }
    case 'list':
    case 'ls': {
      const list = await saved()
      if (!list.length) {
        console.log('No agents on this machine yet. binders add --token … --workspace … sets one up.')
        return 0
      }
      const rows = await Promise.all(list.map(async (s) => {
        const st = await status(s)
        const since = st.pid ? await run('ps', ['-o', 'etime=', '-p', String(st.pid)]).then((r) => r.stdout.trim(), () => '') : ''
        const log = await stat(logOf(s.name)).then((x) => ago(Date.now() - x.mtimeMs), () => '')
        return [s.name, st.running ? 'running' : st.loaded ? 'stopped' : 'off', st.pid ? String(st.pid) : '-', since || '-', log ? `${log} ago` : '-', s.workspace.replace(homedir(), '~'), s.agent]
      }))
      const head = ['NAME', 'STATE', 'PID', 'UP', 'LAST LOG', 'WORKSPACE', 'AGENT']
      const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)))
      for (const r of [head, ...rows]) console.log(r.map((c, i) => c.padEnd(widths[i])).join('  ').trimEnd())
      return 0
    }
    case 'logs': {
      const s = await one(rest[0])
      const follow = f.follow === true || f.f === true || args.includes('-f')
      await new Promise<void>((done) => spawn('tail', ['-n', String(f.lines ?? 80), ...(follow ? ['-f'] : []), logOf(s.name)], { stdio: 'inherit' }).on('exit', () => done()))
      return 0
    }
    case 'start':
    case 'stop':
    case 'restart':
    case 'remove':
    case 'rm': {
      const targets = all ? await saved() : [await one(rest[0])]
      for (const s of targets) {
        if (sub === 'start') await start(s)
        else if (sub === 'stop') await stop(s)
        else if (sub === 'restart') await restart(s)
        else await remove(s, handBack)
        console.log(`✓ ${s.name}: ${{ start: 'started', stop: 'stopped (binders start brings it back)', restart: 'restarted', remove: 'removed', rm: 'removed' }[sub]}`)
      }
      return 0
    }
  }
  return 1
}

export const usage = `binders: Binders agents on this machine. Cards kept running through restarts carry on through stop and restart; remove ends them.

  binders add --token bnd_… [--workspace DIR] [--hub URL] [--name NAME]
                         set an agent up and keep it running in the background (at login, after a crash)
  binders list           every agent here: running or not, its process, how long up, its last log, its folder
  binders logs NAME [-f] what it's been doing (-f: follow)
  binders restart NAME   stop and start it (--all: every one)
  binders stop NAME      stop it until binders start (--all)
  binders start NAME     start it again (--all)
  binders remove NAME    stop it and forget it here (the agent stays on the hub)

  binders [--hub URL] [--workspace DIR]   run one in this terminal instead (BINDERS_TOKEN=…)`
