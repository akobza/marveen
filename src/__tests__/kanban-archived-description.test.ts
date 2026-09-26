// GET /api/kanban/archived returned every archived card WITHOUT its description:
// the SELECT named nine columns and `description` was not one of them. A missing
// key reads the same as an empty text -- `card.description` is undefined, and
// `c.get('description')` is None -- so every archived card looked empty,
// whatever it held. That is not hypothetical: a caller concluded from this
// response that an archived card's description was empty (0 B) and overwrote it
// with a PUT; whatever was there is gone, because nothing else keeps it. The
// dashboard's own read-only detail view reads `card.description` from this same
// response, so it showed an empty description for every archived card too.
//
// Pinned here:
//  - the description comes back, byte-equal with what was stored, and a card
//    without one comes back with "" -- the key is always there, so "empty" and
//    "not returned" can no longer look the same;
//  - `q` finds an archived card by its id (it searched title, project and
//    assignee only) and by its description, so a search run before opening a
//    new card sees work that only an archived card's description still holds;
//  - archived-only is unchanged: an open card never comes back from here;
//  - the list is gzip-capable like GET /api/kanban, since the descriptions make
//    it large.
import { describe, it, expect, beforeEach } from 'vitest'
import { Readable } from 'node:stream'
import { gunzipSync } from 'node:zlib'
import { initDatabase, getDb } from '../db.js'
import { tryHandleKanban } from '../web/routes/kanban.js'
import type { RouteContext } from '../web/routes/types.js'

function fakeCtx(path: string, method: string, reqHeaders: Record<string, string> = {}) {
  const out: { status: number; body: any; headers: Record<string, string> } = { status: 0, body: null, headers: {} }
  const res: any = {
    writeHead(status: number, headers?: Record<string, string>) {
      out.status = status
      if (headers) for (const [k, v] of Object.entries(headers)) out.headers[k.toLowerCase()] = String(v)
      return res
    },
    end(chunk?: string | Buffer) {
      if (!chunk) return
      const raw = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      const text = out.headers['content-encoding'] === 'gzip' ? gunzipSync(raw).toString() : raw.toString()
      try { out.body = JSON.parse(text) } catch { out.body = text }
    },
  }
  const req: any = Readable.from([])
  req.headers = reqHeaders
  const url = new URL(`http://localhost:3420${path}`)
  const ctx = { req, res, path: url.pathname, method, url } as RouteContext
  return { ctx, out }
}

// Multi-line, accented, with a quote and a percent sign: the text must come back
// byte for byte, not merely "non-empty".
const WORK = 'ÁTVETT MARADÉK: a 42% -os "mérés" egyetlen példánya.\nMásodik sor.'
const ARCHIVED_WITH = 'ARCH0001'
const ARCHIVED_NULL = 'ARCH0002'
const ARCHIVED_EMPTY = 'ARCH0003'
const OPEN_CARD = 'OPEN0001'

function seed() {
  const now = Math.floor(Date.now() / 1000)
  const ins = getDb().prepare(
    'INSERT INTO kanban_cards (id, title, description, status, priority, sort_order, created_at, updated_at, archived_at)'
    + ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  )
  ins.run(ARCHIVED_WITH, 'Archivalt, leirassal', WORK, 'done', 'normal', 0, now, now, now - 30)
  ins.run(ARCHIVED_NULL, 'Archivalt, NULL leiras', null, 'done', 'normal', 1, now, now, now - 20)
  ins.run(ARCHIVED_EMPTY, 'Archivalt, ures leiras', '', 'done', 'normal', 2, now, now, now - 10)
  ins.run(OPEN_CARD, 'Nyitott lap', 'nyitott-lap-egyedi-szoveg', 'planned', 'normal', 3, now, now, null)
}

async function archived(query = ''): Promise<{ status: number; cards: any[] }> {
  const { ctx, out } = fakeCtx(`/api/kanban/archived${query}`, 'GET')
  expect(await tryHandleKanban(ctx)).toBe(true)
  return { status: out.status, cards: out.body?.cards ?? [] }
}

describe('GET /api/kanban/archived returns the description and searches it', () => {
  beforeEach(() => { initDatabase(':memory:'); seed() })

  it('returns the stored description byte for byte', async () => {
    const r = await archived()
    expect(r.status).toBe(200)
    const card = r.cards.find((c) => c.id === ARCHIVED_WITH)
    expect(card).toBeDefined()
    expect(card.description).toBe(WORK)
  })

  it('a card without a description carries "" -- the key is never missing', async () => {
    const r = await archived()
    for (const id of [ARCHIVED_NULL, ARCHIVED_EMPTY]) {
      const card = r.cards.find((c) => c.id === id)
      expect(card, id).toBeDefined()
      expect(Object.prototype.hasOwnProperty.call(card, 'description'), id).toBe(true)
      expect(card.description, id).toBe('')
    }
  })

  it('every returned card has the key, whatever it holds', async () => {
    const r = await archived()
    expect(r.cards.map((c) => c.id).sort()).toEqual([ARCHIVED_WITH, ARCHIVED_NULL, ARCHIVED_EMPTY].sort())
    expect(r.cards.every((c) => typeof c.description === 'string')).toBe(true)
  })

  it('q finds an archived card by its id, whole or partial', async () => {
    expect((await archived(`?q=${ARCHIVED_WITH}`)).cards.map((c) => c.id)).toEqual([ARCHIVED_WITH])
    expect((await archived('?q=ARCH000')).cards.map((c) => c.id).sort())
      .toEqual([ARCHIVED_WITH, ARCHIVED_NULL, ARCHIVED_EMPTY].sort())
  })

  it('q finds an archived card by text that only its description holds', async () => {
    const r = await archived(`?q=${encodeURIComponent('egyetlen példánya')}`)
    expect(r.cards.map((c) => c.id)).toEqual([ARCHIVED_WITH])
  })

  it('still archived-only: an open card is not returned, not even by its own id or text', async () => {
    expect((await archived(`?q=${OPEN_CARD}`)).cards).toEqual([])
    expect((await archived('?q=nyitott-lap-egyedi-szoveg')).cards).toEqual([])
    expect((await archived()).cards.some((c) => c.id === OPEN_CARD)).toBe(false)
  })

  it('a gzip-accepting client gets the list compressed, and it decodes to the same cards', async () => {
    const long = 'hosszu leiras '.repeat(300)
    getDb().prepare('UPDATE kanban_cards SET description = ? WHERE id = ?').run(long, ARCHIVED_EMPTY)
    const { ctx, out } = fakeCtx('/api/kanban/archived', 'GET', { 'accept-encoding': 'gzip' })
    expect(await tryHandleKanban(ctx)).toBe(true)
    expect(out.status).toBe(200)
    expect(out.headers['content-encoding']).toBe('gzip')
    expect(out.body.cards.find((c: any) => c.id === ARCHIVED_EMPTY).description).toBe(long)
    expect(out.body.cards.find((c: any) => c.id === ARCHIVED_WITH).description).toBe(WORK)
  })

  it('the old search fields still match (title, assignee)', async () => {
    getDb().prepare('UPDATE kanban_cards SET assignee = ? WHERE id = ?').run('egy-felelos', ARCHIVED_NULL)
    expect((await archived('?q=NULL%20leiras')).cards.map((c) => c.id)).toEqual([ARCHIVED_NULL])
    expect((await archived('?q=egy-felelos')).cards.map((c) => c.id)).toEqual([ARCHIVED_NULL])
  })
})
