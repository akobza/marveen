// The comment POST refused a card that does not exist (404) and let an ARCHIVED
// card through: getKanbanCard does not filter archived rows. A comment posted
// there came back with an id -- the caller saw success -- and landed on a card
// nobody looks at any more. Measured on a live board: 124 comments on 49
// archived cards, written after the archival, every one of them by an agent.
// The GET had the mirror defect: an id that does not exist answered 200 with
// [], the same answer as "exists, no comments yet", so the status said nothing.
//
// Pinned here:
//  - POST to an archived card: 409, nothing stored, and a message that differs
//    from the not-found one -- the two cases need different next steps (a typo
//    against work that moved on);
//  - POST to a card that does not exist: still 404;
//  - GET for an id that does not exist: 404; for an existing card without
//    comments: 200 and []; for an ARCHIVED card: 200 and its comments, because
//    the dashboard's archived detail view reads them;
//  - POSITIVE CONTROL: a live card still takes a comment.
import { describe, it, expect, beforeEach } from 'vitest'
import { Readable } from 'node:stream'
import { initDatabase, getDb } from '../db.js'
import { tryHandleKanban } from '../web/routes/kanban.js'
import type { RouteContext } from '../web/routes/types.js'

function fakeCtx(path: string, method: string, body?: unknown) {
  const out: { status: number; body: any } = { status: 0, body: null }
  const res: any = {
    writeHead(status: number) { out.status = status; return res },
    end(chunk?: string | Buffer) {
      if (chunk) { const s = chunk.toString(); try { out.body = JSON.parse(s) } catch { out.body = s } }
    },
  }
  // readBody() consumes the request through the stream events: a real Readable.
  const payload = body === undefined ? '' : JSON.stringify(body)
  const req: any = Readable.from(payload ? [Buffer.from(payload)] : [])
  req.headers = {}
  const url = new URL(`http://localhost:3420${path}`)
  const ctx = { req, res, path: url.pathname, method, url } as RouteContext
  return { ctx, out }
}

const LIVE = 'LIVE0001'
const ARCHIVED = 'ARCH0001'
const MISSING = 'NINCS001'

function seed() {
  const now = Math.floor(Date.now() / 1000)
  const ins = getDb().prepare(
    'INSERT INTO kanban_cards (id, title, status, priority, sort_order, created_at, updated_at, archived_at)'
    + ' VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  )
  ins.run(LIVE, 'Elo lap', 'in_progress', 'normal', 0, now, now, null)
  ins.run(ARCHIVED, 'Archivalt lap', 'done', 'normal', 1, now - 100, now - 100, now - 50)
  getDb().prepare('INSERT INTO kanban_comments (card_id, author, content, created_at) VALUES (?, ?, ?, ?)')
    .run(ARCHIVED, 'teszt', 'az archivalas elotti komment', now - 60)
}

const commentCount = (id: string) =>
  (getDb().prepare('SELECT count(*) AS n FROM kanban_comments WHERE card_id = ?').get(id) as { n: number }).n

async function call(path: string, method: string, body?: unknown) {
  const { ctx, out } = fakeCtx(path, method, body)
  expect(await tryHandleKanban(ctx)).toBe(true)
  return out
}

describe('kanban comments: an archived card refuses new ones, a missing card is a 404 on both verbs', () => {
  beforeEach(() => { initDatabase(':memory:'); seed() })

  it('POST to an archived card is refused with 409, and nothing is stored', async () => {
    const before = commentCount(ARCHIVED)
    const out = await call(`/api/kanban/${ARCHIVED}/comments`, 'POST', { author: 'teszt', content: 'kesoi komment' })
    expect(out.status).toBe(409)
    expect(out.body.archived).toBe(true)
    expect(typeof out.body.archived_at).toBe('number')
    expect(commentCount(ARCHIVED)).toBe(before)
  })

  it('the archived answer differs from the not-found answer, and says what to do instead', async () => {
    const archived = await call(`/api/kanban/${ARCHIVED}/comments`, 'POST', { author: 'teszt', content: 'x' })
    const missing = await call(`/api/kanban/${MISSING}/comments`, 'POST', { author: 'teszt', content: 'x' })
    expect(missing.status).toBe(404)
    expect(archived.status).not.toBe(missing.status)
    expect(archived.body.error).not.toBe(missing.body.error)
    expect(archived.body.error).toContain('archivált')
    expect(archived.body.error).toContain(`/api/kanban/${ARCHIVED}/unarchive`)
    expect(missing.body.error).toContain('nem található')
    expect(missing.body.archived).toBeUndefined()
    expect(commentCount(MISSING)).toBe(0)
  })

  it('POZITÍV KONTROLL: a live card still takes a comment', async () => {
    const out = await call(`/api/kanban/${LIVE}/comments`, 'POST', { author: 'teszt', content: 'elo komment' })
    expect(out.status).toBe(200)
    expect(typeof out.body.id).toBe('number')
    expect(commentCount(LIVE)).toBe(1)
  })

  it('GET for an id that does not exist answers 404, not an empty list', async () => {
    const out = await call(`/api/kanban/${MISSING}/comments`, 'GET')
    expect(out.status).toBe(404)
    expect(Array.isArray(out.body)).toBe(false)
    expect(out.body.error).toContain(MISSING)
  })

  it('POZITÍV KONTROLL: GET for an existing card without comments is still 200 and []', async () => {
    const out = await call(`/api/kanban/${LIVE}/comments`, 'GET')
    expect(out.status).toBe(200)
    expect(out.body).toEqual([])
  })

  it('GET for an archived card still returns its comments -- the archived detail view reads them', async () => {
    const out = await call(`/api/kanban/${ARCHIVED}/comments`, 'GET')
    expect(out.status).toBe(200)
    expect(out.body.map((c: any) => c.content)).toEqual(['az archivalas elotti komment'])
  })
})
