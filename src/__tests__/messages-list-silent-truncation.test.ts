import { describe, it, expect, beforeAll } from 'vitest'
import { EventEmitter } from 'node:events'
import { initDatabase, createAgentMessage, getDb } from '../db.js'
import { tryHandleMessages } from '../web/routes/messages.js'
import type { RouteContext } from '../web/routes/types.js'

// MSGLISTCUT907: `GET /api/messages` silently truncated to the 200-row cap and
// the global (agent-less) branch ignored the `before` cursor entirely, so rows
// older than the newest 200 were unreachable on this endpoint -- not slowly,
// but at all. Agents dedupe and look up history here, so every "first mention"
// / "only occurrence" claim drawn from a silently moving window can be
// structurally false, and it always errs the reassuring way (fewer hits ->
// "no duplicate" -> a second card opens next to an existing one). Three such
// claims collapsed in a single evening (msg 3175).
//
// The test shape is the point: the POSITIVE CONTROL walks the cursor to a row
// that is KNOWN to exist and sits OUTSIDE the newest-200 window, and fails if
// the walk cannot reach it. That is the only control shape that caught this.

const TOTAL = 250            // > the 200 cap, so the oldest rows are out of the first window
const CAP = 200

function get(query: string): { statusCode: number; body: string } {
  const req = new EventEmitter() as unknown as RouteContext['req']
  ;(req as unknown as { headers: Record<string, string> }).headers = {}
  const state = { statusCode: 200, body: '' }
  const res = {
    writeHead(code: number) { state.statusCode = code; return res },
    end(data?: unknown) { state.body = data === undefined ? '' : String(data) },
    setHeader() { /* json() does not use it */ },
  } as unknown as RouteContext['res']
  const path = '/api/messages'
  const url = new URL(`http://localhost${path}${query}`)
  const handled = tryHandleMessages({ req, res, path, method: 'GET', url, fedPeer: null })
  expect(handled).toBeTruthy()
  return state
}

function rows(query: string): Array<{ id: number }> {
  const r = get(query)
  expect(r.statusCode).toBe(200)
  return JSON.parse(r.body) as Array<{ id: number }>
}

let oldestId = 0
let newestId = 0

beforeAll(() => {
  initDatabase(':memory:')
  // DISTINCT created_at per row on purpose: createAgentMessage() stamps
  // `now`, so a loop would give all 250 rows the SAME second, and the global
  // list orders by created_at alone -- the tie order is then unspecified and
  // the pagination test would measure THAT instead of the cursor. The missing
  // `id` tiebreaker is a real defect of its own; it gets its own case below.
  const base = Math.floor(Date.now() / 1000) - TOTAL - 1
  const upd = getDb().prepare('UPDATE agent_messages SET created_at = ? WHERE id = ?')
  for (let i = 0; i < TOTAL; i++) {
    const m = createAgentMessage('sender', 'receiver', `msg ${i}`)
    upd.run(base + i, m.id)
    if (i === 0) oldestId = m.id
    newestId = m.id
  }
})

describe('GET /api/messages -- the truncation must be visible, and the global branch pageable', () => {
  it('POSITIVE CONTROL: the oldest row exists and is outside the newest-CAP window', () => {
    const firstPage = rows(`?limit=${CAP}`)
    expect(firstPage.length).toBe(CAP)
    expect(firstPage.some(r => r.id === oldestId)).toBe(false)   // it really is out of the window
    expect(newestId - oldestId + 1).toBe(TOTAL)                  // and it really exists
  })

  it('a limit above the cap fails LOUDLY instead of silently returning the cap', () => {
    const r = get('?limit=2000')
    expect(r.statusCode).toBe(400)
    const body = JSON.parse(r.body) as { error?: string; max?: number }
    expect(String(body.error ?? '')).toMatch(/limit/i)
    expect(body.max).toBe(CAP)
  })

  it('the GLOBAL (agent-less) branch honours the `before` cursor and reaches the oldest row', () => {
    const seen = new Set<number>()
    let cursor: number | undefined
    let page = rows('?limit=50')
    let guard = 0
    while (page.length > 0 && guard++ < TOTAL) {
      for (const r of page) seen.add(r.id)
      cursor = page[page.length - 1].id
      if (page.length < 50) break            // short page = end of list, no further call needed
      page = rows(`?limit=50&before=${cursor}`)
    }
    expect(seen.has(oldestId)).toBe(true)     // the walk REACHED the known-existing oldest row
    expect(seen.size).toBe(TOTAL)             // and it saw every row exactly once
  })

  it('the `before` cursor on the global branch actually moves the window', () => {
    const first = rows('?limit=50')
    const second = rows(`?limit=50&before=${first[first.length - 1].id}`)
    expect(second.length).toBeGreaterThan(0)
    expect(second[0].id).toBeLessThan(first[first.length - 1].id)
  })

  it('the global list is stably ordered: equal created_at must not shuffle the window', () => {
    // Same-second rows are the normal case for a burst of messages. Without an
    // `id` tiebreaker the two calls below can return DIFFERENT rows for the same
    // query, and a cursor walk over them can skip or repeat rows silently.
    const tieBase = Math.floor(Date.now() / 1000) + 10
    const upd = getDb().prepare('UPDATE agent_messages SET created_at = ? WHERE id = ?')
    const ids: number[] = []
    for (let i = 0; i < 5; i++) {
      const m = createAgentMessage('tie', 'tie', `burst ${i}`)
      upd.run(tieBase, m.id)
      ids.push(m.id)
    }
    const a = rows('?limit=5').map(r => r.id)
    const b = rows('?limit=5').map(r => r.id)
    expect(a).toEqual(b)
    expect(a).toEqual([...ids].sort((x, y) => y - x))   // newest-first WITHIN the tie
  })
})
