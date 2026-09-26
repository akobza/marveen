// Card 76ed00de, the two points #1214 left open.
//
// On 2026-09-07 the session-stuck alert told the main agent to "restart the
// agent if it is wedged" about a session running a 10m54s turn with a shell in
// the background. #1214 taught the busy detector the minutes form of the turn
// timer. What stayed: every pane state that is not 'busy' fell through to the
// restart advice -- including null (the pane could not be captured) and
// 'unknown' (neither a busy signal nor the idle prompt). A state the detector
// did NOT measure landed on the destructive branch, and the alert never said
// what its reading rested on, so the reader took "no busy signal seen" for
// "measured idle".
//
// Pinned here, on the pure functions and on two real router ticks:
//  - null / 'unknown': the alert says NOT MEASURED and does not advise a restart;
//  - every alert names the signal its pane reading rests on (readPaneState);
//  - CONTROL: a measured idle pane keeps the restart advice, and a long busy
//    turn keeps the busy framing -- the change is about the unmeasured states only.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const SEP = '─'.repeat(80)
const MIN = 60 * 1000
const RESTART = 'restart the agent if it is wedged'

// Real pane shapes, read by the real detector, not handed in as literals.
const IDLE_PANE = ['', SEP, '❯ ', SEP, '  ⏵⏵ bypass permissions on (shift+tab to cycle)'].join('\n')
// Neither a busy signal nor the idle prompt: the detector reads it 'unknown'.
const UNKNOWN_PANE = ['Some tool output that is not a prompt', '', SEP, '  loading…', SEP].join('\n')
// The 2026-09-07 shape: a turn past ten minutes, a background shell.
const LONG_TURN_PANE = [
  '✶ Kneading… (10m 54s · ↓ 27.9k tokens)',
  '',
  SEP,
  '❯ ',
  SEP,
  '  ⏵⏵ bypass permissions on (shift+tab to cycle) · 1 shell · esc to interrupt',
].join('\n')

const mockGetPendingMessages = vi.fn()
const mockCreateAgentMessage = vi.fn((..._a: unknown[]) => ({ id: 999 }))
const mockCapturePane = vi.fn((..._a: unknown[]): string | null => null)

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}))

vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  MAIN_AGENT_ID: 'orin',
  SUBAGENT_TELEGRAM_WAKE_ENABLED: false,
}))

vi.mock('../db.js', () => ({
  getPendingMessages: (toAgent?: string) => (toAgent ? [] : mockGetPendingMessages()),
  getMessageStatus: (..._a: unknown[]) => 'pending',
  markMessageDelivered: (..._a: unknown[]) => true,
  markMessageFailed: (..._a: unknown[]) => true,
  markMessageDone: (..._a: unknown[]) => true,
  markPendingFederatedFailed: (..._a: unknown[]) => 0,
  setMessageResult: (..._a: unknown[]) => true,
  createAgentMessage: (...a: unknown[]) => mockCreateAgentMessage(...a),
  countNewerMessagesFromSameSender: (..._a: unknown[]) => 0,
  stampMessageTrace: (..._a: unknown[]) => false,
  upsertOtelSpan: (..._a: unknown[]) => undefined,
  closeOtelSpan: (..._a: unknown[]) => false,
}))

vi.mock('../web/voice-directive.js', () => ({
  resolveAgentChannelStateDir: () => '/tmp/none',
}))

vi.mock('../web/agent-config.js', () => ({
  readAgentRemoteHost: () => null,
  readAgentVoiceConfig: () => ({ responseMode: 'text' }),
  isKnownAgent: () => true,
  agentDir: () => '/tmp/none-agentdir',
  readAgentWorksourceChannel: () => false,
}))

vi.mock('../web/agent-process.js', () => ({
  agentSessionName: (name: string) => `agent-${name}`,
  isSessionReadyForPrompt: vi.fn(async () => false),
  clearStaleParkedInput: vi.fn(async () => false),
  sendPromptToSession: vi.fn(),
  sessionExistsOnHost: vi.fn(() => true),
  capturePane: (...a: unknown[]) => mockCapturePane(...a),
  clearFeedbackModalAndRecheck: vi.fn(async () => false),
}))

vi.mock('../web/voice-modality.js', () => ({
  setLastInboundModality: vi.fn(),
}))

vi.mock('../web/main-agent.js', () => ({
  MAIN_CHANNELS_SESSION: 'orin-channels',
}))

import { formatStuckSessionAlert, runMessageRouterTick } from '../web/message-router.js'
import { readPaneState, detectPaneState } from '../pane-state.js'

describe('readPaneState: the verdict and the signal it rests on', () => {
  it('names the matched pane text for a long busy turn', () => {
    const r = readPaneState(LONG_TURN_PANE)
    expect(r.state).toBe('busy')
    expect(r.signal).toContain('(10m 54s · ↓ 2')
  })

  it('names the idle prompt, the missing signals, and an empty capture', () => {
    expect(readPaneState(IDLE_PANE)).toEqual({ state: 'idle', signal: 'idle footer, empty input box' })
    expect(readPaneState(UNKNOWN_PANE)).toEqual({ state: 'unknown', signal: 'no idle footer and no busy signal' })
    expect(readPaneState('')).toEqual({ state: 'unknown', signal: 'empty capture' })
  })

  it('its state is the one detectPaneState gives', () => {
    for (const p of [IDLE_PANE, UNKNOWN_PANE, LONG_TURN_PANE, '']) {
      expect(readPaneState(p).state).toBe(detectPaneState(p))
    }
  })
})

describe('formatStuckSessionAlert: an unmeasured pane does not draw the restart advice', () => {
  it('null (not captured): NOT MEASURED, no restart advice, still points at the diagnosis', () => {
    const a = formatStuckSessionAlert('polip', 'orin', 'agent-polip', 11 * MIN, 3, null)!
    expect(a).toContain('NOT MEASURED')
    expect(a).toContain('not captured')
    expect(a).toContain('do NOT restart on this alert alone')
    expect(a).toContain('delivery-stall diagnosis')
    expect(a).not.toContain(RESTART)
  })

  it("'unknown': NOT MEASURED, the missing signal named, no restart advice", () => {
    const r = readPaneState(UNKNOWN_PANE)
    const a = formatStuckSessionAlert('polip', 'orin', 'agent-polip', 11 * MIN, 3, r.state, false, null, r.signal)!
    expect(a).toContain('NOT MEASURED')
    expect(a).toContain('Pane: unknown, on no idle footer and no busy signal.')
    expect(a).not.toContain(RESTART)
  })

  it('KONTROLL: a measured idle pane keeps the restart advice, and says what it rests on', () => {
    const r = readPaneState(IDLE_PANE)
    const a = formatStuckSessionAlert('polip', 'orin', 'agent-polip', 11 * MIN, 3, r.state, false, null, r.signal)!
    expect(a).toContain(RESTART)
    expect(a).toContain('Pane: idle, on idle footer, empty input box.')
    expect(a).not.toContain('NOT MEASURED')
  })

  it('KONTROLL: a busy pane keeps the busy framing, now with the matched signal', () => {
    const r = readPaneState(LONG_TURN_PANE)
    const a = formatStuckSessionAlert('polip', 'orin', 'agent-polip', 31 * MIN, 3, r.state, false, null, r.signal)!
    expect(a).toContain('BUSY')
    expect(a).toContain('(10m 54s · ↓ 2')
    expect(a).not.toContain(RESTART)
  })
})

// The wiring: the router has to read the pane with readPaneState and hand the
// signal to the notifier. Driven through two real router ticks.
let clock = 0
let seq = 0

function pendingFor(agent: string) {
  return {
    id: 7600 + seq++,
    from_agent: 'marveen',
    to_agent: agent,
    content: 'queued behind the stall',
    status: 'pending',
    created_at: Math.floor(clock / 1000),
  }
}

async function twoTicks(agent: string, pane: string | null, gapMin: number) {
  mockGetPendingMessages.mockReturnValue([pendingFor(agent)])
  mockCapturePane.mockReturnValue(pane)
  await runMessageRouterTick() // stuck clock starts
  clock += gapMin * MIN
  await runMessageRouterTick() // escalation check
}

function stuckAlerts(): string[] {
  return mockCreateAgentMessage.mock.calls
    .filter((c) => c[0] === 'system' && c[1] === 'orin' && String(c[2]).startsWith('[session-stuck]'))
    .map((c) => String(c[2]))
}

describe('router: the escalated alert carries the pane reading', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    clock = Date.UTC(2026, 8, 26, 19, 0, 0)
    vi.spyOn(Date, 'now').mockImplementation(() => clock)
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('an unknown pane: NOT MEASURED with the signal, no restart advice', async () => {
    await twoTicks('stuck76a', UNKNOWN_PANE, 11)
    const alerts = stuckAlerts()
    expect(alerts).toHaveLength(1)
    expect(alerts[0]).toContain('NOT MEASURED')
    expect(alerts[0]).toContain('no idle footer and no busy signal')
    expect(alerts[0]).not.toContain(RESTART)
  })

  it('a pane that could not be captured: NOT MEASURED, no restart advice', async () => {
    await twoTicks('stuck76b', null, 11)
    const alerts = stuckAlerts()
    expect(alerts).toHaveLength(1)
    expect(alerts[0]).toContain('not captured')
    expect(alerts[0]).not.toContain(RESTART)
  })

  it('KONTROLL: an idle pane keeps the restart advice, with its reading', async () => {
    await twoTicks('stuck76c', IDLE_PANE, 11)
    const alerts = stuckAlerts()
    expect(alerts).toHaveLength(1)
    expect(alerts[0]).toContain(RESTART)
    expect(alerts[0]).toContain('idle footer, empty input box')
  })

  it('KONTROLL: the 10m54s turn escalates only past the busy watchdog, as BUSY, quoting its timer', async () => {
    await twoTicks('stuck76d', LONG_TURN_PANE, 11)
    expect(stuckAlerts()).toHaveLength(0)
    await twoTicks('stuck76e', LONG_TURN_PANE, 31)
    const alerts = stuckAlerts()
    expect(alerts).toHaveLength(1)
    expect(alerts[0]).toContain('BUSY')
    expect(alerts[0]).toContain('(10m 54s · ↓ 2')
    expect(alerts[0]).not.toContain(RESTART)
  })
})
