import { describe, it, expect, afterEach } from 'vitest'
import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { trackChildProcess, runningChildProcesses, endAllChildProcesses } from '../web/detached-groups.js'

// Card 75693151 (3): a claude the dashboard started with execFile survived the unit's stop in its cgroup (KillMode=process,
// 2026-10-19 15:43:53Z). The plain children are now tracked by pid and the shutdown SIGTERMs them. A real process stands
// in for claude (sleep), so the signal and the exit are measured, not mocked.

const isAlive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }

afterEach(() => { endAllChildProcesses('test cleanup') })

describe('the plain child registry', () => {
  it('shutdown SIGTERMs a tracked child that is still running, and empties the registry', async () => {
    let untrack = (): void => {}
    const exited = new Promise<NodeJS.Signals | null>((resolve) => {
      const child = execFile('/bin/sleep', ['30'], (err) => { untrack(); resolve((err as { signal?: NodeJS.Signals } | null)?.signal ?? null) })
      untrack = trackChildProcess(child.pid, 'sleep (stand-in for claude)')
    })
    const [{ pid }] = runningChildProcesses()
    expect(isAlive(pid)).toBe(true)
    expect(endAllChildProcesses('dashboard shutdown')).toBe(1)
    expect(await exited).toBe('SIGTERM')
    expect(isAlive(pid)).toBe(false)
    expect(runningChildProcesses()).toEqual([])
  })

  it('a child that exited on its own leaves the registry, so a reused pid is never signalled', async () => {
    let untrack = (): void => {}
    await new Promise<void>((resolve) => {
      const child = execFile('/bin/true', () => { untrack(); resolve() })
      untrack = trackChildProcess(child.pid, 'true')
    })
    expect(runningChildProcesses()).toEqual([])
    expect(endAllChildProcesses('dashboard shutdown')).toBe(0)
  })

  it('an unknown pid (the launch failed) is not tracked; a gone pid is quiet at shutdown', () => {
    trackChildProcess(undefined, 'no pid')()
    expect(runningChildProcesses()).toEqual([])
    trackChildProcess(2 ** 22 + 12345, 'gone') // above the default pid_max: ESRCH
    expect(endAllChildProcesses('dashboard shutdown')).toBe(0)
    expect(runningChildProcesses()).toEqual([])
  })
})

// STRUCTURAL: the three execFile sites of claude and the shutdown call (the boot would need every subsystem up).
describe('the wiring', () => {
  const root = join(fileURLToPath(import.meta.url), '..', '..', '..')
  const code = (f: string) =>
    readFileSync(join(root, 'src', f), 'utf-8').split('\n').filter((l) => !l.trimStart().startsWith('//')).join('\n')

  it.each([
    ['web/claude-cli-version.ts', 'claude --version'],
    ['web/claude-credentials-guard.ts', 'claude -p (auth probe)'],
    ['web/mcp-list.ts', 'claude mcp list'],
  ])('%s tracks its claude child and untracks it in the exit callback', (file, label) => {
    const src = code(file)
    expect(src).toContain(`untrack = trackChildProcess(child?.pid, '${label}')`)
    expect(src).toMatch(/const child = execFile\(/)
    expect(src).toMatch(/=> \{\n\s+untrack\(\)/)
  })

  it('the shutdown ends the plain children next to the detached groups', () => {
    const src = code('index.ts')
    const groups = src.indexOf("endAllDetachedGroups('dashboard shutdown')")
    const plain = src.indexOf("endAllChildProcesses('dashboard shutdown')")
    expect(groups).toBeGreaterThan(0)
    expect(plain).toBeGreaterThan(groups)
  })
})
