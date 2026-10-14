// Card f3007079: the kanban comment POST answers with a homoglyph_warning when the stored text carries a lookalike
// letter, in the same field and shape as the daily log, the memories and the agent messages. Warn only: the comment
// is stored unchanged, and a clean text answers as before, without the field. A comment cannot be edited afterwards,
// so the warning in the answer is the writer's one chance to post a corrected follow-up; the AFTER INSERT trigger
// keeps logging the finding as before.
import { describe, it, expect, beforeEach } from 'vitest'
import { Readable } from 'node:stream'
import { initDatabase, getDb } from '../db.js'
import { tryHandleKanban } from '../web/routes/kanban.js'
import { detectHomoglyphs, formatHomoglyphWarning } from '../homoglyph.js'
import type { RouteContext } from '../web/routes/types.js'

function fakeCtx(path: string, method: string, body?: unknown) {
  const out: { status: number; body: any } = { status: 0, body: null }
  const res: any = {
    writeHead(status: number) { out.status = status; return res },
    end(chunk?: string | Buffer) {
      if (chunk) { const s = chunk.toString(); try { out.body = JSON.parse(s) } catch { out.body = s } }
    },
  }
  const payload = body === undefined ? '' : JSON.stringify(body)
  const req: any = Readable.from(payload ? [Buffer.from(payload)] : [])
  req.headers = {}
  const url = new URL(`http://localhost:3420${path}`)
  const ctx = { req, res, path: url.pathname, method, url } as RouteContext
  return { ctx, out }
}

async function call(path: string, method: string, body?: unknown) {
  const { ctx, out } = fakeCtx(path, method, body)
  expect(await tryHandleKanban(ctx)).toBe(true)
  return out
}

const CARD = 'LIVE0001'
// Built at runtime, so this source file carries no lookalike letter itself.
const CYRILLIC_A = String.fromCodePoint(0x0430)
const MIXED = `a lap c${CYRILLIC_A}rd azonositoja`
const CLEAN = 'a lap card azonositoja, ekezettel: arvizturo tukorfurogep, árvíztűrő'

const stored = (id: number) =>
  (getDb().prepare('SELECT content, automated FROM kanban_comments WHERE id = ?').get(id) as { content: string; automated: number })

describe('kanban comment POST: a lookalike letter is warned about in the answer, the comment is stored unchanged', () => {
  beforeEach(() => {
    initDatabase(':memory:')
    const now = Math.floor(Date.now() / 1000)
    getDb().prepare(
      'INSERT INTO kanban_cards (id, title, status, priority, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(CARD, 'Elo lap', 'in_progress', 'normal', 0, now, now)
  })

  it('a Cyrillic a: 200, homoglyph_warning in the daily-log shape (code point, not the letter), the row unchanged', async () => {
    const out = await call(`/api/kanban/${CARD}/comments`, 'POST', { author: 'teszt', content: MIXED })
    expect(out.status).toBe(200)
    expect(typeof out.body.id).toBe('number')
    expect(out.body.homoglyph_warning).toBe(formatHomoglyphWarning(detectHomoglyphs(MIXED)))
    expect(out.body.homoglyph_warning).toContain('U+0430 (CYRILLIC)')
    expect(out.body.homoglyph_warning.includes(CYRILLIC_A)).toBe(false)
    expect(stored(out.body.id).content).toBe(MIXED)
  })

  it('the answer still carries every field of the stored comment', async () => {
    const out = await call(`/api/kanban/${CARD}/comments`, 'POST', { author: 'teszt', content: MIXED })
    expect(out.body).toMatchObject({ card_id: CARD, author: 'teszt', content: MIXED, automated: 0 })
    expect(typeof out.body.created_at).toBe('number')
  })

  it('an automated comment is warned the same way and keeps its automated mark', async () => {
    const out = await call(`/api/kanban/${CARD}/comments`, 'POST', { author: 'gep', content: MIXED, automated: true })
    expect(out.status).toBe(200)
    expect(out.body.homoglyph_warning).toContain('U+0430 (CYRILLIC)')
    expect(stored(out.body.id).automated).toBe(1)
  })

  it('NEGATIVE CONTROL: a clean comment (Hungarian accents included) answers without the field', async () => {
    const out = await call(`/api/kanban/${CARD}/comments`, 'POST', { author: 'teszt', content: CLEAN })
    expect(out.status).toBe(200)
    expect('homoglyph_warning' in out.body).toBe(false)
    expect(stored(out.body.id).content).toBe(CLEAN)
  })
})
