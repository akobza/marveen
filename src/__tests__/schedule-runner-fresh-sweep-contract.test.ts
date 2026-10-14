import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// cc457550: the in-flight sweep and the restart sweep each carry one fresh-session branch that no behavioural test
// reaches (they live inside startScheduleRunner's loop). Deleting any of them keeps every other test green while
// breaking the round's life cycle:
//   - sawTurn must read the fresh round's OWN transcript: the main session writes into the same project directory,
//     so the directory's newest file would report the main session's work as this round's and close it early;
//   - the closing decisions (done / abandoned, and lost) must stop the fresh session, or every round leaves a live
//     claude process behind;
//   - the restart sweep must stop orphaned sched-* sessions -- and only this install's (the tmux server is shared).
// Source contract, in the style of schedule-runner-main-agent-missing.test.ts.
// 856bc199: what each branch DOES (stopFreshRound, stopOrphanedFreshSessions, freshTranscriptMtime, freshInflightFields,
// handFreshSessionToSweep) is held by behaviour in prepare-fresh-session.test.ts; this file pins WHERE the loop and the
// delivery call them, which a behaviour test cannot reach without a live tmux.

const SRC = readFileSync(join(__dirname, '../web/schedule-runner.ts'), 'utf-8')

describe('schedule-runner: the fresh-session branches of the sweeps', () => {
  it('sawTurn reads the fresh round\'s own transcript when the entry has one', () => {
    const at = SRC.indexOf('lastMtimeSeen = entry.freshTranscript')
    expect(at).toBeGreaterThan(0)
    const branch = SRC.slice(at, at + 260)
    expect(branch).toMatch(/\? freshTranscriptMtime\(entry\.freshTranscript\)/)
    expect(branch).toMatch(/: readTranscriptMtimeAcrossConfigDirs\(entry\.workingDir, entry\.configDirs\)/)
  })

  it('done / abandoned stop the fresh session right after the entry is dropped', () => {
    expect(SRC).toMatch(/taskInflightMap\.delete\(key\)\n\s+stopFreshRound\(entry, decision\)/)
  })

  it('lost stops it too, so the retry launches a new session instead of reusing this one', () => {
    expect(SRC).toMatch(/taskInflightMap\.delete\(key\)\n\s+stopFreshRound\(entry, 'lost'\)/)
  })

  it('the restart sweep stops only this install\'s orphaned sched-* sessions', () => {
    // what it stops is held by behaviour (prepare-fresh-session.test.ts); that the restart runs it, here
    const start = SRC.indexOf('export function startScheduleRunner')
    const body = SRC.slice(start, start + 2500)
    expect(body).toMatch(/try \{\n\s+stopOrphanedFreshSessions\(\)\n\s+\} catch/)
    const at = SRC.indexOf('export function stopOrphanedFreshSessions')
    expect(at).toBeGreaterThan(0)
    const fn = SRC.slice(at, at + 400)
    expect(fn).toMatch(/listFreshSessions\(freshTmuxBin\(\), PROJECT_ROOT\)/)
    expect(fn).toMatch(/killFreshSession\(freshTmuxBin\(\), s, PROJECT_ROOT\)/)
  })

  it('the delivery records the fresh fields in the entry and hands the session to the sweep right after registering it', () => {
    // 856bc199: both helpers are held by behaviour; this pins that attemptFireTask calls them where it registers the round
    expect(SRC).toMatch(/\.\.\.freshInflightFields\(task, session\),\n\s+deliveryPending: true,\n\s+\}\n\s+taskInflightMap\.set\(`\$\{task\.name\}@\$\{agentName\}`, inflightEntry\)\n\s+handFreshSessionToSweep\(task, session\)\n/)
  })

  it('every kill in the runner is scoped to PROJECT_ROOT', () => {
    // the whole call line: `[^)]*` would stop at freshTmuxBin()'s own parenthesis
    const kills = SRC.match(/killFreshSession\(freshTmuxBin\(\)[^\n]*/g) ?? []
    expect(kills.length).toBeGreaterThanOrEqual(4)
    for (const k of kills) expect(k).toContain('PROJECT_ROOT')
  })
})
