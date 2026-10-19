import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { STORE_DIR } from './config.js'
import { DECAY_SWEEP_INTERVAL_MS } from './db.js'
import { logger } from './logger.js'

// When the daily decay sweep (memory.ts runDecaySweep) runs (card 75693151).
//
// WHY: it used to run synchronously at EVERY boot, before the web listener, and
// then every 24 h from the boot. On 2026-10-19 15:41Z, on a saturated disk, the
// boot sweep alone took 48.7 s; the health watchdog (2 x 60 s) restarted the
// instance before it ever listened. And because every boot swept, the "0.5% a
// day" salience decay ran once per RESTART (four times that day).
//
// NOW: the sweep is armed only after the listener is up, never sooner than
// DECAY_SWEEP_STARTUP_DELAY_MS after it, and the 24 h are counted from the last
// SUCCESSFUL sweep, which a store file keeps across restarts. A restart neither
// adds a decay nor pushes the daily round out.

/** The first sweep of a boot waits at least this long after the listener is up. */
export const DECAY_SWEEP_STARTUP_DELAY_MS = 10 * 60 * 1000

/** Epoch ms of the last successful sweep, one line. Listed in store-watcher.ts SYSTEM_FILES (not an audited file). */
export const DECAY_SWEEP_STAMP_FILE = '.decay-sweep-last'

/** Pure: ms until the next sweep. No stamp, an unreadable one or one in the future (a clock jump) = due, after the startup delay. */
export function decaySweepDelayMs(
  lastRunMs: number | null,
  nowMs: number,
  intervalMs: number = DECAY_SWEEP_INTERVAL_MS,
  startupDelayMs: number = DECAY_SWEEP_STARTUP_DELAY_MS,
): number {
  if (lastRunMs === null || !Number.isFinite(lastRunMs) || lastRunMs > nowMs) return startupDelayMs
  return Math.max(startupDelayMs, lastRunMs + intervalMs - nowMs)
}

export function readDecaySweepStamp(path: string = join(STORE_DIR, DECAY_SWEEP_STAMP_FILE)): number | null {
  try {
    const n = Number(readFileSync(path, 'utf-8').trim())
    return Number.isFinite(n) && n > 0 ? n : null
  } catch {
    return null
  }
}

export function writeDecaySweepStamp(ms: number, path: string = join(STORE_DIR, DECAY_SWEEP_STAMP_FILE)): void {
  const tmp = `${path}.tmp`
  writeFileSync(tmp, `${ms}\n`, { mode: 0o600 })
  renameSync(tmp, path)
}

export interface DecaySweepDeps {
  run: () => Promise<void>
  now: () => number
  readStamp: () => number | null
  writeStamp: (ms: number) => void
  setTimer: (fn: () => void, ms: number) => NodeJS.Timeout
  clearTimer: (t: NodeJS.Timeout) => void
}

/**
 * Arm the sweep; returns the stop function for shutdown. One timer at a time: the next one is armed only after a run has
 * finished, so two sweeps never overlap. A failed run writes no stamp and is retried one interval later, as the old
 * setInterval did.
 */
export function scheduleDecaySweep(deps: DecaySweepDeps): () => void {
  let timer: NodeJS.Timeout | null = null
  let stopped = false
  const arm = (ms: number): void => {
    if (stopped) return
    timer = deps.setTimer(() => { void tick() }, ms)
    logger.info({ inMinutes: Math.round(ms / 60_000) }, 'Memoria leepulesi sopres utemezve')
  }
  const tick = async (): Promise<void> => {
    timer = null
    let ok = false
    try {
      await deps.run()
      deps.writeStamp(deps.now())
      ok = true
    } catch (err) {
      logger.warn({ err }, 'Memoria leepulesi sopres hiba, egy ciklus mulva ujra')
    }
    arm(ok ? decaySweepDelayMs(deps.readStamp(), deps.now()) : DECAY_SWEEP_INTERVAL_MS)
  }
  arm(decaySweepDelayMs(deps.readStamp(), deps.now()))
  return () => {
    stopped = true
    if (timer) deps.clearTimer(timer)
    timer = null
  }
}
