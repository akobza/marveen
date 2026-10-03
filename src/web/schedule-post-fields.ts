// Which fields POST /api/schedules accepts, and of what type.
//
// Split out of the route handler for the same reason as agent-put-fields.ts:
// the rule is testable without an HTTP context, and its failure mode is silence.
//
// Background (5bdc1e4a): the POST read a fixed handful of fields from the body
// (name, description, prompt, schedule, agent, type, skipIfBusy, forceSend,
// targetSession), hard-coded enabled:true and dropped everything else --
// telegramChatId and preCheck included -- while answering 200 {ok:true}. The
// PUT hands its whole body to writeScheduledTask, which does write those
// fields, so the same payload made a different task depending on the verb.
// Measured 2026-10-02/03: a heartbeat POSTed with a preCheck and enabled:false
// came up enabled and without its pre-check, and three one-shots came up
// without their telegramChatId and had to be fixed with a PUT afterwards.
// Without the pin, for an agent with several contacts the runner writes a
// [FELHIVAS] instead of the delivery instruction.

import type { writeScheduledTask } from './scheduled-tasks-io.js'

type FieldKind = 'string' | 'boolean' | 'number'
type ScheduledTaskWriteData = Parameters<typeof writeScheduledTask>[1]

// Every field writeScheduledTask knows, with its JSON type. Typed as a full
// record over the writer's own data type, so a field added to or removed from
// writeScheduledTask without this map is a compile error here, not a field the
// POST quietly drops again.
export const SCHEDULE_WRITE_FIELD_KINDS: { readonly [K in keyof Required<ScheduledTaskWriteData>]: FieldKind } = {
  description: 'string',
  prompt: 'string',
  schedule: 'string',
  agent: 'string',
  enabled: 'boolean',
  type: 'string',
  skipIfBusy: 'boolean',
  forceSend: 'boolean',
  targetSession: 'string',
  command: 'string',
  timeoutMs: 'number',
  failThreshold: 'number',
  preCheck: 'string',
  catchUpMaxAgeMinutes: 'number',
  stuckAfterMinutes: 'number',
  injectMetrics: 'boolean',
  telegramChatId: 'string',
}

// The POST also carries the task's name; the PUT takes it from the URL.
export const SCHEDULE_POST_FIELDS: readonly string[] = ['name', ...Object.keys(SCHEDULE_WRITE_FIELD_KINDS)]

// The task types the runner tells apart: schedule-runner.ts compares against
// 'heartbeat' and 'command', and runs anything else as a plain task -- so a
// misspelled type would not fail, it would quietly become a task that reports
// every time.
export const SCHEDULE_TASK_TYPES = ['task', 'heartbeat', 'command'] as const

export type SchedulePostFieldCheck =
  | { ok: true }
  | { ok: false; rejected: string[]; message: string }

function kindOf(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

// Refuses the UNKNOWN field and the WRONG-TYPED field, each by name, rather
// than coercing or ignoring them. Checks types, not presence: the required
// fields (name, prompt, schedule) keep their own messages in the route.
export function checkSchedulePostFields(body: unknown): SchedulePostFieldCheck {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, rejected: [], message: 'Request body must be a JSON object.' }
  }
  const data = body as Record<string, unknown>
  const known = new Set<string>(SCHEDULE_POST_FIELDS)
  const unknown = Object.keys(data).filter(k => !known.has(k))
  if (unknown.length) {
    return {
      ok: false,
      rejected: unknown,
      message: `Unknown field(s) for POST /api/schedules: ${unknown.join(', ')}. Known fields: ${SCHEDULE_POST_FIELDS.join(', ')}.`,
    }
  }

  const kinds: Record<string, FieldKind> = { name: 'string', ...SCHEDULE_WRITE_FIELD_KINDS }
  const rejected: string[] = []
  const problems: string[] = []
  for (const [field, value] of Object.entries(data)) {
    const kind = kinds[field]
    const typeOk = kind === 'number' ? typeof value === 'number' && Number.isFinite(value) : typeof value === kind
    if (!typeOk) {
      rejected.push(field)
      problems.push(`${field} must be a ${kind} (got ${kindOf(value)})`)
    } else if (field === 'type' && !(SCHEDULE_TASK_TYPES as readonly string[]).includes(value as string)) {
      rejected.push(field)
      problems.push(`type must be one of ${SCHEDULE_TASK_TYPES.join(', ')} (got "${value as string}")`)
    }
  }
  if (rejected.length) {
    return { ok: false, rejected, message: `Invalid field(s) for POST /api/schedules: ${problems.join('; ')}.` }
  }
  return { ok: true }
}
