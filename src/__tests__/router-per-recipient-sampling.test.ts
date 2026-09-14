// Card 669df94a, step (1): per-recipient sampling.
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

const mockIsReady = vi.fn(async (..._a: unknown[]) => true)
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
  isSessionReadyForPrompt: (...a: unknown[]) => mockIsReady(...a),
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

// The card's wording matters and is pinned here: NOT "let us cache", but ONE
// SAMPLE, ONE USE. A cache would go stale in the DANGEROUS direction -- after a
// delivery the pane is busy, so a cached "ready" would inject a second message
// into a pane that is no longer free. So: probe a recipient once per pass, and
// if it was ready, send that recipient's OLDEST message and leave the rest for
// the next pass.
//
// The measured price, from the card: if a pane becomes ready DURING the pass,
// that recipient loses one tick (~5s). The price of today's behaviour in the
// same situation is the oldest message waiting for the next idle window --
// median 116s, 90th percentile 381s. And the one-per-recipient-per-tick limit
// costs nothing measurable: of 582 deliveries on the tmux path there was NOT
// ONE pair where the same recipient got two within 5 seconds.

function pending(rows: Array<{ id: number; to: string; ageSec?: number }>) {
  const nowSec = Math.floor(Date.now() / 1000)
  return rows.map(r => ({
    id: r.id, from_agent: 'orin', to_agent: r.to, content: 'ping',
    created_at: nowSec - (r.ageSec ?? 0),
  }))
}
function deliveredIds(): number[] {
  return (logInfo.mock.calls as Array<[Record<string, unknown>, string]>)
    .filter(c => c[1] === 'Agent message delivered')
    .map(c => c[0].id as number)
}

describe('per-recipient sampling in one router pass (card 669df94a, step 1)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockSessionExistsOnHost.mockReturnValue(true)
    mockMarkDelivered.mockReturnValue(true)
    mockMarkFailed.mockReturnValue(true)
    mockIsReady.mockImplementation(async () => true)
  })

  it('POSITIVE CONTROL: one pass sends at most ONE message per recipient, and it is the OLDEST', async () => {
    // dex has two queued, ada one. Oldest first in the queue, as the DB returns it.
    mockGetPendingMessages.mockReturnValue(pending([
      { id: 11, to: 'dex', ageSec: 300 },   // dex, oldest
      { id: 12, to: 'ada', ageSec: 200 },
      { id: 13, to: 'dex', ageSec: 100 },   // dex, newer -- must wait for the next pass
    ]))
    await runMessageRouterTick()
    expect(deliveredIds().sort((a, b) => a - b)).toEqual([11, 12])
  })

  it('ONE readiness probe per recipient per pass (one sample, one use)', async () => {
    mockGetPendingMessages.mockReturnValue(pending([
      { id: 21, to: 'dex', ageSec: 300 }, { id: 22, to: 'dex', ageSec: 200 }, { id: 23, to: 'ada', ageSec: 100 },
    ]))
    await runMessageRouterTick()
    const probedSessions = (mockIsReady.mock.calls as unknown[][]).map(c => String(c[0]))
    expect(probedSessions.length).toBe(new Set(probedSessions).size)   // no recipient probed twice
    expect(new Set(probedSessions)).toEqual(new Set(['agent-dex', 'agent-ada']))
  })

  it('NEGATIVE CONTROL: a NOT-ready recipient blocks only itself, the other still gets its oldest', async () => {
    mockIsReady.mockImplementation(async (session: unknown) => session !== 'agent-dex')
    mockGetPendingMessages.mockReturnValue(pending([
      { id: 31, to: 'dex', ageSec: 300 }, { id: 32, to: 'ada', ageSec: 200 },
    ]))
    await runMessageRouterTick()
    expect(deliveredIds()).toEqual([32])
  })

  it('the next pass carries on with the recipient\'s next-oldest, so nothing is starved', async () => {
    mockGetPendingMessages.mockReturnValue(pending([
      { id: 41, to: 'dex', ageSec: 300 }, { id: 42, to: 'dex', ageSec: 200 },
    ]))
    await runMessageRouterTick()
    expect(deliveredIds()).toEqual([41])
    vi.clearAllMocks()
    mockSessionExistsOnHost.mockReturnValue(true)
    mockMarkDelivered.mockReturnValue(true)
    mockIsReady.mockImplementation(async () => true)
    mockGetPendingMessages.mockReturnValue(pending([{ id: 42, to: 'dex', ageSec: 205 }]))
    await runMessageRouterTick()
    expect(deliveredIds()).toEqual([42])
  })
})
