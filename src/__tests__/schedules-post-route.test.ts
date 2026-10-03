import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import type http from 'node:http'

// 5bdc1e4a: POST /api/schedules dropped telegramChatId and preCheck and wrote
// enabled:true whatever was sent, answering 200 {ok:true}; the PUT wrote all
// three. These tests drive the REAL route handler end to end -- a request body
// in, task-config.json out -- and import nothing but the route, so on the old
// code they fail on their assertions (the negative control), not on a missing
// module.
//
// os.homedir() reads $HOME and SCHEDULED_TASKS_DIR is computed at import time,
// so HOME points at a throwaway directory BEFORE the route module is imported.
const tmpHome = mkdtempSync(join(tmpdir(), 'schedules-post-home-'))
const realHome = process.env.HOME
process.env.HOME = tmpHome

let route: typeof import('../web/routes/schedules.js')
let tasksDir: string

beforeAll(async () => {
  route = await import('../web/routes/schedules.js')
  tasksDir = (await import('../web/scheduled-tasks-io.js')).SCHEDULED_TASKS_DIR
})

afterAll(() => {
  process.env.HOME = realHome
  rmSync(tmpHome, { recursive: true, force: true })
})

async function post(body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const req = Readable.from([Buffer.from(JSON.stringify(body))]) as unknown as http.IncomingMessage
  let status = 0
  let out = ''
  const res = {
    writeHead(s: number) { status = s; return res },
    end(b?: string) { out = b ?? '' },
  } as unknown as http.ServerResponse
  const handled = await route.tryHandleSchedules({
    req, res, path: '/api/schedules', method: 'POST', url: new URL('http://localhost/api/schedules'),
  })
  expect(handled).toBe(true)
  return { status, json: JSON.parse(out) as Record<string, unknown> }
}

const taskDir = (name: string) => join(tasksDir, name)
const config = (name: string) => JSON.parse(readFileSync(join(taskDir(name), 'task-config.json'), 'utf-8')) as Record<string, unknown>
const base = { description: 'fixture', prompt: 'run it', schedule: '0 9 * * *', agent: 'agent-a' }

describe('POST /api/schedules writes the optional fields it is given', () => {
  it('telegramChatId "none", a preCheck and enabled:false reach task-config.json', async () => {
    const r = await post({ ...base, name: 'hb-precheck', type: 'heartbeat', enabled: false, telegramChatId: 'none', preCheck: 'precheck.sh' })
    expect(r.status).toBe(200)
    expect(r.json).toEqual({ ok: true, name: 'hb-precheck' })
    const c = config('hb-precheck')
    expect(c.telegramChatId).toBe('none')
    expect(c.preCheck).toBe('precheck.sh')
    expect(c.enabled).toBe(false)
    expect(c.type).toBe('heartbeat')
  })

  it('every other optional field the writer knows survives too', async () => {
    const optional = {
      type: 'command', command: 'echo ok', timeoutMs: 20000, failThreshold: 3,
      catchUpMaxAgeMinutes: 0, stuckAfterMinutes: 90, injectMetrics: true,
      skipIfBusy: true, forceSend: true, targetSession: 'sched-only', telegramChatId: '1000000001',
    }
    const r = await post({ ...base, name: 'all-optional', ...optional })
    expect(r.status).toBe(200)
    const c = config('all-optional')
    for (const [field, value] of Object.entries(optional)) expect(c[field], field).toEqual(value)
    // enabled was not sent: a new task still starts enabled, as before
    expect(c.enabled).toBe(true)
  })
})

describe('POST /api/schedules refuses what it would otherwise lose', () => {
  it('a wrong-typed field is a 400 naming it, and nothing is written', async () => {
    const r = await post({ ...base, name: 'numeric-chat', telegramChatId: 1000000001 })
    expect(r.status).toBe(400)
    expect(r.json.rejected).toEqual(['telegramChatId'])
    expect(String(r.json.error)).toContain('telegramChatId')
    expect(existsSync(taskDir('numeric-chat'))).toBe(false)
  })

  it('enabled:"false" as a string is refused, not read as truthy', async () => {
    const r = await post({ ...base, name: 'string-enabled', enabled: 'false' })
    expect(r.status).toBe(400)
    expect(r.json.rejected).toEqual(['enabled'])
    expect(existsSync(taskDir('string-enabled'))).toBe(false)
  })

  it('an unknown field is a 400 naming it, and nothing is written', async () => {
    const r = await post({ ...base, name: 'snake-case', telegram_chat_id: 'none' })
    expect(r.status).toBe(400)
    expect(r.json.rejected).toEqual(['telegram_chat_id'])
    expect(String(r.json.error)).toContain('telegram_chat_id')
    expect(existsSync(taskDir('snake-case'))).toBe(false)
  })
})

describe('POST /api/schedules is unchanged for the payloads callers send today', () => {
  it('the dashboard create payload writes the same task-config.json, key for key', async () => {
    // web/app.js saveScheduleBtn, create branch
    const r = await post({ name: 'ui-create', description: 'd', prompt: ' p ', schedule: '30 7 * * 1-5', agent: 'agent-a', type: 'task', skipIfBusy: false, forceSend: false })
    expect(r.status).toBe(200)
    const c = config('ui-create')
    expect(Object.keys(c)).toEqual(['schedule', 'agent', 'enabled', 'type', 'skipIfBusy', 'forceSend', 'description', 'createdAt'])
    expect({ ...c, createdAt: 0 }).toEqual({
      schedule: '30 7 * * 1-5', agent: 'agent-a', enabled: true, type: 'task',
      skipIfBusy: false, forceSend: false, description: 'd', createdAt: 0,
    })
    expect(readFileSync(join(taskDir('ui-create'), 'SKILL.md'), 'utf-8')).toBe('---\nname: ui-create\ndescription: d\n---\n\np\n')
  })

  it('the required-field answers stay as they were', async () => {
    expect((await post({ ...base })).json.error).toBe('Name is required')
    expect((await post({ ...base, name: 'no-prompt', prompt: '  ' })).json.error).toBe('Prompt is required')
    expect((await post({ ...base, name: 'no-schedule', schedule: '' })).json.error).toBe('Schedule is required')
    expect((await post({ ...base, name: 'dup-check' })).status).toBe(200)
    expect((await post({ ...base, name: 'dup-check' })).status).toBe(409)
  })
})
