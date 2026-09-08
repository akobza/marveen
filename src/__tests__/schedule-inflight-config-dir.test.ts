import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveAgentConfigDirForRead } from '../web/claude-plans.js'
import { inflightConfigDirFor } from '../web/schedule-runner.js'
import { MAIN_AGENT_ID } from '../config.js'
import { resolveClaudeConfigDir } from '../web/agent-config.js'
import { readTranscriptMtimeFromProjectDir, projectsDirFor } from '../web/active-model.js'

// The post-fire watchdog's sawTurn probe, and why the config dir it is handed
// decides whether the probe can see anything at all.
//
// THE BUG (measured 2026-09-04). The in-flight entry took its configDir from
// readAgentClaudeConfigDir, which reads ONLY the `claudeConfigDir` field of
// agent-config.json. Since the fleet auth rule (2026-07-01) that field must NOT
// be set: every agent's config dir is AUTO-PROVISIONED at
// <agentDir>/.claude-config. So the read returned null, the entry stored
// `undefined`, and readTranscriptMtimeFromProjectDir fell back to
// ~/.claude/projects/<encoded-workingDir> -- a path that does not exist for
// such an agent. The probe therefore returned null on EVERY sweep, sawTurn
// stayed false, and decideTaskTimeout ruled 'lost' for any task that finished
// between two sweeps. That is every FAST task: the pane is idle before the
// injection, briefly busy, and idle again long before the next sample.
//
// The consequence was a re-fire loop with no backoff. On cortex-voip-insight it
// produced 2069 false-lost re-injections in 24 hours from a */5 task (288
// expected), a 7.5x amplification that had been running unnoticed since
// 2026-08-27 -- while `fired` rows kept the run log looking healthy.
//
// The fix reuses resolveAgentConfigDirForRead, which the context-guard and
// restart-gate runners already used for exactly this reason. These tests pin
// the mechanism (the probe can find a transcript) rather than only the call.

describe('in-flight watchdog: config dir for the sawTurn transcript probe', () => {
  let root: string
  const AGENT = 'fixture-agent'
  let agentPath: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'inflight-config-dir-'))
    agentPath = join(root, 'agents', AGENT)
    mkdirSync(agentPath, { recursive: true })
    // Config file WITHOUT claudeConfigDir -- what the fleet auth rule mandates.
    writeFileSync(join(agentPath, 'agent-config.json'), JSON.stringify({ displayName: 'Fixture', model: 'claude-sonnet-5' }))
    // The auto-provisioned config dir, with the transcript where Claude Code
    // actually writes it: <configDir>/projects/<encoded workingDir>/*.jsonl
    const projects = projectsDirFor(agentPath, join(agentPath, '.claude-config'))
    mkdirSync(projects, { recursive: true })
    writeFileSync(join(projects, 'session.jsonl'), '{"type":"turn"}\n')
  })

  afterEach(() => { rmSync(root, { recursive: true, force: true }) })

  it('resolves the auto-provisioned dir even though the config field is absent', () => {
    expect(resolveAgentConfigDirForRead(AGENT, root)).toBe(join(agentPath, '.claude-config'))
  })

  it('the field-only read returns null here -- that null was the bug', () => {
    // Not a criticism of the field read: null is its correct answer (there IS
    // no override field). It is the wrong QUESTION for a transcript reader,
    // which is the whole point of the fix. resolveClaudeConfigDir is the pure
    // core of readAgentClaudeConfigDir, so this pins the behaviour without
    // reaching into the real agents/ tree.
    const raw = readFileSync(join(agentPath, 'agent-config.json'), 'utf-8')
    expect(resolveClaudeConfigDir(raw, root)).toBeNull()
  })

  it('the probe SEES the transcript with the resolved dir, and is blind without it', () => {
    const resolved = resolveAgentConfigDirForRead(AGENT, root) ?? undefined
    expect(readTranscriptMtimeFromProjectDir(agentPath, resolved)).toBeGreaterThan(0)
    // undefined => ~/.claude/projects/<encoded>, which does not exist for an
    // auto-provisioned agent. A null here is what kept sawTurn false forever.
    expect(readTranscriptMtimeFromProjectDir(agentPath, undefined)).toBeNull()
  })

  // BEHAVIOUR, not source text (fejlesztes-vezeto's request, 2026-09-07): the MAIN agent
  // must come back with its ISOLATED dir when that dir exists. This is the assertion the
  // source-match below cannot make -- it fails on the VALUE, not on the wording.
  it('the MAIN agent resolves to its ISOLATED dir, not to the shared root', () => {
    const mainIsolated = join(root, '.channels-config')
    mkdirSync(join(mainIsolated, 'projects'), { recursive: true })
    // `undefined` here is the 2026-09-04 bug: it sends the transcript probe to the shared
    // ~/.claude, whose mtime never advances under MAIN_AGENT_ISOLATED_CONFIG -- and that
    // recorded 217 completed runs out of 459 as 'lost'.
    expect(inflightConfigDirFor(MAIN_AGENT_ID, root)).toBe(mainIsolated)
  })

  it('a SUB-agent still resolves to its own auto-provisioned dir -- one call, both kinds', () => {
    expect(inflightConfigDirFor(AGENT, root)).toBe(join(agentPath, '.claude-config'))
  })

  it('fix-revert guard: the entry resolves the config dir, it does not read the field', () => {
    const src = readFileSync(join(__dirname, '../web/schedule-runner.ts'), 'utf-8')
    // UPDATED 2026-09-07: this guard used to require the `agentName === MAIN_AGENT_ID
    // ? undefined :` special case. That special case became WRONG when
    // resolveAgentConfigDirForRead learned to resolve the MAIN agent too (card
    // main-agent-config-dir-for-read, 2026-09-04): hardcoding `undefined` for the main
    // agent is exactly the shared-~/.claude read the function exists to prevent, and it
    // is what recorded 217 completed runs out of 459 as 'lost' in 2.5 hours.
    // So the guard now pins the SIMPLE form, and the special case is what must not return.
    // The guard was not wrong when written -- it went stale when the function it guards
    // grew a capability. A fix-revert guard has to be re-read whenever its subject changes.
    expect(src).toMatch(/configDir: inflightConfigDirFor\(agentName\)/)
    expect(src).not.toMatch(/configDir: agentName === MAIN_AGENT_ID \? undefined/)
    // and the helper itself must stay a pass-through
    expect(src).toMatch(/return resolveAgentConfigDirForRead\(agentName, root\) \?\? undefined/)
    //
    // ⛔ WHY A SOURCE MATCH SURVIVES HERE, next to the behaviour cases above, rather than
    // being replaced by them: the two catch DIFFERENT failures. The behaviour cases fail if
    // the HELPER's logic goes wrong. This match fails if the call site BYPASSES the helper
    // -- e.g. someone inlines `undefined` again at the entry. A behaviour test on the helper
    // cannot see a caller that stopped calling it, and that is the exact blind spot that let
    // the 2026-09-04 bug live behind five green resolver tests.
    // Behaviour for the logic, source for the wiring. Neither alone is enough.
    // The old call must be gone entirely: leaving it importable invites the
    // revert, and no other site in this file needs it.
    expect(src).not.toMatch(/readAgentClaudeConfigDir\(/)
  })
})
