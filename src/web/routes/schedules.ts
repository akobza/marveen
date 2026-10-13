import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import {
  listPendingTaskRetries, deletePendingTaskRetryById, listTaskRunHistory,
  logScheduleWrite, getScheduleWriteLog, type ScheduleWriteOp,
} from '../../db.js'
import { MAIN_AGENT_ID, currentBotName } from '../../config.js'
import { runAgent } from '../../agent.js'
import { logger } from '../../logger.js'
import { toPendingRetryView } from '../../pending-retries.js'
import { atomicWriteFileSync } from '../atomic-write.js'
import { isValidCronShape } from '../cron.js'
import { readBody, json, RequestBodyTooLargeError } from '../http-helpers.js'
import { sanitizeScheduleName, safeJoin } from '../sanitize.js'
import { listAgentNames } from '../agent-config.js'
import { readFileOr, readJsonObjectForWrite } from '../agent-config.js'
import {
  SCHEDULED_TASKS_DIR, MAX_SCHEDULED_TASK_PROMPT_LEN,
  listScheduledTasks, writeScheduledTask, markDefaultTaskRemoved,
} from '../scheduled-tasks-io.js'
import { runScheduledTaskNow } from '../schedule-runner.js'
import type { RouteContext } from './types.js'

// Resolve a URL-supplied schedule name to an on-disk dir, blocking path
// traversal. sanitizeScheduleName strips everything outside [a-z0-9-] (so no
// "." or "/" survives), the empty check rejects a name that sanitized away
// (which would otherwise resolve to the tasks root and delete/overwrite it),
// and safeJoin is a belt-and-suspenders guard against escaping the base.
function resolveScheduleDir(rawName: string): { name: string; dir: string } | null {
  let decoded: string
  try { decoded = decodeURIComponent(rawName) } catch { return null }
  const name = sanitizeScheduleName(decoded)
  if (!name) return null
  try {
    return { name, dir: safeJoin(SCHEDULED_TASKS_DIR, name) }
  } catch { return null }
}

// HBSCHEDSZAM903: the hourly heartbeat digest's "enabled schedules" figure was
// the ONE number the agent computed itself (counting enabled:true in the raw
// /api/schedules array), and it drifted to a 13x error (376 reported vs 29
// real). Serve the counts pre-computed so the digest copies a number instead
// of deriving one. Pure and exported so the counting rule is unit-testable.
export function summarizeScheduledTasks(tasks: Array<{ enabled?: boolean }>): { total: number; enabled: number; disabled: number } {
  // The same rule the toggle route uses: a task is enabled unless enabled is
  // explicitly false (absent field = enabled).
  const enabled = tasks.filter(t => t.enabled !== false).length
  return { total: tasks.length, enabled, disabled: tasks.length - enabled }
}

// ffc45c28 (b): every successful schedule write leaves a row in schedule_write_log (see db.ts). The agent is the
// X-Agent-Id the caller CLAIMED, as the auth gate resolved it (ctx.auth.agent: roster-checked, not authenticated).
// A failed log write never fails the request: the schedule change already happened, so the error is logged.
const SCHEDULE_FIELDS = new Set([
  'description', 'prompt', 'schedule', 'agent', 'enabled', 'type', 'skipIfBusy', 'forceSend', 'targetSession', 'once',
])
// The names of the fields an update sent, never their values; a name outside the known set is "(other)", so a
// caller-chosen key cannot carry text into the log.
function sentFieldNames(data: Record<string, unknown>): string[] {
  return [...new Set(Object.keys(data).map(k => (SCHEDULE_FIELDS.has(k) ? k : '(other)')))]
}
function recordScheduleWrite(
  ctx: RouteContext,
  entry: { op: ScheduleWriteOp; taskName: string; fields?: string[]; enabled?: boolean },
): void {
  try {
    logScheduleWrite({ ...entry, claimedAgent: ctx.auth?.agent ?? null, authKind: ctx.auth?.kind ?? null })
  } catch (err) {
    logger.warn({ err, name: entry.taskName, op: entry.op }, 'Schedule write log insert failed')
  }
}
const WRITE_LOG_DEFAULT_LIMIT = 200
const WRITE_LOG_MAX_LIMIT = 1000

export async function tryHandleSchedules(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method } = ctx

  if (path === '/api/schedules/agents' && method === 'GET') {
    const agentNames = listAgentNames()
    const agents = [
      { name: MAIN_AGENT_ID, label: currentBotName(), avatar: '/api/marveen/avatar' },
      ...agentNames.map(n => ({ name: n, label: n, avatar: `/api/agents/${encodeURIComponent(n)}/avatar` }))
    ]
    json(res, agents)
    return true
  }

  if (path === '/api/schedules/expand-questions' && method === 'POST') {
    const body = await readBody(req)
    const { prompt, agent } = JSON.parse(body.toString()) as { prompt: string; agent?: string }
    if (!prompt?.trim()) { json(res, { error: 'Prompt is required' }, 400); return true }

    const aiPrompt = `A felhasznalo egy utemezett feladatot akar letrehozni egy AI agensnek. A rovid leirasa:
"${prompt.trim()}"
${agent ? `Az agens neve: ${agent}` : ''}

Generalj 3-4 feleletvalasztos kerdest, amivel pontositani lehet a feladatot. Minden kerdeshez adj 2-4 valaszlehetoseget.

Valaszolj KIZAROLAG JSON formatumban, semmi mas:
[
  {"question": "Kerdes szovege?", "options": ["Opcio 1", "Opcio 2", "Opcio 3"]},
  {"question": "Masik kerdes?", "options": ["A", "B"]}
]`

    try {
      const { text } = await runAgent(aiPrompt)
      if (!text) throw new Error('No response')
      const jsonMatch = text.match(/\[[\s\S]*\]/)
      if (!jsonMatch) throw new Error('Invalid response format')
      const questions = JSON.parse(jsonMatch[0])
      json(res, questions)
    } catch (err) {
      logger.error({ err }, 'Failed to generate expand questions')
      json(res, { error: 'Failed to generate questions' }, 500)
    }
    return true
  }

  if (path === '/api/schedules/expand-prompt' && method === 'POST') {
    const body = await readBody(req)
    const { prompt, answers } = JSON.parse(body.toString()) as { prompt: string; answers: { question: string; answer: string }[] }
    if (!prompt?.trim()) { json(res, { error: 'Prompt is required' }, 400); return true }

    const answersText = answers.map((a: { question: string; answer: string }) => `Kerdes: ${a.question}\nValasz: ${a.answer}`).join('\n\n')

    const aiPrompt = `Bovitsd ki ezt a rovid feladat-leirast egy reszletes, egyertelmu promptta amit egy AI asszisztens vegre tud hajtani.
A prompt legyen magyar nyelvu, konkret utasitasokkal.

Rovid leiras: "${prompt.trim()}"

A felhasznalo valaszai a pontosito kerdesekre:
${answersText}

Az eredmeny CSAK a kibovitett prompt szovege legyen, semmi mas. Ne hasznalj code fence-t.`

    try {
      const { text } = await runAgent(aiPrompt)
      if (!text) throw new Error('No response')
      let expanded = text.trim()
      if (expanded.startsWith('```')) expanded = expanded.replace(/^```\w*\n?/, '').replace(/\n?```$/, '')
      json(res, { prompt: expanded })
    } catch (err) {
      logger.error({ err }, 'Failed to expand prompt')
      json(res, { error: 'Failed to expand prompt' }, 500)
    }
    return true
  }

  if (path === '/api/schedules' && method === 'GET') {
    json(res, listScheduledTasks())
    return true
  }

  if (path === '/api/schedules/summary' && method === 'GET') {
    json(res, summarizeScheduledTasks(listScheduledTasks()))
    return true
  }

  // The write log for a schedule audit: newest first; since = unix seconds; a malformed value is
  // refused (400), never read as "everything".
  if (path === '/api/schedules/write-log' && method === 'GET') {
    const sinceRaw = ctx.url.searchParams.get('since')
    const limitRaw = ctx.url.searchParams.get('limit')
    let since: number | undefined
    if (sinceRaw !== null) {
      if (!/^\d+$/.test(sinceRaw)) { json(res, { error: 'since must be unix seconds' }, 400); return true }
      since = Number(sinceRaw)
    }
    let limit = WRITE_LOG_DEFAULT_LIMIT
    if (limitRaw !== null) {
      if (!/^\d+$/.test(limitRaw) || Number(limitRaw) < 1) { json(res, { error: 'limit must be a positive integer' }, 400); return true }
      limit = Math.min(Number(limitRaw), WRITE_LOG_MAX_LIMIT)
    }
    json(res, {
      note: 'claimed_agent is the X-Agent-Id the caller sent (self-asserted, one shared token: not authenticated)',
      rows: getScheduleWriteLog({ since, limit }),
    })
    return true
  }

  if (path === '/api/schedules' && method === 'POST') {
    let body: Buffer
    try {
      body = await readBody(req, { maxBytes: 256 * 1024 })
    } catch (err) {
      if (err instanceof RequestBodyTooLargeError) {
        json(res, { error: `Request body too large (max ${err.limit} bytes)` }, 413)
        return true
      }
      throw err
    }
    const data = JSON.parse(body.toString()) as {
      name: string; description: string; prompt: string; schedule: string; agent?: string; type?: string; skipIfBusy?: boolean; forceSend?: boolean; targetSession?: string; once?: boolean
    }
    const name = sanitizeScheduleName(data.name || '')
    if (!name) { json(res, { error: 'Name is required' }, 400); return true }
    if (!data.prompt?.trim()) { json(res, { error: 'Prompt is required' }, 400); return true }
    if (data.prompt.length > MAX_SCHEDULED_TASK_PROMPT_LEN) {
      json(res, {
        error: `Prompt too large (${data.prompt.length} chars, max ${MAX_SCHEDULED_TASK_PROMPT_LEN})`,
      }, 413)
      return true
    }
    if (!data.schedule?.trim()) { json(res, { error: 'Schedule is required' }, 400); return true }
    if (!isValidCronShape(data.schedule)) { json(res, { error: 'Invalid cron expression' }, 400); return true }
    if (data.once !== undefined && typeof data.once !== 'boolean') { json(res, { error: 'once must be true or false' }, 400); return true }

    const dir = join(SCHEDULED_TASKS_DIR, name)
    if (existsSync(dir)) { json(res, { error: 'Schedule already exists' }, 409); return true }

    writeScheduledTask(name, {
      description: data.description || '',
      prompt: data.prompt.trim(),
      schedule: data.schedule.trim(),
      agent: data.agent || MAIN_AGENT_ID,
      enabled: true,
      type: data.type || 'task',
      skipIfBusy: data.skipIfBusy === true,
      forceSend: data.forceSend === true,
      targetSession: data.targetSession || undefined,
      once: data.once,
    })
    recordScheduleWrite(ctx, { op: 'create', taskName: name })
    logger.info({ name, schedule: data.schedule, once: data.once === true }, 'Scheduled task created')
    json(res, { ok: true, name })
    return true
  }

  const scheduleUpdateMatch = path.match(/^\/api\/schedules\/([^/]+)$/)
  if (scheduleUpdateMatch && method === 'PUT') {
    const resolved = resolveScheduleDir(scheduleUpdateMatch[1])
    if (!resolved) { json(res, { error: 'Schedule not found' }, 404); return true }
    const { name, dir } = resolved
    if (!existsSync(dir)) { json(res, { error: 'Schedule not found' }, 404); return true }

    let body: Buffer
    try {
      body = await readBody(req, { maxBytes: 256 * 1024 })
    } catch (err) {
      if (err instanceof RequestBodyTooLargeError) {
        json(res, { error: `Request body too large (max ${err.limit} bytes)` }, 413)
        return true
      }
      throw err
    }
    const data = JSON.parse(body.toString()) as {
      description?: string; prompt?: string; schedule?: string; agent?: string; enabled?: boolean; type?: string; skipIfBusy?: boolean; forceSend?: boolean; targetSession?: string; once?: boolean
    }
    if (data.once !== undefined && typeof data.once !== 'boolean') {
      json(res, { error: 'once must be true or false' }, 400)
      return true
    }
    if (data.prompt !== undefined && data.prompt.length > MAX_SCHEDULED_TASK_PROMPT_LEN) {
      json(res, {
        error: `Prompt too large (${data.prompt.length} chars, max ${MAX_SCHEDULED_TASK_PROMPT_LEN})`,
      }, 413)
      return true
    }
    if (data.schedule !== undefined && !isValidCronShape(data.schedule)) {
      json(res, { error: 'Invalid cron expression' }, 400)
      return true
    }
    writeScheduledTask(name, data)
    recordScheduleWrite(ctx, { op: 'update', taskName: name, fields: sentFieldNames(data) })
    logger.info({ name }, 'Scheduled task updated')
    json(res, { ok: true })
    return true
  }

  if (scheduleUpdateMatch && method === 'DELETE') {
    const resolved = resolveScheduleDir(scheduleUpdateMatch[1])
    if (!resolved) { json(res, { error: 'Schedule not found' }, 404); return true }
    const { name, dir } = resolved
    if (!existsSync(dir)) { json(res, { error: 'Schedule not found' }, 404); return true }
    rmSync(dir, { recursive: true, force: true })
    // #796: remember the removal so a shipped default is not re-seeded on the
    // next restart/update. Harmless for a user-authored task (the seeders only
    // ever revisit shipped names); a later re-create with this name clears it.
    markDefaultTaskRemoved(name)
    recordScheduleWrite(ctx, { op: 'delete', taskName: name })
    logger.info({ name }, 'Scheduled task deleted')
    json(res, { ok: true })
    return true
  }

  const scheduleToggleMatch = path.match(/^\/api\/schedules\/([^/]+)\/toggle$/)
  if (scheduleToggleMatch && method === 'POST') {
    const resolved = resolveScheduleDir(scheduleToggleMatch[1])
    if (!resolved) { json(res, { error: 'Schedule not found' }, 404); return true }
    const { name, dir } = resolved
    if (!existsSync(dir)) { json(res, { error: 'Schedule not found' }, 404); return true }

    const configPath = join(dir, 'task-config.json')
    let config: Record<string, unknown> = {}
    // JSONCLOBBER926: a corrupt task-config.json is refused, not reset to {enabled}.
    config = readJsonObjectForWrite(configPath)
    const newEnabled = !(config.enabled !== false)
    config.enabled = newEnabled
    atomicWriteFileSync(configPath, JSON.stringify(config, null, 2))
    recordScheduleWrite(ctx, { op: 'toggle', taskName: name, enabled: newEnabled })
    logger.info({ name, enabled: newEnabled }, 'Scheduled task toggled')
    json(res, { ok: true, enabled: newEnabled })
    return true
  }

  const scheduleRunMatch = path.match(/^\/api\/schedules\/([^/]+)\/run$/)
  if (scheduleRunMatch && method === 'POST') {
    const resolved = resolveScheduleDir(scheduleRunMatch[1])
    if (!resolved) { json(res, { error: 'Schedule not found' }, 404); return true }
    const { name, dir } = resolved
    if (!existsSync(dir)) { json(res, { error: 'Schedule not found' }, 404); return true }
    const result = await runScheduledTaskNow(name)
    if (!result.ok) { json(res, { error: result.error }, 400); return true }
    logger.info({ name, result: result.result }, 'Scheduled task run-now fired')
    json(res, { ok: true, result: result.result })
    return true
  }

  if (path === '/api/schedules/pending' && method === 'GET') {
    const now = Date.now()
    const rows = listPendingTaskRetries().map(r => toPendingRetryView(r, now))
    json(res, rows)
    return true
  }

  const scheduleRunsMatch = path.match(/^\/api\/schedules\/([^/]+)\/runs$/)
  if (scheduleRunsMatch && method === 'GET') {
    const resolved = resolveScheduleDir(scheduleRunsMatch[1])
    if (!resolved) { json(res, { error: 'Schedule not found' }, 404); return true }
    const { name, dir } = resolved
    if (!existsSync(dir)) { json(res, { error: 'Schedule not found' }, 404); return true }
    const runs = listTaskRunHistory(name, 10)
    json(res, runs)
    return true
  }

  const pendingCancelMatch = path.match(/^\/api\/schedules\/pending\/(\d+)$/)
  if (pendingCancelMatch && method === 'DELETE') {
    const id = parseInt(pendingCancelMatch[1], 10)
    if (!Number.isFinite(id)) { json(res, { error: 'Invalid id' }, 400); return true }
    const removed = deletePendingTaskRetryById(id)
    if (!removed) { json(res, { error: 'Pending retry not found' }, 404); return true }
    logger.info({ id }, 'Pending scheduled-task retry cancelled via API')
    json(res, { ok: true })
    return true
  }

  return false
}
