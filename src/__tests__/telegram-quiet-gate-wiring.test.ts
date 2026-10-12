import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawnSync } from 'node:child_process'
import { appendFileSync, cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  agentGetsTelegramQuietGate,
  gateDeadlineSec,
  GATE_FAIL_CLOSED_TAG,
  injectTelegramQuietGate,
  TELEGRAM_QUIET_GATE_MATCHER,
} from '../web/agent-scaffold.js'
import { MAIN_AGENT_ID } from '../config.js'

// Card 20e178fc: the quiet-hours SEND gate (scripts/hooks/telegram-quiet-gate.py)
// must sit on every Telegram tool that writes into a chat, for the main agent (its
// committed project settings) and for every sub-agent (the scaffold), like the copy
// gate. Card 23724bf8: and on Bash, where a Bot API send can be written into the
// command. What the gate DECIDES is measured in scripts/__tests__/telegram-quiet-gate.test.py
// and telegram-quiet-gate-bash.test.py; here the wiring.

const TOOL = 'mcp__plugin_telegram_telegram__'
const WRITES = ['reply', 'react', 'edit_message'].map((t) => TOOL + t)
const fullMatch = (matcher: string, tool: string) => new RegExp(`^(?:${matcher})$`).test(tool)

const quietEntries = (s: Record<string, unknown>) => {
  const hooks = s.hooks as Record<string, unknown>
  const ptu = (hooks?.PreToolUse ?? []) as Array<Record<string, unknown>>
  return ptu.filter((e) => JSON.stringify(e).includes('telegram-quiet-gate.py'))
}

const REPO = join(__dirname, '..', '..')
// The main agent's entry is hand-written in its committed project settings: no builder test reaches it.
const mainEntry = () => {
  const entries = quietEntries(JSON.parse(readFileSync(join(REPO, '.claude', 'settings.json'), 'utf-8')))
  expect(entries).toHaveLength(1)
  return entries[0]
}
const mainHook = () => (mainEntry().hooks as Array<Record<string, unknown>>)[0]

describe('telegram quiet gate wiring (card 20e178fc)', () => {
  it('exempts the main agent in the scaffold (it carries the gate in its own project settings)', () => {
    expect(agentGetsTelegramQuietGate(MAIN_AGENT_ID)).toBe(false)
  })
  it('covers every sub-agent', () => {
    for (const n of ['social', 'emma', 'chris', 'heartbeat-worker']) {
      expect(agentGetsTelegramQuietGate(n)).toBe(true)
    }
  })
  it('the matcher full-matches the three writing tools and Bash, and leaves download_attachment alone', () => {
    for (const t of WRITES) expect(fullMatch(TELEGRAM_QUIET_GATE_MATCHER, t)).toBe(true)
    expect(fullMatch(TELEGRAM_QUIET_GATE_MATCHER, 'Bash')).toBe(true)
    expect(fullMatch(TELEGRAM_QUIET_GATE_MATCHER, TOOL + 'download_attachment')).toBe(false)
  })
  it('wires the gate under that matcher, inside the card 723bbb70 fail-closed tail', () => {
    const settings: Record<string, unknown> = {}
    injectTelegramQuietGate(settings)
    const [entry] = quietEntries(settings)
    expect(entry.matcher).toBe(TELEGRAM_QUIET_GATE_MATCHER)
    const hook = (entry.hooks as Array<Record<string, unknown>>)[0]
    const command = String(hook.command)
    expect(command).toContain('scripts/hooks/telegram-quiet-gate.py"')
    // the sub-agent entry blocks on a broken gate file, like every other gate an injector writes
    expect(command).toContain(`${GATE_FAIL_CLOSED_TAG}: telegram-quiet-gate.py`)
    expect(command.endsWith('exit "$rc"')).toBe(true)
  })
  it('is idempotent, and replaces an entry left under a stale matcher', () => {
    const settings: Record<string, unknown> = {
      hooks: { PreToolUse: [{ matcher: TOOL + 'reply', hooks: [{ type: 'command', command: 'python3 "/x/scripts/hooks/telegram-quiet-gate.py"' }] }] },
    }
    injectTelegramQuietGate(settings)
    injectTelegramQuietGate(settings)
    const entries = quietEntries(settings)
    expect(entries).toHaveLength(1)
    expect(entries[0].matcher).toBe(TELEGRAM_QUIET_GATE_MATCHER)
  })
  it('leaves unrelated PreToolUse entries alone (the copy gate on the same tools included)', () => {
    const copy = { matcher: TOOL + 'reply|' + TOOL + 'edit_message', hooks: [{ type: 'command', command: 'python3 "/x/scripts/hooks/outgoing-copy-gate.py"' }] }
    const settings: Record<string, unknown> = { hooks: { PreToolUse: [copy] } }
    injectTelegramQuietGate(settings)
    const ptu = (settings.hooks as Record<string, unknown>).PreToolUse as unknown[]
    expect(ptu).toHaveLength(2)
    expect(JSON.stringify(ptu)).toContain('outgoing-copy-gate.py')
  })
  it("the main agent's committed settings carry the gate under the same matcher", () => {
    expect(mainEntry().matcher).toBe(TELEGRAM_QUIET_GATE_MATCHER)
  })
  it("the main agent's entry carries the same fail-closed tail, its deadline inside the hook's own timeout", () => {
    const hook = mainHook()
    const command = String(hook.command)
    expect(command).toContain(`timeout -k 1 ${gateDeadlineSec(Number(hook.timeout))} python3 "$CLAUDE_PROJECT_DIR/scripts/hooks/telegram-quiet-gate.py"`)
    expect(command).toContain(`${GATE_FAIL_CLOSED_TAG}: telegram-quiet-gate.py`)
    expect(command.endsWith('exit "$rc"')).toBe(true)
  })
})

// The main agent's entry run exactly as written, with CLAUDE_PROJECT_DIR on a disposable copy of the
// hooks directory. The gate finds its config and marker from its own location, and the copy has
// neither, so nothing here reads or writes the install. A tail present only as text passes the case
// above; here it has to act.
describe("the main agent's entry, run as written on a disposable copy", () => {
  let root: string
  let env: NodeJS.ProcessEnv
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'telegram-quiet-gate-wiring-'))
    cpSync(join(REPO, 'scripts', 'hooks'), join(root, 'scripts', 'hooks'), { recursive: true })
    env = { ...process.env, CLAUDE_PROJECT_DIR: root, PYTHONDONTWRITEBYTECODE: '1' }
  })
  afterAll(() => { rmSync(root, { recursive: true, force: true }) })

  const sh = (command: string, input: string) => {
    const r = spawnSync('/bin/sh', ['-c', command], { input, env, cwd: root, encoding: 'utf-8', timeout: 30_000 })
    return { rc: r.status, stdout: r.stdout, stderr: r.stderr }
  }
  const gate = () => join(root, 'scripts', 'hooks', 'telegram-quiet-gate.py')
  const reply = JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: TOOL + 'reply', tool_input: { chat_id: '1', text: 'x' } })

  it('intact, it decides as the bare call does, an allow and a block among the inputs', () => {
    const command = String(mainHook().command)
    const inputs = [
      JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'true' } }), // no Bot API call in it
      // a Bot API send in Bash: no config and no marker, so no quiet hours
      JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'curl -s https://api.telegram.org/bot$T/sendMessage -d chat_id=1' } }),
      reply, // no config and no marker: no quiet hours
      'not json', // the gate's own block
    ]
    const rcs = inputs.map((input) => {
      const a = sh(`python3 "${gate()}"`, input)
      const b = sh(command, input)
      expect({ rc: b.rc, stdout: b.stdout }).toEqual({ rc: a.rc, stdout: a.stdout })
      expect(b.stderr).not.toContain(GATE_FAIL_CLOSED_TAG)
      return b.rc
    })
    expect(rcs).toEqual([0, 0, 0, 2])
  }, 60_000)

  it('a syntax error in the gate file blocks (2), where the bare call exits 1 and the send would go', () => {
    const command = String(mainHook().command)
    const orig = readFileSync(gate())
    appendFileSync(gate(), '\nx = (\n')
    try {
      expect(sh(`python3 "${gate()}"`, reply).rc).toBe(1)
      const r = sh(command, reply)
      expect(r.rc).toBe(2)
      expect(r.stderr).toContain(`${GATE_FAIL_CLOSED_TAG}: telegram-quiet-gate.py`)
    } finally {
      writeFileSync(gate(), orig)
    }
  }, 60_000)
})
