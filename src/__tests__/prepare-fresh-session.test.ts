// cc457550: prepareFreshSession, the first step of attemptFireTask for a freshSession task. Each branch decides whether
// a session is launched, delivered into, or stopped -- a wrong branch either reuses a session (no longer "fresh") or
// relaunches every tick. tmux, the launch and the session probe are mocked; the real branch logic runs.
// The in-flight sweep's and the restart sweep's fresh branches, held by behaviour: six mutants of these branches kept
// every test green while only a source contract stood over them.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TaskInflightEntry } from '../web/schedule-runner.js'

const state = vi.hoisted(() => ({
  exists: false,
  launches: [] as string[],
  kills: [] as string[],
  killDirs: [] as string[],
  listed: [] as string[],
  listDirs: [] as string[],
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
    killFreshSession: (_tmux: string, session: string, installDir: string) => {
      state.kills.push(session)
      state.killDirs.push(installDir)
      return true
    },
    listFreshSessions: (_tmux: string, installDir: string) => { state.listDirs.push(installDir); return state.listed },
  }
})

const T0 = 1_800_000_000_000

beforeEach(() => {
  state.exists = false
  state.launches = []
  state.kills = []
  state.killDirs = []
  state.listed = []
  state.listDirs = []
  state.launchOk = true
  vi.resetModules()
})

// A delivered round as attemptFireTask registers it (the fields the sweep reads; the rest are inert here).
function inflight(taskName: string, agentName: string, freshSession: boolean): TaskInflightEntry {
  return {
    taskName, agentName, session: `sched-${agentName}-${taskName}`, host: null, injectedAt: T0,
    alerted: false, ownerAlerted: false, sawTurn: false, workingDir: '/w', configDirs: [undefined],
    timeoutMs: 60_000, runId: null, taskType: 'task', freshSession, deliveryPending: false,
  }
}

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

  it('the previous round still runs in its fresh session: busy, its session neither stopped nor relaunched', async () => {
    const { prepareFreshSession, _setTaskInflightEntryForTest } = await runner()
    _setTaskInflightEntryForTest(inflight('audit', 'agent-a', true))
    state.exists = true // the running round's session, alive and not a launch in waiting
    expect(await prepareFreshSession({ name: 'audit' }, 'agent-a', 'sched-agent-a-audit', T0 + 60_000)).toBe('busy')
    expect(state.kills).toEqual([])
    expect(state.launches).toEqual([])
  })

  it('busy is per task and agent: another fresh round in flight does not hold this one', async () => {
    const { prepareFreshSession, _setTaskInflightEntryForTest } = await runner()
    _setTaskInflightEntryForTest(inflight('audit', 'agent-b', true))
    _setTaskInflightEntryForTest(inflight('digest', 'agent-a', true))
    _setTaskInflightEntryForTest(inflight('audit', 'agent-a', false))
    expect(await prepareFreshSession({ name: 'audit' }, 'agent-a', 'sched-agent-a-audit', T0)).toBe('starting')
    expect(state.launches).toEqual(['agent-a/audit'])
  })

  it('resolveTaskTarget gives a fresh task its own local session, and leaves every other task as it was', async () => {
    const { resolveTaskTarget } = await runner()
    expect(resolveTaskTarget({ name: 'audit', freshSession: true }, 'agent-a')).toEqual({ session: 'sched-agent-a-audit', host: null })
    expect(resolveTaskTarget({ name: 'audit', freshSession: false, targetSession: 'x' }, 'agent-a')).toEqual({ session: 'x', host: null })
  })
})

describe('the sweeps\' fresh branches', () => {
  it('a closing decision stops the session of a fresh round, in this install, and of no other round', async () => {
    const { stopFreshRound } = await runner()
    const { PROJECT_ROOT } = await import('../config.js')
    stopFreshRound({ freshSession: true, session: 'sched-agent-a-audit', taskName: 'audit' }, 'done')
    expect(state.kills).toEqual(['sched-agent-a-audit'])
    expect(state.killDirs).toEqual([PROJECT_ROOT])
    stopFreshRound({ freshSession: false, session: 'agent-a', taskName: 'digest' }, 'done')
    stopFreshRound({ session: 'agent-a', taskName: 'digest' }, 'lost')
    expect(state.kills).toEqual(['sched-agent-a-audit'])
  })

  it('the restart sweep stops every sched-* session listed for this install, and only those', async () => {
    const { stopOrphanedFreshSessions } = await runner()
    const { PROJECT_ROOT } = await import('../config.js')
    state.listed = ['sched-agent-a-audit', 'sched-agent-b-backup']
    stopOrphanedFreshSessions()
    expect(state.listDirs).toEqual([PROJECT_ROOT])
    expect(state.kills).toEqual(['sched-agent-a-audit', 'sched-agent-b-backup'])
    expect(state.killDirs).toEqual([PROJECT_ROOT, PROJECT_ROOT])
  })

  it('the restart sweep with nothing listed stops nothing', async () => {
    const { stopOrphanedFreshSessions } = await runner()
    stopOrphanedFreshSessions()
    expect(state.kills).toEqual([])
  })

  it('sawTurn\'s evidence for a fresh round is its own transcript\'s mtime; a transcript not written yet is null', async () => {
    const { freshTranscriptMtime } = await runner()
    const dir = mkdtempSync(join(tmpdir(), 'fresh-transcript-'))
    try {
      const path = join(dir, 'u.jsonl')
      writeFileSync(path, '{}\n')
      utimesSync(path, new Date(T0), new Date(T0 + 7_000))
      expect(freshTranscriptMtime(path)).toBe(T0 + 7_000)
      expect(freshTranscriptMtime(join(dir, 'missing.jsonl'))).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('the in-flight entry of a fresh round carries the transcript its launch recorded; any other entry carries neither field', async () => {
    const { prepareFreshSession, freshInflightFields } = await runner()
    await prepareFreshSession({ name: 'audit' }, 'agent-a', 'sched-agent-a-audit', T0)
    expect(freshInflightFields({ freshSession: true }, 'sched-agent-a-audit'))
      .toStrictEqual({ freshSession: true, freshTranscript: '/t/u.jsonl' })
    expect(freshInflightFields({ freshSession: false }, 'sched-agent-a-audit')).toStrictEqual({})
    expect(freshInflightFields({}, 'sched-agent-a-audit')).toStrictEqual({})
  })

  it('once delivered, the session is no launch in waiting: if it outlives its round, the next occurrence stops it as a leftover', async () => {
    const { prepareFreshSession, handFreshSessionToSweep } = await runner()
    await prepareFreshSession({ name: 'audit' }, 'agent-a', 'sched-agent-a-audit', T0)
    handFreshSessionToSweep({ freshSession: true }, 'sched-agent-a-audit')
    state.exists = true // the round is over, but its session is still up (its stop failed)
    expect(await prepareFreshSession({ name: 'audit' }, 'agent-a', 'sched-agent-a-audit', T0 + 60_000)).toBe('starting')
    expect(state.kills).toEqual(['sched-agent-a-audit'])
    expect(state.launches).toHaveLength(2)
  })

  it('a task that is not fresh hands nothing over: a fresh launch in waiting under that name stays one', async () => {
    const { prepareFreshSession, handFreshSessionToSweep } = await runner()
    await prepareFreshSession({ name: 'audit' }, 'agent-a', 'sched-agent-a-audit', T0)
    handFreshSessionToSweep({ freshSession: false }, 'sched-agent-a-audit')
    state.exists = true
    expect(await prepareFreshSession({ name: 'audit' }, 'agent-a', 'sched-agent-a-audit', T0 + 60_000)).toBe('ready')
    expect(state.kills).toEqual([])
  })
})
