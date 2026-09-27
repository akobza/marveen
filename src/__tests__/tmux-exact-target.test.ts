// TMUXEXACT927 (a190dc57): every tmux target names its session EXACTLY.
//
// tmux resolves a `-t agent-x` that matches no session exactly as a PREFIX when
// exactly one session starts with it. On one install, restarting an agent killed
// its one prefix sibling eight times (2026-09-21..25): startAgentProcess
// re-issues kill-session for its own, already stopped session, and with one
// prefix sibling running that call lands on the sibling. The same resolution sends keys to, reads the pane of and
// reports "running" for the sibling. The fix is one form, `=name:`, at every
// call site (src/web/tmux-target.ts); these tests pin the form against a REAL
// tmux on an isolated socket, and sweep the source so a new call site cannot
// come back without it.
import { describe, it, expect, afterEach } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { tmpdir } from 'node:os'
import { exactTmuxTarget, sessionOfTmuxTarget } from '../web/tmux-target.js'
import { literalKeyArgs, specialKeyArgs } from '../web/tmux-keys.js'
import { runAsUserForTmuxArgs } from '../web/agent-process.js'

const ROOT = join(__dirname, '..', '..')
const HAS_TMUX = spawnSync('tmux', ['-V']).status === 0

describe('exactTmuxTarget / sessionOfTmuxTarget', () => {
  it('a session name becomes `=name:`; a window/pane target gets the `=` on its session part', () => {
    expect(exactTmuxTarget('agent-x')).toBe('=agent-x:')
    expect(exactTmuxTarget('agent-x:0')).toBe('=agent-x:0')
    expect(exactTmuxTarget('agent-x:0.1')).toBe('=agent-x:0.1')
  })
  it('is idempotent, and completes a bare `=name` (which fails as a pane target) to `=name:`', () => {
    expect(exactTmuxTarget('=agent-x:')).toBe('=agent-x:')
    expect(exactTmuxTarget(exactTmuxTarget('agent-x:0.1'))).toBe('=agent-x:0.1')
    expect(exactTmuxTarget('=agent-x')).toBe('=agent-x:')
  })
  it('session, window and pane ids are unique already and pass through', () => {
    expect(exactTmuxTarget('$3')).toBe('$3')
    expect(exactTmuxTarget('@4')).toBe('@4')
    expect(exactTmuxTarget('%12')).toBe('%12')
  })
  it('sessionOfTmuxTarget gives back the session name of any form', () => {
    for (const t of ['agent-x', 'agent-x:0.1', '=agent-x:', '=agent-x:0.1', '=agent-x']) {
      expect(sessionOfTmuxTarget(t)).toBe('agent-x')
    }
  })
})

describe('the run-as-user lookup reads the session out of an exact target', () => {
  // An agent with its own OS user is reached via sudo -u; the lookup keys on the
  // session name. Reading `=agent-x` out of `=agent-x:` would miss the map, and
  // the call would go, silently, to the router's own tmux server.
  const map = new Map([['agent-x', 'user-x']])
  it('finds the agent for `=name:` and `=name:window.pane`, and still for a plain name', () => {
    expect(runAsUserForTmuxArgs(['send-keys', '-t', exactTmuxTarget('agent-x'), 'Enter'], map)).toBe('user-x')
    expect(runAsUserForTmuxArgs(['capture-pane', '-t', exactTmuxTarget('agent-x:0.1'), '-p'], map)).toBe('user-x')
    expect(runAsUserForTmuxArgs(['has-session', '-t', 'agent-x'], map)).toBe('user-x')
  })
  it('the prefix sibling is not the agent', () => {
    expect(runAsUserForTmuxArgs(['has-session', '-t', exactTmuxTarget('agent-x-2')], map)).toBeNull()
  })
})

describe('the dashboard terminal key builders target exactly', () => {
  it('literal and special keys go to `=session:`', () => {
    expect(literalKeyArgs('agent-x', 'hi')).toEqual(['send-keys', '-t', '=agent-x:', '-l', '--', 'hi'])
    expect(specialKeyArgs('agent-x', 'Enter')).toEqual(['send-keys', '-t', '=agent-x:', 'Enter'])
  })
})

// Real tmux, one isolated server per test (-S in a temp dir; the environment is
// cut down to PATH and HOME, so an inherited $TMUX cannot point a command at the
// server this suite may be running in).
let dir = ''
let sock = ''
afterEach(() => {
  if (sock) spawnSync('tmux', ['-S', sock, 'kill-server'])
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = ''
  sock = ''
})
const env = { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' }
function server(...sessions: string[]): void {
  dir = mkdtempSync(join(tmpdir(), 'tmuxexact-'))
  sock = join(dir, 's')
  for (const s of sessions) execFileSync('tmux', ['-S', sock, 'new-session', '-d', '-s', s, '-x', '80', '-y', '20', 'cat'], { env })
}
function tmux(args: string[]): { rc: number | null; out: string } {
  const r = spawnSync('tmux', ['-S', sock, ...args], { env, encoding: 'utf-8' })
  return { rc: r.status, out: r.stdout ?? '' }
}
const alive = (s: string): boolean => tmux(['has-session', '-t', `=${s}:`]).rc === 0
const paneHas = (s: string, text: string): boolean => tmux(['capture-pane', '-p', '-t', `=${s}:`]).out.includes(text)
const settle = (): void => { spawnSync('sleep', ['0.3']) }

describe.skipIf(!HAS_TMUX)('real tmux: the parent is gone, ONE prefix sibling runs (the measured failure)', () => {
  it('NEGATIVE: restarting the parent (kill-session of its own name) leaves the sibling alive', () => {
    server('agent-x-2')
    expect(tmux(['kill-session', '-t', exactTmuxTarget('agent-x')]).rc).not.toBe(0)
    expect(alive('agent-x-2')).toBe(true)
  })
  it('CONTROL: the plain name is the bug -- it kills the sibling (so the negative test can fail)', () => {
    server('agent-x-2')
    expect(tmux(['kill-session', '-t', 'agent-x']).rc).toBe(0)
    expect(alive('agent-x-2')).toBe(false)
  })
  it('keys meant for the parent do not reach the sibling; has-session, capture-pane and list-panes do not see it', () => {
    server('agent-x-2')
    expect(tmux(literalKeyArgs('agent-x', 'NOT-FOR-SIBLING')!).rc).not.toBe(0)
    settle()
    expect(paneHas('agent-x-2', 'NOT-FOR-SIBLING')).toBe(false)
    expect(tmux(['has-session', '-t', exactTmuxTarget('agent-x')]).rc).not.toBe(0)
    expect(tmux(['capture-pane', '-p', '-t', exactTmuxTarget('agent-x')]).rc).not.toBe(0)
    expect(tmux(['list-panes', '-t', exactTmuxTarget('agent-x'), '-F', '#{session_name}']).out).not.toContain('agent-x-2')
  })
  it('CONTROL: with the plain name the keys DO land in the sibling', () => {
    server('agent-x-2')
    expect(tmux(['send-keys', '-t', 'agent-x', '-l', 'LANDS-IN-SIBLING']).rc).toBe(0)
    settle()
    expect(paneHas('agent-x-2', 'LANDS-IN-SIBLING')).toBe(true)
  })
})

describe.skipIf(!HAS_TMUX)('real tmux: both run -- the exact form still reaches the right session', () => {
  it('keys, capture and kill hit the parent only', () => {
    server('agent-x', 'agent-x-2')
    expect(tmux(literalKeyArgs('agent-x', 'FOR-PARENT')!).rc).toBe(0)
    settle()
    expect(paneHas('agent-x', 'FOR-PARENT')).toBe(true)
    expect(paneHas('agent-x-2', 'FOR-PARENT')).toBe(false)
    expect(tmux(['display-message', '-p', '-t', exactTmuxTarget('agent-x'), '#{session_name}']).out.trim()).toBe('agent-x')
    expect(tmux(['kill-session', '-t', exactTmuxTarget('agent-x')]).rc).toBe(0)
    expect(alive('agent-x')).toBe(false)
    expect(alive('agent-x-2')).toBe(true)
  })
})

// ---- source sweep: no tmux target without the exact form ----

function files(dirRel: string, exts: string[]): string[] {
  const out: string[] = []
  const walk = (d: string): void => {
    for (const e of readdirSync(d)) {
      if (e === 'node_modules' || e === '__tests__' || e === '__pycache__' || e === 'fixtures') continue
      const p = join(d, e)
      if (statSync(p).isDirectory()) walk(p)
      else if (exts.some((x) => e.endsWith(x)) && !/\.test\./.test(e)) out.push(p)
    }
  }
  walk(join(ROOT, dirRel))
  return out
}

// TS: an args array `'-t', <expr>`; the expr must be exactTmuxTarget(...) or an
// '='-prefixed literal. `-t` of ssh-keygen / ssh-keyscan is a key type.
function tsViolations(src: string): string[] {
  const bad: string[] = []
  const re = /'-t',\s*([^,\]\n]+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(src)) !== null) {
    const expr = m[1].trim()
    if (expr.startsWith('exactTmuxTarget(') || /^'=/.test(expr) || expr === "'ed25519'") continue
    bad.push(expr)
  }
  // shell-string invocations: `tmux ... -t ${x}`, outside human-facing text ("tmux attach -t ...")
  for (const line of src.split('\n')) {
    const i = line.search(/list-panes -t |send-keys -t |capture-pane [^`]*-t |kill-session -t |has-session -t /)
    if (i >= 0 && !/-t '\$\{exactTmuxTarget\(/.test(line)) bad.push(line.trim().slice(0, 80))
  }
  return bad
}

// Scripts: a tmux command line whose -t (or link-window -s) value is not
// '='-prefixed. Comments and human-facing text (echo/log/alert lines telling an
// operator to `tmux attach -t ...`) are not calls.
function scriptViolations(src: string): string[] {
  const bad: string[] = []
  for (const raw of src.split('\n')) {
    const line = raw.trim()
    if (line.startsWith('#') || /^(echo|log|if alert_owner|alert_owner|printf)\b/.test(line)) continue
    if (!/\btmux\b|\$TMUX\b|\$TMUX_BIN|"tmux"|'tmux'/.test(line)) continue
    const re = /(?:-t|link-window -s)["']?,?\s+(f?["']?)([^\s,)\]]+)/g
    let m: RegExpExecArray | null
    while ((m = re.exec(line)) !== null) {
      const v = m[2].replace(/^["']/, '')
      if (v.startsWith('=') || v.startsWith('{=')) continue
      if (/^(ed25519|\d)/.test(v)) continue
      bad.push(line.slice(0, 100))
    }
  }
  return bad
}

describe('source sweep: every tmux target in the framework is exact', () => {
  it('CONTROL: the sweeps catch the old shapes', () => {
    expect(tsViolations("runTmux(t, ['kill-session', '-t', session])")).toHaveLength(1)
    expect(tsViolations("execSync(`${tmuxPath} list-panes -t ${session} -F x`)")).toHaveLength(1)
    expect(scriptViolations('  $TMUX kill-session -t "$SESSION" 2>/dev/null')).toHaveLength(1)
    expect(scriptViolations('  if tmux link-window -s "${src}:0" -t "=$S:1"; then')).toHaveLength(1)
    expect(scriptViolations('        return subprocess.run(["tmux", "has-session", "-t", session],')).toHaveLength(1)
    expect(scriptViolations('  log "Manual check needed: tmux attach -t $SESSION"')).toHaveLength(0)
  })

  it('src/: no tmux -t target without exactTmuxTarget', () => {
    const offenders: string[] = []
    let exact = 0
    for (const f of files('src', ['.ts'])) {
      const src = readFileSync(f, 'utf-8')
      exact += (src.match(/'-t',\s*exactTmuxTarget\(/g) ?? []).length
      for (const v of tsViolations(src)) offenders.push(`${relative(ROOT, f)}: ${v}`)
    }
    expect(offenders).toEqual([])
    // not vacuous: the router's call sites are all in the count (79 on 2026-09-27)
    expect(exact).toBeGreaterThanOrEqual(79)
  })

  it('scripts/: no tmux -t target without the `=` prefix', () => {
    const offenders: string[] = []
    let exact = 0
    for (const f of files('scripts', ['.sh', '.py', '.mjs'])) {
      const src = readFileSync(f, 'utf-8')
      exact += (src.match(/-t["']?,?\s+f?["']=/g) ?? []).length
      for (const v of scriptViolations(src)) offenders.push(`${relative(ROOT, f)}: ${v}`)
    }
    expect(offenders).toEqual([])
    expect(exact).toBeGreaterThanOrEqual(60)
  })

  it('startAgentProcess, the measured killer, kills its own session exactly', () => {
    const ap = readFileSync(join(ROOT, 'src', 'web', 'agent-process.ts'), 'utf-8')
    const body = ap.slice(ap.indexOf('export async function startAgentProcess('), ap.indexOf('export async function stopAgentProcess('))
    expect(body).toContain("runTmux(agentTmuxTarget(name), ['kill-session', '-t', exactTmuxTarget(session)])")
  })
})
