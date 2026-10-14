// cc457550: prepareFreshSession, the first step of attemptFireTask for a freshSession task. Each branch decides whether
// a session is launched, delivered into, or stopped -- a wrong branch either reuses a session (no longer "fresh") or
// relaunches every tick. tmux, the launch and the session probe are mocked; the real branch logic runs.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const state = vi.hoisted(() => ({
  exists: false,
  launches: [] as string[],
  kills: [] as string[],
  launchOk: true,
}))

vi.mock('../logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() } }))
vi.mock('../web/atomic-write.js', () => ({ atomicWriteFileSync: vi.fn() }))
// Never the real store (the mock set of schedule-runner-command-binding.test.ts, which imports the runner the same way).
vi.mock('../db.js', () => ({
  appendTaskRun: vi.fn(() => 1),
  listPendingTaskRetries: () => [],
  deletePendingTaskRetry: vi.fn(),
  updatePendingTaskRetry: vi.fn(() => true),
  insertPendingTaskRetryIfNew: vi.fn(),
  markPendingTaskRetryAlert: vi.fn(() => false),
  clearPendingTaskRetryAlert: vi.fn(),
  markScheduledTaskKanbanWaiting: vi.fn(),
}))
vi.mock('../web/channel-monitor.js', () => ({ readConfiguredMainModel: () => 'claude-opus-5-5' }))
vi.mock('../web/agent-process.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../web/agent-process.js')>()),
  sessionExistsOnHost: () => state.exists,
}))
vi.mock('../web/fresh-session.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../web/fresh-session.js')>()
  return {
    ...real,
    launchFreshSession: (task: string, agent: string) => {
      state.launches.push(`${agent}/${task}`)
      return state.launchOk
        ? { ok: true, session: real.freshSessionName(task, agent), sessionId: 'u', transcriptPath: '/t/u.jsonl' }
        : { ok: false, session: real.freshSessionName(task, agent), error: 'boom' }
    },
    killFreshSession: (_tmux: string, session: string) => { state.kills.push(session); return true },
  }
})

const T0 = 1_800_000_000_000

beforeEach(() => {
  state.exists = false
  state.launches = []
  state.kills = []
  state.launchOk = true
  vi.resetModules()
})

async function runner() {
  return await import('../web/schedule-runner.js')
}

describe('prepareFreshSession', () => {
  it('no session: launches one and answers starting (the ordinary retry delivers)', async () => {
    const { prepareFreshSession } = await runner()
    expect(await prepareFreshSession({ name: 'audit' }, 'agent-a', 'sched-agent-a-audit', T0)).toBe('starting')
    expect(state.launches).toEqual(['agent-a/audit'])
    expect(state.kills).toEqual([])
  })

  it('the session it launched is up within the boot window: ready, no second launch', async () => {
    const { prepareFreshSession } = await runner()
    await prepareFreshSession({ name: 'audit' }, 'agent-a', 'sched-agent-a-audit', T0)
    state.exists = true
    expect(await prepareFreshSession({ name: 'audit' }, 'agent-a', 'sched-agent-a-audit', T0 + 60_000)).toBe('ready')
    expect(state.launches).toHaveLength(1)
  })

  it('it never reached its prompt within 5 minutes: stopped and missing, NOT relaunched in the same attempt', async () => {
    const { prepareFreshSession } = await runner()
    await prepareFreshSession({ name: 'audit' }, 'agent-a', 'sched-agent-a-audit', T0)
    state.exists = true
    expect(await prepareFreshSession({ name: 'audit' }, 'agent-a', 'sched-agent-a-audit', T0 + 6 * 60_000)).toBe('missing')
    expect(state.kills).toEqual(['sched-agent-a-audit'])
    expect(state.launches).toHaveLength(1)
  })

  it('a leftover nobody launched or tracks is stopped before a new launch, never delivered into', async () => {
    const { prepareFreshSession } = await runner()
    state.exists = true
    expect(await prepareFreshSession({ name: 'audit' }, 'agent-a', 'sched-agent-a-audit', T0)).toBe('starting')
    expect(state.kills).toEqual(['sched-agent-a-audit'])
    expect(state.launches).toEqual(['agent-a/audit'])
  })

  it('a failed launch starts nothing and answers missing', async () => {
    const { prepareFreshSession } = await runner()
    state.launchOk = false
    expect(await prepareFreshSession({ name: 'audit' }, 'agent-a', 'sched-agent-a-audit', T0)).toBe('missing')
    expect(state.kills).toEqual([])
  })

  it('resolveTaskTarget gives a fresh task its own local session, and leaves every other task as it was', async () => {
    const { resolveTaskTarget } = await runner()
    expect(resolveTaskTarget({ name: 'audit', freshSession: true }, 'agent-a')).toEqual({ session: 'sched-agent-a-audit', host: null })
    expect(resolveTaskTarget({ name: 'audit', freshSession: false, targetSession: 'x' }, 'agent-a')).toEqual({ session: 'x', host: null })
  })
})
