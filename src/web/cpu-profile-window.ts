import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Session } from 'node:inspector/promises'
import { logger } from '../logger.js'

// A one-off CPU profile of the dashboard's main thread for a set window (card
// ea6f9b07). A 12-hour stall measurement found about 821 s of main-thread
// JavaScript; sampling /proc gives that total but not the functions behind it.
// V8's own sampling profiler gives the functions. It runs in-process through
// node:inspector (no inspector port is opened), and only when the operator
// sets MARVEEN_CPU_PROFILE_WINDOW before a start, e.g.
//
//   MARVEEN_CPU_PROFILE_WINDOW=2026-10-17T08:00:00Z/3600/10000
//
// start (UTC, to the second) / length in seconds / sampling interval in
// microseconds (optional, default 10000). The profile is written to
// store/cpu-profiles/ as a .cpuprofile (the Chrome DevTools format);
// scripts/cpu-profile-summary.ts ranks it (src/web/cpu-profile-summary.ts). A bad value is logged and ignored:
// this never stops the dashboard.

export type CpuProfileWindow = { startMs: number; seconds: number; intervalUs: number }

export const CPU_PROFILE_ENV = 'MARVEEN_CPU_PROFILE_WINDOW'
export const CPU_PROFILE_MAX_SECONDS = 4 * 3600
export const CPU_PROFILE_DEFAULT_INTERVAL_US = 10_000
// setTimeout fires at once for a delay above 2^31-1 ms (~24.8 days).
const MAX_TIMER_DELAY_MS = 2 ** 31 - 1

export function parseCpuProfileWindow(raw: string | undefined): CpuProfileWindow | { error: string } | null {
  if (raw == null || raw.trim() === '') return null
  const m = raw.trim().match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z)\/(\d+)(?:\/(\d+))?$/)
  if (!m) return { error: 'expected <start, UTC: YYYY-MM-DDTHH:MM:SSZ>/<seconds>[/<interval us>]' }
  const startMs = Date.parse(m[1])
  // Date.parse rolls an impossible day over (2026-02-30 -> March 2), so the
  // value must read back as written.
  if (!Number.isFinite(startMs) || new Date(startMs).toISOString().replace('.000Z', 'Z') !== m[1]) {
    return { error: 'the start is not a real UTC time' }
  }
  const seconds = Number(m[2])
  if (seconds < 1 || seconds > CPU_PROFILE_MAX_SECONDS) return { error: `the length must be 1..${CPU_PROFILE_MAX_SECONDS} seconds` }
  const intervalUs = m[3] === undefined ? CPU_PROFILE_DEFAULT_INTERVAL_US : Number(m[3])
  if (intervalUs < 100 || intervalUs > 1_000_000) return { error: 'the interval must be 100..1000000 microseconds' }
  return { startMs, seconds, intervalUs }
}

type Sleep = (ms: number) => Promise<void>
const unrefSleep: Sleep = (ms) => new Promise<void>((resolve) => { setTimeout(resolve, ms).unref() })

export async function runCpuProfile(
  seconds: number,
  intervalUs: number,
  outDir: string,
  label: string,
  sleep: Sleep = unrefSleep,
): Promise<string> {
  const session = new Session()
  session.connect()
  try {
    await session.post('Profiler.enable')
    await session.post('Profiler.setSamplingInterval', { interval: intervalUs })
    await session.post('Profiler.start')
    await sleep(seconds * 1000)
    const { profile } = await session.post('Profiler.stop')
    mkdirSync(outDir, { recursive: true })
    const file = join(outDir, `cpu-${label}.cpuprofile`)
    writeFileSync(`${file}.tmp`, JSON.stringify(profile))
    renameSync(`${file}.tmp`, file)
    return file
  } finally {
    session.disconnect()
  }
}

export type ScheduledCpuProfile = { delayMs: number; seconds: number; intervalUs: number; label: string }

// What to run, given the env value and the current time; null means nothing
// (no value, a bad value, a window already over, or one too far ahead).
export function planCpuProfileWindow(raw: string | undefined, now: number): ScheduledCpuProfile | null {
  const w = parseCpuProfileWindow(raw)
  if (w == null) return null
  if ('error' in w) {
    logger.warn({ value: raw, reason: w.error }, `${CPU_PROFILE_ENV} ignored`)
    return null
  }
  const endMs = w.startMs + w.seconds * 1000
  if (endMs <= now) {
    logger.warn({ value: raw }, `${CPU_PROFILE_ENV} ignored: the window is over`)
    return null
  }
  const delayMs = Math.max(0, w.startMs - now)
  if (delayMs > MAX_TIMER_DELAY_MS) {
    logger.warn({ value: raw }, `${CPU_PROFILE_ENV} ignored: the start is more than 24 days ahead`)
    return null
  }
  const from = Math.max(now, w.startMs)
  return {
    delayMs,
    seconds: Math.ceil((endMs - from) / 1000),
    intervalUs: w.intervalUs,
    label: new Date(from).toISOString().replace(/[:.]/g, '-'),
  }
}

export function scheduleCpuProfileWindow(raw: string | undefined, outDir: string, now = Date.now()): NodeJS.Timeout | null {
  const plan = planCpuProfileWindow(raw, now)
  if (plan == null) return null
  logger.info({ startsInMs: plan.delayMs, seconds: plan.seconds, intervalUs: plan.intervalUs }, 'CPU profile window scheduled')
  const timer = setTimeout(() => {
    runCpuProfile(plan.seconds, plan.intervalUs, outDir, plan.label)
      .then((file) => logger.info({ file, seconds: plan.seconds }, 'CPU profile written'))
      .catch((err) => logger.warn({ err }, 'CPU profile failed'))
  }, plan.delayMs)
  timer.unref()
  return timer
}
