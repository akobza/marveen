// Every successful /api/schedules write leaves a server-side log row (card ffc45c28, decision (b)).
//
// The self-pace gate sees a sub-agent's schedule write only in the Bash command text; a write sent from inside a
// script reaches the API unseen. The decision keeps that limit
// and records every write on the server, so a schedule audit can compare the schedules it finds with who
// wrote them. The caller's X-Agent-Id is stored as a CLAIM (one shared token: self-asserted, never authenticated).
// Nothing secret goes in: no prompt, no cron, no token; for an update only the names of the fields sent.
//
// SANDBOX: os.homedir() reads $HOME and SCHEDULED_TASKS_DIR is fixed at import, so HOME points at a throwaway
// directory BEFORE any module that reaches scheduled-tasks-io is imported (the schedule-once.test.ts pattern).

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const tmpHome = mkdtempSync(join(tmpdir(), 'schedule-write-log-home-'))
const realHome = process.env.HOME
process.env.HOME = tmpHome

let io: typeof import('../web/scheduled-tasks-io.js')
let route: typeof import('../web/routes/schedules.js')
let db: typeof import('../db.js')

beforeAll(async () => {
  io = await import('../web/scheduled-tasks-io.js')
  route = await import('../web/routes/schedules.js')
  db = await import('../db.js')
  db.initDatabase(':memory:')
})
afterAll(() => {
  process.env.HOME = realHome
  rmSync(tmpHome, { recursive: true, force: true })
})

const PROMPT_MARK = 'PROMPT-TORZS-NE-KERULJON-A-NAPLOBA'
const TOKEN_MARK = 'TOKEN-NE-KERULJON-A-NAPLOBA'
const CRON = '17 4 22 9 *'

beforeEach(() => {
  rmSync(io.SCHEDULED_TASKS_DIR, { recursive: true, force: true })
  db.getDb().exec('DELETE FROM schedule_write_log')
})

type Auth = { kind: 'token' | 'session'; agent?: string; user?: string } | undefined
const AGENT: Auth = { kind: 'token', agent: 'agent-a' }

function fakeCtx(method: string, path: string, body: unknown, auth: Auth) {
  const req = new EventEmitter() as never as import('../web/routes/types.js').RouteContext['req'] & { destroy(): void }
  ;(req as unknown as { headers: Record<string, string> }).headers = { authorization: `Bearer ${TOKEN_MARK}`, 'x-agent-id': 'agent-a' }
  ;(req as { destroy(): void }).destroy = () => {}
  const state = { statusCode: 0, body: '' }
  const res = {
    writeHead(code: number) { state.statusCode = code; return res },
    end(data?: unknown) { state.body = String(data ?? '') },
    setHeader() {},
  } as never
  process.nextTick(() => {
    ;(req as unknown as EventEmitter).emit('data', Buffer.from(JSON.stringify(body ?? {})))
    ;(req as unknown as EventEmitter).emit('end')
  })
  // the router hands the route the pathname; the query string lives only on url (as in the server)
  const url = new URL(`http://localhost${path}`)
  return { ctx: { req, res, path: url.pathname, method, url, fedPeer: null, auth } as never, state }
}
// NO_AUTH: an explicit undefined would trigger the default parameter, so the no-context case needs its own marker
const NO_AUTH = 'no-auth-context' as const
async function call(method: string, path: string, body: unknown = {}, auth: Auth | typeof NO_AUTH = AGENT) {
  const { ctx, state } = fakeCtx(method, path, body, auth === NO_AUTH ? undefined : auth)
  expect(await route.tryHandleSchedules(ctx)).toBe(true)
  return state
}
const rows = () => db.getDb().prepare('SELECT * FROM schedule_write_log ORDER BY id').all() as Array<Record<string, unknown>>
function fixture(name: string) {
  mkdirSync(join(io.SCHEDULED_TASKS_DIR, name), { recursive: true })
  writeFileSync(join(io.SCHEDULED_TASKS_DIR, name, 'SKILL.md'), `---\nname: ${name}\ndescription: fixture\n---\n\nrun it\n`)
  writeFileSync(join(io.SCHEDULED_TASKS_DIR, name, 'task-config.json'), JSON.stringify({ schedule: CRON, agent: 'proba-ugynok', enabled: true }, null, 2))
}

describe('every successful /api/schedules write is logged', () => {
  it('the sandbox holds', () => {
    expect(io.SCHEDULED_TASKS_DIR.startsWith(tmpHome)).toBe(true)
  })

  it('create: the op, the task name, the CLAIMED agent and the auth kind', async () => {
    const before = Math.floor(Date.now() / 1000)
    expect((await call('POST', '/api/schedules', { name: 'uj-ebreszto', prompt: PROMPT_MARK, schedule: CRON, agent: 'proba-ugynok' })).statusCode).toBe(200)
    expect(rows()).toEqual([expect.objectContaining({ op: 'create', task_name: 'uj-ebreszto', claimed_agent: 'agent-a', auth_kind: 'token', fields: null, enabled: null })])
    expect(rows()[0].created_at as number).toBeGreaterThanOrEqual(before)
  })

  it('update: the names of the fields sent, never their values', async () => {
    fixture('frissitett')
    expect((await call('PUT', '/api/schedules/frissitett', { schedule: CRON, prompt: PROMPT_MARK, enabled: false })).statusCode).toBe(200)
    expect(rows()).toEqual([expect.objectContaining({ op: 'update', task_name: 'frissitett', fields: JSON.stringify(['enabled', 'prompt', 'schedule']) })])
  })

  it('update: a field name outside the known set is recorded as "(other)", not by its text', async () => {
    fixture('idegen-mezo')
    expect((await call('PUT', '/api/schedules/idegen-mezo', { [PROMPT_MARK]: 1, once: true })).statusCode).toBe(200)
    expect(rows()[0].fields).toBe(JSON.stringify(['(other)', 'once']))
  })

  it('toggle: the state it switched to', async () => {
    fixture('kapcsolt')
    await call('POST', '/api/schedules/kapcsolt/toggle')
    await call('POST', '/api/schedules/kapcsolt/toggle')
    expect(rows().map(r => [r.op, r.task_name, r.enabled])).toEqual([['toggle', 'kapcsolt', 0], ['toggle', 'kapcsolt', 1]])
  })

  it('delete', async () => {
    fixture('torolt')
    expect((await call('DELETE', '/api/schedules/torolt')).statusCode).toBe(200)
    expect(rows()).toEqual([expect.objectContaining({ op: 'delete', task_name: 'torolt', claimed_agent: 'agent-a' })])
  })

  it('no prompt, no cron and no token reach the log, on any of the four writes', async () => {
    await call('POST', '/api/schedules', { name: 'mind-negy', prompt: PROMPT_MARK, schedule: CRON })
    await call('PUT', '/api/schedules/mind-negy', { prompt: PROMPT_MARK, schedule: CRON, description: PROMPT_MARK })
    await call('POST', '/api/schedules/mind-negy/toggle')
    await call('DELETE', '/api/schedules/mind-negy')
    const text = JSON.stringify(rows())
    expect(rows().map(r => r.op)).toEqual(['create', 'update', 'toggle', 'delete'])
    for (const mark of [PROMPT_MARK, TOKEN_MARK, CRON]) expect(text.includes(mark)).toBe(false)
  })

  it('the claim follows the authenticated context, not the raw header: a session or an unclaimed call has none', async () => {
    await call('POST', '/api/schedules', { name: 'munkamenet', prompt: 'p', schedule: CRON }, { kind: 'session', user: 'admin' })
    await call('POST', '/api/schedules', { name: 'nevtelen', prompt: 'p', schedule: CRON }, { kind: 'token' })
    await call('POST', '/api/schedules', { name: 'kontextus-nelkul', prompt: 'p', schedule: CRON }, NO_AUTH)
    expect(rows().map(r => [r.task_name, r.claimed_agent, r.auth_kind])).toEqual([
      ['munkamenet', null, 'session'], ['nevtelen', null, 'token'], ['kontextus-nelkul', null, null],
    ])
  })
})

describe('NEGATIVE CONTROLS: a refused write or a read leaves no row', () => {
  it('a refused create, update, toggle and delete', async () => {
    fixture('mar-van')
    expect((await call('POST', '/api/schedules', { name: 'mar-van', prompt: 'p', schedule: CRON })).statusCode).toBe(409)
    expect((await call('POST', '/api/schedules', { name: 'rossz-cron', prompt: 'p', schedule: 'nem cron' })).statusCode).toBe(400)
    expect((await call('PUT', '/api/schedules/nincs-ilyen', { enabled: false })).statusCode).toBe(404)
    expect((await call('PUT', '/api/schedules/mar-van', { once: 'igen' })).statusCode).toBe(400)
    expect((await call('POST', '/api/schedules/nincs-ilyen/toggle')).statusCode).toBe(404)
    expect((await call('DELETE', '/api/schedules/nincs-ilyen')).statusCode).toBe(404)
    expect(rows()).toEqual([])
  })

  it('a read', async () => {
    fixture('olvasott')
    await call('GET', '/api/schedules')
    await call('GET', '/api/schedules/olvasott/runs')
    expect(rows()).toEqual([])
  })
})

describe('a failed log write never fails the schedule write', () => {
  it('without the table the create still answers 200 and the task exists', async () => {
    const d = db.getDb()
    d.exec('ALTER TABLE schedule_write_log RENAME TO schedule_write_log_kint')
    try {
      expect((await call('POST', '/api/schedules', { name: 'naplo-nelkul', prompt: 'p', schedule: CRON })).statusCode).toBe(200)
      expect(io.readScheduledTask('naplo-nelkul')).not.toBeNull()
    } finally {
      d.exec('ALTER TABLE schedule_write_log_kint RENAME TO schedule_write_log')
    }
  })
})

describe('GET /api/schedules/write-log: the audit reads it here', () => {
  it('newest first, with since and limit, and says the agent is a claim', async () => {
    for (const n of ['elso', 'masodik', 'harmadik']) await call('POST', '/api/schedules', { name: n, prompt: 'p', schedule: CRON })
    const all = JSON.parse((await call('GET', '/api/schedules/write-log')).body) as { note: string; rows: Array<{ task_name: string }> }
    expect(all.rows.map(r => r.task_name)).toEqual(['harmadik', 'masodik', 'elso'])
    expect(all.note).toMatch(/self-asserted/)
    const one = JSON.parse((await call('GET', '/api/schedules/write-log?limit=1')).body) as { rows: unknown[] }
    expect(one.rows).toHaveLength(1)
    const future = Math.floor(Date.now() / 1000) + 3600
    const none = JSON.parse((await call('GET', `/api/schedules/write-log?since=${future}`)).body) as { rows: unknown[] }
    expect(none.rows).toEqual([])
  })

  it('a malformed since or limit is refused, not silently widened', async () => {
    expect((await call('GET', '/api/schedules/write-log?since=tegnap')).statusCode).toBe(400)
    expect((await call('GET', '/api/schedules/write-log?limit=0')).statusCode).toBe(400)
    expect((await call('GET', '/api/schedules/write-log?limit=abc')).statusCode).toBe(400)
  })

  it('reading the log is not itself logged', async () => {
    await call('GET', '/api/schedules/write-log')
    expect(rows()).toEqual([])
  })
})
