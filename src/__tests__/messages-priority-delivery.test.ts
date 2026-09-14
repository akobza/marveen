import { describe, it, expect, beforeEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { initDatabase, createAgentMessage, getPendingMessages, getDb } from '../db.js'
import { MAIN_AGENT_ID } from '../config.js'
import { tryHandleMessages } from '../web/routes/messages.js'
import type { RouteContext } from '../web/routes/types.js'

// MSGFIFO907: inter-agent delivery was strictly FIFO, so an urgent instruction
// queued behind whatever was already there. Measured cost (2026-09-07 18:2xZ):
// three GO messages landed behind 10 / 11 / 43 pending rows, the oldest 1h50m
// old, and all three had to be overtaken by hand with a tmux nudge. The queue
// was not stuck -- it was draining -- so "wait for it" was not an answer: an
// urgent instruction that queues for an hour in our own system is not urgent.
//
// The controls are the point: a high-priority message must be measurably NEXT
// out of a loaded queue, and a normal one must still arrive in FIFO order --
// priority must not turn into "everything jumps".

const TARGET = 'busy-agent'

function post(body: unknown): Promise<{ statusCode: number; json: Record<string, unknown> }> {
  const req = new EventEmitter() as unknown as RouteContext['req'] & { destroy(): void }
  ;(req as unknown as { headers: Record<string, string> }).headers = {}
  ;(req as { destroy(): void }).destroy = () => { /* readBody over-limit hook */ }
  const state = { statusCode: 200, body: '' }
  const res = {
    writeHead(code: number) { state.statusCode = code; return res },
    end(data?: unknown) { state.body = data === undefined ? '' : String(data) },
    setHeader() { /* json() does not use it */ },
  } as unknown as RouteContext['res']
  process.nextTick(() => {
    ;(req as unknown as EventEmitter).emit('data', Buffer.from(JSON.stringify(body)))
    ;(req as unknown as EventEmitter).emit('end')
  })
  const path = '/api/messages'
  const ctx: RouteContext = { req, res, path, method: 'POST', url: new URL(`http://localhost${path}`), fedPeer: null }
  return Promise.resolve(tryHandleMessages(ctx)).then(() => ({
    statusCode: state.statusCode,
    json: state.body ? JSON.parse(state.body) as Record<string, unknown> : {},
  }))
}

function loadQueue(n: number): void {
  // A queue that is FULL but MOVING -- the measured situation. created_at is
  // pushed back so the backlog is genuinely older than what we send next.
  const base = Math.floor(Date.now() / 1000) - 3600
  const upd = getDb().prepare('UPDATE agent_messages SET created_at = ? WHERE id = ?')
  for (let i = 0; i < n; i++) {
    const m = createAgentMessage('someone', TARGET, `backlog ${i}`)
    upd.run(base + i, m.id)
  }
}

beforeEach(() => {
  initDatabase(':memory:')
  loadQueue(10)
})

describe('inter-agent delivery: an urgent message must be able to overtake a loaded queue', () => {
  it('POSITIVE CONTROL: a high-priority message is the NEXT one delivered out of a 10-deep queue', async () => {
    const before = getPendingMessages(TARGET)
    expect(before.length).toBe(10)                       // the queue really is loaded
    const r = await post({ from: MAIN_AGENT_ID, to: TARGET, content: 'GO', priority: 'high' })
    expect(r.statusCode).toBe(200)
    const after = getPendingMessages(TARGET)
    expect(after.length).toBe(11)
    expect(after[0].content).toBe('GO')                  // measured order, not assumed
    expect(after[0].id).toBe(r.json.id as number)
  })

  it('NEGATIVE CONTROL: a normal message into the same queue still arrives LAST (FIFO holds)', async () => {
    const r = await post({ from: MAIN_AGENT_ID, to: TARGET, content: 'later', priority: 'normal' })
    expect(r.statusCode).toBe(200)
    const after = getPendingMessages(TARGET)
    expect(after[after.length - 1].content).toBe('later')
    expect(after[0].content).toBe('backlog 0')
  })

  it('a MISSING priority field means normal -- the default is stated and measured', async () => {
    const r = await post({ from: MAIN_AGENT_ID, to: TARGET, content: 'no field' })
    expect(r.statusCode).toBe(200)
    const after = getPendingMessages(TARGET)
    expect(after[after.length - 1].content).toBe('no field')
    expect(String(r.json.priority ?? '')).toBe('normal')  // echoed back, so the sender sees it
  })

  it('an unknown priority value fails LOUDLY instead of silently becoming normal', async () => {
    const r = await post({ from: MAIN_AGENT_ID, to: TARGET, content: 'x', priority: 'URGENT!!' })
    expect(r.statusCode).toBe(400)
    expect(String(r.json.error ?? '')).toMatch(/priority/i)
  })

  it('the sender gets a MEASURED queue position back, not just a warning text', async () => {
    const high = await post({ from: MAIN_AGENT_ID, to: TARGET, content: 'GO', priority: 'high' })
    expect(high.json.queuePosition).toBe(1)              // next out
    const normal = await post({ from: MAIN_AGENT_ID, to: TARGET, content: 'normal one' })
    expect(normal.json.queuePosition).toBe(12)           // 10 backlog + the high one + itself
    expect(normal.json.queueDepth).toBe(12)
  })
})
