import { describe, it, expect, beforeEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { initDatabase, createAgentMessage, getPendingMessages, getAgentMessage, markMessageDelivered } from '../db.js'
import { MAIN_AGENT_ID } from '../config.js'
import { tryHandleMessages } from '../web/routes/messages.js'
import type { RouteContext } from '../web/routes/types.js'

// MSGREVOKE907: a queued inter-agent instruction could not be taken back. When
// an instruction was overridden minutes later, the OLD message stayed pending
// and was delivered hours afterwards -- by which time the recipient was already
// working from the correction. The two are indistinguishable at the recipient:
// same sender, both in the shape of a valid instruction. And the obvious
// defence ("later arrival = newer") is FALSE here, because a queue that lags by
// an hour means delivery order is not decision order.
//
// Measured case (2026-09-07): the superseded instruction sat AHEAD of its own
// correction in the queue, and only an agent's alertness stopped it from being
// acted on. This test replaces that alertness with a mechanism.

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

beforeEach(() => { initDatabase(':memory:') })

describe('a queued instruction must be revocable before it is delivered', () => {
  it('POSITIVE CONTROL: two contradictory instructions, the first revoked -- only the second reaches the recipient', async () => {
    const first = await post({ from: MAIN_AGENT_ID, to: TARGET, content: 'put the skill in the LOCAL folder' })
    expect(getPendingMessages(TARGET).length).toBe(1)

    const second = await post({
      from: MAIN_AGENT_ID, to: TARGET,
      content: 'correction: the GLOBAL folder, the previous instruction is void',
      supersedes: first.json.id,
    })
    expect(second.statusCode).toBe(200)
    expect(second.json.supersededOk).toBe(true)

    // What the recipient actually gets -- measured, not assumed:
    const queue = getPendingMessages(TARGET)
    expect(queue.length).toBe(1)
    expect(queue[0].id).toBe(second.json.id)
    expect(getAgentMessage(first.json.id as number)?.superseded_by).toBe(second.json.id)
  })

  it('NEGATIVE CONTROL: without `supersedes` both instructions stay queued (nothing is cancelled by accident)', async () => {
    await post({ from: MAIN_AGENT_ID, to: TARGET, content: 'first' })
    await post({ from: MAIN_AGENT_ID, to: TARGET, content: 'second' })
    expect(getPendingMessages(TARGET).length).toBe(2)
  })

  it('TOO LATE is not silent success: superseding an already delivered message reports failure and changes nothing', async () => {
    const first = await post({ from: MAIN_AGENT_ID, to: TARGET, content: 'already gone' })
    markMessageDelivered(first.json.id as number)

    const second = await post({
      from: MAIN_AGENT_ID, to: TARGET, content: 'too late correction', supersedes: first.json.id,
    })
    expect(second.statusCode).toBe(200)
    expect(second.json.supersededOk).toBe(false)                 // the caller LEARNS it did not stop it
    expect(String(second.json.supersededError ?? '')).toMatch(/delivered|no longer pending/i)
    expect(getAgentMessage(first.json.id as number)?.status).toBe('delivered')
  })

  it('a sender may only revoke its OWN message to the SAME recipient', async () => {
    const foreign = createAgentMessage('other-sender', TARGET, 'not yours to cancel')
    const r = await post({
      from: MAIN_AGENT_ID, to: TARGET, content: 'trying to cancel someone else', supersedes: foreign.id,
    })
    expect(r.json.supersededOk).toBe(false)
    expect(getAgentMessage(foreign.id)?.status).toBe('pending')   // untouched
  })

  it('a superseded row is not delivered, and says what replaced it', async () => {
    const first = await post({ from: MAIN_AGENT_ID, to: TARGET, content: 'old' })
    const second = await post({ from: MAIN_AGENT_ID, to: TARGET, content: 'new', supersedes: first.json.id })
    const row = getAgentMessage(first.json.id as number)
    expect(row?.superseded_by).toBe(second.json.id)
    expect(getPendingMessages(TARGET).some(m => m.id === first.json.id)).toBe(false)
    expect(String(row?.result ?? '')).toContain(String(second.json.id))   // the trail survives
  })
})
