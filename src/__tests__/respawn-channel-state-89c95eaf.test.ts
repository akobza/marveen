// 89c95eaf (2026-09-23): a planned restart of the main agent left the Telegram
// channel silent for ~4 minutes and lost a queued inbound message. Two measured
// causes, one test block each:
//
//  1. The recovery respawn command (buildMainSessionRespawnCmd) did not export
//     TELEGRAM_STATE_DIR, so the respawned plugin looked for its bot token in the
//     legacy ~/.claude/channels/telegram (emptied by the #915 migration), exited,
//     and channels.sh's 180 s watchdog restarted the whole session a second time.
//  2. The pane-state busy scan did not recognise the spinner shape
//     "(running UserPromptSubmit hooks… 13/15 · 46m 37s · ↓ 145.9k tokens)", so
//     the context-guard read a live turn as 'idle' and restarted it.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildMainSessionRespawnCmd, mainChannelStateEnv } from '../web/channel-monitor.js'
import { FLEET_OAUTH_TOKEN_PATH } from '../web/agent-process.js'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { mainConfigDecisionForTest } from '../web/main-config-decision.js'
import { detectPaneState } from '../pane-state.js'

const OPTS = { claudePath: 'claude', pluginId: 'telegram', model: '', continueSession: false, config: mainConfigDecisionForTest() }

describe('89c95eaf: the respawn command carries the channel state dir', () => {
  it('exports <PROVIDER>_STATE_DIR, quoted, before the claude launch', () => {
    const cmd = buildMainSessionRespawnCmd({ ...OPTS, channelStateEnv: { envVar: 'TELEGRAM_STATE_DIR', dir: '/inst/.claude/channels/telegram' } })
    const exportAt = cmd.indexOf("&& export TELEGRAM_STATE_DIR='/inst/.claude/channels/telegram'")
    expect(exportAt).toBeGreaterThan(-1)
    expect(exportAt).toBeLessThan(cmd.indexOf('&& claude'))
  })

  it('without the option the command is unchanged (no STATE_DIR at all)', () => {
    const cmd = buildMainSessionRespawnCmd({ ...OPTS })
    expect(cmd).not.toMatch(/STATE_DIR/)
  })

  it('refuses a var name that is not a plain upper-case identifier', () => {
    for (const envVar of ['X; touch /tmp/pwned', 'telegram_state_dir', '', '1ABC']) {
      const cmd = buildMainSessionRespawnCmd({ ...OPTS, channelStateEnv: { envVar, dir: '/inst' } })
      expect(cmd).not.toMatch(/STATE_DIR|pwned|export 1ABC|export telegram/)
    }
  })

  it('quotes a hostile dir into one inert word', () => {
    const cmd = buildMainSessionRespawnCmd({ ...OPTS, channelStateEnv: { envVar: 'TELEGRAM_STATE_DIR', dir: "/x'; touch /tmp/pwned; '" } })
    expect(cmd).toContain("export TELEGRAM_STATE_DIR='/x'\\''; touch /tmp/pwned; '\\'''")
  })

  it('mainChannelStateEnv names the var the plugin honours and the install-scoped dir', () => {
    const saved = process.env.TELEGRAM_STATE_DIR
    delete process.env.TELEGRAM_STATE_DIR
    try {
      const env = mainChannelStateEnv('telegram')
      expect(env.envVar).toBe('TELEGRAM_STATE_DIR')
      expect(env.dir.endsWith('/.claude/channels/telegram')).toBe(true)
    } finally {
      if (saved !== undefined) process.env.TELEGRAM_STATE_DIR = saved
    }
  })

  it('WIRING: every buildMainSessionRespawnCmd call site in channel-monitor.ts passes channelStateEnv', () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'web', 'channel-monitor.ts'), 'utf8')
    const calls = src.match(/buildMainSessionRespawnCmd\(\{/g) ?? []
    const wired = src.match(/channelStateEnv: mainChannelStateEnv\(provider\.type\)/g) ?? []
    expect(calls.length).toBe(3)
    expect(wired.length).toBe(calls.length)
  })
})

// The bottom of the real pane snapshot the context-guard took at 12:52:06Z
// (store/context-guard-last-pane-ugyvezeto.txt), with the sender ids and the
// message text replaced by neutral placeholders. Layout and chrome are verbatim.
const INCIDENT_PANE = [
  '     content=f"[ugyv…',
  '',
  '✢ Wibbling… (running UserPromptSubmit hooks… 13/15 · 46m 37s · ↓ 145.9k tokens)',
  '  ⎿  Tip: Use /clear to start fresh when switching topics and free up context',
  '',
  '← telegram · 1000000001: (voice message)',
  '← telegram · 1000000002: placeholder text',
  '',
  '────────────────────────────────────────────────',
  '❯ ',
  '────────────────────────────────────────────────',
  '  Opus 4.8 | ctx 31% | 5h 5% | 7d 31%',
  '  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents',
].join('\n')

describe('89c95eaf: a prefixed spinner line reads busy', () => {
  it('the incident pane is busy', () => {
    expect(detectPaneState(INCIDENT_PANE)).toBe('busy')
  })

  it('CONTROL: the same pane without the spinner line is not busy', () => {
    const withoutSpinner = INCIDENT_PANE.split('\n').filter((l) => !l.includes('Wibbling')).join('\n')
    expect(detectPaneState(withoutSpinner)).not.toBe('busy')
  })

  it('the old unprefixed shapes still read busy', () => {
    for (const line of ['✻ Thinking… (52s · ↓ 2.6k tokens)', '✻ Working… (1m 16s · ↓ 4.0k tokens)']) {
      const pane = INCIDENT_PANE.split('\n').map((l) => (l.includes('Wibbling') ? line : l)).join('\n')
      expect(detectPaneState(pane)).toBe('busy')
    }
  })

  it('prose with a parenthesis and a middle dot but no ↓N tail does not read busy', () => {
    const pane = INCIDENT_PANE.split('\n')
      .map((l) => (l.includes('Wibbling') ? 'Note (running late · 5s total) was fine' : l))
      .join('\n')
    expect(detectPaneState(pane)).not.toBe('busy')
  })
})

// 89c95eaf, measured 2026-09-23 14:5xZ: the respawned main agent ran on the FLEET token (store/.claude-oauth-token)
// although .env carries its own CLAUDE_CODE_OAUTH_TOKEN, because the respawn exported the fleet file unconditionally
// while channels.sh:48-57 reads .env first. These tests RUN the generated shell fragment against temp files.
describe('89c95eaf: the respawn takes the token from .env first, like channels.sh', () => {
  const dir = mkdtempSync(join(tmpdir(), 'resp-tok-'))
  const fleet = join(dir, 'fleet-token')
  writeFileSync(fleet, 'FLEETTOKEN\n')
  const run = (envFile: string): string => {
    const cmd = buildMainSessionRespawnCmd({ ...OPTS, config: mainConfigDecisionForTest({ fleetToken: true }), envFile })
    const fragment = cmd.split(' && claude ')[0].split(FLEET_OAUTH_TOKEN_PATH).join(fleet)
    return execFileSync('bash', ['-c', `${fragment} && printf %s "$CLAUDE_CODE_OAUTH_TOKEN"`], { encoding: 'utf8' })
  }

  it('.env has the line -> the .env token wins over the fleet file', () => {
    const env = join(dir, 'with.env')
    writeFileSync(env, 'FOO=1\nCLAUDE_CODE_OAUTH_TOKEN=OWNTOKEN\nBAR=2\n')
    expect(run(env)).toBe('OWNTOKEN')
  })

  it('.env without the line -> the fleet file is the fallback', () => {
    const env = join(dir, 'without.env')
    writeFileSync(env, 'FOO=1\n')
    expect(run(env)).toBe('FLEETTOKEN')
  })

  it('no .env at all -> the fleet file is the fallback', () => {
    expect(run(join(dir, 'missing.env'))).toBe('FLEETTOKEN')
  })

  it('the token value never appears in the command text (read at launch)', () => {
    const cmd = buildMainSessionRespawnCmd({ ...OPTS, config: mainConfigDecisionForTest({ fleetToken: true }), envFile: join(dir, 'with.env') })
    expect(cmd).not.toContain('OWNTOKEN')
    expect(cmd).not.toContain('FLEETTOKEN')
  })
})
