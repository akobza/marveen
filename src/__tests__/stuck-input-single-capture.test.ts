import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Card ea6f9b07: the 15 s stuck-input sweep read every pane twice, milliseconds
// apart, with the same `capture-pane -e -p` (the paste check, then the typing
// recovery), and every capture forks the large dashboard process. The sweep now
// takes ONE ghost-stripped capture per session per tick and hands it to both
// paths. The typing path only runs when the paste path sent nothing, so the
// handed-in capture is what a second capture would have read.

const h = vi.hoisted(() => ({
  captures: [] as Array<[string, string | null]>,
  panes: new Map<string, string>(),
  recovered: [] as Array<{ session: string; parkedView: unknown; args: number }>,
}))

vi.mock('../logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() } }))
vi.mock('../web/agent-config.js', () => ({
  listAgentNames: () => ['a', 'b', 'r'],
  readAgentRemoteHost: (name: string) => (name === 'r' ? 'laptop.invalid' : null),
}))
vi.mock('../web/channel-mcp-reconnect.js', () => ({ resolveAgentSession: (name: string) => `agent-${name}` }))
vi.mock('../web/main-agent.js', () => ({ MAIN_CHANNELS_SESSION: 'main-channels' }))
vi.mock('../web/agent-process.js', () => ({
  isAgentRunning: () => true,
  captureParkedInputView: vi.fn((session: string, host: string | null = null) => {
    h.captures.push([session, host])
    return h.panes.get(session) ?? `pane of ${session}`
  }),
  capturePane: vi.fn(() => null),
  sendEnterToSession: vi.fn(),
}))
vi.mock('../web/channel-monitor.js', () => ({
  recoverStuckInputForSession: vi.fn(async (session: string, ...rest: unknown[]) => {
    h.recovered.push({ session, parkedView: rest[3], args: rest.length + 1 })
    return { parkedSig: null, firstSeenAt: null, lastRecoverAt: null, attempts: 0 }
  }),
  sendAlert: vi.fn(),
}))
vi.mock('../pane-state.js', async (orig) => ({
  ...(await orig() as object),
  parkedPasteSignature: (pane: string) => (pane.includes('[PASTE]') ? 'paste-sig' : null),
}))

import { startStuckInputWatcher } from '../web/stuck-input-watcher.js'
import { sendEnterToSession } from '../web/agent-process.js'

let timer: NodeJS.Timeout | null = null

beforeEach(() => {
  h.captures.length = 0
  h.panes.clear()
  h.recovered.length = 0
  vi.mocked(sendEnterToSession).mockClear()
  vi.useFakeTimers()
})

afterEach(() => {
  if (timer) clearInterval(timer)
  timer = null
  vi.useRealTimers()
})

// One sweep: the interval's first tick (15 s), before the 20 s initial run.
async function oneSweep(): Promise<void> {
  timer = startStuckInputWatcher()
  await vi.advanceTimersByTimeAsync(15_000)
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

describe('one ghost-stripped capture per session per stuck-input tick', () => {
  it('every session is captured once, and the typing recovery gets that same capture', async () => {
    await oneSweep()
    expect(h.captures).toEqual([
      ['main-channels', null],
      ['agent-a', null],
      ['agent-b', null],
      ['agent-r', 'laptop.invalid'],
    ])
    expect(h.recovered.map(r => r.session)).toEqual(['main-channels', 'agent-a', 'agent-b'])
    for (const r of h.recovered) {
      expect(r.args).toBe(5)
      expect(r.parkedView).toBe(`pane of ${r.session}`)
    }
    // Nothing is parked in these panes: no recovery Enter, the remote included.
    expect(vi.mocked(sendEnterToSession)).not.toHaveBeenCalled()
  })

  it('a parked paste skips the typing recovery for that session, still one capture each', async () => {
    h.panes.set('agent-a', 'box [PASTE] placeholder')
    await oneSweep()
    expect(h.captures.map(c => c[0])).toEqual(['main-channels', 'agent-a', 'agent-b', 'agent-r'])
    expect(h.recovered.map(r => r.session)).toEqual(['main-channels', 'agent-b'])
  })

  it('a failed capture reaches the typing recovery as null (nothing parked), not as a second capture', async () => {
    h.panes.set('agent-b', null as unknown as string)
    vi.mocked((await import('../web/agent-process.js')).captureParkedInputView).mockImplementation((session: string, host: string | null = null) => {
      h.captures.push([session, host])
      return session === 'agent-b' ? null : `pane of ${session}`
    })
    await oneSweep()
    expect(h.captures.filter(c => c[0] === 'agent-b').length).toBe(1)
    const b = h.recovered.find(r => r.session === 'agent-b')
    expect(b?.args).toBe(5)
    expect(b?.parkedView).toBeNull()
  })
})

// The channel-monitor side, source level (the module drives tmux and the
// process table, so a unit run of recoverStuckInputForSession is not possible
// here): a handed-in view is used as is, and only an omitted one is captured.
describe('wiring: recoverStuckInputForSession takes the caller\'s capture', () => {
  const src = readFileSync(join(__dirname, '..', 'web', 'channel-monitor.ts'), 'utf-8')
  const start = src.indexOf('export async function recoverStuckInputForSession(')
  const body = src.slice(start, src.indexOf('\n}\n', start))

  it('an optional parkedView parameter replaces the capture when given', () => {
    expect(start).toBeGreaterThan(-1)
    expect(body).toMatch(/parkedView\?: string \| null,\n\): Promise<StuckInputState> \{/)
    expect(body).toContain('const pane = parkedView !== undefined ? parkedView : captureParkedInputView(session)')
    expect(body.match(/captureParkedInputView\(/g)?.length).toBe(1)
  })
})
