import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  checkSchedulePostFields, SCHEDULE_POST_FIELDS, SCHEDULE_WRITE_FIELD_KINDS, SCHEDULE_TASK_TYPES,
} from '../web/schedule-post-fields.js'

// 5bdc1e4a: POST /api/schedules answered 200 {ok:true} and dropped the fields it
// did not read (telegramChatId, preCheck, enabled). The end-to-end behaviour is in
// schedules-post-route.test.ts; this file pins the rule itself.
describe('checkSchedulePostFields', () => {
  it('accepts the payloads callers actually send', () => {
    // if one of these starts failing, that caller breaks -- pinned deliberately
    // web/app.js, create branch of saveScheduleBtn
    expect(checkSchedulePostFields({ name: 'n', description: 'd', prompt: 'p', schedule: '0 8 * * *', agent: 'a', type: 'task', skipIfBusy: false, forceSend: false, targetSession: 's' }).ok).toBe(true)
    // a one-shot helper script that creates dated tasks
    expect(checkSchedulePostFields({ name: 'n', description: 'd', prompt: 'p', schedule: '5 6 4 10 *', agent: 'a', type: 'heartbeat', skipIfBusy: false, forceSend: true }).ok).toBe(true)
    // docs/scheduled-tasks.md and the agent CLAUDE.md template (agent-scaffold.ts)
    expect(checkSchedulePostFields({ name: 'n', description: 'd', prompt: 'p', schedule: '0 8 * * *', agent: 'a', type: 'heartbeat', skipIfBusy: true }).ok).toBe(true)
    expect(checkSchedulePostFields({ name: 'n', description: 'd', prompt: 'p', schedule: '0 8 * * *', agent: 'a', type: 'heartbeat' }).ok).toBe(true)
    // the fields this card is about
    expect(checkSchedulePostFields({ name: 'n', prompt: 'p', schedule: '0 8 * * *', enabled: false, telegramChatId: 'none', preCheck: 'precheck.sh' }).ok).toBe(true)
  })

  it('refuses a field nobody has heard of, and names every one', () => {
    const r = checkSchedulePostFields({ name: 'n', prompt: 'p', telegram_chat_id: 'none', requiresDesktop: true, createdAt: 1 })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.rejected).toEqual(['telegram_chat_id', 'requiresDesktop', 'createdAt'])
    expect(r.message).toContain('telegram_chat_id')
    expect(r.message).toContain('Known fields:')
  })

  it('refuses a known field of the wrong type, and names every one', () => {
    const r = checkSchedulePostFields({ name: 'n', telegramChatId: 1000000001, enabled: 'false', preCheck: true, timeoutMs: '10000', injectMetrics: 1, description: 'ok' })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.rejected).toEqual(['telegramChatId', 'enabled', 'preCheck', 'timeoutMs', 'injectMetrics'])
    expect(r.message).toContain('telegramChatId must be a string (got number)')
    expect(r.message).toContain('enabled must be a boolean (got string)')
    expect(r.message).not.toContain('description')
  })

  it('refuses null for a field instead of reading it as "unset"', () => {
    const r = checkSchedulePostFields({ name: 'n', telegramChatId: null })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.rejected).toEqual(['telegramChatId'])
    expect(r.message).toContain('(got null)')
  })

  it('a number must be finite', () => {
    expect(checkSchedulePostFields({ timeoutMs: Number.NaN }).ok).toBe(false)
    expect(checkSchedulePostFields({ stuckAfterMinutes: Number.POSITIVE_INFINITY }).ok).toBe(false)
    expect(checkSchedulePostFields({ catchUpMaxAgeMinutes: -1 }).ok).toBe(true)
  })

  it('type is one of the values the runner tells apart', () => {
    // the set itself is pinned: a widened set would let a value through that the runner silently runs as a task
    expect([...SCHEDULE_TASK_TYPES]).toEqual(['task', 'heartbeat', 'command'])
    for (const t of SCHEDULE_TASK_TYPES) expect(checkSchedulePostFields({ type: t }).ok).toBe(true)
    const r = checkSchedulePostFields({ type: 'Heartbeat' })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.rejected).toEqual(['type'])
  })

  it('rejects a body that is not an object at all', () => {
    expect(checkSchedulePostFields(null).ok).toBe(false)
    expect(checkSchedulePostFields([{ name: 'n' }]).ok).toBe(false)
    // an EMPTY array has no keys to refuse: only the explicit array check stops it
    expect(checkSchedulePostFields([]).ok).toBe(false)
    expect(checkSchedulePostFields('name=n').ok).toBe(false)
    expect(checkSchedulePostFields(42).ok).toBe(false)
  })
})

describe('the accepted fields are the writer\'s fields', () => {
  it('the field map covers exactly what writeScheduledTask reads from its data', () => {
    // A runtime cross-check next to the compile-time one (the map is typed over
    // the writer's parameter): read the writer's body and collect every data.X.
    const io = readFileSync(join(__dirname, '../web/scheduled-tasks-io.ts'), 'utf-8')
    const start = io.indexOf('export function writeScheduledTask(')
    const body = io.slice(start, io.indexOf('\n}\n', start))
    const read = new Set([...body.matchAll(/\bdata\.(\w+)/g)].map(m => m[1]))
    expect(read.size).toBeGreaterThan(10)
    expect([...read].sort()).toEqual(Object.keys(SCHEDULE_WRITE_FIELD_KINDS).sort())
  })

  it('does not quietly gain or lose a field', () => {
    // growing or shrinking what the POST accepts should require editing this test too
    expect([...SCHEDULE_POST_FIELDS]).toEqual([
      'name', 'description', 'prompt', 'schedule', 'agent', 'enabled', 'type',
      'skipIfBusy', 'forceSend', 'targetSession', 'command', 'timeoutMs', 'failThreshold',
      'preCheck', 'catchUpMaxAgeMinutes', 'stuckAfterMinutes', 'injectMetrics', 'telegramChatId',
    ])
  })
})
