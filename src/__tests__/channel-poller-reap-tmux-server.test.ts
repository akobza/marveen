// Card cc4d0ddd: the channel reaper must reach the plugin POLLER, never the
// owning agent's other processes and never the tmux server.
//
// Measured case (2026-09-24 12:23:28Z): a stage-3 recovery reap on the main
// channel dir killed pid 2888 -- the tmux server, started by scripts/channels.sh
// and therefore carrying TELEGRAM_STATE_DIR=<main dir> in its environment -- and
// every agent session on the host went down with it. The env scan matched the
// server; the live-pane guard did not spare it, because a server is no pane
// leader. The reaped list that day was [2888, 4650, 4651, 72915, 73460, 76162,
// 76163, 76166, 76199, 76200, 77266, 77286]; the fixture below reuses those pids.
// Only the server's identity was measured, the other rows' commands are
// illustrative of what an agent's tree carries (all measured classes the same
// day: bash tool shells, sleep, claude, postgres test databases, node builds).
//
// Three layers:
//   1. selection (pure): a candidate needs BOTH the state-dir literal and the
//      provider's CLAUDE_PLUGIN_ROOT anchor. The old state-dir-only matcher is
//      run on the same fixture to show it selects the whole blast radius.
//   2. protection (pure): the tmux server, every live pane leader and the parent
//      of every live pane leader are never reap targets, even when their row
//      carries both markers.
//   3. real processes against a fake tmux (as in the live-pane test): a plain
//      process with the state dir survives, a plugin poller is reaped and logged
//      with its command line, the parent of a live pane survives, and a stale
//      bot.pid that names a non-plugin process is not signalled.
import { describe, it, expect, afterAll, vi } from 'vitest'
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync, chmodSync, mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  parsePollerPidsFromPs,
  parseStateDirPollerPids,
  isPluginPollerPid,
  protectedPidsForReap,
  selectReapTargets,
  commandForLog,
  reapChannelOrphans,
  type ProcRow,
} from '../web/channel-poller-reap.js'
import { channelStateDir } from '../channel-provider.js'
import { logger } from '../logger.js'

const MAIN = '/home/op/app/.claude/channels/telegram'
const SUB = '/home/op/app/agents/dev/.claude/channels/telegram'
const ROOT = '/home/op/.claude/plugins/cache/official/telegram/0.0.7'

// `ps eww -e` rows: pid, tty, stat, time, argv, then the environment.
const PS_EWW_1223 = [
  `  2888 ?        Ss     0:00 tmux new-session -d -s main-channels bash -lc claude --channels plugin:telegram@x HOME=/home/op TELEGRAM_STATE_DIR=${MAIN} LANG=C.UTF-8`,
  `  2889 pts/1    Ssl+   0:09 /home/op/.local/bin/claude --channels plugin:telegram@x HOME=/home/op TELEGRAM_STATE_DIR=${MAIN}`,
  `  4650 pts/1    Sl+    0:01 bun run --cwd ${ROOT} --shell=bun --silent start CLAUDE_PLUGIN_ROOT=${ROOT} TELEGRAM_STATE_DIR=${MAIN}`,
  `  4651 pts/1    Sl+    0:00 bun ${ROOT}/server.ts CLAUDE_PLUGIN_ROOT=${ROOT} TELEGRAM_STATE_DIR=${MAIN}`,
  ` 72915 pts/1    S+     0:00 /bin/bash -c source /home/op/.claude/shell-snapshots/s.sh && eval 'npm test' HOME=/home/op TELEGRAM_STATE_DIR=${MAIN}`,
  ` 76162 ?        S      0:00 sleep 600 HOME=/home/op TELEGRAM_STATE_DIR=${MAIN}`,
  ` 77266 ?        Ss     0:00 /usr/lib/postgresql/18/bin/postgres -D pgdata -p 55597 TELEGRAM_STATE_DIR=${MAIN}`,
  // another agent's poller: its own state dir
  ` 80001 pts/3    Sl+    0:01 bun run --cwd ${ROOT} --shell=bun --silent start CLAUDE_PLUGIN_ROOT=${ROOT} TELEGRAM_STATE_DIR=${SUB}`,
  // a sibling plugin whose dir only STARTS with /telegram
  ` 80002 pts/4    Sl+    0:01 bun x CLAUDE_PLUGIN_ROOT=/home/op/.claude/plugins/cache/official/telegram-inline/1.0.0 TELEGRAM_STATE_DIR=${MAIN}`,
  // a state dir that only STARTS with the main one
  ` 80003 ?        S      0:00 bun y CLAUDE_PLUGIN_ROOT=${ROOT} TELEGRAM_STATE_DIR=${MAIN}-old`,
].join('\n')

describe('cc4d0ddd selection: a candidate needs the state dir AND the plugin root', () => {
  it('the old state-dir-only matcher selects the whole 12:23Z blast radius, the tmux server included', () => {
    const old = parsePollerPidsFromPs(PS_EWW_1223, 'TELEGRAM_STATE_DIR', MAIN)
    expect(old).toContain(2888)
    expect(old).toEqual(expect.arrayContaining([2889, 4650, 4651, 72915, 76162, 77266]))
  })

  it('the narrowed matcher selects only the plugin pollers of that state dir', () => {
    expect(parseStateDirPollerPids(PS_EWW_1223, 'TELEGRAM_STATE_DIR', MAIN, '/telegram')).toEqual([4650, 4651])
  })

  it('keeps each agent to its own state dir, and honours both boundaries', () => {
    expect(parseStateDirPollerPids(PS_EWW_1223, 'TELEGRAM_STATE_DIR', SUB, '/telegram')).toEqual([80001])
    const sel = parseStateDirPollerPids(PS_EWW_1223, 'TELEGRAM_STATE_DIR', MAIN, '/telegram')
    expect(sel).not.toContain(80002) // /telegram-inline is another plugin
    expect(sel).not.toContain(80003) // <main>-old is another state dir
  })

  it('trusts bot.pid only while that pid is still a plugin process', () => {
    expect(isPluginPollerPid(PS_EWW_1223, 4650, '/telegram')).toBe(true)
    expect(isPluginPollerPid(PS_EWW_1223, 2888, '/telegram')).toBe(false) // a reused pid after a reboot
    expect(isPluginPollerPid(PS_EWW_1223, 12345, '/telegram')).toBe(false) // gone
  })
})

describe('cc4d0ddd protection: the tmux server and live panes are never targets', () => {
  const procs: ProcRow[] = [
    { pid: 1, ppid: 0, command: '/sbin/init' },
    { pid: 2888, ppid: 1, command: 'tmux new-session -d -s main-channels bash -lc claude --channels plugin:telegram@x' },
    { pid: 2889, ppid: 2888, command: '/home/op/.local/bin/claude --channels plugin:telegram@x' },
    { pid: 4551, ppid: 2888, command: 'sh -c claude --channels plugin:telegram@x' },
    { pid: 4650, ppid: 2889, command: `bun run --cwd ${ROOT} --shell=bun --silent start` },
    { pid: 9001, ppid: 1, command: '/usr/bin/tmux -L other new-session -d -s side' },
  ]
  const live = new Set([2889, 4551])

  it('protects the pane leaders, their parent (the server) and every tmux binary', () => {
    const prot = protectedPidsForReap(procs, live)
    expect([...prot].sort((a, b) => a - b)).toEqual([2888, 2889, 4551, 9001])
    expect(prot.has(4650)).toBe(false)
  })

  it('spares the server even when its row carries both markers (the 12:23Z shape, worst case)', () => {
    const sel = selectReapTargets([2888, 2889, 4650, 9001], procs, live)
    expect(sel.reap).toEqual([4650])
    expect(sel.skippedLivePane).toEqual([2889])
    expect(sel.skippedProtected).toEqual([2888, 9001])
    expect(sel.failSafe).toBe(false)
  })

  it('reaps nothing when the live panes or the process table cannot be resolved', () => {
    expect(selectReapTargets([4650], procs, new Set()).reap).toEqual([])
    expect(selectReapTargets([4650], [], live).reap).toEqual([])
  })

  it('logs a command line without secret values and bounded in length', () => {
    const line = commandForLog(`bash -lc export CLAUDE_CODE_OAUTH_TOKEN=abc123 && curl -H Authorization: Bearer xyz789 ${'x'.repeat(400)}`)
    expect(line).not.toContain('abc123')
    expect(line).not.toContain('xyz789')
    expect(line.length).toBeLessThanOrEqual(240)
  })
})

// ---------------------------------------------------------------------------
// Real processes, fake tmux. A real tmux server is never touched.
const tmp = mkdtempSync(join(tmpdir(), 'reap-tmux-server-'))
const agentDir = join(tmp, 'agent')
const chanDir = channelStateDir('telegram', agentDir)
mkdirSync(chanDir, { recursive: true })
const pluginRoot = join(tmp, 'plugins', 'cache', 'official', 'telegram', '0.0.1')
const fakeTmux = join(tmp, 'fake-tmux')
const kids: number[] = []

function spawnWithEnv(cmd: string, args: string[], env: Record<string, string>): number {
  const p = spawn(cmd, args, { detached: true, stdio: 'ignore', env: { ...process.env, ...env } })
  p.unref()
  kids.push(p.pid!)
  return p.pid!
}
const stateOnly = () => spawnWithEnv('/bin/sleep', ['300'], { TELEGRAM_STATE_DIR: chanDir })
const poller = () => spawnWithEnv('/bin/sleep', ['300'], { TELEGRAM_STATE_DIR: chanDir, CLAUDE_PLUGIN_ROOT: pluginRoot })
function fakeTmuxPrints(body: string): void {
  writeFileSync(fakeTmux, `#!/bin/sh\n${body}\n`)
  chmodSync(fakeTmux, 0o755)
}
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true } catch { return false } }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

afterAll(() => {
  for (const k of kids) { try { process.kill(k, 'SIGKILL') } catch { /* gone */ } }
  rmSync(tmp, { recursive: true, force: true })
})

describe('cc4d0ddd reapChannelOrphans on real processes', () => {
  it('a process that only inherited the state dir survives, even when a stale bot.pid names it', async () => {
    const plain = stateOnly(); await sleep(150)
    writeFileSync(join(chanDir, 'bot.pid'), String(plain))
    fakeTmuxPrints('echo 4242')
    const r = reapChannelOrphans('telegram', agentDir, { tmuxPath: fakeTmux })
    await sleep(500)
    expect(r.reaped).not.toContain(plain)
    expect(r.source.fromBotPid).toBeNull()
    expect(r.skippedNotPoller).toContain(plain)
    expect(alive(plain)).toBe(true)
  })

  it('a plugin poller is still reaped, and logged with its command line (positive control)', async () => {
    const p = poller(); await sleep(150)
    writeFileSync(join(chanDir, 'bot.pid'), String(p))
    fakeTmuxPrints('echo 4242')
    const spy = vi.spyOn(logger, 'info')
    const r = reapChannelOrphans('telegram', agentDir, { tmuxPath: fakeTmux })
    await sleep(800)
    expect(r.reaped).toContain(p)
    expect(alive(p)).toBe(false)
    const d = r.reapedDetail.find((x) => x.pid === p)
    expect(d?.command).toMatch(/sleep 300/)
    const logged = spy.mock.calls.some(([obj, msg]) => msg === 'channel-poller-reap: orphans killed'
      && Array.isArray((obj as { reapedDetail?: unknown[] }).reapedDetail)
      && (obj as { reapedDetail: { pid: number }[] }).reapedDetail.some((x) => x.pid === p))
    expect(logged).toBe(true)
    spy.mockRestore()
  })

  it('the parent of a live pane survives even with both markers; the pane leader too', async () => {
    const childFile = join(tmp, 'child.pid')
    // "server" = a shell that owns the pane process; both carry both markers.
    const server = spawnWithEnv('/bin/sh', ['-c', `sleep 300 & echo $! > ${childFile}; wait`],
      { TELEGRAM_STATE_DIR: chanDir, CLAUDE_PLUGIN_ROOT: pluginRoot })
    for (let i = 0; i < 40 && !existsSync(childFile); i++) await sleep(50)
    const pane = parseInt(readFileSync(childFile, 'utf-8').trim(), 10)
    kids.push(pane)
    writeFileSync(join(chanDir, 'bot.pid'), String(server))
    fakeTmuxPrints(`echo ${pane}`)
    const r = reapChannelOrphans('telegram', agentDir, { tmuxPath: fakeTmux })
    await sleep(800)
    expect(r.skippedProtected).toContain(server)
    expect(r.skippedLivePane).toContain(pane)
    expect(r.reaped).not.toContain(server)
    expect(r.reaped).not.toContain(pane)
    expect(alive(server)).toBe(true)
    expect(alive(pane)).toBe(true)
  })
})
