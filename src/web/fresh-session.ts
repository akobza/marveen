// cc457550 (a9c75fd8): a scheduled round of the main agent in a FRESH session of its own.
//
// Why: the main agent's scheduled rounds ran inside its long-running channel session, at a 450-630k context; the
// kanban-audit alone is a 21.7 KB prompt four times a day (a9c75fd8). A task with freshSession: true gets a tmux
// session per occurrence instead, and that session stops when the round ends (schedule-runner's in-flight sweep).
//
// What the session shares with the main one, and what it does not ("the same cwd, CLAUDE.md, hooks and
// permissions, WITHOUT the channel plugin"):
//   - SHARED: the cwd (PROJECT_ROOT, so the project CLAUDE.md and the .claude/settings.json hooks load), the config dir
//     and its auth (scripts/main-agent-isolated-config.mjs, the helper channels.sh uses), the model (the caller passes
//     readConfiguredMainModel, which mirrors channels.sh), the custom-provider env (scripts/main-agent-custom-provider.mjs,
//     also channels.sh's), the pane auth file and the MCP env channels.sh exports, --dangerously-skip-permissions.
//   - NOT: the channel plugin. No --channels, and every CHANNEL_PLUGIN_IDS entry is disabled for this session only, via
//     --settings (a second getUpdates poller on the owner's bot is the 409 that killed the live channel; agent-worker.ts).
//     EXTRA_SETTINGS_FLAG is left out for the same reason: it only switches channel plugins ON. TELEGRAM_STATE_DIR too:
//     a scheduled round has no channel turn.
//   - ADDED: MARVEEN_SESSION_ROLE=scheduled, which exactly five continuity hooks read to stand aside (inbox-drain,
//     ledger-replay, taskstate-replay, clear-replay, telegram-reply-guard), and --session-id <uuid>: the
//     round's own transcript, because the main session writes its transcripts into the same project directory and the
//     sweep's "did a turn happen" probe must not read the main session's work as this round's.
import { spawnSync, execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { CHANNEL_PLUGIN_IDS } from './plugin-ids.js'
import { projectsDirFor } from './active-model.js'
import { exactTmuxTarget } from '../tmux-target.js'

export const FRESH_SESSION_PREFIX = 'sched-'
export const SESSION_ROLE_ENV = 'MARVEEN_SESSION_ROLE'
export const SESSION_ROLE_SCHEDULED = 'scheduled'

// The exports channels.sh puts in front of the main session (MCP_BATCH_ENV, scripts/channels.sh). A contract test
// compares the two, so a key added there and not here turns red instead of drifting silently.
export const MCP_BATCH_ENV =
  'export CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION=false CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY=1 CLAUDE_CODE_DISABLE_AGENT_VIEW=1 ' +
  'MCP_SERVER_CONNECTION_BATCH_SIZE=10 MCP_CONNECTION_NONBLOCKING=1 MCP_TIMEOUT=60000 && ' +
  '{ [ "$(id -u)" != 0 ] || export IS_SANDBOX=1; } && '

/** sched-<agent>-<task>, with anything tmux or a shell could misread replaced. The tmux server and its session names
 *  are shared by every install and test tree on the host; the agent id keeps one install's rounds apart from another's. */
export function freshSessionName(taskName: string, agentId: string): string {
  return FRESH_SESSION_PREFIX + `${agentId}-${taskName}`.replace(/[^A-Za-z0-9_-]/g, '-')
}

export function isFreshSessionName(name: string): boolean {
  return name.startsWith(FRESH_SESSION_PREFIX)
}

function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

/** Session-scoped settings: every channel plugin off, and the bypass-permissions warning answered (as the worker's). */
export function freshSessionSettingsJson(): string {
  const enabledPlugins: Record<string, boolean> = {}
  for (const id of Object.values(CHANNEL_PLUGIN_IDS)) enabledPlugins[id] = false
  return JSON.stringify({ enabledPlugins, skipDangerousModePermissionPrompt: true })
}

/** The main agent's config dir, as channels.sh resolves it ("<mode>\t<path>[\t<secret>]" on fd 3), or null. */
export interface MainConfig { mode: 'explicit' | 'rotated' | 'isolated' | 'token'; dir: string; tokenSecret?: string }

export function parseMainConfigContract(raw: string): MainConfig | null {
  const line = raw.split('\n').find(l => /^(explicit|rotated|isolated|token)\t\//.test(l))
  if (!line) return null
  const [mode, dir, secret] = line.split('\t')
  return { mode: mode as MainConfig['mode'], dir, ...(mode === 'token' && secret ? { tokenSecret: secret } : {}) }
}

export interface FreshLaunchInputs {
  installDir: string          // PROJECT_ROOT: the cwd and the install the helpers belong to
  claudeBin: string
  nodeBin: string
  config: MainConfig | null   // null: the shared ~/.claude, as channels.sh without a contract line
  customProviderEnv: string   // main-agent-custom-provider.mjs output, '' when none
  model: string               // '' leaves --model off, as channels.sh does
  sessionId: string
}

/** The pane command of a fresh scheduled session: the main launch line, minus the channel, plus the role and the id. */
export function buildFreshPaneCommand(i: FreshLaunchInputs): string {
  const store = join(i.installDir, 'store')
  const authFile = join(store, '.channels-pane-auth')
  let cfg = ''
  if (i.config) {
    cfg = `export CLAUDE_CONFIG_DIR=${shq(i.config.dir)} && `
    if (i.config.mode === 'isolated') {
      cfg += `export CLAUDE_CODE_OAUTH_TOKEN="$(cat ${shq(join(store, '.claude-oauth-token'))})" && `
    } else if (i.config.mode === 'token') {
      cfg += `_plan_token="$(${shq(i.nodeBin)} ${shq(join(i.installDir, 'scripts', 'resolve-plan-token-env.mjs'))} ` +
        `${shq(i.config.tokenSecret ?? '')} ${shq(join(store, '.claude-oauth-token'))} ${shq(join(store, 'channels-failures.log'))})" && ` +
        `export CLAUDE_CODE_OAUTH_TOKEN="$_plan_token" && `
    }
  }
  const flags = [
    '--dangerously-skip-permissions',
    `--session-id ${shq(i.sessionId)}`,
    `--settings ${shq(freshSessionSettingsJson())}`,
    ...(i.model ? [`--model ${shq(i.model)}`] : []),
  ].join(' ')
  return `{ [ ! -f ${shq(authFile)} ] || . ${shq(authFile)}; } && ${cfg}${i.customProviderEnv}${MCP_BATCH_ENV}` +
    `export ${SESSION_ROLE_ENV}=${SESSION_ROLE_SCHEDULED} && cd ${shq(i.installDir)} && exec ${shq(i.claudeBin)} ${flags}`
}

/** Where the fresh session's transcript will be: <config dir or ~/.claude>/projects/<cwd slug>/<session id>.jsonl. */
export function freshTranscriptPath(installDir: string, config: MainConfig | null, sessionId: string): string {
  return join(projectsDirFor(installDir, config?.dir), `${sessionId}.jsonl`)
}

export interface FreshLaunchDeps {
  installDir: string
  claudeBin: string | null
  nodeBin: string | null
  tmuxBin: string
  channelProvider: string   // channels.sh passes $CHANNEL_PROVIDER to the config helper
  model: () => string
  // Seams for the tests; the defaults run the real helpers and tmux.
  runHelper?: (script: string, args: string[], fd3: boolean) => { status: number | null; out: string }
  tmux?: (args: string[]) => void
  uuid?: () => string
  isBuilt?: (distWebFile: string) => boolean   // default: <installDir>/dist/web/<file> exists
}

export interface FreshLaunch { ok: true; session: string; sessionId: string; transcriptPath: string }
export interface FreshLaunchError { ok: false; session: string; error: string }

function defaultRunHelper(nodeBin: string, installDir: string) {
  return (script: string, args: string[], fd3: boolean) => {
    const r = spawnSync(nodeBin, [join(installDir, 'scripts', script), ...args], {
      cwd: installDir, timeout: 20000, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
    })
    const out = fd3 ? String((r.output?.[3] as unknown) ?? '') : String(r.stdout ?? '')
    return { status: r.status, out }
  }
}

/** Start the fresh session for one occurrence of `taskName`. Never throws; nothing is started on any failure. */
export function launchFreshSession(taskName: string, agentId: string, deps: FreshLaunchDeps): FreshLaunch | FreshLaunchError {
  const session = freshSessionName(taskName, agentId)
  if (!deps.claudeBin) return { ok: false, session, error: 'claude not found on PATH' }
  if (!deps.nodeBin) return { ok: false, session, error: 'node not found on PATH' }
  const run = deps.runHelper ?? defaultRunHelper(deps.nodeBin, deps.installDir)
  try {
    // As channels.sh: each helper runs only when the dist module it imports is built; without it the main launch keeps
    // the shared ~/.claude and no custom provider, and so does this one.
    const built = deps.isBuilt ?? ((rel: string) => existsSync(join(deps.installDir, 'dist', 'web', rel)))
    const config = built('agent-process.js')
      ? parseMainConfigContract(run('main-agent-isolated-config.mjs', [deps.channelProvider], true).out) : null
    if (config && !existsSync(config.dir)) return { ok: false, session, error: `config dir missing: ${config.dir}` }
    // channels.sh aborts on a non-zero exit here ("customProvider configured but broken"): never launch on a wrong backend.
    const cp = built('agent-process.js') && built('custom-providers.js') ? run('main-agent-custom-provider.mjs', [config?.dir ?? ''], false) : { status: 0, out: '' }
    if (cp.status !== 0) return { ok: false, session, error: `main-agent-custom-provider exited ${cp.status}` }
    const sessionId = (deps.uuid ?? randomUUID)()
    const cmd = buildFreshPaneCommand({
      installDir: deps.installDir, claudeBin: deps.claudeBin, nodeBin: deps.nodeBin, config,
      customProviderEnv: cp.out.trim() ? cp.out.trim().replace(/\s*$/, ' ') : '', model: deps.model(), sessionId,
    })
    const tmux = deps.tmux ?? ((args: string[]) => { execFileSync(deps.tmuxBin, args, { timeout: 10000 }) })
    tmux(['new-session', '-d', '-s', session, '-c', deps.installDir, 'bash', '-lc', cmd])
    return { ok: true, session, sessionId, transcriptPath: freshTranscriptPath(deps.installDir, config, sessionId) }
  } catch (err) {
    return { ok: false, session, error: err instanceof Error ? err.message : String(err) }
  }
}

/** The start directory of a tmux session (-c at launch), or null when there is no such session. */
export function tmuxSessionPath(tmuxBin: string, session: string): string | null {
  try {
    const out = execFileSync(tmuxBin, ['display-message', '-p', '-t', exactTmuxTarget(session), '#{session_path}'],
      { timeout: 5000, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] })
    return out.trim() || null
  } catch {
    return null
  }
}

/** Stop a fresh session -- only a sched-* name that THIS install started (its start directory is installDir): the tmux
 *  server is shared, and a test run or another install on the host must never stop a live round of this one. */
export function killFreshSession(
  tmuxBin: string, session: string, installDir: string,
  seams: { tmux?: (args: string[]) => void; pathOf?: (session: string) => string | null } = {},
): boolean {
  if (!isFreshSessionName(session)) return false
  if ((seams.pathOf ?? ((s: string) => tmuxSessionPath(tmuxBin, s)))(session) !== installDir) return false
  try {
    ;(seams.tmux ?? ((args: string[]) => { execFileSync(tmuxBin, args, { timeout: 5000, stdio: 'ignore' }) }))(['kill-session', '-t', exactTmuxTarget(session)])
    return true
  } catch {
    return false
  }
}

/** Every live sched-* session THIS install started (the startup sweep: after a restart nothing tracks them). */
export function listFreshSessions(tmuxBin: string, installDir: string, run?: () => string): string[] {
  try {
    const out = run ? run() : execFileSync(tmuxBin, ['list-sessions', '-F', '#{session_name}\t#{session_path}'],
      { timeout: 5000, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] })
    return out.split('\n').map(l => l.split('\t')).filter(([name, path]) => isFreshSessionName(name ?? '') && path === installDir).map(([name]) => name)
  } catch {
    return []
  }
}
