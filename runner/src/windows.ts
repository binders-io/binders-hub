import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, win32 } from 'node:path'
import { promisify } from 'node:util'

// The parts of running on Windows that aren't how the rest does it: a logon task in place of a service, and tools that
// npm installs as .cmd files. Pure where it can be, so it's tested everywhere.

export const taskName = (name: string) => `Binders\\runner-${name}`

const xml = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
/** For a .cmd file, in double quotes: a double quote can't be in a Windows path, and % means something even there. */
const quoted = (text: string) => `"${text.replace(/"/g, '').replace(/%/g, '%%')}"`

export interface Launcher {
  command: string[]
  workspace: string
  env: Record<string, string>
  log: string
  stopFile: string
}

/**
 * What the logon task runs: its settings, which a task can't hold, the runner, its log, and starting it again after a
 * crash, which a task only does when it can't start at all. A person stopping it leaves a file saying so.
 */
export function launcherFor({ command, workspace, env, log, stopFile }: Launcher) {
  return [
    '@echo off',
    'chcp 65001 >nul',
    ...Object.entries(env).map(([name, value]) => `set "${name}=${value.replace(/"/g, '').replace(/%/g, '%%')}"`),
    `cd /d ${quoted(workspace)}`,
    ':again',
    `if exist ${quoted(stopFile)} exit /b 0`,
    `${command.map(quoted).join(' ')} >> ${quoted(log)} 2>&1`,
    `if exist ${quoted(stopFile)} exit /b 0`,
    'ping -n 11 127.0.0.1 >nul',
    'goto again',
    '',
  ].join('\r\n')
}

/**
 * The logon task: for this user alone, so it needs no admin and no password, and with no time limit. conhost --headless
 * gives the launcher the console it needs without a window on the screen.
 */
export function taskXml({ description, user, launcher }: { description: string; user: string; launcher: string }) {
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>${xml(description)}</Description></RegistrationInfo>
  <Triggers><LogonTrigger><Enabled>true</Enabled><UserId>${xml(user)}</UserId></LogonTrigger></Triggers>
  <Principals><Principal id="Author"><UserId>${xml(user)}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <StartWhenAvailable>true</StartWhenAvailable>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Enabled>true</Enabled>
  </Settings>
  <Actions Context="Author"><Exec><Command>conhost.exe</Command><Arguments>--headless cmd.exe /d /c ${xml(`"${launcher}"`)}</Arguments></Exec></Actions>
</Task>
`
}

/** What a .cmd from npm really runs: it can only be started through cmd.exe, which would read a card's text as commands. */
export function shimTarget(shim: string, text: string) {
  const found = /"%dp0%\\([^"]+)"\s+%\*/i.exec(text)?.[1]
  if (!found) return undefined
  return win32.join(shim, '..', found)
}

const shimsSeen = new Map<string, string | undefined>()

/** A tool as it can be started without a shell: as it is, or, for an npm .cmd, what that runs. */
export function startable(command: string, args: string[], platform: NodeJS.Platform = process.platform, node = process.execPath, read = (file: string) => readFileSync(file, 'utf8')) {
  if (platform !== 'win32' || !/\.(cmd|bat)$/i.test(command)) return { command, args }
  if (!shimsSeen.has(command)) shimsSeen.set(command, shimTarget(command, read(command)))
  const target = shimsSeen.get(command)
  if (!target) throw new Error(`${command} can’t be started safely: only a program, or a command installed by npm, can be.`)
  return /\.exe$/i.test(target) ? { command: target, args } : { command: node, args: [target, ...args] }
}

const run = promisify(execFile)

/** Picks a program out of what where.exe lists: it also lists npm's script for other shells, which Windows can't start. */
export const pickProgram = (lines: string[]) => {
  const usable = lines.map((line) => line.trim()).filter((line) => /\.(exe|cmd|bat)$/i.test(line))
  return usable.find((line) => /\.exe$/i.test(line)) ?? usable[0]
}

/** Where a tool's command is on Windows: on the PATH, or where its installer puts it. */
export async function whereOnWindows(command: string) {
  const listed = await run('where.exe', [command]).then((r) => r.stdout.split(/\r?\n/), () => [] as string[])
  const onPath = pickProgram(listed)
  if (onPath) return onPath
  const home = homedir()
  const folders = [join(home, '.local', 'bin'), ...(process.env.APPDATA ? [join(process.env.APPDATA, 'npm')] : []), join(home, `.${command}`, 'bin'), join(home, '.bun', 'bin'), join(home, '.cargo', 'bin'), join(home, 'go', 'bin')]
  for (const folder of folders) for (const ending of ['.exe', '.cmd']) {
    const path = join(folder, command + ending)
    if (await stat(path).then((s) => s.isFile(), () => false)) return path
  }
  return undefined
}

/** Stops a process and all it started: Windows has no groups to signal, nor a signal it can catch. */
export const stopTreeArgs = (pid: number) => ['/T', '/F', '/PID', String(pid)]
