/**
 * 6a6fe7d2: a reminder the dashboard sent on the Bot API (src/web/reminder-sender.ts) is written to conversation_log,
 * so the ledger-based gates see it, under its OWN agent id '<agent>:emlekezteto': the open-question rule takes the
 * newest outbound after the newest inbound per agent_id (chat-blind) as the answer, so a reminder under the agent's own
 * id would close the owner's open question. Checked on the TS gates (src/db.ts) and on the Python one
 * (scripts/hooks/ledger_lib.py open_question, through LEDGER_DB_PATH). The Bot API is an injected send.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const H = vi.hoisted(() => ({ root: `${process.env['TMPDIR'] || '/tmp'}/rem-ledger-${process.pid}-${Date.now()}` }))

vi.mock('../config.js', async () => {
  const actual = await vi.importActual<typeof import('../config.js')>('../config.js')
  return { ...actual, MAIN_AGENT_ID: 'chief-test', PROJECT_ROOT: H.root }
})

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}))

const {
  initDatabase, createReminder, getReminder, getDb, hasOpenInboundQuestion, openInboundQuestionMessageId, logReminderOutbound,
  REMINDER_LEDGER_AGENT_SUFFIX,
} = await import('../db.js')
const { reminderTick, _resetReminderSenderForTest } = await import('../web/reminder-sender.js')
import type { ReminderSenderDeps } from '../web/reminder-sender.js'

const ROOT = join(__dirname, '..', '..')
const AGENT = 'area-agent'
const CHAT = '7000000002'
const OTHER_CHAT = '7000000009'
const WED_17 = Date.parse('2026-10-07T15:00:00Z') // Wednesday 17:00 Budapest
const sec = (ms: number) => Math.floor(ms / 1000)
const dbFile = () => join(H.root, 'ledger.db')

let n = 0
function reminder(text?: string) {
  n++
  return createReminder({
    id: `${String(n).padStart(8, '0')}-0000-4000-8000-0000000000aa`,
    requester: 'owner-a', recipient_chat_id: CHAT, agent_id: AGENT, text: text ?? `Szólj a szállítónak (${n})`,
    due_at: sec(WED_17) - 60, send_after: sec(WED_17) - 60,
  })
}

function deps(over: Partial<ReminderSenderDeps> = {}) {
  const sent: Array<[string, string, string]> = []
  const d: ReminderSenderDeps = {
    nowMs: () => WED_17,
    windows: () => ({ ok: true, config: { recipients: {} } }),
    send: async (a, c, t) => { sent.push([a, c, t]); return 4242 },
    alertMain: () => {},
    copyToAgent: () => {},
    digestMain: () => {},
    ...over,
  }
  return { d, sent }
}

type LogRow = { agent_id: string; chat_id: string; direction: string; message_id: string | null; text: string; ts: string; created_at: number }
const rows = () => getDb().prepare(
  'SELECT agent_id, chat_id, direction, message_id, text, ts, created_at FROM conversation_log ORDER BY id',
).all() as LogRow[]

function logRow(agentId: string, chatId: string, direction: 'in' | 'out', messageId: string | null, createdAt: number) {
  getDb().prepare(
    `INSERT INTO conversation_log (agent_id, chat_id, direction, message_id, text, ts, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(agentId, chatId, direction, messageId, 'Mikor jön a szerelő?', new Date(createdAt * 1000).toISOString(), createdAt)
}

/** The Python ledger's open question for the agent (its message id), or NONE. */
function pythonOpenQuestion(agentId: string): string {
  const script = [
    'import sys',
    "sys.path.insert(0, 'scripts/hooks')",
    'import ledger_lib',
    'oq = ledger_lib.open_question(sys.argv[1])',
    "print('NONE' if oq is None else oq[1])",
  ].join('\n')
  return execFileSync('python3', ['-c', script, agentId], {
    cwd: ROOT, env: { ...process.env, LEDGER_DB_PATH: dbFile() }, encoding: 'utf-8',
  }).trim()
}

beforeEach(() => {
  rmSync(H.root, { recursive: true, force: true })
  mkdirSync(H.root, { recursive: true })
  initDatabase(dbFile())
  _resetReminderSenderForTest()
})

afterEach(() => {
  try { getDb().close() } catch { /* already closed */ }
  rmSync(H.root, { recursive: true, force: true })
})

describe('6a6fe7d2: a reminder sent on the Bot API in conversation_log', () => {
  it('is ONE outbound row under <agent>:emlekezteto in the ledger outbound form, and none under the agent id', async () => {
    expect(REMINDER_LEDGER_AGENT_SUFFIX).toBe(':emlekezteto')
    const r = reminder()
    const res = await reminderTick(deps().d)
    expect(res.sent).toBe(1)
    expect(getReminder(r.id)?.status).toBe('sent')
    expect(rows()).toEqual([{
      agent_id: 'area-agent:emlekezteto', chat_id: CHAT, direction: 'out', message_id: '4242',
      text: r.text, ts: '2026-10-07T15:00:00Z', created_at: sec(WED_17),
    }])
  })

  it("keeps the agent's open question open for the TS gates, even when the reminder goes to the asker's chat", async () => {
    logRow(AGENT, CHAT, 'in', '9001', sec(WED_17) - 30)
    reminder()
    expect(hasOpenInboundQuestion(AGENT)).toBe(true)
    await reminderTick(deps().d)
    expect(rows().filter((x) => x.direction === 'out')).toHaveLength(1)
    expect(hasOpenInboundQuestion(AGENT)).toBe(true)
    expect(openInboundQuestionMessageId(AGENT)).toBe('9001')
    // control: an outbound under the agent's own id (even in another chat) closes it for the same gates
    logRow(AGENT, OTHER_CHAT, 'out', null, sec(WED_17))
    expect(hasOpenInboundQuestion(AGENT)).toBe(false)
    expect(openInboundQuestionMessageId(AGENT)).toBe(null)
  })

  it('keeps it open for the Python ledger gate (scripts/hooks/ledger_lib.py open_question)', async () => {
    logRow(AGENT, CHAT, 'in', '9002', sec(WED_17) - 30)
    reminder()
    await reminderTick(deps().d)
    expect(pythonOpenQuestion(AGENT)).toBe('9002')
    // control: an outbound under the agent's own id closes it for the same gate
    logRow(AGENT, OTHER_CHAT, 'out', null, sec(WED_17) + 1)
    expect(pythonOpenQuestion(AGENT)).toBe('NONE')
  })

  it('a failed send writes no row', async () => {
    reminder()
    const res = await reminderTick(deps({ send: async () => { throw new Error('Telegram 400 Bad Request') } }).d)
    expect(res.failed).toBe(1)
    expect(rows()).toEqual([])
  })

  it('masks a secret in the logged text; the text sent to Telegram is unchanged', async () => {
    const token = 'abcdef0123456789abcdef0123456789'
    reminder(`Hívd fel a szállítót. Authorization: Bearer ${token}`)
    const { d, sent } = deps()
    await reminderTick(d)
    expect(sent[0][2]).toContain(token)
    const logged = rows()[0].text
    expect(logged).not.toContain(token)
    expect(logged).toContain('Hívd fel a szállítót.')
  })

  it('a failed ledger write keeps the reminder sent', async () => {
    const r = reminder()
    getDb().exec('DROP TABLE conversation_log')
    const res = await reminderTick(deps().d)
    expect(res).toMatchObject({ sent: 1, failed: 0 })
    expect(getReminder(r.id)?.status).toBe('sent')
  })

  it('the same Telegram message id twice is one row (the ledger UNIQUE dedup)', () => {
    expect(logReminderOutbound(AGENT, CHAT, 4242, 'Szólj a szállítónak', sec(WED_17))).toBe(true)
    expect(logReminderOutbound(AGENT, CHAT, 4242, 'Szólj a szállítónak', sec(WED_17))).toBe(false)
    expect(rows()).toHaveLength(1)
  })
})
