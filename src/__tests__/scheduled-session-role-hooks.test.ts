// cc457550: MARVEEN_SESSION_ROLE=scheduled marks the FRESH session a scheduled round runs in.
// That session works in the main agent's cwd, so every main-agent check passes in it; exactly five continuity hooks
// read the flag and stand aside: inbox-drain (it would claim the main agent's pending inter-agent messages),
// ledger-replay (the owner's conversation and open question), taskstate-replay and clear-replay (the long-running
// session's state) and telegram-reply-guard (it would block the round's stop over the owner's open question).
//
// Each of the five runs for real, from a scratch copy of scripts/hooks (the hooks find store/.dashboard-token next to
// their own install), first WITH the flag (exit 0, no effect, nothing consumed) and then WITHOUT it (today's effect on
// the very same state -- which also proves the flagged run left that state alone). The other half of the decision:
// no guard reads the flag (name search over scripts/ and src/) and each guard answers identically with and without it.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawn, spawnSync } from 'node:child_process'
import http from 'node:http'
import { mkdtempSync, mkdirSync, cpSync, writeFileSync, readFileSync, readdirSync, statSync, rmSync } from 'node:fs'
import { join, relative } from 'node:path'
import { tmpdir } from 'node:os'
import type { AddressInfo } from 'node:net'

const ROOT = join(__dirname, '..', '..')
const HOOKS = join(ROOT, 'scripts', 'hooks')
const FLAG = 'MARVEEN_SESSION_ROLE'
const CONTINUITY = ['inbox-drain.py', 'ledger-replay.py', 'taskstate-replay.py', 'clear-replay.py', 'telegram-reply-guard.py']

let server: http.Server
let port = 0
let install = ''
let hooks = ''
let clearStore = ''
const hits: Record<string, number> = {}

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const path = (req.url ?? '').split('?')[0]
    hits[path] = (hits[path] ?? 0) + 1
    res.writeHead(200, { 'Content-Type': 'application/json' })
    if (path.endsWith('/drain-inbox')) res.end(JSON.stringify({ text: 'DRAINED_MESSAGE_X' }))
    else if (path.endsWith('/replay')) res.end(JSON.stringify({ additionalContext: 'TASKSTATE_X' }))
    else res.end('{}')
  })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  port = (server.address() as AddressInfo).port
  install = mkdtempSync(join(tmpdir(), 'session-role-install-'))
  hooks = join(install, 'scripts', 'hooks')
  cpSync(HOOKS, hooks, { recursive: true })
  mkdirSync(join(install, 'store'), { recursive: true })
  mkdirSync(join(install, 'agents', 'tester'), { recursive: true })
  writeFileSync(join(install, 'store', '.dashboard-token'), 'tok\n')
  clearStore = mkdtempSync(join(tmpdir(), 'session-role-clearstate-'))
})

afterAll(() => {
  server.close()
  rmSync(install, { recursive: true, force: true })
  rmSync(clearStore, { recursive: true, force: true })
})

interface Run { code: number | null; stdout: string; stderr: string }

function baseEnv(flag: boolean): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: install,
    WEB_PORT: String(port),
    MAIN_AGENT_ID: 'marveen',
    MARVEEN_AGENT_ID: 'marveen',
    LEDGER_DB_PATH: join(install, 'store', 'ledger.db'),
    CLEARSTATE_DIR: clearStore,
  }
  delete env[FLAG]
  if (flag) env[FLAG] = 'scheduled'
  return env
}

function run(cmd: string, args: string[], payload: unknown, flag: boolean): Promise<Run> {
  return new Promise(resolve => {
    const p = spawn(cmd, args, { env: baseEnv(flag), cwd: install })
    let stdout = ''
    let stderr = ''
    p.stdout.on('data', d => { stdout += d })
    p.stderr.on('data', d => { stderr += d })
    p.on('close', code => resolve({ code, stdout, stderr }))
    p.stdin.on('error', () => { /* a hook that exits before reading stdin */ })
    p.stdin.end(JSON.stringify(payload))
  })
}
const hook = (name: string, payload: unknown, flag: boolean) => run('python3', [join(hooks, name)], payload, flag)

function seedInbound(text: string): void {
  const py = 'import sys, datetime; sys.path.insert(0, sys.argv[1]); import ledger_lib; ' +
    'ledger_lib.log_inbound("marveen", "42", sys.argv[3], sys.argv[2], ' +
    'datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z"))'
  const r = spawnSync('python3', ['-c', py, hooks, text, String(Date.now())], { env: baseEnv(false) })
  if (r.status !== 0) throw new Error('seed failed: ' + String(r.stderr))
}

describe('the five continuity hooks stand aside in a scheduled fresh session', () => {
  it('inbox-drain: with the flag no drain call at all; without it the inbox is drained as before', async () => {
    const payload = { prompt: 'heti kanban-audit', session_id: 's', cwd: install }
    const flagged = await hook('inbox-drain.py', payload, true)
    expect(flagged.code).toBe(0)
    expect(flagged.stdout).toBe('')
    expect(hits['/api/agents/marveen/drain-inbox'] ?? 0).toBe(0)
    const plain = await hook('inbox-drain.py', payload, false)
    expect(plain.code).toBe(0)
    expect(plain.stdout).toContain('DRAINED_MESSAGE_X')
    expect(hits['/api/agents/marveen/drain-inbox']).toBe(1)
  })

  it('ledger-replay: with the flag nothing is injected; without it the open question is', async () => {
    seedInbound('NYITOTT_KERDES_X mi a helyzet a lappal?')
    const payload = { source: 'startup', session_id: 's', cwd: install }
    const flagged = await hook('ledger-replay.py', payload, true)
    expect(flagged.code).toBe(0)
    expect(flagged.stdout).toBe('')
    const plain = await hook('ledger-replay.py', payload, false)
    expect(plain.code).toBe(0)
    expect(plain.stdout).toContain('NYITOTT_KERDES_X')
  })

  it('taskstate-replay: with the flag no replay request and nothing consumed; without it the state is injected', async () => {
    const payload = { source: 'compact', session_id: 's', cwd: install }
    const before = { replay: hits['/api/agent-taskstate/marveen/replay'] ?? 0, consume: hits['/api/agent-taskstate/marveen/consume'] ?? 0 }
    const flagged = await hook('taskstate-replay.py', payload, true)
    expect(flagged.code).toBe(0)
    expect(flagged.stdout).toBe('')
    expect(hits['/api/agent-taskstate/marveen/replay'] ?? 0).toBe(before.replay)
    expect(hits['/api/agent-taskstate/marveen/consume'] ?? 0).toBe(before.consume)
    const plain = await hook('taskstate-replay.py', payload, false)
    expect(plain.code).toBe(0)
    expect(plain.stdout).toContain('TASKSTATE_X')
    expect(hits['/api/agent-taskstate/marveen/consume']).toBe(before.consume + 1)
  })

  it('clear-replay: with the flag the record is neither injected nor consumed; without it, it is', async () => {
    const transcript = join(clearStore, 'session.jsonl')
    writeFileSync(transcript, [
      { type: 'user', message: { content: 'CLEAR_KERDES_X javitsd meg a szurot' } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Kesz.' }] } },
    ].map(e => JSON.stringify(e)).join('\n') + '\n')
    const cwd = join(install, 'agents', 'tester')
    const cap = await hook('clear-capture.py', { reason: 'clear', cwd, transcript_path: transcript }, false)
    expect(cap.code).toBe(0)
    const flagged = await hook('clear-replay.py', { source: 'clear', cwd }, true)
    expect(flagged.code).toBe(0)
    expect(flagged.stdout).toBe('')
    const plain = await hook('clear-replay.py', { source: 'clear', cwd }, false)
    expect(plain.code).toBe(0)
    expect(plain.stdout).toContain('CLEAR_KERDES_X')
  })

  it('telegram-reply-guard: with the flag the stop is allowed; without it an open question blocks it', async () => {
    seedInbound('GUARD_KERDES_X mennyi 2+2?')
    const payload = { session_id: 's', cwd: install, stop_hook_active: false }
    const flagged = await hook('telegram-reply-guard.py', payload, true)
    expect(flagged.code).toBe(0)
    expect(flagged.stdout).toBe('')
    const plain = await hook('telegram-reply-guard.py', payload, false)
    expect(plain.code).toBe(0)
    expect(JSON.parse(plain.stdout).decision).toBe('block')
  })
})

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    if (e === 'node_modules' || e === '__pycache__' || e === '__tests__' || e.startsWith('.')) continue
    const p = join(dir, e)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.(py|mjs|js|cjs|sh|ts)$/.test(e)) out.push(p)
  }
  return out
}

describe('no guard reads the flag', () => {
  it('name search: under scripts/ only the five continuity hooks mention it; under src/ only the runner may set it', () => {
    const readers = walk(join(ROOT, 'scripts')).filter(f => readFileSync(f, 'utf-8').includes(FLAG)).map(f => relative(ROOT, f)).sort()
    expect(readers).toEqual(CONTINUITY.map(h => `scripts/hooks/${h}`).sort())
    const src = walk(join(ROOT, 'src')).filter(f => readFileSync(f, 'utf-8').includes(FLAG)).map(f => relative(ROOT, f))
    for (const f of src) expect(['src/web/fresh-session.ts']).toContain(f)
  })

  // Representative inputs per guard; what matters is that the answer is the same with the flag as without it.
  const probes: Array<[string, string[], unknown]> = [
    ['egress-gate.mjs', ['node'], { tool_name: 'WebFetch', tool_input: { url: 'http://metadata.google.internal/computeMetadata/v1/' } }],
    ['egress-gate.mjs', ['node'], { tool_name: 'WebFetch', tool_input: { url: 'https://example.com/' } }],
    ['outgoing-copy-gate.py', ['python3'], { tool_name: 'Bash', tool_input: { command: 'echo hello' } }],
    ['outgoing-copy-gate.py', ['python3'], { tool_name: 'mcp__gmail__send_email', tool_input: { to: ['a@example.com'], subject: 'Teszt', body: 'Szia, ez egy proba level.' } }],
    ['email-approval-gate.py', ['python3'], { tool_name: 'mcp__gmail__send_email', tool_input: { to: ['a@example.com'], subject: 'Teszt', body: 'Szia.' } }],
    ['provenance-gate.py', ['python3'], { prompt: 'mehet a restart', session_id: 's', cwd: install }],
    ['memory-frontmatter-gate.py', ['python3'], { tool_name: 'Write', tool_input: { file_path: join(install, '.claude', 'projects', 'p', 'memory', 'x.md'), content: 'no frontmatter' } }],
    ['memory-frontmatter-bash-gate.py', ['python3'], { tool_name: 'Bash', tool_input: { command: `cat > ${join(install, '.claude', 'projects', 'p', 'memory', 'y.md')} <<'EOF'\nno frontmatter\nEOF` } }],
  ]
  for (const [name, cmd, payload] of probes) {
    it(`behaviour probe: ${name} answers the same with and without the flag (${JSON.stringify(payload).slice(0, 60)})`, async () => {
      const a = await run(cmd[0], [join(hooks, name)], payload, false)
      const b = await run(cmd[0], [join(hooks, name)], payload, true)
      expect(b.code).toBe(a.code)
      expect(b.stdout).toBe(a.stdout)
      expect(b.stderr).toBe(a.stderr)
    })
  }
})
