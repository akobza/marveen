import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Card ea6f9b07: `tmux list-sessions` answers for the whole tmux server, so the
// run-state and session-existence checks share one answer per server for
// SESSION_LIST_TTL_MS instead of forking one child per agent. The fork of the
// large dashboard process is what blocks the event loop, not tmux itself.
//
// Harness as in send-prompt-chunk-binding.test.ts: the helpers go through
// node:child_process execFileSync, which is mocked with argument inspection.
// An agent named remote-* runs on a remote host (readAgentRemoteHost), so its
// list-sessions goes through ssh: one argv element carries the remote command.
// An agent named own-* runs under its own OS user (readAgentRunAsUser), so its
// tmux server is another one, reached through sudo.

const h = vi.hoisted(() => ({
  calls: [] as string[][],
  listOut: 'agent-alpha\nagent-beta\n',
  remoteListOut: 'agent-remote-a\n',
  userListOut: 'agent-own-a\n',
  failStatus: null as number | null,
  remoteFailStatus: null as number | null,
}))

vi.mock('node:child_process', async (orig) => ({
  ...(await orig() as object),
  execFileSync: vi.fn((file: string, args?: string[]) => {
    if (Array.isArray(args)) {
      h.calls.push(args)
      if (args.some(a => a.includes('list-sessions'))) {
        const remote = file === 'ssh'
        const status = remote ? h.remoteFailStatus : h.failStatus
        if (status !== null) throw Object.assign(new Error('tmux list-sessions failed'), { status })
        return remote ? h.remoteListOut : file === 'sudo' ? h.userListOut : h.listOut
      }
    }
    return ''
  }),
}))
vi.mock('../notify.js', () => ({ notifyChannel: vi.fn(async () => {}), notifyTelegram: vi.fn(async () => {}) }))
vi.mock('../web/agent-config.js', async (orig) => ({
  ...(await orig() as object),
  readAgentRemoteHost: (name: string) => (name.startsWith('remote-') ? 'laptop.invalid' : null),
  readAgentRunAsUser: (name: string) => (name.startsWith('own-') ? 'agentuser' : null),
}))
vi.mock('../web/ssh-tmux.js', async (orig) => ({
  ...(await orig() as object),
  ensureControlDir: vi.fn(),
}))

import {
  agentRunState,
  isAgentRunning,
  sessionExistsOnHost,
  invalidateTmuxSessionList,
  SESSION_LIST_TTL_MS,
} from '../web/agent-process.js'

const listCalls = (): number => h.calls.filter(a => a.some(x => x.includes('list-sessions'))).length

beforeEach(() => {
  h.calls.length = 0
  h.listOut = 'agent-alpha\nagent-beta\n'
  h.remoteListOut = 'agent-remote-a\n'
  h.userListOut = 'agent-own-a\n'
  h.failStatus = null
  h.remoteFailStatus = null
  invalidateTmuxSessionList()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('one list-sessions per tmux server per window', () => {
  it('a sweep over several agents and session checks forks list-sessions once', () => {
    expect(agentRunState('alpha')).toBe('running')
    expect(agentRunState('beta')).toBe('running')
    expect(agentRunState('gamma')).toBe('stopped')
    expect(isAgentRunning('alpha')).toBe(true)
    expect(sessionExistsOnHost(null, 'agent-beta')).toBe(true)
    expect(sessionExistsOnHost(null, 'agent-gamma')).toBe(false)
    expect(listCalls()).toBe(1)
  })

  it('the shared answer expires after SESSION_LIST_TTL_MS', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-12T12:00:00Z'))
    expect(agentRunState('alpha')).toBe('running')
    vi.setSystemTime(new Date(Date.parse('2026-10-12T12:00:00Z') + SESSION_LIST_TTL_MS - 1))
    h.listOut = 'agent-beta\n'
    expect(agentRunState('alpha')).toBe('running')
    expect(listCalls()).toBe(1)
    vi.setSystemTime(new Date(Date.parse('2026-10-12T12:00:00Z') + SESSION_LIST_TTL_MS))
    expect(agentRunState('alpha')).toBe('stopped')
    expect(listCalls()).toBe(2)
  })

  it('fresh bypasses the shared answer, and its result is shared afterwards', () => {
    expect(agentRunState('alpha')).toBe('running')
    h.listOut = 'agent-beta\n'
    expect(agentRunState('alpha', { fresh: true })).toBe('stopped')
    expect(isAgentRunning('alpha')).toBe(false)
    expect(listCalls()).toBe(2)
    expect(isAgentRunning('beta', { fresh: true })).toBe(true)
    expect(listCalls()).toBe(3)
  })

  it('invalidateTmuxSessionList drops the shared answer', () => {
    expect(agentRunState('alpha')).toBe('running')
    h.listOut = 'agent-beta\n'
    invalidateTmuxSessionList()
    expect(agentRunState('alpha')).toBe('stopped')
    expect(listCalls()).toBe(2)
  })

  it('a failed query is shared with its exit status (no server running = stopped, locally)', () => {
    h.failStatus = 1
    expect(agentRunState('alpha')).toBe('stopped')
    expect(agentRunState('beta')).toBe('stopped')
    expect(sessionExistsOnHost(null, 'agent-alpha')).toBe(false)
    expect(listCalls()).toBe(1)
    h.failStatus = null
    invalidateTmuxSessionList()
    expect(agentRunState('alpha')).toBe('running')
    expect(listCalls()).toBe(2)
  })

  it('a remote host keeps its own shared answer, apart from the local server', () => {
    expect(agentRunState('alpha')).toBe('running')
    expect(agentRunState('remote-a')).toBe('running')
    expect(agentRunState('remote-b')).toBe('stopped')
    expect(agentRunState('beta')).toBe('running')
    expect(listCalls()).toBe(2)
    expect(h.calls.filter(a => a.includes('laptop.invalid')).length).toBe(1)
  })

  it('an agent under its own OS user keeps its own shared answer, apart from the default server', () => {
    expect(agentRunState('alpha')).toBe('running')
    expect(agentRunState('own-a')).toBe('running')
    expect(agentRunState('own-b')).toBe('stopped')
    expect(agentRunState('beta')).toBe('running')
    expect(listCalls()).toBe(2)
    expect(h.calls.filter(a => a.includes('agentuser')).length).toBe(1)
  })

  it('a failed remote query is shared with its exit status: 1 is stopped, 255 is unreachable', () => {
    // On a reachable host "no server running" exits 1 and means stopped (the
    // agent must stay startable); 255 is an ssh failure and means unreachable.
    // The second agent of the sweep reads the shared answer, so the status has
    // to travel with it.
    h.remoteFailStatus = 1
    expect(agentRunState('remote-a')).toBe('stopped')
    expect(agentRunState('remote-b')).toBe('stopped')
    expect(listCalls()).toBe(1)
    invalidateTmuxSessionList()
    h.remoteFailStatus = 255
    expect(agentRunState('remote-a')).toBe('unreachable')
    expect(agentRunState('remote-b')).toBe('unreachable')
    expect(listCalls()).toBe(2)
  })
})

// Wiring: the paths that create, kill or rename a session must drop the shared
// answer, and the start/stop guards must read fresh. Source-level, because those
// paths touch the real home directory and process table and cannot run in a unit test.
describe('wiring of the shared list-sessions answer', () => {
  const root = join(__dirname, '..')
  const src = (rel: string): string => readFileSync(join(root, rel), 'utf-8')

  it('runTmux drops the shared answer after every session-changing command, failed or not', () => {
    const ap = src('web/agent-process.ts')
    const start = ap.indexOf('function runTmux(')
    const end = ap.indexOf('\n}\n', start)
    expect(start).toBeGreaterThan(-1)
    const body = ap.slice(start, end)
    expect(body).toMatch(/\}\s*finally\s*\{[^}]*if \(SESSION_CHANGING_TMUX_COMMANDS\.has\(tmuxArgs\[0\]\)\) invalidateTmuxSessionList\(\)/)
    const set = ap.match(/const SESSION_CHANGING_TMUX_COMMANDS = new Set\(\[([^\]]*)\]\)/)
    expect(set).not.toBeNull()
    for (const c of ['new-session', 'kill-session', 'kill-server', 'rename-session']) expect(set![1]).toContain(`'${c}'`)
  })

  it('the start, stop and restart guards read fresh', () => {
    const ap = src('web/agent-process.ts')
    expect(ap).toContain("const state = agentRunState(name, { fresh: true })\n  if (state === 'running') return { ok: false, error: 'Agent is already running' }")
    expect(ap).toContain("if (isAgentRunning(name, { fresh: true })) return { ok: false, error: 'Agent is already running' }")
    expect(ap).toContain("if (!isAgentRunning(name, { fresh: true })) return { ok: false, error: 'Agent is not running' }")
    expect(ap).toContain('if (opts.fresh) cancelRestartWake(name)\n    if (isAgentRunning(name, { fresh: true })) {')
  })

  it('the modules that drive tmux directly drop the shared answer after creating or killing a session', () => {
    // Each direct `new-session` / `kill-session` call is followed, within its own
    // try/catch/finally (at most 14 lines), by invalidateTmuxSessionList().
    const files = ['web/agent-worker.ts', 'web/reauth-healer.ts', 'web/routes/background-tasks.ts']
    let sites = 0
    for (const f of files) {
      const lines = src(f).split('\n')
      lines.forEach((line, i) => {
        if (!/execFile(Sync)?\(TMUX, \[\s*('new-session'|'kill-session')|^\s*'new-session', '-d'/.test(line)) return
        sites += 1
        const window = lines.slice(i, i + 14).join('\n')
        expect(window, `${f}:${i + 1}`).toContain('invalidateTmuxSessionList()')
      })
    }
    expect(sites).toBe(5)
  })
})
