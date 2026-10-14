// ffc45c28 (b2): the schedule write log names every field an update sent, by the list of fields the writer persists.
//
// Measured on a running install after the write log shipped: an update's fields read ["(other)"] when a one-shot tool
// set the recipient with {"telegramChatId": ...}. The known names came from the route's body
// type (ten), but the route hands the whole body to writeScheduledTask, which persists twenty: telegramChatId,
// command, channelProvider and seven more were hidden behind "(other)", the very fields the audit needs to see.
// The decision: the known names are the writer's fields from ONE constant; only names,
// never values; "(other)" only for a key the writer does not know; a guard that fails when the writer gets a field
// the constant does not list.
//
// SANDBOX: as schedule-write-log.test.ts, HOME points at a throwaway directory before scheduled-tasks-io is imported.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const tmpHome = mkdtempSync(join(tmpdir(), 'schedule-write-log-fields-home-'))
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
beforeEach(() => {
  rmSync(io.SCHEDULED_TASKS_DIR, { recursive: true, force: true })
  db.getDb().exec('DELETE FROM schedule_write_log')
})

function fakeCtx(method: string, path: string, body: unknown) {
  const req = new EventEmitter() as never as import('../web/routes/types.js').RouteContext['req'] & { destroy(): void }
  ;(req as unknown as { headers: Record<string, string> }).headers = { 'x-agent-id': 'agent-a' }
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
  const url = new URL(`http://localhost${path}`)
  return { ctx: { req, res, path: url.pathname, method, url, fedPeer: null, auth: { kind: 'token', agent: 'agent-a' } } as never, state }
}
async function put(name: string, body: Record<string, unknown>) {
  const { ctx, state } = fakeCtx('PUT', `/api/schedules/${name}`, body)
  expect(await route.tryHandleSchedules(ctx)).toBe(true)
  return state
}
const rows = () => db.getDb().prepare('SELECT * FROM schedule_write_log ORDER BY id').all() as Array<Record<string, unknown>>
function fixture(name: string) {
  mkdirSync(join(io.SCHEDULED_TASKS_DIR, name), { recursive: true })
  writeFileSync(join(io.SCHEDULED_TASKS_DIR, name, 'SKILL.md'), `---\nname: ${name}\ndescription: fixture\n---\n\nrun it\n`)
  writeFileSync(join(io.SCHEDULED_TASKS_DIR, name, 'task-config.json'), JSON.stringify({ schedule: '17 4 22 9 *', agent: 'proba-ugynok', enabled: true }, null, 2))
}

// The ten fields the (b) list hid, each with a value the log must never carry.
const HIDDEN_BEFORE: Record<string, unknown> = {
  command: 'echo PARANCS-ERTEK-NE-KERULJON-A-NAPLOBA',
  timeoutMs: 7654321,
  failThreshold: 7,
  preCheck: 'PRECHECK-ERTEK-NE-KERULJON-A-NAPLOBA',
  catchUpMaxAgeMinutes: 31,
  stuckAfterMinutes: 47,
  injectMetrics: true,
  sendDigestDirect: true,
  telegramChatId: 'CHATID-ERTEK-NE-KERULJON-A-NAPLOBA',
  channelProvider: 'telegram',
}
const VALUE_MARKS = ['PARANCS-ERTEK', 'PRECHECK-ERTEK', 'CHATID-ERTEK', '7654321']

describe('an update names every field the writer persists (b2)', () => {
  it('the sandbox holds', () => {
    expect(io.SCHEDULED_TASKS_DIR.startsWith(tmpHome)).toBe(true)
  })

  it('the ten fields the old list hid are each named, none is "(other)", and no value is in the row', async () => {
    fixture('rejtett-mezok')
    expect((await put('rejtett-mezok', HIDDEN_BEFORE)).statusCode).toBe(200)
    const [row] = rows()
    expect(row.op).toBe('update')
    expect([...JSON.parse(String(row.fields))].sort()).toEqual(Object.keys(HIDDEN_BEFORE).sort())
    const text = JSON.stringify(row)
    for (const v of VALUE_MARKS) expect(text.includes(v), v).toBe(false)
    // the writer did persist them: the names in the log are fields that changed, not just keys that came in
    const cfg = JSON.parse(readFileSync(join(io.SCHEDULED_TASKS_DIR, 'rejtett-mezok', 'task-config.json'), 'utf8'))
    expect(cfg.telegramChatId).toBe(HIDDEN_BEFORE.telegramChatId)
    expect(cfg.command).toBe(HIDDEN_BEFORE.command)
  })

  it('the live case: the one-shot tool\'s recipient PUT is logged as ["telegramChatId"]', async () => {
    fixture('egyszeri-hordozo')
    expect((await put('egyszeri-hordozo', { telegramChatId: 'none' })).statusCode).toBe(200)
    expect(JSON.parse(String(rows()[0].fields))).toEqual(['telegramChatId'])
  })

  it('a key the writer does not know is still "(other)", and its name is not stored', async () => {
    fixture('ismeretlen-kulcs')
    expect((await put('ismeretlen-kulcs', { telegramChatId: 'none', ISMERETLEN_KULCS_NEV: 1 })).statusCode).toBe(200)
    expect([...JSON.parse(String(rows()[0].fields))].sort()).toEqual(['(other)', 'telegramChatId'])
    expect(JSON.stringify(rows()[0]).includes('ISMERETLEN_KULCS_NEV')).toBe(false)
  })
})

// The guard: every field the writer touches is in SCHEDULED_TASK_WRITE_FIELDS, and the other way round. A field is
// one the writer reads from `data.<field>` OR writes as `config.<field> =` (a cast access such as
// `(data as Record<string, unknown>).x` escapes the first pattern, the config write still shows it); createdAt is the
// writer's own stamp, not a caller's field.
function writerFields(source: string): Set<string> {
  const start = source.indexOf('export function writeScheduledTask(')
  if (start < 0) throw new Error('writeScheduledTask not found')
  const end = source.indexOf('\n}\n', start)
  const body = source.slice(start, end)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').filter(l => !l.trim().startsWith('//')).join('\n')
  const read = [...body.matchAll(/\bdata\.([A-Za-z_]\w*)/g)].map(m => m[1])
  const written = [...body.matchAll(/\bconfig\.([A-Za-z_]\w*)\s*=(?!=)/g)].map(m => m[1])
  return new Set([...read, ...written].filter(f => f !== 'createdAt'))
}
// tsc guard as well: a field the writer's data type declares and the constant does not list fails the type check
type WriterField = keyof Parameters<typeof import('../web/scheduled-tasks-io.js')['writeScheduledTask']>[1]
type Listed = (typeof import('../web/scheduled-tasks-io.js'))['SCHEDULED_TASK_WRITE_FIELDS'][number]
type Unlisted = Exclude<WriterField, Listed>

describe('the field list follows the writer (b2 guard)', () => {
  const source = () => readFileSync(join(__dirname, '..', 'web', 'scheduled-tasks-io.ts'), 'utf8')

  it('the fields writeScheduledTask reads are exactly SCHEDULED_TASK_WRITE_FIELDS', () => {
    const read = writerFields(source())
    expect(read.size).toBeGreaterThanOrEqual(20)
    expect([...read].sort()).toEqual([...io.SCHEDULED_TASK_WRITE_FIELDS].sort())
  })

  it('KONTROLL: a field added to the writer and not to the list is found, in the plain and in a cast form', () => {
    const anchor = "  if (data.once !== undefined) config.once = data.once\n"
    for (const added of [
      "  if (data.ujMezo !== undefined) config.ujMezo = data.ujMezo\n",
      "  if ((data as Record<string, unknown>).ujMezo !== undefined) config.ujMezo = (data as Record<string, unknown>).ujMezo\n",
    ]) {
      const src = source().replace(anchor, anchor + added)
      expect(src).not.toBe(source())
      const unlisted = [...writerFields(src)].filter(f => !(io.SCHEDULED_TASK_WRITE_FIELDS as readonly string[]).includes(f))
      expect(unlisted).toEqual(['ujMezo'])
    }
  })

  it('the writer\'s data type declares no field the list misses (checked by tsc)', () => {
    const allListed: [Unlisted] extends [never] ? true : Unlisted = true
    expect(allListed).toBe(true)
  })
})
