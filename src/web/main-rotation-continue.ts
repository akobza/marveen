// 8c338dc4: the opt-in "continue" variant of the main agent's plan rotation
// (POST /api/claude-plans/rotate with "continue": true).
//
// The default rotation restarts the main session FRESH (hardRestartMarveenChannels).
// The continue variant restarts it through the existing --continue path
// (resumeMarveenSession: respawn-pane, the two reaps, the first-run-picker guard,
// the resume-summary modal, the identity and plugin follow-ups, the post-resume
// plugin guard), so the agent picks up the SAME conversation. The new plan's
// credentials still apply: the respawn command resolves CLAUDE_CONFIG_DIR and the
// token from the rotation state at respawn time, and the route writes that state
// before it restarts.
//
// Two things decide whether --continue can find that conversation, and both are
// checked BEFORE the route writes anything:
//   1. the CLAUDE_CONFIG_DIR must not change: --continue reads
//      <config dir>/projects/<encoded project>/. Every token-mode plan shares the
//      one generic isolated dir, so a token-to-token switch keeps it; a plan with
//      its own configDir does not, and --continue there would resume a stale
//      conversation of that dir, or nothing at all. Neither does a first plan
//      assignment without the fleet token: until then the main agent runs on the
//      shared ~/.claude, and the token-mode plan moves it to the isolated dir.
//   2. there must be a prior conversation in that dir: without one claude --continue
//      prints "No conversation found" and exits at once. The conversation is a
//      transcript, not the folder (962faa19): the same encoded project dir also holds
//      memory/ and per-session folders, so a dir with only those exists and still has
//      nothing to resume (see hasClaudeTranscript).
//
// And one thing only the restart itself can show: whether the resumed session is still
// there a few seconds later (continueSurvived, 962faa19). respawn-pane returning means
// the command was started, not that the conversation continued.
import { readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { encodeClaudeProjectDir } from '../claude-project-dir.js'

export type ContinueBlockReason = 'config-dir-changes' | 'no-prior-session'
export type ContinueVerdict = { ok: true } | { ok: false; reason: ContinueBlockReason }

/**
 * 962faa19: does this encoded project dir hold a conversation claude --continue can resume?
 * Claude Code keeps each conversation as <session id>.jsonl at the top of the dir; the
 * memory/ folder and the per-session folders next to them are not conversations. So: at
 * least one non-empty regular *.jsonl file there. A dir that cannot be read counts as none,
 * the same answer as a missing one -- the caller then refuses the continue loudly instead
 * of starting a --continue that exits.
 */
export function hasClaudeTranscript(dir: string): boolean {
  try {
    return readdirSync(dir, { withFileTypes: true }).some((entry) => {
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) return false
      try { return statSync(join(dir, entry.name)).size > 0 } catch { return false }
    })
  } catch {
    return false
  }
}

export function mainRotationContinueVerdict(input: {
  /** resolveMainAgentConfigDir(): an explicit MAIN_AGENT_CONFIG_DIR wins over any rotation, before and after. */
  explicitDir: string | null
  /** resolveMainAgentRotatedConfigDir(), read BEFORE the rotation state is written: the active plan's own configDir. */
  activeRotatedDir: string | null
  /** resolveMainAgentRotatedTokenSecretId() !== null, read BEFORE the write: the active plan is a token-mode plan. */
  activeIsTokenPlan: boolean
  /** hasFleetOauthToken(): with no active plan, the main agent has the isolated dir only with the fleet token. */
  fleetToken: boolean
  /** The target plan's own configDir; null for a token-mode plan. */
  targetConfigDir: string | null
  /** The generic isolated dir every token-mode plan shares (mainAgentSharedConfigDir()). */
  sharedDir: string
  /** The main session's working directory, whose encoding names the transcript dir. */
  projectRoot: string
  /** Defaults to hasClaudeTranscript; injected in the tests. */
  hasTranscript?: (dir: string) => boolean
}): ContinueVerdict {
  // The dir now and the dir after the switch, in resolveMainConfigDecision()'s order (the route has
  // already required MAIN_AGENT_ISOLATED_CONFIG=1): the explicit dir, else the plan's own configDir,
  // else the shared isolated dir -- which, with no active plan, needs the fleet token; without it the
  // main agent runs on the shared ~/.claude (null), and no plan can keep that.
  const before = input.explicitDir ?? input.activeRotatedDir
    ?? (input.activeIsTokenPlan || input.fleetToken ? input.sharedDir : null)
  const after = resolve(input.explicitDir ?? input.targetConfigDir ?? input.sharedDir)
  if (before === null || resolve(before) !== after) return { ok: false, reason: 'config-dir-changes' }
  const hasTranscript = input.hasTranscript ?? hasClaudeTranscript
  const transcripts = join(after, 'projects', encodeClaudeProjectDir(input.projectRoot))
  if (!hasTranscript(transcripts)) return { ok: false, reason: 'no-prior-session' }
  return { ok: true }
}

export type SurvivalVerdict = { ok: true } | { ok: false; reason: string }

/** Reads of the main session after the --continue respawn, and the gap before each. */
export const CONTINUE_SURVIVAL_READS = 3
export const CONTINUE_SURVIVAL_GAP_MS = 3000

/**
 * 962faa19: did the resumed session survive? A --continue that finds no conversation exits at
 * once, and with it the pane and the session go away (channels.sh starts the session without
 * remain-on-exit). Read the session a few times: gone at any read, or no claude process in the
 * pane at the last one, means the conversation did not continue. The reads are injected
 * (channel-monitor.ts binds tmux), so this runs without tmux in the tests.
 */
export async function continueSurvived(probe: {
  sessionExists: () => boolean
  claudePid: () => number | null
  wait: (ms: number) => Promise<void>
  reads?: number
  gapMs?: number
}): Promise<SurvivalVerdict> {
  const reads = probe.reads ?? CONTINUE_SURVIVAL_READS
  const gapMs = probe.gapMs ?? CONTINUE_SURVIVAL_GAP_MS
  for (let i = 0; i < reads; i++) {
    await probe.wait(gapMs)
    if (!probe.sessionExists()) return { ok: false, reason: 'the main session is gone' }
  }
  if (probe.claudePid() == null) return { ok: false, reason: 'no claude process in the main pane' }
  return { ok: true }
}

export type ContinueRestartResult =
  | { ok: true; mode: 'continue' | 'fresh-fallback' }
  | { ok: false; mode: 'fresh-fallback'; error: string }

/**
 * The restart itself, with its steps injected so it can be tested without tmux
 * (channel-monitor.ts binds the real ones: restartMainForRotationContinue).
 * The consent stamp first, as hardRestartMarveenChannels does (FABLEFALL1): the
 * respawned claude boots from the same shared roots either way. When the resume
 * fails (e.g. the pane is gone), or the resumed session does not survive its first
 * seconds (962faa19), the fresh hard restart is the fallback: it still lands on the
 * new plan, only the conversation is not kept, and the result says so. A resumed
 * session that is already gone was reported as 'continue' before, and only the
 * post-resume guard (90 s later) brought a session back.
 *
 * After a fresh fallback, the guard the resume scheduled can still be pending, and it
 * would check the NEW session against a question about the old one: a channels.sh
 * cold start takes minutes, so at 90 s it can look deaf and be torn down again.
 * standDownResumeGuard retires it.
 */
export async function runMainContinueRestart(steps: {
  stampConsent: () => void
  resume: () => Promise<boolean>
  survived: () => Promise<SurvivalVerdict>
  fresh: () => { ok: boolean; error?: string }
  standDownResumeGuard: () => void
  warn: (message: string) => void
}): Promise<ContinueRestartResult> {
  try { steps.stampConsent() } catch { /* backstop handlers remain, as in hardRestartMarveenChannels */ }
  if (await steps.resume()) {
    let alive: SurvivalVerdict
    try { alive = await steps.survived() } catch { alive = { ok: false, reason: 'the survival probe failed' } }
    if (alive.ok) return { ok: true, mode: 'continue' }
    steps.warn(`Claude plan rotation: the --continue session did not survive (${alive.reason}), falling back to a fresh restart (the new plan still applies)`)
  } else {
    steps.warn('Claude plan rotation: the --continue resume failed, falling back to a fresh restart (the new plan still applies)')
  }
  const r = steps.fresh()
  // Only a fresh restart that took over retires the guard: when it failed too, the guard is
  // the next chance to bring a session back.
  if (r.ok) steps.standDownResumeGuard()
  return r.ok
    ? { ok: true, mode: 'fresh-fallback' }
    : { ok: false, mode: 'fresh-fallback', error: r.error || 'Main agent restart failed' }
}
