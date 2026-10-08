import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  agentGetsTelegramQuietGate,
  GATE_FAIL_CLOSED_TAG,
  injectTelegramQuietGate,
  TELEGRAM_QUIET_GATE_MATCHER,
} from '../web/agent-scaffold.js'
import { MAIN_AGENT_ID } from '../config.js'

// Card 20e178fc: the quiet-hours SEND gate (scripts/hooks/telegram-quiet-gate.py)
// must sit on every Telegram tool that writes into a chat, for the main agent (its
// committed project settings) and for every sub-agent (the scaffold), like the copy
// gate. What the gate DECIDES is measured in scripts/__tests__/telegram-quiet-gate.test.py;
// here the wiring.

const TOOL = 'mcp__plugin_telegram_telegram__'
const WRITES = ['reply', 'react', 'edit_message'].map((t) => TOOL + t)
const fullMatch = (matcher: string, tool: string) => new RegExp(`^(?:${matcher})$`).test(tool)

const quietEntries = (s: Record<string, unknown>) => {
  const hooks = s.hooks as Record<string, unknown>
  const ptu = (hooks?.PreToolUse ?? []) as Array<Record<string, unknown>>
  return ptu.filter((e) => JSON.stringify(e).includes('telegram-quiet-gate.py'))
}

describe('telegram quiet gate wiring (card 20e178fc)', () => {
  it('exempts the main agent in the scaffold (it carries the gate in its own project settings)', () => {
    expect(agentGetsTelegramQuietGate(MAIN_AGENT_ID)).toBe(false)
  })
  it('covers every sub-agent', () => {
    for (const n of ['social', 'emma', 'chris', 'heartbeat-worker']) {
      expect(agentGetsTelegramQuietGate(n)).toBe(true)
    }
  })
  it('the matcher full-matches the three writing tools and leaves download_attachment alone', () => {
    for (const t of WRITES) expect(fullMatch(TELEGRAM_QUIET_GATE_MATCHER, t)).toBe(true)
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
    const settings = JSON.parse(readFileSync(join(__dirname, '..', '..', '.claude', 'settings.json'), 'utf-8'))
    const entries = quietEntries(settings)
    expect(entries).toHaveLength(1)
    expect(entries[0].matcher).toBe(TELEGRAM_QUIET_GATE_MATCHER)
  })
})
