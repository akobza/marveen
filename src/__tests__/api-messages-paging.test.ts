import { describe, it, expect, beforeAll } from 'vitest'

// 39a46ab7: GET /api/messages used to cut the list to 200 rows in silence (limit=500 and
// limit=2000 both answered 200 rows, and nothing in the response said so), and the GLOBAL branch
// (no `agent`) ignored the `before` cursor, so nothing older than the fleet's newest 200 rows could
// be listed at all. Every "first mention" claim built on that list could be structurally false.
//
// The decision (2026-09-28): the body stays a bare JSON array (the fleet's
// scripts read that shape); three headers state the cut (X-Messages-Limit, X-Messages-Has-More,
// X-Messages-Next-Before); the global branch gets the cursor; no 400 for a large limit.

import { initDatabase, createAgentMessage, AGENT_MESSAGE_LIMIT_CAP } from '../db.js'
import { tryHandleMessages } from '../web/routes/messages.js'

type Resp = { status: number; headers: Record<string, string>; json: any }

async function get(pathAndQuery: string): Promise<Resp> {
  let status = 200
  let body = ''
  const headers: Record<string, string> = {}
  const res = {
    setHeader(k: string, v: string | number) { headers[k.toLowerCase()] = String(v) },
    writeHead(s: number, h?: Record<string, string>) {
      status = s
      for (const [k, v] of Object.entries(h ?? {})) headers[k.toLowerCase()] = String(v)
    },
    end(b?: string | Buffer) { body = b ? b.toString() : '' },
  } as any
  const url = new URL(`http://localhost${pathAndQuery}`)
  const handled = await tryHandleMessages({
    // `accept-encoding` absent so jsonMaybeGzip answers in plain JSON.
    req: { headers: {} } as any, res, path: url.pathname, method: 'GET', url,
  } as any)
  return { status: handled ? status : -1, headers, json: body ? JSON.parse(body) : null }
}

/** Follow X-Messages-Next-Before until the list says there is no more; returns every id seen. */
async function pageAll(base: string): Promise<{ ids: number[]; pages: Resp[] }> {
  const ids: number[] = []
  const pages: Resp[] = []
  let next: string | undefined
  for (let i = 0; i < 50; i++) {
    const r = await get(next ? `${base}&before=${next}` : base)
    pages.push(r)
    ids.push(...r.json.map((m: { id: number }) => m.id))
    if (r.headers['x-messages-has-more'] !== 'true') break
    next = r.headers['x-messages-next-before']
  }
  return { ids, pages }
}

const AGENT_ROWS = 250
const OTHER_ROWS = 30
let oldestForAgent = 0
let oldestOverall = 0
let total = 0

beforeAll(() => {
  initDatabase(':memory:')
  for (let i = 0; i < AGENT_ROWS; i++) {
    const m = createAgentMessage('kuldo', 'lapozo', `uzenet ${i}`)
    if (i === 0) { oldestForAgent = m.id; oldestOverall = m.id }
  }
  for (let i = 0; i < OTHER_ROWS; i++) createAgentMessage('mas-a', 'mas-b', `mas ${i}`)
  for (let i = 0; i < 3; i++) createAgentMessage('kuldo', 'hatar', `hatar ${i}`)
  total = AGENT_ROWS + OTHER_ROWS + 3
})

describe('GET /api/messages states the cut instead of hiding it (39a46ab7)', () => {
  it('agent branch: limit=500 answers the cap, and the headers say it was cut', async () => {
    const r = await get('/api/messages?agent=lapozo&limit=500')
    expect(r.status).toBe(200)
    expect(Array.isArray(r.json)).toBe(true) // the body shape is unchanged: a bare array
    expect(r.json).toHaveLength(200)
    expect(r.headers['x-messages-limit']).toBe('200')
    expect(r.headers['x-messages-has-more']).toBe('true')
    expect(r.headers['x-messages-next-before']).toBe(String(r.json[r.json.length - 1].id))
    // the known oldest row sits outside this first window
    expect(r.json.map((m: { id: number }) => m.id)).not.toContain(oldestForAgent)
  })

  it('agent branch: paging with the cursor reaches the known row outside the 200-row window', async () => {
    const { ids, pages } = await pageAll('/api/messages?agent=lapozo&limit=500')
    expect(ids).toContain(oldestForAgent)
    expect(new Set(ids).size).toBe(ids.length) // no row twice
    expect(ids).toHaveLength(AGENT_ROWS)
    const last = pages[pages.length - 1]
    expect(last.headers['x-messages-has-more']).toBe('false')
    expect(last.headers['x-messages-next-before']).toBeUndefined()
  })

  it('global branch: `before` is honoured now, and paging reaches the oldest row of the whole list', async () => {
    const first = await get('/api/messages?limit=2000')
    expect(first.json).toHaveLength(200)
    expect(first.headers['x-messages-has-more']).toBe('true')
    const { ids, pages } = await pageAll('/api/messages?limit=2000')
    expect(ids).toContain(oldestOverall)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).toHaveLength(total)
    expect(pages[pages.length - 1].headers['x-messages-has-more']).toBe('false')
  })

  it('the two boundaries: exactly the remaining rows says "no more"; one fewer says "more", with the cursor', async () => {
    const exact = await get('/api/messages?agent=hatar&limit=3')
    expect(exact.json).toHaveLength(3)
    expect(exact.headers['x-messages-has-more']).toBe('false')
    expect(exact.headers['x-messages-next-before']).toBeUndefined()
    const fewer = await get('/api/messages?agent=hatar&limit=2')
    expect(fewer.json).toHaveLength(2)
    expect(fewer.headers['x-messages-has-more']).toBe('true')
    expect(fewer.headers['x-messages-next-before']).toBe(String(fewer.json[1].id))
    const rest = await get(`/api/messages?agent=hatar&limit=2&before=${fewer.headers['x-messages-next-before']}`)
    expect(rest.json).toHaveLength(1)
    expect(rest.headers['x-messages-has-more']).toBe('false')
  })

  it('the applied limit is the one cap, 200, and the header reports it for an over-cap ask', async () => {
    // Pinned on purpose: a silent change of the cap (the positive control sets it to 5) must turn this red.
    expect(AGENT_MESSAGE_LIMIT_CAP).toBe(200)
    const r = await get('/api/messages?limit=500')
    expect(r.headers['x-messages-limit']).toBe(String(AGENT_MESSAGE_LIMIT_CAP))
    expect(r.json).toHaveLength(AGENT_MESSAGE_LIMIT_CAP)
  })

  it('an under-cap ask is served as asked and says "no more" only when nothing is left', async () => {
    const r = await get('/api/messages?agent=lapozo&limit=50')
    expect(r.json).toHaveLength(50)
    expect(r.headers['x-messages-limit']).toBe('50')
    expect(r.headers['x-messages-has-more']).toBe('true')
  })

  it('the pending lists are not capped: Limit "none", Has-More "false", no cursor', async () => {
    const r = await get('/api/messages?agent=lapozo&status=pending')
    expect(r.json).toHaveLength(AGENT_ROWS)
    expect(r.headers['x-messages-limit']).toBe('none')
    expect(r.headers['x-messages-has-more']).toBe('false')
    expect(r.headers['x-messages-next-before']).toBeUndefined()
  })

  it('a non-numeric limit or cursor does not throw: the limit falls back to 1, the cursor is ignored', async () => {
    const r = await get('/api/messages?limit=abc&before=xyz')
    expect(r.status).toBe(200)
    expect(r.json).toHaveLength(1)
    expect(r.headers['x-messages-limit']).toBe('1')
    expect(r.headers['x-messages-has-more']).toBe('true')
  })
})
