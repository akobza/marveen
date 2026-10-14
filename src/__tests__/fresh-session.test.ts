// cc457550: src/web/fresh-session.ts builds the pane command of a scheduled round's FRESH session -- the main agent's
// launch line from scripts/channels.sh minus the channel -- and starts, stops and lists sched-* sessions.
// Unit half: the pure pieces and the launch's failure paths, with the helpers and tmux injected.
// Contract half: the pieces this module mirrors are read out of channels.sh, so a change there that this file does not
// follow turns red instead of drifting (same cwd, CLAUDE.md, hooks and permissions, no channel plugin).
import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  FRESH_SESSION_PREFIX, MCP_BATCH_ENV, SESSION_ROLE_ENV, SESSION_ROLE_SCHEDULED,
  freshSessionName, isFreshSessionName, freshSessionSettingsJson, parseMainConfigContract,
  buildFreshPaneCommand, freshTranscriptPath, launchFreshSession, killFreshSession, listFreshSessions, type FreshLaunchInputs,
} from '../web/fresh-session.js'
import { CHANNEL_PLUGIN_IDS } from '../web/plugin-ids.js'

const ROOT = join(__dirname, '..', '..')
const UUID = '11111111-2222-4333-8444-555555555555'
const base: FreshLaunchInputs = {
  installDir: '/srv/marveen', claudeBin: '/usr/local/bin/claude', nodeBin: '/usr/bin/node',
  config: { mode: 'isolated', dir: '/srv/marveen/.channels-config' }, customProviderEnv: '', model: 'claude-opus-5-5', sessionId: UUID,
}
const bashSyntaxOk = (cmd: string) => spawnSync('bash', ['-n', '-c', cmd]).status === 0

describe('fresh-session: names and settings', () => {
  it('sched-<agent>-<task>, with anything tmux or a shell could misread replaced', () => {
    expect(freshSessionName('kanban-audit', 'agent-a')).toBe('sched-agent-a-kanban-audit')
    expect(freshSessionName('a b.c:d', 'x')).toBe('sched-x-a-b-c-d')
    expect(isFreshSessionName('sched-x')).toBe(true)
    expect(isFreshSessionName('marveen-channels')).toBe(false)
    expect(isFreshSessionName('agent-sched-x')).toBe(false)
  })

  it('every channel plugin is off for the session, and the bypass warning is answered', () => {
    const s = JSON.parse(freshSessionSettingsJson())
    const ids = Object.values(CHANNEL_PLUGIN_IDS)
    expect(ids.length).toBeGreaterThan(0)
    for (const id of ids) expect(s.enabledPlugins[id]).toBe(false)
    expect(Object.values(s.enabledPlugins).every(v => v === false)).toBe(true)
    expect(s.skipDangerousModePermissionPrompt).toBe(true)
  })
})

describe('fresh-session: the config helper contract', () => {
  it('reads the mode, the dir and (token mode only) the secret id; ignores any other line', () => {
    expect(parseMainConfigContract('isolated\t/srv/x/.channels-config\n')).toEqual({ mode: 'isolated', dir: '/srv/x/.channels-config' })
    expect(parseMainConfigContract('noise from pino\ntoken\t/srv/x/cfg\tvault-id-1\n')).toEqual({ mode: 'token', dir: '/srv/x/cfg', tokenSecret: 'vault-id-1' })
    expect(parseMainConfigContract('explicit\t/home/u/.claude-bot\n')).toEqual({ mode: 'explicit', dir: '/home/u/.claude-bot' })
    expect(parseMainConfigContract('')).toBeNull()
    expect(parseMainConfigContract('isolated relative/dir\n')).toBeNull()
  })
})

describe('fresh-session: the pane command', () => {
  it('isolated: the main line minus the channel, plus the role, the session id and the plugin-off settings', () => {
    const cmd = buildFreshPaneCommand(base)
    expect(bashSyntaxOk(cmd)).toBe(true)
    expect(cmd).toContain(`export CLAUDE_CONFIG_DIR='/srv/marveen/.channels-config' && `)
    expect(cmd).toContain(`export CLAUDE_CODE_OAUTH_TOKEN="$(cat '/srv/marveen/store/.claude-oauth-token')"`)
    expect(cmd).toContain(`. '/srv/marveen/store/.channels-pane-auth'`)
    expect(cmd).toContain(MCP_BATCH_ENV)
    expect(cmd).toContain(`export ${SESSION_ROLE_ENV}=${SESSION_ROLE_SCHEDULED} && cd '/srv/marveen' && exec '/usr/local/bin/claude' --dangerously-skip-permissions`)
    expect(cmd).toContain(`--session-id '${UUID}'`)
    expect(cmd).toContain(`--settings '${freshSessionSettingsJson()}'`)
    expect(cmd).toContain(`--model 'claude-opus-5-5'`)
    expect(cmd).not.toContain('--channels')
    // the pane auth file is sourced BEFORE the config env, as in channels.sh (a mode's own token wins)
    expect(cmd.indexOf('.channels-pane-auth')).toBeLessThan(cmd.indexOf('CLAUDE_CONFIG_DIR'))
  })

  it('token mode: the plan token resolved in the pane by resolve-plan-token-env.mjs, never in argv', () => {
    const cmd = buildFreshPaneCommand({ ...base, config: { mode: 'token', dir: '/srv/marveen/cfg', tokenSecret: 'plan-secret-id' } })
    expect(bashSyntaxOk(cmd)).toBe(true)
    expect(cmd).toContain(`'/srv/marveen/scripts/resolve-plan-token-env.mjs' 'plan-secret-id'`)
    expect(cmd).toContain('export CLAUDE_CODE_OAUTH_TOKEN="$_plan_token"')
  })

  it('explicit / rotated: the dir only, no fleet token; no contract line: the shared ~/.claude', () => {
    for (const mode of ['explicit', 'rotated'] as const) {
      const cmd = buildFreshPaneCommand({ ...base, config: { mode, dir: '/home/u/.claude-bot' } })
      expect(cmd).toContain(`export CLAUDE_CONFIG_DIR='/home/u/.claude-bot'`)
      expect(cmd).not.toContain('CLAUDE_CODE_OAUTH_TOKEN')
    }
    const shared = buildFreshPaneCommand({ ...base, config: null })
    expect(bashSyntaxOk(shared)).toBe(true)
    expect(shared).not.toContain('CLAUDE_CONFIG_DIR')
  })

  it('no model configured: --model is left off, as channels.sh does; a quote in a path stays quoted', () => {
    expect(buildFreshPaneCommand({ ...base, model: '' })).not.toContain('--model')
    const odd = buildFreshPaneCommand({ ...base, installDir: "/srv/o'brien" })
    expect(bashSyntaxOk(odd)).toBe(true)
    expect(odd).toContain(`cd '/srv/o'\\''brien'`)
  })

  it('the transcript is <config dir>/projects/<cwd slug>/<session id>.jsonl', () => {
    const p = freshTranscriptPath('/srv/marveen', base.config, UUID)
    expect(p.startsWith('/srv/marveen/.channels-config/projects/')).toBe(true)
    expect(p.endsWith(`/${UUID}.jsonl`)).toBe(true)
  })
})

describe('fresh-session: launch and stop', () => {
  const deps = (over: Record<string, unknown> = {}) => {
    const calls: string[][] = []
    const d = {
      installDir: ROOT, claudeBin: '/usr/local/bin/claude', nodeBin: '/usr/bin/node', tmuxBin: 'tmux', channelProvider: 'telegram',
      model: () => 'claude-opus-5-5', uuid: () => UUID, isBuilt: () => true,
      runHelper: (script: string) => script === 'main-agent-isolated-config.mjs'
        ? { status: 0, out: `isolated\t${ROOT}\n` } : { status: 0, out: '' },
      tmux: (args: string[]) => { calls.push(args) },
      ...over,
    }
    return { d, calls }
  }

  it('starts sched-<task> detached in the install dir, through bash -lc, and returns the transcript', () => {
    const { d, calls } = deps()
    const r = launchFreshSession('kanban-audit', 'agent-a', d)
    expect(r.ok).toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0].slice(0, 8)).toEqual(['new-session', '-d', '-s', 'sched-agent-a-kanban-audit', '-c', ROOT, 'bash', '-lc'])
    expect(calls[0][8]).toContain('--session-id')
    if (r.ok) expect(r.transcriptPath.endsWith(`${UUID}.jsonl`)).toBe(true)
  })

  it('starts nothing when the custom-provider helper fails, claude is missing, or the config dir does not exist', () => {
    let x = deps({ runHelper: (s: string) => s === 'main-agent-custom-provider.mjs' ? { status: 1, out: '' } : { status: 0, out: '' } })
    expect(launchFreshSession('t', 'a', x.d).ok).toBe(false)
    expect(x.calls).toHaveLength(0)
    x = deps({ claudeBin: null })
    expect(launchFreshSession('t', 'a', x.d).ok).toBe(false)
    expect(x.calls).toHaveLength(0)
    x = deps({ runHelper: (s: string) => s === 'main-agent-isolated-config.mjs' ? { status: 0, out: 'isolated\t/does/not/exist\n' } : { status: 0, out: '' } })
    expect(launchFreshSession('t', 'a', x.d).ok).toBe(false)
    expect(x.calls).toHaveLength(0)
  })

  it('an install without a dist build: neither helper runs, the shared ~/.claude and no custom provider (as channels.sh)', () => {
    const ran: string[] = []
    const { d, calls } = deps({ isBuilt: () => false, runHelper: (s: string) => { ran.push(s); return { status: 1, out: '' } } })
    const r = launchFreshSession('t', 'a', d)
    expect(r.ok).toBe(true)
    expect(ran).toEqual([])
    expect(calls[0][8]).not.toContain('CLAUDE_CONFIG_DIR')
  })

  it('kill touches a sched-* session of THIS install only: the tmux server is shared with every other tree', () => {
    const calls: string[][] = []
    const seams = (path: string | null) => ({ tmux: (a: string[]) => { calls.push(a) }, pathOf: () => path })
    expect(killFreshSession('tmux', 'marveen-channels', '/inst', seams('/inst'))).toBe(false)
    expect(killFreshSession('tmux', 'agent-worker', '/inst', seams('/inst'))).toBe(false)
    expect(killFreshSession('tmux', `${FRESH_SESSION_PREFIX}x-t`, '/inst', seams('/live/marveen'))).toBe(false)
    expect(killFreshSession('tmux', `${FRESH_SESSION_PREFIX}x-t`, '/inst', seams(null))).toBe(false)
    expect(calls).toHaveLength(0)
    expect(killFreshSession('tmux', `${FRESH_SESSION_PREFIX}x-t`, '/inst', seams('/inst'))).toBe(true)
    expect(calls[0][0]).toBe('kill-session')
  })

  it('the restart sweep lists only sched-* sessions started in this install', () => {
    const out = 'sched-a-x\t/inst\nsched-b-y\t/live/marveen\nmarveen-channels\t/inst\nsched-c-z\t/inst\n'
    expect(listFreshSessions('tmux', '/inst', () => out)).toEqual(['sched-a-x', 'sched-c-z'])
  })
})

describe('fresh-session: contract with scripts/channels.sh', () => {
  const ch = readFileSync(join(ROOT, 'scripts', 'channels.sh'), 'utf-8')
  const exportsOf = (s: string) => new Set((s.match(/export ([A-Z0-9_]+=[^ &;]+(?: [A-Z0-9_]+=[^ &;]+)*)/)?.[1] ?? '').split(' '))

  it('the MCP env is channels.sh\'s, key for key and value for value', () => {
    const line = ch.split('\n').find(l => l.startsWith('MCP_BATCH_ENV='))
    expect(line).toBeTruthy()
    expect(exportsOf(line!)).toEqual(exportsOf(MCP_BATCH_ENV))
    expect(line).toContain('IS_SANDBOX=1')
    expect(MCP_BATCH_ENV).toContain('IS_SANDBOX=1')
  })

  it('the main launch line still runs --dangerously-skip-permissions and --channels (the one piece left out here)', () => {
    const launches = ch.split('\n').filter(l => l.includes('$CLAUDE --dangerously-skip-permissions'))
    expect(launches.length).toBeGreaterThan(0)
    for (const l of launches) expect(l).toContain('--channels plugin:')
  })

  it('channels.sh resolves the config dir and the custom provider through the same helpers this module calls', () => {
    expect(ch).toContain('scripts/main-agent-isolated-config.mjs" "$CHANNEL_PROVIDER"')
    expect(ch).toContain('scripts/main-agent-custom-provider.mjs"')
    expect(ch).toContain('.channels-pane-auth')
  })
})
