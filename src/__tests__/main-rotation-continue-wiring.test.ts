import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

// 962faa19: the continue restart's steps are tested with stubs in main-rotation-continue.test.ts;
// what binds them is channel-monitor.ts, which needs tmux. Two wiring mutants would stay green
// there: a restartMainForRotationContinue that never reads the session after the resume (a
// --continue without a conversation would again be reported as 'continue'), and a post-resume
// guard that does not stand down after the rotation's fresh fallback (it would judge the new,
// still-booting session at 90 s and could tear it down).

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const MONITOR_SRC = readFileSync(join(REPO_ROOT, 'src', 'web', 'channel-monitor.ts'), 'utf-8')

// A top-level function's text: from its header to the first closing brace at column 0.
function fnText(header: string): string {
  const start = MONITOR_SRC.indexOf(header)
  expect(start, header).toBeGreaterThan(-1)
  const end = MONITOR_SRC.indexOf('\n}\n', start)
  expect(end, header).toBeGreaterThan(start)
  return MONITOR_SRC.slice(start, end)
}

describe('restartMainForRotationContinue wiring (962faa19)', () => {
  const src = fnText('export function restartMainForRotationContinue(')

  it('reads the main session after the resume: the survival probe on the real session and pane', () => {
    expect(src).toContain('survived: () => continueSurvived({')
    expect(src).toContain('sessionExists: mainChannelsSessionExists,')
    expect(src).toContain('claudePid: () => getClaudePidForSession(MAIN_CHANNELS_SESSION),')
  })

  it('a fresh fallback retires the pending post-resume guard', () => {
    expect(src).toContain('standDownResumeGuard: () => { postResumeGuardEpoch++ }')
  })
})

describe('the post-resume guard stands down once the rotation replaced the session (962faa19)', () => {
  const src = fnText('function schedulePostResumePluginGuard(')

  it('takes the epoch when it is scheduled, not when it fires', () => {
    const taken = src.indexOf('const epoch = postResumeGuardEpoch')
    expect(taken).toBeGreaterThan(-1)
    expect(taken).toBeLessThan(src.indexOf('setTimeout('))
  })

  it('compares it first, before it reads the pane or escalates', () => {
    const check = src.indexOf('if (epoch !== postResumeGuardEpoch) {')
    expect(check).toBeGreaterThan(src.indexOf('setTimeout('))
    expect(check).toBeLessThan(src.indexOf('getClaudePidForSession('))
    expect(check).toBeLessThan(src.indexOf('respawnMarveenSessionFresh()'))
  })

  it('only the rotation fallback bumps the epoch: the other recovery paths keep the guard as it was', () => {
    expect(MONITOR_SRC.split('postResumeGuardEpoch++').length - 1).toBe(1)
  })
})
