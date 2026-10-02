// Card 28c4a739: read-only status rows for non-fleet agents (store/external-status-agents.json + a status file
// refreshed on the host). The status file shape is the one the host job writes (fields: active_state, sub_state,
// active_since, last_activity, last_report, updated_at, errors). Every failure is a field of the result, never a
// throw: a missing or broken file is "not readable", an old file is "stale".

import { describe, it, expect, vi, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DEFAULT_STALE_AFTER_SECONDS,
  EXTERNAL_STATUS_CONFIG_FILENAME,
  loadExternalStatusConfig,
  parseExternalStatusConfig,
  readExternalAgentStatus,
  type ExternalStatusAgentConfig,
} from '../web/external-status-agents.js'

const NOW = Date.parse('2026-10-02T08:00:00Z')
const CFG: ExternalStatusAgentConfig = { id: 'partner-bot', label: 'Partner bot', statusFile: '/var/lib/partner-bot-status/status.json', staleAfterSeconds: 120 }

// The shape the host job writes, with invented values.
function doc(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schema: 'partner-status/1', unit: 'partner-bot.service', active_state: 'active', sub_state: 'running',
    active_since: '2026-10-01T23:46:40Z', n_restarts: 0, cpu_usage_nsec: 123, cpu_delta_nsec: 4, cpu_delta_since: '2026-10-02T07:59:00Z',
    last_activity: '2026-10-02T07:55:00Z', last_activity_source: 'transcripts', last_report: '2026-10-02T07:30:00Z',
    updated_at: '2026-10-02T07:59:30Z', errors: [], ...over,
  })
}
const reader = (text: string) => () => text

describe('the config: well-formed entries only, a bad one never hides the others', () => {
  it('keeps a valid entry, fills the defaults (label = id, staleAfterSeconds = 120)', () => {
    expect(parseExternalStatusConfig({ agents: [{ id: 'partner-bot', statusFile: '/var/lib/x/status.json' }] })).toEqual([
      { id: 'partner-bot', label: 'partner-bot', statusFile: '/var/lib/x/status.json', staleAfterSeconds: DEFAULT_STALE_AFTER_SECONDS },
    ])
  })

  it('drops a non-slug id, a relative statusFile and a duplicate id, and keeps the rest', () => {
    const out = parseExternalStatusConfig({ agents: [
      { id: 'Bad Id', statusFile: '/a' }, { id: 'rel', statusFile: 'status.json' },
      { id: 'ok-1', statusFile: '/a', label: '  Első  ', staleAfterSeconds: 300 }, { id: 'ok-1', statusFile: '/b' },
    ] })
    expect(out).toEqual([{ id: 'ok-1', label: 'Első', statusFile: '/a', staleAfterSeconds: 300 }])
  })

  it('a non-list, a non-object and null give no entry', () => {
    expect(parseExternalStatusConfig({ agents: 'x' })).toEqual([])
    expect(parseExternalStatusConfig('x')).toEqual([])
    expect(parseExternalStatusConfig(null)).toEqual([])
  })

  it('the file: absent gives no entry, invalid JSON gives no entry, a valid file gives its entries', () => {
    const dir = mkdtempSync(join(tmpdir(), 'external-status-'))
    try {
      expect(loadExternalStatusConfig(dir)).toEqual([])
      writeFileSync(join(dir, EXTERNAL_STATUS_CONFIG_FILENAME), '{not json')
      expect(loadExternalStatusConfig(dir)).toEqual([])
      writeFileSync(join(dir, EXTERNAL_STATUS_CONFIG_FILENAME), JSON.stringify({ agents: [{ id: 'partner-bot', statusFile: '/s.json' }] }))
      expect(loadExternalStatusConfig(dir).map((c) => c.id)).toEqual(['partner-bot'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('the status file: read, never thrown', () => {
  it('a fresh, active unit is running and not stale, with its times', () => {
    const s = readExternalAgentStatus(CFG, NOW, reader(doc()))
    expect(s).toMatchObject({
      id: 'partner-bot', label: 'Partner bot', readable: true, state: 'running', activeState: 'active', subState: 'running',
      activeSince: '2026-10-01T23:46:40Z', lastActivity: '2026-10-02T07:55:00Z', lastReport: '2026-10-02T07:30:00Z',
      updatedAt: '2026-10-02T07:59:30Z', ageSeconds: 30, stale: false, errors: [],
    })
  })

  it('inactive, failed and deactivating are stopped; any other state is unknown', () => {
    for (const st of ['inactive', 'failed', 'deactivating']) {
      expect(readExternalAgentStatus(CFG, NOW, reader(doc({ active_state: st }))).state).toBe('stopped')
    }
    expect(readExternalAgentStatus(CFG, NOW, reader(doc({ active_state: 'activating' }))).state).toBe('unknown')
  })

  it('⛔ an old file is stale (an old state must not look live); a missing updated_at is stale too', () => {
    const old = readExternalAgentStatus(CFG, NOW, reader(doc({ updated_at: '2026-10-02T07:55:00Z' })))
    expect(old).toMatchObject({ readable: true, state: 'running', ageSeconds: 300, stale: true })
    const none = readExternalAgentStatus(CFG, NOW, reader(doc({ updated_at: undefined })))
    expect(none).toMatchObject({ readable: true, updatedAt: null, ageSeconds: null, stale: true })
  })

  it('⛔ CONTROL: the threshold is the entry\'s own, not a constant', () => {
    const lax = readExternalAgentStatus({ ...CFG, staleAfterSeconds: 600 }, NOW, reader(doc({ updated_at: '2026-10-02T07:55:00Z' })))
    expect(lax.stale).toBe(false)
  })

  it('⛔ a missing file, invalid JSON, a non-object and a missing active_state are "not readable", with no throw', () => {
    const cases: Array<() => string> = [
      () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) },
      reader('{oops'), reader('[1,2]'), reader(doc({ active_state: undefined })),
    ]
    for (const read of cases) {
      const s = readExternalAgentStatus(CFG, NOW, read)
      expect(s).toMatchObject({ readable: false, state: 'unknown', stale: true, activeState: null })
    }
  })

  it('the errors list keeps strings only, at most 10, each at most 200 characters; a non-date time is null', () => {
    const many = Array.from({ length: 12 }, (_, i) => `source ${i}`)
    const s = readExternalAgentStatus(CFG, NOW, reader(doc({
      errors: [42, 'x'.repeat(250), ...many], active_since: 'yesterday', last_activity: 7,
    })))
    expect(s.errors).toHaveLength(10)
    expect(s.errors[0]).toHaveLength(200)
    expect(s.errors.every((e) => typeof e === 'string')).toBe(true)
    expect(s.activeSince).toBeNull()
    expect(s.lastActivity).toBeNull()
  })
})

describe('the route: GET only', () => {
  afterEach(() => {
    vi.resetModules()
    vi.doUnmock('../web/external-status-agents.js')
  })

  async function call(path: string, method: string) {
    vi.resetModules()
    vi.doMock('../web/external-status-agents.js', () => ({
      externalAgentStatuses: () => [{ id: 'partner-bot', label: 'Partner bot', readable: false }],
    }))
    const { tryHandleExternalAgents } = await import('../web/routes/external-agents.js')
    const out: { status?: number; body?: string } = {}
    const res = {
      writeHead: (status: number) => { out.status = status },
      end: (body: string) => { out.body = body },
    }
    const handled = await tryHandleExternalAgents({ req: {} as never, res: res as never, path, method, url: new URL(`http://x${path}`) })
    return { handled, ...out }
  }

  it('GET /api/external-agents answers the list', async () => {
    const r = await call('/api/external-agents', 'GET')
    expect(r.handled).toBe(true)
    expect(r.status).toBe(200)
    expect(JSON.parse(r.body ?? '{}')).toEqual({ agents: [{ id: 'partner-bot', label: 'Partner bot', readable: false }] })
  })

  it('any other method or path is not handled (no write route exists)', async () => {
    expect((await call('/api/external-agents', 'POST')).handled).toBe(false)
    expect((await call('/api/external-agents/partner-bot', 'GET')).handled).toBe(false)
  })
})
