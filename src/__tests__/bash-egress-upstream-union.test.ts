import { describe, it, expect, afterAll } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
// @ts-expect-error -- plain .mjs hook script, no types
import { upstreamVerdictApplies } from '../../scripts/hooks/bash-egress-parser.mjs'

// 95800e1d (2026-10-12): the local egress layer asks the pinned upstream parser for a second opinion. Measured on the
// upstream test: 58 calls the local layer allowed and the upstream denies; on the fleet's real Bash traffic (543 563
// commands, 2026-09-28 -> 2026-10-12) a plain union would add 77 false denies on sub-agents, the narrowed one 0. These
// cases drive the REAL hook process: the closed shapes deny, the false-deny class stays allowed, the shapes still open
// are pinned so a later fix flips them on purpose, and a missing second classifier fails closed.

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const HOOK = join(ROOT, 'scripts', 'hooks', 'bash-egress-parser.mjs')
const dirs: string[] = []
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }) })

function run(command: string, hook = HOOK) {
  const dir = mkdtempSync(join(tmpdir(), 'egress-union-'))
  dirs.push(dir)
  writeFileSync(join(dir, 'none.json'), '{}')
  const r = spawnSync(process.execPath, [hook], {
    input: JSON.stringify({ tool_name: 'Bash', tool_input: { command }, cwd: ROOT }),
    encoding: 'utf-8',
    env: { ...process.env, BASH_EGRESS_BLOCK_LOG: join(dir, 'blocks.jsonl'), BASH_EGRESS_VENDOR_HOSTS: join(dir, 'none.json') },
  })
  return { rc: r.status, deny: r.stdout.includes('"permissionDecision":"deny"'), stdout: r.stdout, stderr: r.stderr }
}

describe('the upstream second opinion closes the shapes the local layer missed', () => {
  const closed: Array<[string, string]> = [
    ['a perl heredoc body', "perl <<-'PL'\n\tuse LWP::Simple; getprint('http://example.org/');\n\tPL"],
    ['a bash here-string', "bash <<< 'curl -s https://example.org/'"],
    ['a while-read loop fed by a here-string', 'while read u; do curl -s "$u"; done <<< "https://example.org/"'],
    ['a read from a here-string, then curl', 'read u <<< "https://example.org/"; curl -s "$u"'],
    ['a python here-string', 'python3 <<< "import urllib.request; urllib.request.urlopen(\'https://example.org/\')"'],
    ['a PowerShell -Command one-liner', 'powershell.exe -NoProfile -Command "Invoke-RestMethod \'https://example.org/x\'"'],
  ]
  for (const [name, command] of closed) {
    it(`⛔ denies ${name}`, () => {
      const r = run(command)
      expect(r.rc).toBe(0)
      expect(r.deny).toBe(true)
    })
  }

  it('the block log names the upstream reason', () => {
    const dir = mkdtempSync(join(tmpdir(), 'egress-union-log-'))
    dirs.push(dir)
    writeFileSync(join(dir, 'none.json'), '{}')
    const log = join(dir, 'blocks.jsonl')
    spawnSync(process.execPath, [HOOK], {
      input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: "bash <<< 'curl -s https://example.org/'" } }),
      encoding: 'utf-8',
      env: { ...process.env, BASH_EGRESS_BLOCK_LOG: log, BASH_EGRESS_VENDOR_HOSTS: join(dir, 'none.json') },
    })
    expect(readFileSync(log, 'utf-8')).toContain('"reason":"upstream-')
  })
})

describe('the upstream verdict is NOT taken where the real traffic showed false denies', () => {
  it('a python heredoc posting to the localhost dashboard with an external URL as data stays allowed', () => {
    const r = run("python3 - <<'PY'\nimport urllib.request\nurllib.request.urlopen('http://localhost:3420/api/messages', data=b'PR: https://github.com/o/r/pull/1')\nPY")
    expect(r.deny).toBe(false)
  })
  it('a python heredoc that only builds a Google API URL for a local helper stays allowed', () => {
    const r = run("python3 - <<'PY'\nimport subprocess, urllib.parse\nurl = 'https://gmail.googleapis.com/gmail/v1/users/me/messages?q=' + urllib.parse.quote('x')\nsubprocess.run(['python3', 'scripts/helper.py', 'request', '--url', url])\nPY")
    expect(r.deny).toBe(false)
  })
  it('control: a plain external curl is denied by the local layer, a localhost curl is allowed', () => {
    expect(run('curl -s https://example.org/').deny).toBe(true)
    expect(run('curl -s http://localhost:3420/api/health').deny).toBe(false)
  })
})

describe('left open by the second opinion, closed by the local (f) reading (95800e1d (3))', () => {
  it('⛔ an exec-wrapped urlopen in a python heredoc is denied', () => {
    const r = run("python3 - <<'PY'\nexec(\"import urllib.request; urllib.request.urlopen('https://example.org/')\")\nPY")
    expect(r.deny).toBe(true)
  })
})

describe('upstreamVerdictApplies: where the upstream verdict joins', () => {
  const deny = (reason: string) => ({ deny: true, reason, hosts: ['example.org'] })
  it('takes every upstream deny except heredoc-external on a python or node heredoc', () => {
    expect(upstreamVerdictApplies('x', deny('curl-external'))).toBe(true)
    expect(upstreamVerdictApplies("perl <<PL\nx\nPL", deny('heredoc-external'))).toBe(true)
    expect(upstreamVerdictApplies('python3 <<< "x"', deny('heredoc-external'))).toBe(true)
    expect(upstreamVerdictApplies("bash <<< 'curl x'", deny('heredoc-external'))).toBe(true)
    expect(upstreamVerdictApplies("python3 - <<'PY'\nx\nPY", deny('heredoc-external'))).toBe(false)
    expect(upstreamVerdictApplies('node <<EOF\nx\nEOF', deny('heredoc-external'))).toBe(false)
    expect(upstreamVerdictApplies('cd x && python3 - "$S" <<\'PY\'\nx\nPY', deny('heredoc-external'))).toBe(false)
  })
  it('an allow, a missing verdict or an upstream error never denies', () => {
    expect(upstreamVerdictApplies('x', { deny: false, reason: null, hosts: [] })).toBe(false)
    expect(upstreamVerdictApplies('x', null)).toBe(false)
  })
})

describe('the second classifier fails closed', () => {
  function tree(upstream: string | null) {
    const dir = mkdtempSync(join(tmpdir(), 'egress-union-tree-'))
    dirs.push(dir)
    mkdirSync(join(dir, 'scripts', 'hooks'), { recursive: true })
    copyFileSync(HOOK, join(dir, 'scripts', 'hooks', 'bash-egress-parser.mjs'))
    copyFileSync(join(ROOT, 'scripts', 'self-pace-gate.mjs'), join(dir, 'scripts', 'self-pace-gate.mjs'))
    if (upstream != null) writeFileSync(join(dir, 'scripts', 'hooks', 'bash-egress-parser-upstream.mjs'), upstream)
    return join(dir, 'scripts', 'hooks', 'bash-egress-parser.mjs')
  }
  it('⛔ a missing upstream module denies with exit 2 and says why', () => {
    const r = run('ls -la', tree(null))
    expect(r.rc).toBe(2)
    expect(r.stderr).toContain('masodik osztalyozoja')
  })
  it('⛔ an upstream runtime error denies with exit 2 (owner decision (b))', () => {
    const r = run('ls -la', tree("export function classify() { throw new Error('proba') }\nexport function loadVendorHosts() { return new Set() }\nexport function loadVendorDomains() { return new Set() }\n"))
    expect(r.rc).toBe(2)
    expect(r.stderr).toContain('upstream osztalyozoja belso hibaval')
  })
  it('⛔ a local runtime error denies with exit 2 too (it used to allow)', () => {
    const hook = tree(readFileSync(join(ROOT, 'scripts', 'hooks', 'bash-egress-parser-upstream.mjs'), 'utf-8'))
    const src = readFileSync(hook, 'utf-8')
    const head = 'export function classify(command, depth = 0, vendorHosts = new Set(), vendorDomains = new Set(), ctx = {}) {\n'
    expect(src.split(head).length - 1).toBe(1)
    writeFileSync(hook, src.replace(head, head + "  if (String(command).includes('KIVETEL-PROBA')) throw new Error('proba')\n"))
    const r = run('echo KIVETEL-PROBA', hook)
    expect(r.rc).toBe(2)
    expect(r.stderr).toContain('helyi osztalyozoja belso hibaval')
    expect(run('ls -la', hook).rc).toBe(0)
  })
})
