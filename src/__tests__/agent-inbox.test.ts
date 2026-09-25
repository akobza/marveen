import { describe, it, expect } from 'vitest'
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Card 71263d15 (B), 15060: the reader must never cut a message silently. On
// 2026-09-22 an agent answered the first 600 characters of a 1217-character
// message (the decisive sentence stood right after the cut) because its ad-hoc
// inbox command printed content[:600] and nothing else.
//
// This runs the script's actual rendering block against a fixture response, the
// way agent-msg-get-freshness.test.ts does: the check is what the reader SEES.
function render(response: unknown, agent: string, max = 0): string {
  const script = readFileSync(new URL('../../scripts/agent-inbox.sh', import.meta.url), 'utf-8')
  const m = script.match(/python3 - "\$OUT" "\$AGENT" "\$MAX" <<'PY'\n([\s\S]*?)\nPY/)
  expect(m, 'the python rendering block must still be recognizable').not.toBeNull()
  const dir = mkdtempSync(join(tmpdir(), 'inbox-'))
  const py = join(dir, 'render.py')
  const json = join(dir, 'msgs.json')
  writeFileSync(py, m![1], 'utf-8')
  writeFileSync(json, JSON.stringify(response), 'utf-8')
  return execFileSync('python3', [py, json, agent, String(max)], { encoding: 'utf-8' })
}

const LONG = 'A'.repeat(600) + 'TEGNAP OTA MEGVALTOZOTT: ez a dönto mondat. ' + 'B'.repeat(573)
const rows = [
  { id: 29777, from_agent: 'olvaso', to_agent: 'ugyvezeto', status: 'pending', created_at: 1790000100, content: 'kimeno, nem ide tartozik' },
  { id: 29776, from_agent: 'csatlakozas', to_agent: 'olvaso', status: 'pending', created_at: 1790000000, content: LONG },
  { id: 29783, from_agent: 'ugyvezeto', to_agent: 'olvaso', status: 'pending', created_at: 1790000200, content: 'rovid',
    freshness: { note: '[!FRISSESSEG (5p regi): azota 1 ujabb uzenet]' } },
]

describe('agent-inbox.sh never cuts a message silently (71263d15 B)', () => {
  it('prints every incoming message IN FULL by default, oldest first, with its length', () => {
    const out = render({ messages: rows }, 'olvaso')
    expect(LONG.length).toBe(1217)
    expect(out).toContain(LONG)
    expect(out).toContain('# 2 message(s) to olvaso')
    expect(out).toContain('1217 karakter')
    expect(out.indexOf('# msg 29776')).toBeLessThan(out.indexOf('# msg 29783'))
    expect(out).not.toContain('kimeno, nem ide tartozik')
  })

  it('⛔ with --max it says how much it cut, and how to read the rest, where the text stops', () => {
    const out = render({ messages: rows }, 'olvaso', 600)
    expect(out).toContain('A'.repeat(600) + ' [... +617 karakter levágva; teljes: bash scripts/agent-msg-get.sh 29776]')
    expect(out).not.toContain('TEGNAP OTA MEGVALTOZOTT')
    // A message shorter than the cut is printed whole, with no marker.
    expect(out).toContain('\nrovid\n')
  })

  it('prints the freshness note above the content, as agent-msg-get.sh does', () => {
    const out = render(rows, 'olvaso')
    const note = '[!FRISSESSEG (5p regi): azota 1 ujabb uzenet]'
    expect(out).toContain(note)
    expect(out.indexOf(note)).toBeLessThan(out.indexOf('\nrovid'))
  })

  it('an empty inbox says so', () => {
    expect(render({ messages: [] }, 'olvaso')).toContain('# 0 message(s) to olvaso')
  })
})
