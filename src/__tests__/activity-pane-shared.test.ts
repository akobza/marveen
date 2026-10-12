import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Card ea6f9b07 (decision B1): the Agents page polls /api/agents/activity every
// 3 s, and each poll captured every running local pane (one tmux fork each, per
// open tab). Local captures are now shared for ACTIVITY_PANE_TTL_MS, a window
// under the poll interval, and a hidden tab does not poll at all.

const h = vi.hoisted(() => ({ captures: [] as string[] }))

vi.mock('../web/agent-process.js', async (orig) => ({
  ...(await orig() as object),
  capturePane: vi.fn((session: string) => {
    h.captures.push(session)
    return `pane of ${session}`
  }),
  agentRunState: () => 'running',
}))
vi.mock('../web/agent-config.js', async (orig) => ({
  ...(await orig() as object),
  listAgentNames: () => ['zz-act-a', 'zz-act-b'],
  readAgentRemoteHost: () => null,
}))

import { tryHandleAgents, ACTIVITY_PANE_TTL_MS } from '../web/routes/agents.js'
import { PROJECT_ROOT } from '../config.js'
import { MAIN_CHANNELS_SESSION } from '../web/main-agent.js'
import type { RouteContext } from '../web/routes/types.js'

async function poll(): Promise<unknown[]> {
  let body = ''
  const res = {
    writeHead() { return res },
    end(chunk?: Buffer | string) { if (chunk) body = chunk.toString() },
  }
  const url = new URL('http://localhost:3420/api/agents/activity')
  const ctx = { req: { headers: {} }, res, path: url.pathname, method: 'GET', url } as unknown as RouteContext
  expect(await tryHandleAgents(ctx, join(PROJECT_ROOT, 'web'))).toBe(true)
  return JSON.parse(body) as unknown[]
}

const PANES = [MAIN_CHANNELS_SESSION, 'agent-zz-act-a', 'agent-zz-act-b'].sort()

beforeEach(() => {
  h.captures.length = 0
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('GET /api/agents/activity shares the local pane captures', () => {
  it('two polls inside the window capture each pane once and answer the same', async () => {
    vi.setSystemTime(new Date('2026-10-12T12:00:00Z'))
    const first = await poll()
    vi.setSystemTime(new Date(Date.parse('2026-10-12T12:00:00Z') + ACTIVITY_PANE_TTL_MS - 1))
    const second = await poll()
    expect([...h.captures].sort()).toEqual(PANES)
    expect(second).toEqual(first)
    expect(first.length).toBe(3)
  })

  it('a poll after the window captures every pane again', async () => {
    // A later hour, so nothing is left in the window from the case above.
    vi.setSystemTime(new Date('2026-10-12T13:00:00Z'))
    await poll()
    vi.setSystemTime(new Date(Date.parse('2026-10-12T13:00:00Z') + ACTIVITY_PANE_TTL_MS))
    await poll()
    expect([...h.captures].sort()).toEqual([...PANES, ...PANES].sort())
  })
})

// The page side, source level (web/app.js is a browser script).
describe('web/app.js: a hidden tab does not poll the activity endpoint', () => {
  const app = readFileSync(join(PROJECT_ROOT, 'web', 'app.js'), 'utf-8')

  it('startAgentsBusyPoll returns at once on a hidden tab, before the first request', () => {
    const start = app.indexOf('function startAgentsBusyPoll() {')
    expect(start).toBeGreaterThan(-1)
    const body = app.slice(start, app.indexOf('\n}\n', start))
    const guard = body.indexOf('if (document.hidden) return')
    expect(guard).toBeGreaterThan(-1)
    expect(guard).toBeLessThan(body.indexOf('refreshAgentTerminalBusy()'))
  })

  it('a visibilitychange listener stops the poll when hidden and restarts it on the Agents page', () => {
    expect(app).toContain(
      "document.addEventListener('visibilitychange', () => {\n" +
      '  if (document.hidden) stopAgentsBusyPoll()\n' +
      "  else if (!document.getElementById('agentsPage').hidden) startAgentsBusyPoll()\n" +
      '})',
    )
  })

  it('the shared window is shorter than the poll, so one tab still reads fresh panes', () => {
    const m = app.match(/agentsBusyTimer = setInterval\(refreshAgentTerminalBusy, (\d+)\)/)
    expect(m).not.toBeNull()
    expect(ACTIVITY_PANE_TTL_MS).toBeLessThan(Number(m![1]))
  })
})
