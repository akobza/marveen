import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { initDatabase, getDb, decayMemoriesBatch, DECAY_SWEEP_INTERVAL_MS } from '../db.js'
import { runDecaySweep } from '../memory.js'
import {
  decaySweepDelayMs,
  readDecaySweepStamp,
  writeDecaySweepStamp,
  scheduleDecaySweep,
  DECAY_SWEEP_STARTUP_DELAY_MS,
  DECAY_SWEEP_STAMP_FILE,
  type DecaySweepDeps,
} from '../decay-sweep-schedule.js'

// Card 75693151: the decay sweep left the boot path. It is armed after the web listener is up, at most one a day counted
// from the last successful sweep (a store file), and the decay runs in batches with an event-loop turn between two.

const H = 3_600_000
const DAY = 24 * H
const T0 = 1_800_000_000_000

describe('decaySweepDelayMs', () => {
  it('no, unreadable or future stamp: due after the startup delay', () => {
    expect(decaySweepDelayMs(null, T0)).toBe(DECAY_SWEEP_STARTUP_DELAY_MS)
    expect(decaySweepDelayMs(Number.NaN, T0)).toBe(DECAY_SWEEP_STARTUP_DELAY_MS)
    expect(decaySweepDelayMs(T0 + 1, T0)).toBe(DECAY_SWEEP_STARTUP_DELAY_MS)
  })
  it('counts the 24 h from the last success, never sooner than the startup delay', () => {
    expect(decaySweepDelayMs(T0 - 25 * H, T0)).toBe(DECAY_SWEEP_STARTUP_DELAY_MS)
    expect(decaySweepDelayMs(T0 - 23 * H, T0)).toBe(H)
    expect(decaySweepDelayMs(T0, T0)).toBe(DAY)
    expect(decaySweepDelayMs(T0 - DAY + DECAY_SWEEP_STARTUP_DELAY_MS, T0)).toBe(DECAY_SWEEP_STARTUP_DELAY_MS)
    expect(decaySweepDelayMs(T0 - DAY + DECAY_SWEEP_STARTUP_DELAY_MS + 1, T0)).toBe(DECAY_SWEEP_STARTUP_DELAY_MS + 1)
    expect(decaySweepDelayMs(T0 - DAY + DECAY_SWEEP_STARTUP_DELAY_MS - 1, T0)).toBe(DECAY_SWEEP_STARTUP_DELAY_MS)
    expect(decaySweepDelayMs(T0 - 2 * H, T0)).toBe(22 * H)
  })
  it('the defaults: a 24 h interval and a 10 min startup delay', () => {
    expect(DECAY_SWEEP_INTERVAL_MS).toBe(DAY)
    expect(DECAY_SWEEP_STARTUP_DELAY_MS).toBe(10 * 60_000)
  })
})

describe('the stamp file', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'decay-stamp-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('round-trips, and anything but a positive number reads as no stamp', () => {
    const p = join(dir, DECAY_SWEEP_STAMP_FILE)
    expect(readDecaySweepStamp(p)).toBeNull()
    writeDecaySweepStamp(T0, p)
    expect(readDecaySweepStamp(p)).toBe(T0)
    expect(readFileSync(p, 'utf-8')).toBe(`${T0}\n`)
    for (const bad of ['', 'x', '0', '-5', 'NaN']) {
      writeFileSync(p, bad)
      expect(readDecaySweepStamp(p)).toBeNull()
    }
  })
})

// A hand-driven clock and timer queue: the scheduler gets nothing real.
function harness(initialStamp: number | null, run: () => Promise<void> = async () => {}) {
  type Timer = { fn: () => void; ms: number; cleared: boolean; fired: boolean }
  const st = { now: T0, stamp: initialStamp, runs: 0, timers: [] as Timer[] }
  const deps: DecaySweepDeps = {
    run: async () => { st.runs++; await run() },
    now: () => st.now,
    readStamp: () => st.stamp,
    writeStamp: (ms) => { st.stamp = ms },
    setTimer: (fn, ms) => {
      const t: Timer = { fn, ms, cleared: false, fired: false }
      st.timers.push(t)
      return t as unknown as NodeJS.Timeout
    },
    clearTimer: (t) => { (t as unknown as Timer).cleared = true },
  }
  const pending = () => st.timers.filter((t) => !t.cleared && !t.fired)
  const fire = async () => {
    const p = pending()
    expect(p).toHaveLength(1)
    const t = p[0]
    st.now += t.ms
    t.fired = true
    t.fn()
    for (let i = 0; i < 5; i++) await Promise.resolve()
  }
  return { st, deps, pending, fire }
}

describe('scheduleDecaySweep', () => {
  it('never runs at arm time; with no stamp the first run is after the startup delay, then every 24 h', async () => {
    const h = harness(null)
    scheduleDecaySweep(h.deps)
    expect(h.st.runs).toBe(0)
    expect(h.pending().map((t) => t.ms)).toEqual([DECAY_SWEEP_STARTUP_DELAY_MS])
    await h.fire()
    expect(h.st.runs).toBe(1)
    expect(h.st.stamp).toBe(T0 + DECAY_SWEEP_STARTUP_DELAY_MS)
    expect(h.pending().map((t) => t.ms)).toEqual([DAY])
    await h.fire()
    expect(h.st.runs).toBe(2)
  })

  it('a stamp from 2 h ago: the next run is 22 h out, not at boot', () => {
    const h = harness(T0 - 2 * H)
    scheduleDecaySweep(h.deps)
    expect(h.st.runs).toBe(0)
    expect(h.pending().map((t) => t.ms)).toEqual([22 * H])
  })

  it('two boots within 24 h decay once: the second boot waits for the first boot\'s stamp + 24 h', async () => {
    const first = harness(null)
    const stop = scheduleDecaySweep(first.deps)
    await first.fire()
    stop()
    // a restart 3 h later, with the stamp the first boot wrote
    const second = harness(first.st.stamp)
    second.st.now = first.st.now + 3 * H
    scheduleDecaySweep(second.deps)
    expect(first.st.runs + second.st.runs).toBe(1)
    expect(second.pending().map((t) => t.ms)).toEqual([21 * H])
  })

  it('a failed run writes no stamp and retries one interval later', async () => {
    const h = harness(null, async () => { throw new Error('disk') })
    scheduleDecaySweep(h.deps)
    await h.fire()
    expect(h.st.runs).toBe(1)
    expect(h.st.stamp).toBeNull()
    expect(h.pending().map((t) => t.ms)).toEqual([DECAY_SWEEP_INTERVAL_MS])
  })

  it('stop clears the pending timer, and a run finishing after stop arms nothing', async () => {
    let release: () => void = () => {}
    const h = harness(null, () => new Promise<void>((r) => { release = r }))
    const stop = scheduleDecaySweep(h.deps)
    expect(h.pending()).toHaveLength(1)
    await h.fire() // the run is now in flight
    stop()
    release()
    for (let i = 0; i < 5; i++) await Promise.resolve()
    expect(h.pending()).toHaveLength(0)
    const h2 = harness(null)
    const stop2 = scheduleDecaySweep(h2.deps)
    stop2()
    expect(h2.st.timers.every((t) => t.cleared)).toBe(true)
  })
})

describe('the batched decay', () => {
  beforeAll(() => {
    process.env.NODE_ENV = 'test'
    initDatabase(':memory:')
  })
  beforeEach(() => {
    getDb().exec('DELETE FROM memories')
  })
  const now = () => Math.floor(Date.now() / 1000)
  function seed(old: number, fresh: number) {
    const ins = getDb().prepare(
      "INSERT INTO memories (chat_id, content, sector, salience, created_at, accessed_at) VALUES ('decay-chat', ?, 'semantic', 1.0, ?, ?)",
    )
    for (let i = 0; i < old; i++) ins.run(`old ${i}`, now() - 30 * 86400, now())
    for (let i = 0; i < fresh; i++) ins.run(`fresh ${i}`, now(), now())
  }
  const saliences = (like: string) =>
    (getDb().prepare('SELECT salience FROM memories WHERE content LIKE ? ORDER BY id').all(like) as { salience: number }[]).map((r) => r.salience)

  it('decayMemoriesBatch walks the old rows in id order, `limit` at a time, each exactly once', () => {
    seed(1203, 3)
    const cutoff = now() - 7 * 86400
    const sizes: number[] = []
    // bounded: a batch that does not move past its own last id would loop forever and hang the worker (mutant D8, 75693151)
    for (let r = decayMemoriesBatch(0, 500, cutoff); r.lastId !== null && sizes.length < 10; r = decayMemoriesBatch(r.lastId, 500, cutoff)) sizes.push(r.changes)
    expect(sizes).toEqual([500, 500, 203])
    expect(new Set(saliences('old %'))).toEqual(new Set([0.995]))
    expect(saliences('fresh %')).toEqual([1, 1, 1])
  })

  it('runDecaySweep decays every old row once and gives the event loop a turn between batches', async () => {
    seed(1203, 3)
    let turned = false
    setImmediate(() => { turned = true })
    const sweep = runDecaySweep()
    expect(turned).toBe(false)
    await sweep
    expect(turned).toBe(true)
    expect(new Set(saliences('old %'))).toEqual(new Set([0.995]))
    expect(saliences('fresh %')).toEqual([1, 1, 1])
  })
})

// STRUCTURAL: the boot wiring in index.ts (a behavioral boot test would have to stand up every subsystem; the mcp-list
// boot-warmup test makes the same trade). Comment lines are dropped, so a call written in a comment does not count.
describe('the boot wiring', () => {
  const root = join(fileURLToPath(import.meta.url), '..', '..', '..')
  const code = (f: string) =>
    readFileSync(join(root, 'src', f), 'utf-8').split('\n').filter((l) => !l.trimStart().startsWith('//')).join('\n')

  it('index.ts never calls runDecaySweep() itself and arms the schedule only after startWebServer, on listening', () => {
    const src = code('index.ts')
    expect(src).not.toMatch(/\brunDecaySweep\s*\(/)
    expect(src).not.toMatch(/setInterval\(\s*runDecaySweep/)
    const web = src.indexOf('webServer = startWebServer(WEB_PORT)')
    const arm = src.indexOf('stopDecaySweep = scheduleDecaySweep({')
    expect(web).toBeGreaterThan(0)
    expect(arm).toBeGreaterThan(web)
    expect(src).toContain('run: runDecaySweep,')
    // 2nd PR: the listening handler (afterListening) arms the sweep, next to the store watcher
    expect(src.indexOf("webServer.once('listening', afterListening)")).toBeGreaterThan(web)
    expect(src).toContain('if (webServer.listening) afterListening()')
    expect(src.indexOf('armDecaySweep()', src.indexOf('const afterListening = (): void => {'))).toBeGreaterThan(web)
    expect(src).toContain('if (stopDecaySweep) stopDecaySweep()')
  })

  it('the stamp file is a system file for the store watcher (not an audited write)', () => {
    expect(code('store-watcher.ts')).toContain(`'${DECAY_SWEEP_STAMP_FILE}'`)
  })
})
