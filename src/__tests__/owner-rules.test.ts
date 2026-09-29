/**
 * Owner rules (src/owner-rules.ts, /api/owner-rules): one source for the owners' standing rules and decisions.
 *
 * Pinned here, against a real in-memory SQLite and the real route:
 *  - a rule write (create, revoke, import) needs the owner-rules write token, whose sha256 alone is configured; without
 *    it the dashboard token is refused (403), without the configured hash every write is (503), and the write's actor
 *    is the one the token is bound to, never the body's;
 *  - every write leaves an event (actor, auth kind, hash), and the unified audit log shows who and when;
 *  - a rule is never deleted, only revoked with its source; a revocation is final, even around the API;
 *  - the view file is generated: any hand change to it, anywhere in the file, is copied aside, overwritten AND alerted;
 *  - the import takes the hand-written file as it really is (fixtures/owner-rules-shape-twin.md has the line shapes of
 *    the real rules file, with neutral text and made-up ids): every line is kept, what a rule lacks is marked to
 *    complete, and the generated view carries every line of the file, the bullets in order.
 * The real rules file itself is internal data and never lands in this repo; the opt-in suite at the end imports it when
 * OWNER_RULES_REAL_FILE points to a copy.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { Readable } from 'node:stream'

const H = vi.hoisted(() => {
  const dir = `${process.env.TMPDIR || '/tmp'}/owner-rules-test-${process.pid}-${Date.now()}`
  return { dir, viewPath: `${dir}/rules-view.md`, storeDir: `${dir}/store`, tokenSha256: '' }
})

vi.mock('../config.js', async () => {
  const actual = await vi.importActual<typeof import('../config.js')>('../config.js')
  return {
    ...actual,
    MAIN_AGENT_ID: 'agent-main',
    OWNER_RULES_VIEW_PATH: H.viewPath,
    STORE_DIR: H.storeDir,
    ownerRulesWriteTokenSha256: () => H.tokenSha256,
  }
})

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}))

import { getDb, initDatabase, queryAuditLog } from '../db.js'
import { tryHandleOwnerRules } from '../web/routes/owner-rules.js'
import {
  bulletLines,
  checkOwnerRulesWriteToken,
  checkViewFile,
  listOwnerRules,
  ownerRuleToComplete,
  parseOwnerRulesMarkdown,
  writeOwnerRulesView,
} from '../owner-rules.js'
import type { RouteContext } from '../web/routes/types.js'

const TWIN = readFileSync(new URL('./fixtures/owner-rules-shape-twin.md', import.meta.url), 'utf8')
const BACKUP_DIR = join(H.storeDir, 'owner-rules-view-backups')
const OWNER = { owner_chat_id: '1001', owner_label: 'Tulajdonos A' }

// The raw write token exists only in this process: generated per test, never written down; the config gets its hash.
let TOKEN = ''

async function call(path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: any }> {
  const url = new URL(`http://localhost:3420${path}`)
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]) as any
  req.headers = headers
  let statusCode = 200
  let responseBody = ''
  const res = {
    writeHead: (code: number) => { statusCode = code },
    end: (b?: string) => { responseBody = b || '' },
  }
  const ctx: RouteContext = { req, res: res as any, path: url.pathname, method, url, auth: { kind: 'token' } }
  const handled = await tryHandleOwnerRules(ctx)
  expect(handled).toBe(true)
  return { status: statusCode, body: responseBody ? JSON.parse(responseBody) : null }
}

/** A rule write with the write token (the dashboard token is the ctx's auth, as for every call here). */
function write(path: string, body: unknown, token = TOKEN) {
  return call(path, 'POST', body, { 'x-owner-rules-token': token })
}

const RULE = {
  owner_chat_id: '1001',
  owner_label: 'Tulajdonos A',
  rule: 'A heti riport hétfőn reggel megy.',
  source: 'tg 101',
  decided_on: '2026-09-01',
}

function systemAlerts(): string[] {
  return (getDb().prepare("SELECT content FROM agent_messages WHERE from_agent = 'system' AND to_agent = 'agent-main' ORDER BY id").all() as Array<{ content: string }>).map((r) => r.content)
}

function backups(): string[] {
  return existsSync(BACKUP_DIR) ? readdirSync(BACKUP_DIR) : []
}

/** The non-empty lines of a hand-written file after its frontmatter. */
function afterFrontmatter(text: string): string[] {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const end = lines[0] === '---' ? lines.indexOf('---', 1) : -1
  return lines.slice(end + 1).filter((l) => l.trim())
}

beforeEach(() => {
  TOKEN = randomBytes(32).toString('hex')
  H.tokenSha256 = createHash('sha256').update(TOKEN, 'utf8').digest('hex')
  initDatabase(':memory:')
  rmSync(H.dir, { recursive: true, force: true })
})

afterAll(() => {
  rmSync(H.dir, { recursive: true, force: true })
})

describe('owner rules API', () => {
  it('creates a rule with its create event; GET lists it as audited; the audit log shows the actor and the time', async () => {
    const created = await write('/api/owner-rules', RULE)
    expect(created.status).toBe(200)
    expect(created.body.ok).toBe(true)
    const list = await call('/api/owner-rules')
    expect(list.body.rules).toHaveLength(1)
    expect(list.body.rules[0]).toMatchObject({
      id: created.body.id, kind: 'rule', owner_chat_id: '1001', rule: RULE.rule, source: 'tg 101', decided_on: '2026-09-01',
      created_by: 'agent-main', audited: true, audit_problem: null, to_complete: [],
    })
    const audit = queryAuditLog({ sources: ['owner_rule'], limit: 10 })
    expect(audit).toHaveLength(1)
    expect(audit[0]).toMatchObject({ source: 'owner_rule', rule_id: created.body.id, event_type: 'create', actor: 'agent-main', auth_kind: 'owner-rules-token' })
    expect(audit[0].created_at).toBeGreaterThan(0)
  })

  it('refuses an invalid write with 400 and writes nothing', async () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ['no owner', { ...RULE, owner_chat_id: '' }],
      ['owner with a space', { ...RULE, owner_chat_id: '10 01' }],
      ['no rule', { ...RULE, rule: '  ' }],
      ['a two-line rule', { ...RULE, rule: 'első sor\nmásodik sor' }],
      ['no source', { ...RULE, source: '' }],
      ['a rolled-over date', { ...RULE, decided_on: '2026-02-30' }],
      ['not a date', { ...RULE, decided_on: '2026.09.01' }],
      ['validity reversed', { ...RULE, valid_from: '2026-10-02', valid_until: '2026-10-01' }],
    ]
    for (const [name, body] of cases) {
      const r = await write('/api/owner-rules', body)
      expect(r.status, name).toBe(400)
      expect(typeof r.body.error, name).toBe('string')
    }
    expect(listOwnerRules({ includeRevoked: true })).toHaveLength(0)
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM owner_rule_events').get()).toEqual({ n: 0 })
  })

  it('saves a rule with a look-alike letter and warns (the framework warns, never blocks)', async () => {
    const r = await write('/api/owner-rules', { ...RULE, rule: 'A riport hеtfőn megy.' })
    expect(r.status).toBe(200)
    expect(r.body.homoglyph_warning).toMatch(/homoglyph/)
    const clean = await write('/api/owner-rules', RULE)
    expect(clean.body.homoglyph_warning).toBeUndefined()
  })

  it('revokes with a source; a second revocation is 409, an unknown id 404, a revocation without a source 400', async () => {
    const { body } = await write('/api/owner-rules', RULE)
    expect((await write(`/api/owner-rules/${body.id}/revoke`, {})).status).toBe(400)
    const revoked = await write(`/api/owner-rules/${body.id}/revoke`, { source: 'tg 202' })
    expect(revoked.status).toBe(200)
    expect((await write(`/api/owner-rules/${body.id}/revoke`, { source: 'tg 203' })).status).toBe(409)
    expect((await write('/api/owner-rules/999/revoke', { source: 'tg 204' })).status).toBe(404)
    expect((await call('/api/owner-rules')).body.rules).toHaveLength(0)
    const all = (await call('/api/owner-rules?include_revoked=1')).body.rules
    expect(all).toHaveLength(1)
    expect(all[0]).toMatchObject({ revoked_source: 'tg 202', revoked_by: 'agent-main' })
    expect(all[0].revoked_at).toBeGreaterThan(0)
    const events = queryAuditLog({ sources: ['owner_rule'], limit: 10 }).map((e) => e.event_type).sort()
    expect(events).toEqual(['create', 'revoke'])
  })

  it('never deletes: DELETE is 405, a direct DELETE aborts, the event log cannot be changed', async () => {
    const { body } = await write('/api/owner-rules', RULE)
    expect((await call('/api/owner-rules', 'DELETE')).status).toBe(405)
    expect((await call(`/api/owner-rules/${body.id}/revoke`, 'GET')).status).toBe(405)
    const db = getDb()
    expect(() => db.prepare('DELETE FROM owner_rules WHERE id = ?').run(body.id)).toThrow(/revoke a rule/)
    expect(() => db.prepare("UPDATE owner_rule_events SET actor = 'someone-else'").run()).toThrow(/append-only/)
    expect(() => db.prepare('DELETE FROM owner_rule_events').run()).toThrow(/append-only/)
    expect(listOwnerRules()).toHaveLength(1)
  })
})

describe('owner rules write token', () => {
  const WRITES: Array<[string, (id: number) => [string, Record<string, unknown>]]> = [
    ['create', () => ['/api/owner-rules', RULE]],
    ['revoke', (id) => [`/api/owner-rules/${id}/revoke`, { source: 'tg 202' }]],
    ['import', () => ['/api/owner-rules/import', { markdown: TWIN, ...OWNER, owner_chat_id: '1002', dry_run: false }]],
  ]

  it('NEGATIVE: the dashboard token alone, or a wrong write token, is 403 on every write endpoint, and nothing is written', async () => {
    const { body } = await write('/api/owner-rules', RULE)
    const rowsBefore = listOwnerRules({ includeRevoked: true, includeNotes: true })
    for (const [name, make] of WRITES) {
      const [path, payload] = make(body.id)
      const bare = await call(path, 'POST', payload)
      expect(bare.status, name).toBe(403)
      expect(bare.body.error, name).toMatch(/x-owner-rules-token/)
      const wrong = await write(path, payload, randomBytes(32).toString('hex'))
      expect(wrong.status, name).toBe(403)
    }
    expect(listOwnerRules({ includeRevoked: true, includeNotes: true })).toEqual(rowsBefore)
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM owner_rule_events').get()).toEqual({ n: 1 })
  })

  it('NEGATIVE: without the configured hash (or with one that is not a sha256 digest) every write is refused, even with the token', async () => {
    const { body } = await write('/api/owner-rules', RULE)
    for (const configured of ['', 'not-a-digest', H.tokenSha256.slice(1)]) {
      H.tokenSha256 = configured
      for (const [name, make] of WRITES) {
        const [path, payload] = make(body.id)
        const r = await write(path, payload)
        expect(r.status, `${name} with ${JSON.stringify(configured.slice(0, 8))}`).toBe(503)
        expect(r.body.error).toMatch(/OWNER_RULES_WRITE_TOKEN_SHA256/)
      }
    }
    expect(listOwnerRules({ includeRevoked: true, includeNotes: true })).toHaveLength(1)
    expect(listOwnerRules()).toHaveLength(1)
  })

  it('with the right token every write is 200, and it writes as the actor the token is bound to; a body naming another actor is 403', async () => {
    const created = await write('/api/owner-rules', { ...RULE, actor: 'agent-main' })
    expect(created.status).toBe(200)
    const other = await write('/api/owner-rules', { ...RULE, actor: 'fejleszto' })
    expect(other.status).toBe(403)
    expect(other.body.error).toMatch(/writes as agent-main/)
    expect((await write(`/api/owner-rules/${created.body.id}/revoke`, { source: 'tg 202', actor: 'someone' })).status).toBe(403)
    expect((await write(`/api/owner-rules/${created.body.id}/revoke`, { source: 'tg 202' })).status).toBe(200)
    expect((await write('/api/owner-rules/import', { markdown: TWIN, ...OWNER, owner_chat_id: '1002', dry_run: false })).status).toBe(200)
    const actors = queryAuditLog({ sources: ['owner_rule'], limit: 100 }).map((e) => `${e.actor}/${e.auth_kind}`)
    expect(new Set(actors)).toEqual(new Set(['agent-main/owner-rules-token']))
    expect(new Set(listOwnerRules({ includeRevoked: true, includeNotes: true }).map((r) => r.created_by))).toEqual(new Set(['agent-main']))
  })

  it('reading and regenerating the view stay on the dashboard token', async () => {
    await write('/api/owner-rules', RULE)
    expect((await call('/api/owner-rules')).status).toBe(200)
    expect((await call('/api/owner-rules/view', 'POST', {})).status).toBe(200)
  })

  it('the check compares the digests: an upper-case hex hash matches, the raw token configured in place of its hash opens nothing', () => {
    expect(checkOwnerRulesWriteToken(TOKEN, H.tokenSha256.toUpperCase())).toEqual({ ok: true })
    expect(checkOwnerRulesWriteToken(TOKEN, TOKEN)).toMatchObject({ ok: false, status: 403 })
    expect(checkOwnerRulesWriteToken(undefined, H.tokenSha256)).toMatchObject({ ok: false, status: 403 })
    expect(checkOwnerRulesWriteToken([TOKEN, TOKEN], H.tokenSha256)).toMatchObject({ ok: false, status: 403 })
  })
})

describe('owner rules view', () => {
  it('is written after each write; a revoked rule leaves the view and stays in the table with its revocation source', async () => {
    const a = await write('/api/owner-rules', RULE)
    await write('/api/owner-rules', { ...RULE, rule: 'A számla péntekig megy ki.', source: 'card 0a1b2c3d', decided_on: '2026-09-02' })
    expect(a.body.view).toMatchObject({ written: true, path: H.viewPath })
    let view = readFileSync(H.viewPath, 'utf8')
    expect(view).toMatch(/^---\nname: rules-view\n/)
    expect(view).toMatch(/<!-- owner-rules-view: .* file-sha256: [0-9a-f]{64} -->/)
    expect(checkViewFile(view)).toBe('intact')
    expect(view).toContain('## Tulajdonos A (1001)')
    expect(view).toContain('- A heti riport hétfőn reggel megy. (tg 101, 2026-09-01)')
    expect(view).toContain('- A számla péntekig megy ki. (card 0a1b2c3d, 2026-09-02)')
    await write(`/api/owner-rules/${a.body.id}/revoke`, { source: 'tg 202' })
    view = readFileSync(H.viewPath, 'utf8')
    expect(view).not.toContain('A heti riport')
    expect(view).toContain('A számla péntekig')
    expect(listOwnerRules({ includeRevoked: true }).find((r) => r.id === a.body.id)).toMatchObject({ revoked_source: 'tg 202' })
  })

  it('NEGATIVE: any hand change to the view file, above, in or below its header, is copied aside, then overwritten AND alerted', async () => {
    await write('/api/owner-rules', RULE)
    expect(systemAlerts()).toHaveLength(0)
    const cases: Array<[string, (t: string) => string]> = [
      ['a bullet added below the header', (t) => t.replace('- A heti riport', '- KÉZZEL ÍRT SZABÁLY\n- A heti riport')],
      ['a bullet between the frontmatter and the header', (t) => t.replace('\n<!-- owner-rules-view:', '\n- KÉZZEL ÍRT SZABÁLY\n<!-- owner-rules-view:')],
      ['the frontmatter description rewritten', (t) => t.replace(/^description: .*$/m, 'description: "kézzel átírt leírás"')],
      ['the header text rewritten, its hash kept', (t) => t.replace('do not edit by hand', 'edit freely')],
      ['the header deleted and a bullet added', (t) => `${t.split('\n').filter((l) => !l.startsWith('<!-- owner-rules-view:')).join('\n')}- KÉZZEL ÍRT SZABÁLY\n`],
      ['saved with CRLF line endings', (t) => t.replace(/\n/g, '\r\n')],
      ['the old hand-written file put back', () => TWIN],
    ]
    for (const [name, edit] of cases) {
      const before = readFileSync(H.viewPath, 'utf8')
      const edited = edit(before)
      expect(edited, name).not.toBe(before)
      writeFileSync(H.viewPath, edited)
      const alertsBefore = systemAlerts().length
      const r = await call('/api/owner-rules/view', 'POST', {})
      expect(r.body.view.written, name).toBe(true)
      expect(r.body.view.manualEdit || r.body.view.replacedUnmanaged, name).toBe(true)
      // The hand-written content survives the overwrite, byte for byte, and the alert says where.
      expect(readFileSync(r.body.view.backupPath, 'utf8'), name).toBe(edited)
      expect(systemAlerts(), name).toHaveLength(alertsBefore + 1)
      expect(systemAlerts().at(-1), name).toMatch(/^\[OWNER-RULES\] the view file .* (was edited by hand|had no generator header)/)
      expect(systemAlerts().at(-1), name).toContain(r.body.view.backupPath)
      const regenerated = readFileSync(H.viewPath, 'utf8')
      expect(checkViewFile(regenerated), name).toBe('intact')
      expect(regenerated, name).not.toContain('KÉZZEL')
    }
    expect(backups()).toHaveLength(cases.length)
    // CONTROL: an untouched file regenerates without an alert and without a copy.
    const alerts = systemAlerts().length
    const quiet = await call('/api/owner-rules/view', 'POST', {})
    expect(quiet.body.view).toMatchObject({ written: true, manualEdit: false, replacedUnmanaged: false, backupPath: null })
    expect(systemAlerts()).toHaveLength(alerts)
    expect(backups()).toHaveLength(cases.length)
    // A deleted view file is simply written again: nothing to keep, nothing to alert.
    unlinkSync(H.viewPath)
    const again = await call('/api/owner-rules/view', 'POST', {})
    expect(again.body.view).toMatchObject({ written: true, backupPath: null })
    expect(systemAlerts()).toHaveLength(alerts)
  })

  it('NEGATIVE: a hand-edited file that cannot be copied aside is NOT overwritten, and the alert says so', async () => {
    await write('/api/owner-rules', RULE)
    const edited = readFileSync(H.viewPath, 'utf8').replace('- A heti riport', '- KÉZZEL ÍRT SZABÁLY\n- A heti riport')
    writeFileSync(H.viewPath, edited)
    const blocker = join(H.dir, 'not-a-directory')
    writeFileSync(blocker, 'a file where the backup directory should be')
    const alerts: string[] = []
    const r = writeOwnerRulesView({ path: H.viewPath, today: '2026-09-28', backupDir: blocker, alert: (m) => alerts.push(m) })
    expect(r).toMatchObject({ written: false, backupPath: null })
    expect(r.error).toMatch(/could not be copied aside/)
    expect(readFileSync(H.viewPath, 'utf8')).toBe(edited)
    expect(alerts).toHaveLength(1)
    expect(alerts[0]).toMatch(/NOT overwritten/)
  })

  it('a row written around the API is left out and alerted; a revocation written around the API keeps the rule and alerts', async () => {
    const { body } = await write('/api/owner-rules', RULE)
    const db = getDb()
    db.prepare(
      "INSERT INTO owner_rules (owner_chat_id, rule, source, decided_on, created_by, created_at) VALUES ('1001', 'CSEMPÉSZETT SZABÁLY', 'tg 999', '2026-09-03', 'x', 1)",
    ).run()
    db.prepare("UPDATE owner_rules SET revoked_at = 5, revoked_source = 'tg 998', revoked_by = 'x' WHERE id = ?").run(body.id)
    const r = await call('/api/owner-rules/view', 'POST', {})
    expect(r.body.view.anomalies.map((a: { kind: string }) => a.kind).sort()).toEqual(['unaudited-revocation', 'unaudited-rule'])
    const view = readFileSync(H.viewPath, 'utf8')
    expect(view).not.toContain('CSEMPÉSZETT')
    expect(view).toContain('A heti riport')
    expect(systemAlerts().at(-1)).toMatch(/2 owner rule row\(s\) failed the audit check/)
    // The API still reports the smuggled row as not audited.
    const listed = (await call('/api/owner-rules')).body.rules
    expect(listed.find((x: { rule: string }) => x.rule === 'CSEMPÉSZETT SZABÁLY')).toMatchObject({ audited: false, audit_problem: 'unaudited-rule' })
  })

  it('NEGATIVE: a revocation cannot be undone or changed around the API; the DB refuses it, and with the trigger gone the view still keeps the rule out and alerts', async () => {
    const { body } = await write('/api/owner-rules', RULE)
    await write(`/api/owner-rules/${body.id}/revoke`, { source: 'tg 202' })
    const db = getDb()
    expect(() => db.prepare('UPDATE owner_rules SET revoked_at = NULL, revoked_source = NULL, revoked_by = NULL WHERE id = ?').run(body.id)).toThrow(/revocation is final/)
    expect(() => db.prepare("UPDATE owner_rules SET revoked_source = 'tg 999' WHERE id = ?").run(body.id)).toThrow(/revocation is final/)
    expect(listOwnerRules({ includeRevoked: true })[0]).toMatchObject({ revoked_source: 'tg 202', revoked_by: 'agent-main' })
    // Around the trigger as well: dropped, the undo goes through, and the events still decide.
    db.exec('DROP TRIGGER owner_rules_revocation_final')
    db.prepare('UPDATE owner_rules SET revoked_at = NULL, revoked_source = NULL, revoked_by = NULL WHERE id = ?').run(body.id)
    const r = await call('/api/owner-rules/view', 'POST', {})
    expect(r.body.view.anomalies).toEqual([expect.objectContaining({ rule_id: body.id, kind: 'revocation-undone' })])
    expect(readFileSync(H.viewPath, 'utf8')).not.toContain('A heti riport')
    expect(systemAlerts().at(-1)).toMatch(/#\d+ revocation-undone/)
    const listed = (await call('/api/owner-rules')).body.rules
    expect(listed.find((x: { id: number }) => x.id === body.id)).toMatchObject({ audited: false, audit_problem: 'revocation-undone' })
  })

  it('shows a rule only inside its validity window', async () => {
    await write('/api/owner-rules', { ...RULE, rule: 'Még nem él.', valid_from: '2999-01-01' })
    await write('/api/owner-rules', { ...RULE, rule: 'Már lejárt.', valid_until: '2000-01-01' })
    await write('/api/owner-rules', { ...RULE, rule: 'Most él.', valid_from: '2000-01-01', valid_until: '2999-12-31' })
    const view = readFileSync(H.viewPath, 'utf8')
    expect(view).toContain('Most él.')
    expect(view).not.toContain('Még nem él.')
    expect(view).not.toContain('Már lejárt.')
  })

  it('writes nothing without a configured path', () => {
    const r = writeOwnerRulesView({ path: null, today: '2026-09-28' })
    expect(r).toMatchObject({ written: false, path: null })
    expect(existsSync(H.viewPath)).toBe(false)
  })
})

describe('owner rules import', () => {
  it('takes the real file shapes: a full stop after the source group, a bullet without a source group, a group without a date', () => {
    const parsed = parseOwnerRulesMarkdown(TWIN)
    const rules = parsed.filter((p) => p.kind === 'rule')
    expect(rules).toHaveLength(20)
    expect(parsed.filter((p) => p.kind !== 'rule').map((p) => [p.line, p.kind])).toEqual([[11, 'intro'], [34, 'outro']])
    expect(rules.filter((p) => p.source === null).map((p) => p.line)).toEqual([14, 22, 27, 30, 31])
    expect(rules.filter((p) => p.source !== null && p.decided_on === null).map((p) => p.line)).toEqual([16, 17, 18, 19, 20, 21, 23, 26, 28, 29, 32])
    expect(rules.filter((p) => ownerRuleToComplete(p).length === 0).map((p) => p.line)).toEqual([13, 15, 24, 25])
    expect(rules[0]).toMatchObject({ line: 13, source: 'tg 101, 2026-09-28', decided_on: '2026-09-28' })
    expect(rules[0].rule.endsWith('ami kívül esik, rossz')).toBe(true)
    // A source group that names no message or card id is kept, and marked to complete with the missing date.
    expect(ownerRuleToComplete(rules.find((p) => p.line === 21)!)).toEqual(['source', 'decided_on'])
    expect(ownerRuleToComplete(rules.find((p) => p.line === 16)!)).toEqual(['decided_on'])
    expect(ownerRuleToComplete(rules.find((p) => p.line === 14)!)).toEqual(['source', 'decided_on'])
    // Every row keeps its line as it stood.
    const lines = TWIN.split('\n')
    for (const p of parsed) expect(p.raw).toBe(lines[p.line - 1])
  })

  it('a dry run of the file: no problem, a full round trip, the lines to complete listed, nothing written', async () => {
    const dry = await write('/api/owner-rules/import', { markdown: TWIN, ...OWNER })
    expect(dry.status).toBe(200)
    expect(dry.body).toMatchObject({
      ok: true, dry_run: true, rules: 20, non_bullet_lines: 2, problems: [],
      round_trip: { bullets: 20, bullets_in_order: true, missing_lines: [] },
    })
    expect(dry.body.to_complete).toHaveLength(16)
    expect(dry.body.to_complete.find((t: { line: number }) => t.line === 14)).toEqual({ line: 14, missing: ['source', 'decided_on'] })
    expect(listOwnerRules({ includeRevoked: true, includeNotes: true })).toHaveLength(0)
    expect(existsSync(H.viewPath)).toBe(false)
  })

  it('imports every line: each bullet one rule with its source and date or NULL; the view carries every line of the file, the bullets in order', async () => {
    const done = await write('/api/owner-rules/import', { markdown: TWIN, ...OWNER, dry_run: false })
    expect(done.status).toBe(200)
    expect(done.body).toMatchObject({ ok: true, imported: 20, imported_text_lines: 2 })
    const rows = listOwnerRules({ includeRevoked: true })
    expect(rows).toHaveLength(bulletLines(TWIN).length)
    const parsedRules = parseOwnerRulesMarkdown(TWIN).filter((p) => p.kind === 'rule')
    expect(rows.map((r) => [r.source, r.decided_on])).toEqual(parsedRules.map((p) => [p.source, p.decided_on]))
    expect(listOwnerRules({ includeRevoked: true, includeNotes: true })).toHaveLength(22)
    expect(queryAuditLog({ sources: ['owner_rule'], limit: 100 })).toHaveLength(22)
    const view = readFileSync(H.viewPath, 'utf8')
    expect(checkViewFile(view)).toBe('intact')
    expect(bulletLines(view)).toEqual(bulletLines(TWIN))
    const viewLines = new Set(view.split('\n'))
    expect(afterFrontmatter(TWIN).filter((l) => !viewLines.has(l))).toEqual([])
    // The API lists the rules with what each still lacks; every row is audited.
    const listed = (await call('/api/owner-rules')).body.rules
    expect(listed).toHaveLength(20)
    expect(listed.filter((r: { to_complete: string[] }) => r.to_complete.length > 0)).toHaveLength(16)
    expect(listed.every((r: { audited: boolean }) => r.audited)).toBe(true)
    expect((await call('/api/owner-rules?include_notes=1')).body.rules.map((r: { kind: string }) => r.kind).filter((k: string) => k !== 'rule')).toEqual(['intro', 'outro'])
    // A second import would duplicate the owner's rules.
    expect((await write('/api/owner-rules/import', { markdown: TWIN, ...OWNER, dry_run: false })).status).toBe(409)
  })

  it('the first import over the hand-written file itself: the file is copied aside, the alert names the copy, the view carries every line', async () => {
    mkdirSync(dirname(H.viewPath), { recursive: true })
    writeFileSync(H.viewPath, TWIN)
    const r = await write('/api/owner-rules/import', { markdown: TWIN, ...OWNER, dry_run: false })
    expect(r.body.view).toMatchObject({ written: true, manualEdit: false, replacedUnmanaged: true })
    expect(readFileSync(r.body.view.backupPath, 'utf8')).toBe(TWIN)
    expect(systemAlerts()).toHaveLength(1)
    expect(systemAlerts()[0]).toContain(r.body.view.backupPath)
    const viewLines = new Set(readFileSync(H.viewPath, 'utf8').split('\n'))
    expect(afterFrontmatter(TWIN).filter((l) => !viewLines.has(l))).toEqual([])
  })

  it('the API format round-trips as well (no full stop after the group)', async () => {
    const apiFormat = '- A heti riport hétfőn reggel megy. (tg 101, 2026-09-01)\n- Két üzenetből jött szabály. (tg 102/103, 2026-09-02)\n'
    const dry = await write('/api/owner-rules/import', { markdown: apiFormat, ...OWNER })
    expect(dry.body).toMatchObject({ ok: true, problems: [], to_complete: [], round_trip: { bullets: 2, bullets_in_order: true, missing_lines: [] } })
  })

  it('NEGATIVE: a file without a bullet is a named 400 on a real import (not a 500), and a dry run reports the same; nothing is written', async () => {
    const noBullets = '---\nname: x\n---\n\nCsak bevezető, bullet nélkül.\n'
    const real = await write('/api/owner-rules/import', { markdown: noBullets, ...OWNER, dry_run: false })
    expect(real.status).toBe(400)
    expect(real.body.error).toMatch(/^import refused, nothing was written: no rule lines/)
    const dry = await write('/api/owner-rules/import', { markdown: noBullets, ...OWNER })
    expect(dry.body).toMatchObject({ ok: false, rules: 0 })
    expect(dry.body.problems).toEqual([{ line: null, problem: 'no rule lines: the file has no "- " bullet' }])
    expect(listOwnerRules({ includeRevoked: true, includeNotes: true })).toHaveLength(0)
  })

  it('refuses an empty bullet and a generated view as input, and writes nothing', async () => {
    const empty = await write('/api/owner-rules/import', { markdown: '- Rendes szabály. (tg 101, 2026-09-01)\n- (tg 102, 2026-09-02).\n', ...OWNER, dry_run: false })
    expect(empty.status).toBe(400)
    expect(empty.body.problems).toEqual([{ line: 2, problem: 'empty rule text' }])
    await write('/api/owner-rules', RULE)
    const generated = readFileSync(H.viewPath, 'utf8')
    const again = await write('/api/owner-rules/import', { markdown: generated, ...OWNER, owner_chat_id: '1002', dry_run: false })
    expect(again.status).toBe(400)
    expect(again.body.error).toMatch(/generated owner-rules view/)
    expect(listOwnerRules({ includeRevoked: true, includeNotes: true })).toHaveLength(1)
  })
})

// The real rules file is internal data: it never lands in this repo. Point OWNER_RULES_REAL_FILE at a copy to import it.
const REAL_FILE = process.env.OWNER_RULES_REAL_FILE
describe.skipIf(!REAL_FILE)('owner rules import, the real rules file (opt-in: OWNER_RULES_REAL_FILE=<copy>)', () => {
  it('imports every line of the real file, and the view carries every line after the frontmatter, the bullets in order', async () => {
    const real = readFileSync(REAL_FILE as string, 'utf8')
    const dry = await write('/api/owner-rules/import', { markdown: real, ...OWNER })
    expect(dry.body.problems).toEqual([])
    const done = await write('/api/owner-rules/import', { markdown: real, ...OWNER, dry_run: false })
    expect(done.status).toBe(200)
    expect(done.body.imported).toBe(bulletLines(real).length)
    expect(listOwnerRules({ includeRevoked: true })).toHaveLength(bulletLines(real).length)
    const view = readFileSync(H.viewPath, 'utf8')
    expect(bulletLines(view)).toEqual(bulletLines(real))
    const viewLines = new Set(view.split('\n'))
    expect(afterFrontmatter(real).filter((l) => !viewLines.has(l)).length).toBe(0)
  })
})
