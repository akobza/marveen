// Reap orphaned channel-plugin pollers (bun/node processes that survived a
// tmux kill-session or are left over from a previous agent crash).
//
// The bug we close (2026-06-01 incident, channel-disconnect roundtrip):
//   - stopAgentProcess used `pkill -f TELEGRAM_STATE_DIR=<dir>`, but the
//     plugin process argv is just `bun run --cwd .../telegram/0.0.6 start`
//     - the env var lives in /proc-equivalent environment storage, not argv,
//     so `pkill -f` never matches and the orphan keeps polling getUpdates
//     with the same bot token until SIGTERM by hand.
//   - startAgentProcess only killed the tmux session pre-launch and did NOT
//     reap orphans at all. After a restart the old poller raced the new one
//     and Telegram returned 409 Conflict in a loop.
//   - The plugin writes bot.pid in <chanDir>/bot.pid. That works on the
//     happy path but if a new poller crashed and a later one overwrote the
//     file, the older orphan is no longer in bot.pid - we miss it.
//
// Strategy: combine two identifiers.
//   1. bot.pid (cheap, works for the supervised process).
//   2. `ps eww -e` scan for the *_STATE_DIR=<chanDir> env-var match. This
//      catches orphans whose pid is no longer in bot.pid - any process that
//      was started against this channel state dir is in scope, regardless
//      of how its argv was rendered. macOS BSD ps emits each process's full
//      environment when invoked with `e`; we grep that.
//
// NARROWED 2026-09-24 (card cc4d0ddd): "any process that was started against
// this channel state dir" turned out to be far too wide. The state-dir variable
// is exported by the session launcher, so EVERY descendant of the owning agent
// inherits it: the agent's own claude, its Bash tools, builds, test databases,
// watchers -- and, when scripts/channels.sh starts the tmux server, the tmux
// SERVER itself. On 2026-09-24 12:23:28Z a stage-3 recovery reap on the main
// channel dir killed that tmux server (a fromEnvScan hit that was no pane
// leader), and with it every agent session on the host. Measured the same day
// on the live host: of the processes carrying TELEGRAM_STATE_DIR, all 10 real
// pollers also carried CLAUDE_PLUGIN_ROOT=.../telegram/<ver>, and none of the
// 27 others (bash, sleep, claude, postgres, node builds, watchers) did.
// So a candidate now needs BOTH markers (parseStateDirPollerPids), bot.pid is
// honoured only while that pid is still a plugin process (after a reboot a
// stale bot.pid can name a reused pid), and whatever the markers say, the tmux
// server, every live pane leader and the parent of every live pane leader are
// never signalled (protectedPidsForReap). Every signalled pid is logged with its
// command line (argv only, never the environment; secret-looking values masked).

import { execFileSync, execSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { ChannelProviderType } from '../channel-provider.js'
import { channelStateDir } from '../channel-provider.js'
import { logger } from '../logger.js'

const STATE_ENV_VAR: Record<ChannelProviderType, string> = {
  telegram: 'TELEGRAM_STATE_DIR',
  slack: 'SLACK_STATE_DIR',
  discord: 'DISCORD_STATE_DIR',
  googlechat: 'GOOGLECHAT_STATE_DIR',
  teams: 'TEAMS_STATE_DIR',
}

// Parse `ps eww -e` output and return every PID whose process environment
// contains `<envVar>=<value>`. Exported for testability.
//
// `ps eww -e` rows on macOS look like:
//   90798 s000  S+   0:00.01 bun run --cwd ... HOME=/Users/... TELEGRAM_STATE_DIR=/path... ...
// The match must be precise: substring `TELEGRAM_STATE_DIR=/path` against
// `TELEGRAM_STATE_DIR=/path-elsewhere` is acceptable because the value is an
// absolute path, but we still anchor on the env-var literal to avoid
// matching a row that just *mentions* the path string in its argv.
export function parsePollerPidsFromPs(
  psOutput: string,
  envVar: string,
  value: string,
): number[] {
  const needle = `${envVar}=${value}`
  const out: number[] = []
  for (const line of psOutput.split('\n')) {
    if (!line.includes(needle)) continue
    const m = line.match(/^\s*(\d+)\s/)
    if (!m) continue
    const pid = parseInt(m[1]!, 10)
    if (pid > 1) out.push(pid)
  }
  return out
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// The CLAUDE_PLUGIN_ROOT anchor for one provider: the env literal, then the
// provider dir segment ending on a path/version/space boundary, so `/telegram`
// does not match a longer sibling like `/telegram-inline`. Claude Code sets this
// variable only for the plugin server it spawns (and that server's children).
function pluginRootRegex(pluginRootNeedle: string): RegExp {
  return new RegExp(`CLAUDE_PLUGIN_ROOT=\\S*${escapeRe(pluginRootNeedle)}(?:[/@ ]|$)`)
}

/**
 * cc4d0ddd: the poller candidates of ONE channel state dir. A `ps eww -e` row
 * counts only if it carries BOTH the state-dir literal `<envVar>=<chanDir>`
 * (ending on whitespace or end of line, so `/x/telegram` does not also match
 * `/x/telegram-old`) AND the provider's CLAUDE_PLUGIN_ROOT anchor. The state-dir
 * variable alone is inherited by everything the owning agent starts (see the
 * header), so on its own it selects the agent's whole process tree, not its
 * poller. Exported for testability.
 */
export function parseStateDirPollerPids(
  psEwwOutput: string,
  envVar: string,
  chanDir: string,
  pluginRootNeedle: string,
): number[] {
  const rootRe = pluginRootRegex(pluginRootNeedle)
  const dirRe = new RegExp(`(?:^|\\s)${escapeRe(envVar)}=${escapeRe(chanDir)}(?:\\s|$)`)
  const out: number[] = []
  for (const line of psEwwOutput.split('\n')) {
    if (!dirRe.test(line) || !rootRe.test(line)) continue
    const m = line.match(/^\s*(\d+)\s/)
    if (!m) continue
    const pid = parseInt(m[1]!, 10)
    if (pid > 1) out.push(pid)
  }
  return out
}

/**
 * cc4d0ddd: is `pid`, in the same `ps eww -e` snapshot, a plugin process of the
 * provider (CLAUDE_PLUGIN_ROOT anchor present)? bot.pid is only trusted through
 * this check: after a reboot the file can still name a pid the kernel has since
 * handed to an unrelated process. Exported for testability.
 */
export function isPluginPollerPid(psEwwOutput: string, pid: number, pluginRootNeedle: string): boolean {
  const rootRe = pluginRootRegex(pluginRootNeedle)
  for (const line of psEwwOutput.split('\n')) {
    const m = line.match(/^\s*(\d+)\s/)
    if (m && parseInt(m[1]!, 10) === pid) return rootRe.test(line)
  }
  return false
}

function psEwwSnapshot(chanDir: string): string {
  try {
    return execSync('/bin/ps eww -e', { timeout: 5000, encoding: 'utf-8', maxBuffer: 8 * 1024 * 1024 })
  } catch (err) {
    logger.warn({ err, chanDir }, 'channel-poller-reap: ps scan failed')
    return ''
  }
}

function readBotPid(chanDir: string): number | null {
  const path = join(chanDir, 'bot.pid')
  if (!existsSync(path)) return null
  try {
    const pid = parseInt(readFileSync(path, 'utf-8').trim(), 10)
    return Number.isFinite(pid) && pid > 1 ? pid : null
  } catch {
    return null
  }
}

export interface ReapResult {
  reaped: number[]
  source: { fromBotPid: number | null; fromEnvScan: number[] }
  // Candidates that matched bot.pid/env-scan but were spared because they ARE a
  // live tmux pane's own leader process right now. Non-empty here is the exact
  // signature of the 2026-09-19 bug (card 08a02137): env-var inheritance makes a
  // pane's own claude process match its own *_STATE_DIR export, and killing it
  // here (instead of leaving it to the caller's imminent `respawn-pane -k`)
  // collapsed the pane before respawn-pane could run. Logged whenever non-empty
  // so a recurrence is visible instead of silently "just working".
  skippedLivePane: number[]
  // True when the tmux server itself matched the candidate sources and was
  // spared (TMUXSERVERREAP929). Killing it takes every agent session down.
  skippedTmuxServer?: boolean
  // cc4d0ddd: candidates spared as protected. Since TMUXSERVERREAP929 the
  // reapChannelOrphans guard is the tmux server check, so this holds the server
  // pid when it was a candidate (the 2026-09-24 12:23Z signature).
  skippedProtected: number[]
  // cc4d0ddd: processes that carry the state-dir variable but are not plugin
  // processes (the owning agent's own tree), plus a stale bot.pid. Spared by
  // design; the count is logged so the narrowing stays visible.
  skippedNotPoller: number[]
  // cc4d0ddd: every killed pid with its command line (argv, masked, bounded).
  reapedDetail: { pid: number; command: string }[]
  // 35ea0375: targets spared because another uid owns them, or their owner could not be read.
  skippedOtherUid: number[]
  skippedUnknownOwner: number[]
  // 35ea0375: the signal outcome by kind; `reaped` holds only the pids actually killed.
  killOutcome: KillOutcomes
}

// ---------------------------------------------------------------------------
// Down-verdict forensics (2026-07-14).
//
// The watchdog restarted agents ~10x/day on a "channel plugin down" verdict,
// and the restart DESTROYS the evidence: the poller is reaped, the session is
// respawned, and the post-mortem log says only "down -- auto-restarting". So
// the interesting question -- did the poller really die, or did the tree-walk
// lose a live one? -- could not be answered from the logs at all.
//
// This captures the state at the MOMENT the verdict is formed, before anything
// is torn down: is a poller process for this chanDir alive at all, is it in the
// claude process tree, and does bot.pid still point at it. One WARN per
// down-spell, so it costs a ps per spell, not per sweep.

export interface PollerEvidenceRow {
  pid: number
  ppid: number
  // Whether claudePid is an ancestor of this pid. FALSE with a live pid is the
  // interesting case: the poller exists but hangs outside the tree the liveness
  // probe walks (reparented / attached to a previous claude).
  inClaudeTree: boolean
}

export interface PollerEvidence {
  botPid: number | null
  botPidAlive: boolean
  // Pollers found by env-var scan, i.e. every process started against this
  // channel state dir regardless of parentage.
  envScanPids: number[]
  rows: PollerEvidenceRow[]
  // The verdict this evidence supports, spelled out so the log line is readable
  // without re-deriving it:
  //   'no-poller'      -> nothing alive: the plugin really did die.
  //   'orphaned'       -> a live poller exists but is NOT under claude.
  //   'in-tree'        -> a live poller IS under claude: the probe was WRONG.
  interpretation: 'no-poller' | 'orphaned' | 'in-tree'
}

// Pure core: exported for tests (no ps, no fs).
export function buildPollerEvidence(
  procs: ProcRow[],
  botPid: number | null,
  envScanPids: number[],
  claudePid: number,
): PollerEvidence {
  const byPid = new Map<number, ProcRow>()
  for (const p of procs) byPid.set(p.pid, p)

  const isUnderClaude = (pid: number): boolean => {
    let cur = pid
    const seen = new Set<number>()
    for (let hops = 0; hops < 8; hops++) {
      if (cur === claudePid) return true
      if (seen.has(cur)) break
      seen.add(cur)
      const next = byPid.get(cur)?.ppid
      if (next === undefined || next === cur || next <= 1) break
      cur = next
    }
    return false
  }

  const candidates = new Set<number>(envScanPids)
  if (botPid != null) candidates.add(botPid)

  const rows: PollerEvidenceRow[] = []
  for (const pid of candidates) {
    const row = byPid.get(pid)
    if (!row) continue // not in the ps snapshot -> dead
    rows.push({ pid, ppid: row.ppid, inClaudeTree: isUnderClaude(pid) })
  }

  const interpretation: PollerEvidence['interpretation'] = rows.length === 0
    ? 'no-poller'
    : rows.some((r) => r.inClaudeTree) ? 'in-tree' : 'orphaned'

  return {
    botPid,
    botPidAlive: botPid != null && byPid.has(botPid),
    envScanPids,
    rows,
    interpretation,
  }
}

// Collect the evidence for one agent. Call this ONCE per down-spell, at the
// first down observation, BEFORE any teardown.
export function collectPollerEvidence(
  provider: ChannelProviderType,
  agentDirPath: string,
  claudePid: number,
): PollerEvidence {
  const chanDir = channelStateDir(provider, agentDirPath)
  return buildPollerEvidence(
    snapshotProcs(),
    readBotPid(chanDir),
    // Evidence only, nothing is signalled here: kept on the state-dir-only
    // match it always used (cc4d0ddd narrowed the REAP paths, not this one).
    parsePollerPidsFromPs(psEwwSnapshot(chanDir), STATE_ENV_VAR[provider], chanDir),
    claudePid,
  )
}

// ---------------------------------------------------------------------------
// Own-uid guard and kill outcomes (card 35ea0375).
//
// The process tables the reapers read are host-wide: `ps -axww` and `ps eww -e`
// list every user's processes. A detached `claude --channels` that belongs to
// ANOTHER user on the same host therefore passed the orphan test, its SIGTERM
// failed with EPERM, the catch read that as "already gone", and the log said
// "killed" for the same pids every cycle while they lived on. Two rules close it:
//   - every kill path signals only processes owned by the dashboard's own uid
//     (the owner of /proc/<pid>; `ps -o uid=` where there is no /proc). The rest
//     is skipped, and the skips are ONE count per reap call, not a line per pid;
//   - each signal's outcome is kept by kind (ok / ESRCH / EPERM / other), and a
//     pid counts as killed only when a signal of ours reached it and it is gone
//     or got SIGKILL. The returned and the logged `reaped` lists are those pids.

const HAS_PROC = existsSync('/proc/self')

/**
 * The owner uid of a process: the owner of /proc/<pid> where /proc exists, else
 * `ps -o uid= -p <pid>`. null when it cannot be read (the process is gone, or
 * neither source answers); such a pid is never signalled. Exported for testability.
 */
export function processOwnerUid(pid: number): number | null {
  if (HAS_PROC) {
    try { return statSync(`/proc/${pid}`).uid } catch { return null }
  }
  try {
    const out = execFileSync('/bin/ps', ['-o', 'uid=', '-p', String(pid)], { timeout: 3000, encoding: 'utf-8' }).trim()
    return /^\d+$/.test(out) ? Number(out) : null
  } catch { return null }
}

/** The dashboard's own uid; null where the platform has none (then nothing is signalled). */
function dashboardUid(): number | null {
  return typeof process.getuid === 'function' ? process.getuid() : null
}

export interface OwnerSplit {
  // owned by the dashboard's uid: the only pids a reaper may signal
  own: number[]
  // owned by another uid: skipped
  foreign: number[]
  // the owner could not be read (gone, or no source answered): skipped
  unknown: number[]
}

/** Pure: split candidate pids by owner against `uid` (null: nothing is ours). Exported for testability. */
export function splitByOwner(
  pids: number[],
  uid: number | null,
  ownerOf: (pid: number) => number | null = processOwnerUid,
): OwnerSplit {
  const split: OwnerSplit = { own: [], foreign: [], unknown: [] }
  for (const pid of pids) {
    const owner = uid === null ? null : ownerOf(pid)
    if (owner === null) split.unknown.push(pid)
    else if (owner === uid) split.own.push(pid)
    else split.foreign.push(pid)
  }
  return split
}

export type SignalOutcome = 'ok' | 'ESRCH' | 'EPERM' | 'other'
export type KillFn = (pid: number, signal: NodeJS.Signals | 0) => void

const processKill: KillFn = (pid, signal) => { process.kill(pid, signal) }

/**
 * One signal and its outcome by kind: process.kill throws ESRCH for a pid that is
 * gone and EPERM for one this user may not signal. Exported for testability.
 */
export function sendSignal(pid: number, signal: NodeJS.Signals | 0, kill: KillFn = processKill): SignalOutcome {
  try {
    kill(pid, signal)
    return 'ok'
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    return code === 'ESRCH' || code === 'EPERM' ? code : 'other'
  }
}

export interface KillOutcomes {
  // a signal of ours reached the pid, and it is gone or got SIGKILL
  killed: number[]
  // ESRCH on the first SIGTERM: it was gone before we signalled
  alreadyGone: number[]
  // EPERM: not ours to signal
  permissionDenied: number[]
  // any other failure
  failed: number[]
}

/** Test seams of the reapers (35ea0375): the owner lookup, the own uid and the signal function. */
export interface ReapSeams {
  ownerOf?: (pid: number) => number | null
  ownUid?: number | null
  kill?: KillFn
}

function pauseForFlush(): void {
  try { execFileSync('/bin/sleep', ['0.3'], { timeout: 2000 }) } catch { /* ignore */ }
}

/**
 * SIGTERM every pid, give bun/node ~300ms to flush, then SIGKILL any survivor,
 * keeping each pid's outcome by kind. `kill` and `pause` are test seams.
 * Exported for testability.
 */
export function terminatePids(pids: number[], deps: { kill?: KillFn; pause?: () => void } = {}): KillOutcomes {
  const kill = deps.kill ?? processKill
  const out: KillOutcomes = { killed: [], alreadyGone: [], permissionDenied: [], failed: [] }
  const notKilled = (pid: number, outcome: SignalOutcome) => {
    if (outcome === 'EPERM') out.permissionDenied.push(pid)
    else out.failed.push(pid)
  }
  const termed: number[] = []
  for (const pid of pids) {
    const sent = sendSignal(pid, 'SIGTERM', kill)
    if (sent === 'ok') termed.push(pid)
    else if (sent === 'ESRCH') out.alreadyGone.push(pid)
    else notKilled(pid, sent)
  }
  if (termed.length === 0) return out
  const pause = deps.pause ?? pauseForFlush
  pause()
  for (const pid of termed) {
    const probe = sendSignal(pid, 0, kill)
    if (probe === 'ESRCH') { out.killed.push(pid); continue } // our SIGTERM ended it
    if (probe !== 'ok') { notKilled(pid, probe); continue }
    const sigkill = sendSignal(pid, 'SIGKILL', kill)
    if (sigkill === 'ok' || sigkill === 'ESRCH') out.killed.push(pid) // delivered, or it died just now
    else notKilled(pid, sigkill)
  }
  return out
}

/** The outcome counts by kind for a log line. */
function outcomeByKind(o: KillOutcomes): { ok: number; ESRCH: number; EPERM: number; other: number } {
  return { ok: o.killed.length, ESRCH: o.alreadyGone.length, EPERM: o.permissionDenied.length, other: o.failed.length }
}

/** One line per reap call for the spared owners: counts only, never a line per pid. */
function logOwnerSkips(where: Record<string, unknown>, split: OwnerSplit): void {
  if (split.foreign.length === 0 && split.unknown.length === 0) return
  logger.info({ ...where, skippedOtherUid: split.foreign.length, skippedUnknownOwner: split.unknown.length },
    'channel-poller-reap: spared processes not owned by this user (35ea0375)')
}

/** The signalled pids that were NOT killed, with the outcome by kind (warn when a signal was refused or failed). */
function logNotKilled(where: Record<string, unknown>, o: KillOutcomes): void {
  const notKilled = [...o.alreadyGone, ...o.permissionDenied, ...o.failed]
  if (notKilled.length === 0) return
  const unexpected = o.permissionDenied.length + o.failed.length > 0
  const line = { ...where, notKilled, outcome: outcomeByKind(o) }
  const msg = 'channel-poller-reap: signalled pid(s) not killed, outcome by kind'
  if (unexpected) logger.warn(line, msg)
  else logger.info(line, msg)
}

/**
 * Reap every channel-plugin poller process associated with this agent.
 * Combines bot.pid (cheap, supervised pid) with a `ps eww -e` env-var scan
 * (catches orphans whose pid is no longer in bot.pid). SIGTERM first; after
 * a short grace period, SIGKILL any survivor. Safe to call multiple times
 * (process.kill on a missing pid is caught). Signals only processes of the
 * dashboard's own uid, and `reaped` lists only the pids actually killed (35ea0375).
 */
export function reapChannelOrphans(
  provider: ChannelProviderType,
  agentDirPath: string,
  opts: { tmuxPath?: string } & ReapSeams = {},
): ReapResult {
  const chanDir = channelStateDir(provider, agentDirPath)
  const envVar = STATE_ENV_VAR[provider]
  const needle = PLUGIN_ROOT_NEEDLE[provider]

  // cc4d0ddd: both sources are narrowed to plugin processes (see the header).
  const psEww = psEwwSnapshot(chanDir)
  const botPid = readBotPid(chanDir)
  const fromBotPid = botPid !== null && isPluginPollerPid(psEww, botPid, needle) ? botPid : null
  const fromEnvScan = parseStateDirPollerPids(psEww, envVar, chanDir, needle)
  const skippedNotPoller = parsePollerPidsFromPs(psEww, envVar, chanDir).filter((pid) => !fromEnvScan.includes(pid))
  if (botPid !== null && fromBotPid === null && !skippedNotPoller.includes(botPid)) skippedNotPoller.push(botPid)

  // Deduplicate while preserving order so the bot.pid path is logged first.
  const candidates: number[] = []
  const seen = new Set<number>()
  for (const pid of [fromBotPid, ...fromEnvScan]) {
    if (pid && !seen.has(pid)) {
      seen.add(pid)
      candidates.push(pid)
    }
  }

  // Never kill a pid that IS a live tmux pane's own leader process right now.
  // `export VAR=x && exec claude` makes VAR visible in claude's OWN environment
  // too, not just a spawned poller child's -- so the env-var scan (and, for the
  // main session, even bot.pid) can match the pane's own claude process, not
  // just its poller. Killing that pid here -- instead of leaving it to the
  // caller's imminent `tmux respawn-pane -k`, which is built to replace exactly
  // that process cleanly -- races the respawn and can collapse the pane first
  // (no remain-on-exit -> pane death takes the whole session with it). A
  // grandchild poller (the bun/node child under it) is NOT a pane leader and
  // stays a normal reap target, which is the whole point of reaping here rather
  // than relying on respawn-pane -k alone.
  //
  // Fail-SAFE, not fail-open (Logra's review, 2026-09-19, same card 08a02137):
  // an empty `live` set means the tmux query itself failed (a real server
  // always has at least one pane), not "nothing is live". Treating that as
  // "nothing to protect" would silently reproduce the exact bug this function
  // exists to fix. So an unresolved live-pane set aborts the kill entirely,
  // mirroring reapDetachedChannelClaudes's own fail-safe (`live.size === 0` ->
  // reap nothing) instead of contradicting it.
  //
  // cc4d0ddd had its own server guard here (selectReapTargets: the parents of live
  // pane leaders and every tmux binary). TMUXSERVERREAP929 below resolves the server
  // pid from tmux itself and supersedes it on this path; the helpers stay exported
  // (reapDetachedChannelClaudes still filters through protectedPidsForReap).
  const live = livePanePids(opts.tmuxPath ?? 'tmux')
  const liveQueryFailed = live.size === 0
  const skippedLivePane = liveQueryFailed ? [] : candidates.filter((pid) => live.has(pid))
  if (liveQueryFailed && candidates.length > 0) {
    logger.warn({ provider, chanDir, candidates },
      'channel-poller-reap: could not resolve live tmux panes, refusing to reap (fail-safe)')
  }

  // Never kill the tmux SERVER either (TMUXSERVERREAP929). When channels.sh
  // creates the server itself (after a host reboot it usually does: it runs
  // `tmux start-server` with the state-dir var already exported), the server
  // process carries TELEGRAM_STATE_DIR in its own environment, so the env scan
  // matches it. Killing it tears down EVERY agent's pane on the host, not just
  // this one's poller. Measured 2026-09-28 12:47, 14:47 and 2026-09-29 04:31:
  // the reap's `reaped` list held the server pid (the parent of every pane),
  // the next `tmux list-panes` answered "no server running", and the whole
  // fleet died and came back only through the service manager.
  // Fail-safe like the live-pane guard: an unresolved server pid refuses the
  // reap instead of guessing, because the guess is exactly the fleet kill.
  const serverPid = liveQueryFailed ? null : tmuxServerPid(opts.tmuxPath ?? 'tmux')
  const serverQueryFailed = !liveQueryFailed && serverPid === null
  if (serverQueryFailed && candidates.length > 0) {
    logger.warn({ provider, chanDir, candidates },
      'channel-poller-reap: could not resolve the tmux server pid, refusing to reap (fail-safe)')
  }
  const skippedTmuxServer = serverPid !== null && candidates.includes(serverPid) && !live.has(serverPid)
  const all = liveQueryFailed || serverQueryFailed
    ? []
    : candidates.filter((pid) => !live.has(pid) && pid !== serverPid)
  if (skippedTmuxServer) {
    logger.warn({ provider, chanDir, serverPid, fromBotPid, fromEnvScan },
      'channel-poller-reap: candidate IS the tmux server, sparing it (killing it would take down every agent session)')
  }

  // cc4d0ddd: the process table, taken BEFORE any signal, only for the logged
  // command lines (argv, masked); skippedProtected reports the spared server.
  const procs = all.length > 0 || skippedTmuxServer ? snapshotProcs() : []
  const skippedProtected = skippedTmuxServer && serverPid !== null ? [serverPid] : []

  // 35ea0375: only this user's processes are signalled. SIGTERM, give bun/node
  // ~300ms to flush, then SIGKILL stragglers; the outcome is kept by kind.
  const owners = splitByOwner(all, opts.ownUid === undefined ? dashboardUid() : opts.ownUid, opts.ownerOf)
  logOwnerSkips({ provider, chanDir }, owners)
  const killOutcome = terminatePids(owners.own, { kill: opts.kill })
  const reaped = killOutcome.killed

  const commandOf = new Map(procs.map((p) => [p.pid, p.command] as const))
  const detail = (pid: number) => ({ pid, command: commandForLog(commandOf.get(pid) ?? '?') })
  const reapedDetail = reaped.map(detail)
  if (reaped.length > 0) {
    logger.info({ provider, chanDir, reaped, reapedDetail, outcome: outcomeByKind(killOutcome), fromBotPid, fromEnvScan },
      'channel-poller-reap: orphans killed')
  }
  logNotKilled({ provider, chanDir }, killOutcome)
  if (skippedLivePane.length > 0) {
    logger.warn({ provider, chanDir, skippedLivePane, fromBotPid, fromEnvScan },
      'channel-poller-reap: candidate IS a live pane leader, sparing it (respawn-pane will replace it)')
  }
  if (skippedNotPoller.length > 0) {
    logger.info({ provider, chanDir, skippedNotPoller: skippedNotPoller.length },
      'channel-poller-reap: spared processes that carry the state dir but are not plugin processes (cc4d0ddd)')
  }
  return {
    reaped,
    source: { fromBotPid, fromEnvScan },
    skippedLivePane,
    skippedTmuxServer,
    skippedProtected,
    skippedNotPoller,
    reapedDetail,
    skippedOtherUid: owners.foreign,
    skippedUnknownOwner: owners.unknown,
    killOutcome,
  }
}

/**
 * cc4d0ddd: pids a channel reap must never signal, whatever their environment
 * or argv say:
 *   - every live tmux pane leader (the 08a02137 rule; the caller's
 *     `respawn-pane -k` replaces those cleanly),
 *   - the parent of every live pane leader: that is the tmux server (2026-09-24
 *     12:23Z: it inherited TELEGRAM_STATE_DIR from channels.sh, the env scan
 *     matched it, and killing it took down every session on the host),
 *   - every process whose argv[0] basename is `tmux` (a server whose panes could
 *     not be listed, or a client).
 * Exported for testability.
 */
export function protectedPidsForReap(procs: ProcRow[], livePanePids: Set<number>): Set<number> {
  const byPid = new Map(procs.map((p) => [p.pid, p] as const))
  const out = new Set<number>(livePanePids)
  for (const pane of livePanePids) {
    const parent = byPid.get(pane)?.ppid
    if (parent !== undefined && parent > 1) out.add(parent)
  }
  for (const p of procs) {
    if (argv0Base(p.command) === 'tmux') out.add(p.pid)
  }
  return out
}

/**
 * cc4d0ddd: split the candidates into the ones to signal and the ones spared.
 * An empty live-pane set or an empty process table means a query failed (a real
 * host always has both), so nothing is reaped: without them the protected set
 * cannot be built. Exported for testability.
 */
export function selectReapTargets(
  candidates: number[],
  procs: ProcRow[],
  livePanePids: Set<number>,
): { reap: number[]; skippedLivePane: number[]; skippedProtected: number[]; failSafe: boolean } {
  if (livePanePids.size === 0 || procs.length === 0) {
    return { reap: [], skippedLivePane: [], skippedProtected: [], failSafe: true }
  }
  const prot = protectedPidsForReap(procs, livePanePids)
  return {
    reap: candidates.filter((pid) => !prot.has(pid)),
    skippedLivePane: candidates.filter((pid) => livePanePids.has(pid)),
    skippedProtected: candidates.filter((pid) => prot.has(pid) && !livePanePids.has(pid)),
    failSafe: false,
  }
}

/**
 * cc4d0ddd: a command line fit for the dashboard log: argv only (callers pass
 * `ps -o command`, never the environment), secret-looking assignments and
 * bearer values masked, bounded. Exported for testability.
 */
export function commandForLog(command: string): string {
  return command
    .replace(/((?:TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|AUTH)[A-Z0-9_]*=)\S+/gi, '$1<redacted>')
    .replace(/(Bearer\s+)\S+/gi, '$1<redacted>')
    .slice(0, 240)
}

// ---------------------------------------------------------------------------
// Detached channel CLAUDE reaper (the parent-process leak, 2026-06-03).
//
// reapChannelOrphans (above) kills bun/node POLLERS by env-var scan + bot.pid.
// That works for sub-agents (their claude+poller carry TELEGRAM_STATE_DIR=<dir>)
// but MISSES the main channels session entirely: channels.sh launches the main
// `claude --channels` with NO *_STATE_DIR export (the plugin uses its default
// dir), so neither the main claude nor its poller match the env needle, and the
// plugin never writes bot.pid. When a --continue respawn (channel-monitor
// respawn-pane / agent-process start) fails to tear down the prior claude, the
// detached claude survives -- reparented to the tmux server -- and keeps a bun
// poller hitting getUpdates on the SHARED bot token. 5 such orphans accumulated
// over 13 days, each 409-racing the live poller (token churn + a self-feeding
// agent thrash-restart loop). See project_channels_continue_respawn_leak.
//
// Identification is by tmux-pane attribution, NOT env/argv heuristics (cmdline
// alone cannot tell a live agent claude from a detached one -- see
// feedback_verify_session_before_kill): a `claude --channels` process is an
// orphan iff neither its pid nor any ancestor pid is a LIVE tmux pane pid.
//   - main session: tmux runs claude as the pane leader, so claudePid == panePid.
//   - sub-agents:   tmux runs `sh -c "...claude..."`, so the pane pid is the sh
//                   and claude is its child -> ancestor walk catches it.
// The tmux SERVER process is excluded up front: its argv embeds the full
// `new-session ... claude --channels ...` string, a false positive, but argv[0]
// is tmux, not claude.

export interface ProcRow { pid: number; ppid: number; command: string }

// argv[0] basename === 'claude' (the binary), so the tmux server row whose argv
// merely *contains* the claude command string is excluded.
function argv0Base(command: string): string {
  const argv0 = command.trim().split(/\s+/, 1)[0] ?? ''
  return argv0.split('/').pop() ?? ''
}

function isClaudeBinary(command: string): boolean {
  return argv0Base(command) === 'claude'
}

/**
 * Pure: return the pids of `claude --channels` processes that are NOT attached
 * to any live tmux pane (orphans). `livePanePids` is the set of pane pids from
 * `tmux list-panes -a`. `channelNeedle` optionally restricts to one plugin
 * (e.g. 'plugin:telegram@...'); when omitted, every channel plugin is in scope.
 * Exported for testability.
 */
export function findOrphanChannelClaudes(
  procs: ProcRow[],
  livePanePids: Set<number>,
  channelNeedle?: string,
): number[] {
  const byPid = new Map<number, ProcRow>()
  for (const p of procs) byPid.set(p.pid, p)

  const attachedToLivePane = (pid: number): boolean => {
    let cur = pid
    const seen = new Set<number>()
    for (let hops = 0; hops < 8; hops++) {
      if (livePanePids.has(cur)) return true
      if (seen.has(cur)) break
      seen.add(cur)
      const next = byPid.get(cur)?.ppid
      if (next === undefined || next === cur || next <= 1) break
      cur = next
    }
    return false
  }

  const orphans: number[] = []
  for (const p of procs) {
    if (!p.command.includes('--channels')) continue
    if (!isClaudeBinary(p.command)) continue
    if (channelNeedle && !p.command.includes(channelNeedle)) continue
    if (attachedToLivePane(p.pid)) continue
    orphans.push(p.pid)
  }
  return orphans
}

function snapshotProcs(): ProcRow[] {
  try {
    const out = execSync('/bin/ps -axww -o pid=,ppid=,command=', { timeout: 5000, encoding: 'utf-8', maxBuffer: 8 * 1024 * 1024 })
    const rows: ProcRow[] = []
    for (const line of out.split('\n')) {
      const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/)
      if (!m) continue
      rows.push({ pid: parseInt(m[1]!, 10), ppid: parseInt(m[2]!, 10), command: m[3]! })
    }
    return rows
  } catch (err) {
    logger.warn({ err }, 'channel-poller-reap: ps -axww snapshot failed')
    return []
  }
}

// The tmux server's own pid, or null when it cannot be resolved.
function tmuxServerPid(tmuxPath: string): number | null {
  try {
    const out = execSync(`${tmuxPath} display-message -p '#{pid}'`, { timeout: 5000, encoding: 'utf-8' })
    const n = parseInt(out.trim().split('\n')[0] ?? '', 10)
    return Number.isFinite(n) && n > 1 ? n : null
  } catch (err) {
    logger.warn({ err }, 'channel-poller-reap: tmux display-message failed')
    return null
  }
}

function livePanePids(tmuxPath: string): Set<number> {
  try {
    const out = execSync(`${tmuxPath} list-panes -a -F '#{pane_pid}'`, { timeout: 5000, encoding: 'utf-8' })
    const s = new Set<number>()
    for (const line of out.split('\n')) {
      const n = parseInt(line.trim(), 10)
      if (Number.isFinite(n) && n > 1) s.add(n)
    }
    return s
  } catch (err) {
    logger.warn({ err }, 'channel-poller-reap: tmux list-panes failed')
    return new Set()
  }
}

function killBunChildren(claudePid: number, uid: number | null, seams: ReapSeams): void {
  try {
    const out = execSync(`/usr/bin/pgrep -P ${claudePid} bun`, { timeout: 3000, encoding: 'utf-8' })
    const children = out.split('\n').map((line) => parseInt(line.trim(), 10)).filter((pid) => Number.isFinite(pid) && pid > 1)
    // 35ea0375: the same own-uid rule as for the claude itself.
    for (const pid of splitByOwner(children, uid, seams.ownerOf).own) sendSignal(pid, 'SIGTERM', seams.kill)
  } catch { /* no bun children (pgrep exits 1) */ }
}

/**
 * Reap detached `claude --channels` orphans (parent-process leak). SAFE to call
 * before any (re)spawn: it spares every claude attached to a live tmux pane, so
 * it never kills the active session or a live sibling agent -- only truly
 * detached leftovers. Kills each orphan's bun poller children first, then the
 * claude (SIGTERM, ~300ms grace, SIGKILL stragglers). Signals only processes of
 * the dashboard's own uid (35ea0375). Returns the pids actually killed.
 *
 * tmuxPath defaults to a bare `tmux` (resolved on PATH); callers that already
 * hold an absolute path should pass it.
 */
export function reapDetachedChannelClaudes(opts: { channelNeedle?: string; tmuxPath?: string } & ReapSeams = {}): number[] {
  const tmuxPath = opts.tmuxPath ?? 'tmux'
  const procs = snapshotProcs()
  const live = livePanePids(tmuxPath)
  // No live panes resolved (tmux query failed) -> refuse to reap: without the
  // live set we cannot tell orphans from the active session. Fail safe.
  if (live.size === 0) {
    logger.warn('channel-poller-reap: no live panes resolved, skipping detached-claude reap (fail-safe)')
    return []
  }
  // cc4d0ddd: the same never-signal set as reapChannelOrphans. The orphan test
  // already requires argv[0] == claude, so the tmux server cannot be selected
  // today; this keeps it that way if the selection ever widens.
  const prot = protectedPidsForReap(procs, live)
  const orphans = findOrphanChannelClaudes(procs, live, opts.channelNeedle).filter((pid) => !prot.has(pid))
  // 35ea0375: the process table is host-wide; only this user's orphans are signalled.
  const uid = opts.ownUid === undefined ? dashboardUid() : opts.ownUid
  const owners = splitByOwner(orphans, uid, opts.ownerOf)
  const where = { channelNeedle: opts.channelNeedle ?? '(all)' }
  logOwnerSkips(where, owners)
  for (const pid of owners.own) killBunChildren(pid, uid, opts)
  const killOutcome = terminatePids(owners.own, { kill: opts.kill })
  if (killOutcome.killed.length > 0) {
    const commandOf = new Map(procs.map((p) => [p.pid, p.command] as const))
    const reapedDetail = killOutcome.killed.map((pid) => ({ pid, command: commandForLog(commandOf.get(pid) ?? '?') }))
    logger.info({ reaped: killOutcome.killed, reapedDetail, outcome: outcomeByKind(killOutcome), ...where },
      'channel-poller-reap: detached channel claudes killed')
  }
  logNotKilled(where, killOutcome)
  return killOutcome.killed
}

// ---------------------------------------------------------------------------
// Foreign MAIN-token poller reaper (2026-07-18 incident: the main bot went
// silent for ~half an afternoon).
//
// The two reapers above share a blind spot that this one closes:
//
//   reapChannelOrphans          -> matches by <PROVIDER>_STATE_DIR=<chanDir>.
//     The MAIN channels session is launched by channels.sh with NO
//     TELEGRAM_STATE_DIR export (the plugin falls back to its default dir,
//     ~/.claude/channels/<provider>), so the main poller carries no state-dir
//     needle and is invisible to that env scan.
//   reapDetachedChannelClaudes  -> matches `claude --channels` processes not
//     attached to a live pane. A THIEF here is NOT a `--channels` session: it
//     is a plain local-agent-mode / CLI `claude` running in the project cwd,
//     which AUTO-LOADS the telegram plugin because the PROJECT settings.json
//     has enabledPlugins.telegram=true. Its argv has no `--channels`, so that
//     reaper never even considers it.
//
// Net effect: a local-agent-mode subagent (e.g. one the main session's own
// Agent/Task tool spawns) loads the plugin with the DEFAULT state dir, grabs
// the MAIN bot token, and long-polls getUpdates alongside the legit poller ->
// 409 Conflict -> the main bot silently drops inbound. The existing
// down-recovery restarts the VICTIM (the legit session), never the THIEF, so
// the outage persists until the thief happens to exit.
//
// This reaper targets exactly that class: a poller bound to the MAIN (default)
// state dir -- i.e. WITHOUT a <PROVIDER>_STATE_DIR override, which cleanly
// excludes every sub-agent -- whose owning `claude` process is NOT the pane
// leader of the main channels session. The legit main poller's nearest claude
// ancestor IS the channels pane pid; a thief's nearest claude ancestor is the
// local-agent-mode claude (a DESCENDANT of the pane, but not the pane leader).
// So pane-pid EQUALITY -- not mere descent -- is the discriminator (the thief
// is a descendant of the channels pane too, so an "ancestor includes pane"
// test would wrongly spare it).

// argv[0] basename of the CLAUDE_PLUGIN_ROOT plugin dir per provider. The
// telegram plugin cache path ends in `.../telegram/<ver>`; slack-channel in
// `.../slack-channel/<ver>`; etc.
const PLUGIN_ROOT_NEEDLE: Record<ChannelProviderType, string> = {
  telegram: '/telegram',
  slack: '/slack-channel',
  discord: '/discord',
  googlechat: '/googlechat',
  teams: '/teams',
}

// Candidate = a poller bound to the MAIN default state dir: its env carries
// CLAUDE_PLUGIN_ROOT=.../<provider>/<ver> but NO <PROVIDER>_STATE_DIR override
// (the override is exactly what every sub-agent sets, so its absence isolates
// the main-dir pollers). Exported for testability.
export function parseMainDirPollerPids(
  psEwwOutput: string,
  pluginRootNeedle: string, // e.g. '/telegram'
  stateEnvVar: string,      // e.g. 'TELEGRAM_STATE_DIR'
): number[] {
  const rootRe = pluginRootRegex(pluginRootNeedle)
  const out: number[] = []
  for (const line of psEwwOutput.split('\n')) {
    if (!rootRe.test(line)) continue
    if (line.includes(`${stateEnvVar}=`)) continue // sub-agent override -> not main dir
    const m = line.match(/^\s*(\d+)\s/)
    if (!m) continue
    const pid = parseInt(m[1]!, 10)
    if (pid > 1) out.push(pid)
  }
  return out
}

// Nearest ancestor whose argv[0] basename is `claude`. Null if none is found
// within the hop budget (a cycle-guarded 8-hop walk). Exported for testability.
export function nearestClaudeAncestor(pid: number, byPid: Map<number, ProcRow>): number | null {
  const seen = new Set<number>()
  let cur = byPid.get(pid)?.ppid
  for (let hops = 0; hops < 8; hops++) {
    if (cur === undefined || cur <= 1 || seen.has(cur)) break
    seen.add(cur)
    const row = byPid.get(cur)
    if (row && isClaudeBinary(row.command)) return cur
    cur = row?.ppid
  }
  return null
}

/**
 * Pure: from the candidate MAIN-dir poller pids, return those whose owning
 * claude (nearest claude ancestor) is NOT a legit main-session pane leader.
 *
 * Fail-safe on two fronts:
 *   - legitClaudePids empty (the main channels session could not be resolved)
 *     -> return [] : without the legit set we cannot tell the real poller from
 *     a thief, and killing the real one would take the bot down.
 *   - a candidate whose owning claude cannot be resolved -> skipped : we never
 *     kill on an ambiguous parent chain.
 * Exported for testability.
 */
export function findForeignMainPollers(
  candidatePollerPids: number[],
  procs: ProcRow[],
  legitClaudePids: Set<number>,
): number[] {
  if (legitClaudePids.size === 0) return []
  const byPid = new Map<number, ProcRow>()
  for (const p of procs) byPid.set(p.pid, p)
  const out: number[] = []
  for (const pid of candidatePollerPids) {
    const owner = nearestClaudeAncestor(pid, byPid)
    if (owner == null) continue
    if (legitClaudePids.has(owner)) continue
    out.push(pid)
  }
  return out
}

function mainSessionPanePids(session: string, tmuxPath: string): Set<number> {
  try {
    const out = execSync(`${tmuxPath} list-panes -t ${session} -F '#{pane_pid}'`, { timeout: 5000, encoding: 'utf-8' })
    const s = new Set<number>()
    for (const line of out.split('\n')) {
      const n = parseInt(line.trim(), 10)
      if (Number.isFinite(n) && n > 1) s.add(n)
    }
    return s
  } catch {
    // Session absent OR tmux query failed -> empty set -> caller fails safe.
    return new Set()
  }
}

/**
 * Reap foreign pollers contending for the MAIN bot token (see the block comment
 * above). SIGTERM -> ~300ms grace -> SIGKILL stragglers. Kills only the poller
 * process, never its owning claude (a real Agent/Task subagent may still be
 * doing legit work -- it just must not hold the main channel's poller). Returns
 * the pids killed; signals only processes of the dashboard's own uid (35ea0375).
 * Fail-safe: does nothing when the main session can't be resolved or the ps/tmux
 * snapshot fails.
 */
export function reapForeignMainPollers(opts: {
  provider: ChannelProviderType
  mainSession: string
  tmuxPath?: string
} & ReapSeams): number[] {
  const tmuxPath = opts.tmuxPath ?? 'tmux'
  const legit = mainSessionPanePids(opts.mainSession, tmuxPath)
  if (legit.size === 0) return [] // fail-safe: cannot distinguish legit from thief

  let psEww: string
  try {
    psEww = execSync('/bin/ps eww -e', { timeout: 5000, encoding: 'utf-8', maxBuffer: 8 * 1024 * 1024 })
  } catch (err) {
    logger.warn({ err }, 'channel-poller-reap: ps eww scan failed (foreign-main reap skipped)')
    return []
  }
  const candidates = parseMainDirPollerPids(psEww, PLUGIN_ROOT_NEEDLE[opts.provider], STATE_ENV_VAR[opts.provider])
  if (candidates.length === 0) return []

  const foreign = findForeignMainPollers(candidates, snapshotProcs(), legit)
  // 35ea0375: only this user's pollers are signalled; the outcome is kept by kind.
  const owners = splitByOwner(foreign, opts.ownUid === undefined ? dashboardUid() : opts.ownUid, opts.ownerOf)
  const where = { provider: opts.provider, mainSession: opts.mainSession }
  logOwnerSkips(where, owners)
  const killOutcome = terminatePids(owners.own, { kill: opts.kill })
  if (killOutcome.killed.length > 0) {
    logger.info(
      { ...where, reaped: killOutcome.killed, outcome: outcomeByKind(killOutcome), legit: [...legit] },
      'channel-poller-reap: foreign main-token poller(s) killed (thief contending for the main bot token)',
    )
  }
  logNotKilled(where, killOutcome)
  return killOutcome.killed
}
