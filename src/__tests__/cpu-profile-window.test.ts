import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Card ea6f9b07: a one-off, operator-set CPU profile window of the dashboard's
// main thread (in-process node:inspector, no port), and its ranking.

vi.mock('../logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() } }))

import {
  parseCpuProfileWindow,
  planCpuProfileWindow,
  runCpuProfile,
  CPU_PROFILE_MAX_SECONDS,
} from '../web/cpu-profile-window.js'
import { summarizeCpuProfile } from '../web/cpu-profile-summary.js'
import { logger } from '../logger.js'

describe('parseCpuProfileWindow', () => {
  it('reads start / seconds / interval, and the interval defaults to 10 ms', () => {
    expect(parseCpuProfileWindow('2026-10-17T08:00:00Z/3600/5000'))
      .toEqual({ startMs: Date.parse('2026-10-17T08:00:00Z'), seconds: 3600, intervalUs: 5000 })
    expect(parseCpuProfileWindow(' 2026-10-17T08:00:00Z/60 '))
      .toEqual({ startMs: Date.parse('2026-10-17T08:00:00Z'), seconds: 60, intervalUs: 10_000 })
  })

  it('no value means no window', () => {
    expect(parseCpuProfileWindow(undefined)).toBeNull()
    expect(parseCpuProfileWindow('  ')).toBeNull()
  })

  it('a bad shape, an impossible day and out-of-range numbers are refused', () => {
    const bad = [
      '2026-10-17 08:00/60',
      '2026-10-17T08:00:00Z',
      '2026-10-17T08:00:00+02:00/60',
      '2026-02-30T08:00:00Z/60',
      '2026-10-17T08:00:00Z/0',
      `2026-10-17T08:00:00Z/${CPU_PROFILE_MAX_SECONDS + 1}`,
      '2026-10-17T08:00:00Z/60/99',
      '2026-10-17T08:00:00Z/60/1000001',
    ]
    for (const v of bad) expect(parseCpuProfileWindow(v), v).toHaveProperty('error')
  })
})

describe('planCpuProfileWindow', () => {
  const now = Date.parse('2026-10-17T07:00:00Z')

  it('a future window waits for its start and runs its full length', () => {
    expect(planCpuProfileWindow('2026-10-17T08:00:00Z/3600', now))
      .toEqual({ delayMs: 3_600_000, seconds: 3600, intervalUs: 10_000, label: '2026-10-17T08-00-00-000Z' })
  })

  it('a window already running starts now, for what is left of it', () => {
    expect(planCpuProfileWindow('2026-10-17T06:30:00Z/3600', now))
      .toEqual({ delayMs: 0, seconds: 1800, intervalUs: 10_000, label: '2026-10-17T07-00-00-000Z' })
  })

  it('an ended window, a bad value and a start beyond the timer range are ignored, each with a warning', () => {
    vi.mocked(logger.warn).mockClear()
    expect(planCpuProfileWindow('2026-10-17T05:00:00Z/3600', now)).toBeNull()
    expect(planCpuProfileWindow('nonsense', now)).toBeNull()
    expect(planCpuProfileWindow('2026-12-17T08:00:00Z/60', now)).toBeNull()
    expect(vi.mocked(logger.warn)).toHaveBeenCalledTimes(3)
  })
})

describe('runCpuProfile, a real in-process profile', () => {
  it('writes one .cpuprofile with samples and a time span', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cpu-profile-'))
    try {
      // The "sleep" keeps this thread busy, so the sampler has work to see.
      const file = await runCpuProfile(1, 1000, dir, 'test', async () => {
        const until = Date.now() + 150
        while (Date.now() < until) { /* busy */ }
      })
      expect(file).toBe(join(dir, 'cpu-test.cpuprofile'))
      expect(readdirSync(dir)).toEqual(['cpu-test.cpuprofile'])
      const p = JSON.parse(readFileSync(file, 'utf-8'))
      expect(p.nodes.length).toBeGreaterThan(1)
      expect(p.samples.length).toBeGreaterThan(10)
      expect(p.endTime).toBeGreaterThan(p.startTime)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('summarizeCpuProfile', () => {
  it('self time per function and per file, with idle, GC and (program) apart; a sample lasts until the next one', () => {
    const profile = {
      nodes: [
        { id: 1, callFrame: { functionName: '(root)', url: '', lineNumber: -1 } },
        { id: 2, callFrame: { functionName: 'hot', url: 'file:///app/a.js', lineNumber: 9 } },
        { id: 3, callFrame: { functionName: '(idle)', url: '', lineNumber: -1 } },
        { id: 4, callFrame: { functionName: '(garbage collector)', url: '', lineNumber: -1 } },
        { id: 5, callFrame: { functionName: '', url: 'file:///app/b.js', lineNumber: 0 } },
      ],
      startTime: 1000,
      endTime: 61_000,
      samples: [2, 2, 3, 4, 5],
      // sample times 1000, 11000, 31000, 41000, 51000; the last lasts until endTime
      timeDeltas: [0, 10_000, 20_000, 10_000, 10_000],
    }
    expect(summarizeCpuProfile(profile)).toEqual({
      totalMs: 60,
      idleMs: 10,
      gcMs: 10,
      programMs: 0,
      functions: [{ name: 'hot file:///app/a.js:10', ms: 30 }, { name: '(anonymous) file:///app/b.js:1', ms: 10 }],
      files: [{ url: 'file:///app/a.js', ms: 30 }, { url: 'file:///app/b.js', ms: 10 }],
    })
  })
})

// Source level: index.ts drives timers and the process lifecycle, so it is not
// run here.
describe('wiring: the dashboard schedules the window once, after the web server starts', () => {
  const src = readFileSync(join(__dirname, '..', 'index.ts'), 'utf-8')

  it('reads the env value and writes under store/cpu-profiles', () => {
    const call = "scheduleCpuProfileWindow(process.env[CPU_PROFILE_ENV], join(STORE_DIR, 'cpu-profiles'))"
    expect(src.split(call).length - 1).toBe(1)
    expect(src.indexOf('webServer = startWebServer(WEB_PORT)')).toBeGreaterThan(0)
    expect(src.indexOf('webServer = startWebServer(WEB_PORT)')).toBeLessThan(src.indexOf(call))
  })
})
