import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { deskAddress } from '../src/desk.ts'
import { launcherFor, pickProgram, shimTarget, splitCommand, startable, taskName, taskXml } from '../src/windows.ts'

const npmShim = `@ECHO off\r\nGOTO start\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*\r\n`

describe('a runner on Windows', () => {
  it('names one task for each agent, under Binders', () => {
    assert.equal(taskName('reviewer'), 'Binders\\runner-reviewer')
  })

  it('keeps its logon task for this user, without admin, a password or a time limit, and with no window', () => {
    const task = taskXml({ description: 'Binders runner: R&D', user: 'HOST\\me', launcher: 'C:\\Users\\me\\.binders\\agents\\a.cmd' })
    assert.match(task, /<LogonTrigger><Enabled>true<\/Enabled><UserId>HOST\\me<\/UserId>/)
    assert.match(task, /<LogonType>InteractiveToken<\/LogonType><RunLevel>LeastPrivilege<\/RunLevel>/)
    assert.match(task, /<ExecutionTimeLimit>PT0S<\/ExecutionTimeLimit>/)
    assert.match(task, /<Command>conhost\.exe<\/Command><Arguments>--headless cmd\.exe \/d \/c &quot;C:\\Users\\me\\\.binders\\agents\\a\.cmd&quot;<\/Arguments>/)
    assert.match(task, /R&amp;D/)
  })

  it('runs through a launcher that keeps its settings and log, starts it again after a crash, and stops when asked', () => {
    const text = launcherFor({ command: ['C:\\Program Files\\nodejs\\node.exe', 'C:\\h\\r.mjs', '--hub', 'https://hub.test?a=1&b=2'], workspace: 'C:\\my code', env: { PATH: 'C:\\a;C:\\b', HTTPS_PROXY: 'http://me:p%40ss@proxy:8080' }, log: 'C:\\h\\a.log', stopFile: 'C:\\h\\a.stop' })
    assert.match(text, /^@echo off\r\n/)
    assert.ok(text.includes('set "HTTPS_PROXY=http://me:p%%40ss@proxy:8080"\r\n'), 'with % as a .cmd reads it')
    assert.ok(text.includes('cd /d "C:\\my code"\r\n'))
    assert.ok(text.includes('"C:\\Program Files\\nodejs\\node.exe" "C:\\h\\r.mjs" "--hub" "https://hub.test?a=1&b=2" >> "C:\\h\\a.log" 2>&1\r\n'))
    assert.equal(text.split('if exist "C:\\h\\a.stop" exit /b 0').length, 3, 'looks before starting, and before starting again')
    assert.match(text, /goto again/)
  })

  it('finds what an npm command runs, so a card’s text never goes through cmd.exe', () => {
    assert.equal(shimTarget('C:\\npm\\claude.cmd', npmShim)?.replace(/\//g, '\\').endsWith('npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js'), true)
    const read = () => npmShim
    const started = startable('C:\\npm\\claude-a.cmd', ['-p', 'a & del x'], 'win32', 'C:\\node.exe', read)
    assert.equal(started.command, 'C:\\node.exe')
    assert.match(started.args[0], /cli\.js$/)
    assert.deepEqual(started.args.slice(1), ['-p', 'a & del x'])
    const binary = startable('C:\\npm\\codex-a.cmd', ['x'], 'win32', 'C:\\node.exe', () => '"%_prog%" "%dp0%\\node_modules\\codex\\codex.exe" %*')
    assert.match(binary.command, /codex\.exe$/)
    assert.deepEqual(binary.args, ['x'])
  })

  it('won’t start another kind of .cmd, and leaves everything else alone', () => {
    assert.throws(() => startable('C:\\x\\mine-a.cmd', [], 'win32', 'node', () => 'echo hi %*'), /can’t be started safely/)
    assert.deepEqual(startable('C:\\x\\claude.exe', ['a'], 'win32'), { command: 'C:\\x\\claude.exe', args: ['a'] })
    assert.deepEqual(startable('/usr/bin/claude.cmd', ['a'], 'linux'), { command: '/usr/bin/claude.cmd', args: ['a'] })
  })

  it('picks a program from what where.exe lists, past npm’s script for other shells', () => {
    assert.equal(pickProgram(['C:\\npm\\claude', 'C:\\npm\\claude.cmd', '']), 'C:\\npm\\claude.cmd')
    assert.equal(pickProgram(['C:\\npm\\claude.cmd', 'C:\\x\\claude.exe']), 'C:\\x\\claude.exe')
    assert.equal(pickProgram(['C:\\npm\\claude', '']), undefined)
  })

  it('runs an agent’s own command without cmd.exe, a card’s text as one argument however it reads', () => {
    const prompt = 'Fix "it" & del C:\\x\nthen %PATH% | more'
    assert.deepEqual(splitCommand('node "C:\\my tools\\agent.mjs" --dir {dir} -p {prompt}', { prompt, dir: 'C:\\w' }), ['node', 'C:\\my tools\\agent.mjs', '--dir', 'C:\\w', '-p', prompt])
    assert.deepEqual(splitCommand("agent '--prompt={prompt}' {other}", { prompt: 'a b' }), ['agent', '--prompt=a b', '{other}'])
  })

  it('has an agent reach its runner over a named pipe, one for each', () => {
    assert.match(deskAddress('C:\\h\\a.desk', 'win32'), /^\\\\\.\\pipe\\binders-[0-9a-f]{24}$/)
    assert.notEqual(deskAddress('C:\\h\\a.desk', 'win32'), deskAddress('C:\\h\\b.desk', 'win32'))
    assert.equal(deskAddress('/h/a.desk', 'linux'), '/h/a.desk')
  })
})
