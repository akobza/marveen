// Card 669df94a, step (a): the tick needs an IDENTIFIER in the log.
//
// Today it cannot be established from the log whether two deliveries happened
// in the SAME router pass: the delivery line carries no tick id, and the "not
// ready" WARN is emitted at most once per message id (routerLoggedMisses), so
// a message skipped in ten consecutive ticks logs once. The card puts this
// first on purpose -- it LOGS, it does not behave, so it is the lowest-risk
// item, and its measurement is the input to the fairness change that follows.
//
// What the acceptance criterion needs to become measurable: per tick, PER
// RECIPIENT, how many messages went out. That is what the summary line below
// carries, and what these tests measure.

// Contract test for the per-tick work cap in the message router.
//
// runMessageRouterTick() must process AT MOST MAX_MESSAGES_PER_TICK pending
// messages per pass, rolling any backlog to the next tick. This bounds a single
// tick's wall-time so a large pending backlog (e.g. after a delivery stall) can
// never make one tick run long and starve the event loop -- the slow-tick half
// of the progressive-hang pattern.
//
// Since card 2922e380, sessionExistsOnHost is called once per unique receiver
// in the pre-pass and cached for the main loop (not once per message). The work
// cap is verified by the slice() bound: at most MAX_MESSAGES_PER_TICK messages
// enter the loop per tick, regardless of backlog size.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockGetPendingMessages = vi.fn()
const mockMarkDelivered = vi.fn((..._a: unknown[]) => true)
const mockMarkFailed = vi.fn((..._a: unknown[]) => true)
const mockSessionExistsOnHost = vi.fn((..._a: unknown[]) => false)

const logInfo = vi.fn()
const logWarn = vi.fn()
vi.mock('../logger.js', () => ({
  logger: {
    info: (...a: unknown[]) => logInfo(...a),
    warn: (...a: unknown[]) => logWarn(...a),
    debug: vi.fn(), error: vi.fn(),
  },
}))

vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  MAIN_AGENT_ID: 'orin',
  // message-router imports maybeWakeSubAgentsForTelegram, which reads this flag
  // from config; keep it OFF so the wake watcher early-returns and this test
  // stays isolated to the per-tick message cap.
  SUBAGENT_TELEGRAM_WAKE_ENABLED: false,
}))

vi.mock('../db.js', () => ({
  getPendingMessages: (toAgent?: string) => {
    if (toAgent) return [] // per-agent query for reconnect pre-pass
    return mockGetPendingMessages()
  },
  markMessageDelivered: (...a: unknown[]) => mockMarkDelivered(...a),
  markMessageFailed: (...a: unknown[]) => mockMarkFailed(...a),
  markMessageDone: (..._a: unknown[]) => true,
  createAgentMessage: (..._a: unknown[]) => ({ id: 999 }),
  // card def5a189: OTel trace stubs -- no-ops in this test
  stampMessageTrace: (..._a: unknown[]) => false,
  countNewerMessagesFromSameSender: (..._a: unknown[]) => 0,
  upsertOtelSpan: (..._a: unknown[]) => undefined,
  closeOtelSpan: (..._a: unknown[]) => false,
}))

vi.mock('../web/voice-directive.js', () => ({
  resolveAgentChannelStateDir: () => '/tmp/none',
}))

vi.mock('../web/agent-config.js', () => ({
  readAgentRemoteHost: () => null,
  readAgentVoiceConfig: () => ({ responseMode: 'text' }),
  // Default-OFF, matching the real reader: the agents in this test take the
  // tmux path, so the cap being measured is the cap on the unchanged route.
  readAgentWorksourceChannel: () => false,
}))

vi.mock('../web/agent-process.js', () => ({
  // The not-ready-path modal clear: false = no modal, so every caller keeps
  // its existing skip/busy behaviour and these fixtures are unaffected.
  clearFeedbackModalAndRecheck: () => false,
  agentSessionName: (name: string) => `agent-${name}`,
  isSessionReadyForPrompt: vi.fn(async () => true),
  clearStaleParkedInput: vi.fn(() => false),
  sendPromptToSession: vi.fn(),
  sessionExistsOnHost: (...a: unknown[]) => mockSessionExistsOnHost(...a),
}))

vi.mock('../web/voice-modality.js', () => ({
  setLastInboundModality: vi.fn(),
}))

vi.mock('../web/main-agent.js', () => ({
  MAIN_CHANNELS_SESSION: 'orin-channels',
}))

vi.mock('../web/agent-message-wrap.js', () => ({
  classifyAgentMessage: () => ({ category: 'trusted-peer', safeFrom: 'orin' }),
  wrapAgentMessageForDelivery: () => ({ prefix: '', wrapped: '' }),
}))


import { runMessageRouterTick } from '../web/message-router.js'

type LogCall = [Record<string, unknown>, string]

function pending(rows: Array<{ id: number; to: string; ageSec?: number }>) {
  const nowSec = Math.floor(Date.now() / 1000)
  return rows.map(r => ({
    id: r.id,
    from_agent: 'orin',
    to_agent: r.to,
    content: 'ping',
    created_at: nowSec - (r.ageSec ?? 0),
  }))
}

function lines(mock: { mock: { calls: unknown[][] } }, msg: string): LogCall[] {
  return (mock.mock.calls as LogCall[]).filter(c => c[1] === msg)
}

describe('router tick identity in the log (card 669df94a, step a)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockSessionExistsOnHost.mockReturnValue(true)
    mockMarkDelivered.mockReturnValue(true)
    mockMarkFailed.mockReturnValue(true)
  })

  it('every delivery line carries the tick id', async () => {
    mockGetPendingMessages.mockReturnValue(pending([{ id: 1, to: 'dex' }, { id: 2, to: 'ada' }]))
    await runMessageRouterTick()
    const delivered = lines(logInfo, 'Agent message delivered')
    expect(delivered.length).toBe(2)
    for (const [fields] of delivered) expect(typeof fields.tick).toBe('number')
    expect(delivered[0][0].tick).toBe(delivered[1][0].tick)   // same pass = same id
  })

  it('two passes get DIFFERENT tick ids (otherwise the id measures nothing)', async () => {
    mockGetPendingMessages.mockReturnValue(pending([{ id: 1, to: 'dex' }]))
    await runMessageRouterTick()
    mockGetPendingMessages.mockReturnValue(pending([{ id: 2, to: 'dex' }]))
    await runMessageRouterTick()
    const ids = lines(logInfo, 'Agent message delivered').map(c => c[0].tick)
    expect(ids.length).toBe(2)
    expect(ids[0]).not.toBe(ids[1])
  })

  it('POSITIVE CONTROL: the per-tick summary reports PER RECIPIENT how many went out', async () => {
    mockGetPendingMessages.mockReturnValue(pending([
      { id: 1, to: 'dex' }, { id: 2, to: 'ada' }, { id: 3, to: 'dex' },
    ]))
    await runMessageRouterTick()
    const summary = lines(logInfo, 'message-router: tick summary')
    expect(summary.length).toBe(1)
    const fields = summary[0][0] as { tick: number; delivered: Record<string, number>; pendingSeen: number }
    expect(typeof fields.tick).toBe('number')
    expect(fields.delivered).toEqual({ dex: 2, ada: 1 })    // measured, not assumed
    expect(fields.pendingSeen).toBe(3)
  })

  it('NEGATIVE CONTROL: a tick with nothing pending still reports itself, with an empty split', async () => {
    mockGetPendingMessages.mockReturnValue([])
    await runMessageRouterTick()
    const summary = lines(logInfo, 'message-router: tick summary')
    expect(summary.length).toBe(1)
    expect((summary[0][0] as { delivered: Record<string, number> }).delivered).toEqual({})
  })
})
