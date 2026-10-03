import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkPersonIds } from '../security/person-id-check.js'
import { runGate } from '../security/secret-gate.js'

// Card 7b964221: the pre-commit run of the secret gate checks the staged additions for KNOWN
// person identifiers, through the existing scanner (scripts/person-id-scan.py). Every identifier
// here is SYNTHETIC and lives only in a throwaway configuration tree built per run, the same way
// the scanner's own tests point --root at a fixture: no real identifier is in this file, and the
// gate finds these only because the fixture configuration lists them.

const REPO = process.cwd()
const RUNNER = join(REPO, 'scripts', 'secret-gate.ts')
const SCANNER = join(REPO, 'scripts', 'person-id-scan.py')
const TSX = join(REPO, 'node_modules', '.bin', 'tsx')

const MAIN_ID = '9990000001' // the main channel's allowFrom
const SUB_ID = '9990000003' // only a sub-agent channel knows this one
const PRINCIPAL_ID = '9990000004' // only principals.json knows this one
const NOT_LISTED = '9990000009' // same length, in no list

/** A secret shape the core detects, assembled at runtime (see secret-gate-runner.test.ts). */
const SECRET_LINE = `const k = '${'AKIA'}${'ABCDEFGHIJKLMNOP'}'`

let tmp: string
let fixture: string

function makeConfig(root: string, opts: { corrupt?: boolean } = {}): string {
  const main = join(root, '.claude', 'channels', 'telegram')
  const sub = join(root, 'agents', 'sub', '.claude', 'channels', 'telegram')
  mkdirSync(main, { recursive: true })
  mkdirSync(sub, { recursive: true })
  mkdirSync(join(root, 'store'), { recursive: true })
  writeFileSync(join(main, 'access.json'), opts.corrupt ? '{ not json' : JSON.stringify({ allowFrom: [MAIN_ID] }))
  writeFileSync(join(sub, 'access.json'), JSON.stringify({ allowFrom: [SUB_ID] }))
  writeFileSync(join(root, 'store', 'principals.json'), JSON.stringify({ principals: { [PRINCIPAL_ID]: { name: 'Owner A' } } }))
  return root
}

/** A unified diff that adds `lines` as a new file, the shape `git diff --cached` produces. */
function addedFile(path: string, lines: string[]): string {
  return [
    `diff --git a/${path} b/${path}`,
    'new file mode 100644',
    '--- /dev/null',
    `+++ b/${path}`,
    `@@ -0,0 +1,${lines.length} @@`,
    ...lines.map((l) => `+${l}`),
    '',
  ].join('\n')
}

function check(diff: string, extra: Partial<Parameters<typeof checkPersonIds>[0]> = {}) {
  return checkPersonIds({ mode: '--staged', diff, scanner: SCANNER, root: fixture, ...extra })
}

function fakeScanner(name: string, body: string): string {
  const p = join(tmp, name)
  writeFileSync(p, body)
  return p
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' })
}

function newRepo(): string {
  const root = mkdtempSync(join(tmp, 'repo-'))
  git(root, ['init', '-q', '-b', 'main'])
  git(root, ['config', 'user.email', 'test@example.invalid'])
  git(root, ['config', 'user.name', 'test'])
  writeFileSync(join(root, 'README.md'), '# base\n')
  git(root, ['add', '-A'])
  git(root, ['commit', '-qm', 'base'])
  return root
}

function runGateCli(cwd: string, args: string[], root: string): { status: number; out: string } {
  const r = spawnSync(TSX, [RUNNER, ...args], {
    cwd,
    encoding: 'utf-8',
    env: { ...process.env, SECRET_GATE_PERSON_ID_ROOT: root },
  })
  return { status: r.status ?? -1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` }
}

beforeAll(() => {
  expect(existsSync(SCANNER), 'the identifier scanner must be in this tree').toBe(true)
  expect(existsSync(TSX), 'tsx must be installed to run the gate').toBe(true)
  tmp = mkdtempSync(join(tmpdir(), 'secret-gate-person-id-'))
  fixture = makeConfig(join(tmp, 'config'))
})

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true })
})

describe('person-id check: a listed identifier in any form is found, masked', () => {
  it.each([
    ['a string literal', `const owner = '${MAIN_ID}'`, MAIN_ID],
    ['a comment', `// the sub channel's owner is ${SUB_ID}`, SUB_ID],
    ['JSON', `{ "owner": ${PRINCIPAL_ID}, "role": "staff" }`, PRINCIPAL_ID],
    ['a URL', `const url = 'https://api.example.test/send?to=${MAIN_ID}&text=hi'`, MAIN_ID],
  ])('%s', (_form, text, id) => {
    const out = check(addedFile('src/notes.ts', ['export const a = 1', text]))
    expect(out.status).toBe('found')
    if (out.status !== 'found') return
    expect(out.findings).toEqual([{ file: 'src/notes.ts', line: 2, masked: `*******${id.slice(-3)}` }])
    // The full identifier is never part of the outcome.
    expect(JSON.stringify(out)).not.toContain(id)
  })

  it('each source of the one list counts: main channel, sub-agent channel, principals', () => {
    const out = check(addedFile('src/three.ts', [`a = ${MAIN_ID}`, `b = ${SUB_ID}`, `c = ${PRINCIPAL_ID}`]))
    expect(out.status).toBe('found')
    if (out.status === 'found') expect(out.findings.map((f) => f.line)).toEqual([1, 2, 3])
  })

  it('NEGATIVE: a same-length number that is in no list passes', () => {
    const out = check(addedFile('src/other.ts', [`const other = '${NOT_LISTED}'`, `// ${NOT_LISTED}`]))
    expect(out).toEqual({ status: 'clean', identifiers: 3, scannedLines: 2 })
  })

  it('a longer number that only CONTAINS a listed identifier is not a hit', () => {
    const out = check(addedFile('src/longer.ts', [`const n = 1${MAIN_ID}2`]))
    expect(out.status).toBe('clean')
  })

  it('only added lines are scanned: a listed identifier on a removed line does not block', () => {
    const diff = ['diff --git a/src/x.ts b/src/x.ts', '--- a/src/x.ts', '+++ b/src/x.ts', '@@ -1 +1 @@', `-const owner = '${MAIN_ID}'`, `+const owner = '${NOT_LISTED}'`, ''].join('\n')
    expect(check(diff).status).toBe('clean')
  })
})

describe('person-id check: when it cannot answer, it says so (not-run), and never claims clean', () => {
  it.each(['--range', '--all'])('mode %s: not run, the list is only in the local configuration', (mode) => {
    const out = check(addedFile('src/a.ts', [`x = ${MAIN_ID}`]), { mode })
    expect(out.status).toBe('not-run')
    if (out.status === 'not-run') expect(out.reason).toContain(`mode ${mode}`)
  })

  it('no scanner in the tree', () => {
    const out = check(addedFile('src/a.ts', [`x = ${MAIN_ID}`]), { scanner: join(tmp, 'missing.py') })
    expect(out.status).toBe('not-run')
    if (out.status === 'not-run') expect(out.reason).toContain('not in this tree')
  })

  it('no configuration under the root', () => {
    const empty = mkdtempSync(join(tmp, 'empty-'))
    const out = check(addedFile('src/a.ts', [`x = ${MAIN_ID}`]), { root: empty })
    expect(out.status).toBe('not-run')
    if (out.status === 'not-run') expect(out.reason).toContain('no access.json')
  })

  it('an unreadable source: a partial list is not a clean answer', () => {
    const broken = makeConfig(mkdtempSync(join(tmp, 'broken-')), { corrupt: true })
    const out = check(addedFile('src/a.ts', [`x = ${SUB_ID}`]), { root: broken })
    expect(out.status).toBe('not-run')
    if (out.status === 'not-run') expect(out.reason).toContain('unreadable')
  })

  it('a scanner that does not finish in time', () => {
    const slow = fakeScanner('slow.py', 'import time\ntime.sleep(10)\n')
    const out = check('', { scanner: slow, timeoutMs: 500 })
    expect(out.status).toBe('not-run')
    if (out.status === 'not-run') expect(out.reason).toContain('did not finish')
  })

  it('a scanner that crashes (a traceback also exits 1) is not a finding', () => {
    const crash = fakeScanner('crash.py', 'raise RuntimeError("boom")\n')
    const out = check('', { scanner: crash })
    expect(out.status).toBe('not-run')
    if (out.status === 'not-run') expect(out.reason).toMatch(/failed \(exit 1\).*RuntimeError: boom/)
  })

  it('a FOUND answer whose lines cannot be parsed still blocks', () => {
    const odd = fakeScanner('odd.py', 'import sys\nprint("FOUND 1 identifier occurrence(s):")\nsys.exit(1)\n')
    const out = check('', { scanner: odd })
    expect(out.status).toBe('found')
  })
})

describe('secret-gate runner, --staged: the person-id check is part of the pre-commit verdict', () => {
  it('a listed identifier blocks the commit: file:line, masked, never the full value', () => {
    const repo = newRepo()
    mkdirSync(join(repo, 'src'))
    writeFileSync(join(repo, 'src', 'owner.ts'), `export const a = 1\nexport const owner = '${MAIN_ID}'\n`)
    git(repo, ['add', '-A'])
    const r = runGateCli(repo, ['--staged'], fixture)
    expect(r.status).toBe(1)
    expect(r.out).toContain('src/owner.ts:2  [person-id]  *******001')
    expect(r.out).not.toContain(MAIN_ID)
    expect(r.out).not.toContain('PASS')
  })

  it('--staged reads the INDEX: an identifier staged and then edited away in the working tree still blocks', () => {
    const repo = newRepo()
    writeFileSync(join(repo, 'later.ts'), `export const owner = '${PRINCIPAL_ID}'\n`)
    git(repo, ['add', '-A'])
    writeFileSync(join(repo, 'later.ts'), `export const owner = '${NOT_LISTED}'\n`)
    const r = runGateCli(repo, ['--staged'], fixture)
    expect(r.status).toBe(1)
    expect(r.out).toContain('later.ts:1  [person-id]  *******004')
  })

  it('a clean staged set passes, and the PASS line names the person-id check', () => {
    const repo = newRepo()
    writeFileSync(join(repo, 'ok.ts'), `export const other = '${NOT_LISTED}'\n`)
    git(repo, ['add', '-A'])
    const r = runGateCli(repo, ['--staged'], fixture)
    expect(r.status).toBe(0)
    expect(r.out).toContain('PASS: no denied path, no secret shape, no channel material, no known person identifier in 1 file(s).')
  })

  it('without a readable configuration it passes, says the check did NOT run, and the PASS line does not claim it', () => {
    const repo = newRepo()
    writeFileSync(join(repo, 'ok.ts'), `export const owner = '${MAIN_ID}'\n`)
    git(repo, ['add', '-A'])
    const r = runGateCli(repo, ['--staged'], mkdtempSync(join(tmp, 'noconf-')))
    expect(r.status).toBe(0)
    expect(r.out).toContain('PASS: no denied path, no secret shape, no channel material in 1 file(s).')
    expect(r.out).toContain('The person-identifier check did NOT run')
    expect(r.out).toContain('This PASS says nothing about person identifiers.')
    expect(r.out).not.toContain('no known person identifier')
  })

  it('--range (CI) does not run the check, says so, and is not turned red by it', () => {
    const repo = newRepo()
    const base = git(repo, ['rev-parse', 'HEAD']).trim()
    writeFileSync(join(repo, 'ok.ts'), `export const owner = '${MAIN_ID}'\n`)
    git(repo, ['add', '-A'])
    git(repo, ['commit', '-qm', 'add'])
    const r = runGateCli(repo, ['--range', `${base}..HEAD`], fixture)
    expect(r.status).toBe(0)
    expect(r.out).toContain('The person-identifier check did NOT run: mode --range')
    expect(r.out).not.toContain('no known person identifier')
  })

  it('a secret and a listed identifier together: both are reported, the commit fails', () => {
    const repo = newRepo()
    writeFileSync(join(repo, 'both.ts'), `${SECRET_LINE}\nexport const owner = '${SUB_ID}'\n`)
    git(repo, ['add', '-A'])
    const r = runGateCli(repo, ['--staged'], fixture)
    expect(r.status).toBe(1)
    expect(r.out).toContain('BLOCKED (1):')
    expect(r.out).toContain('both.ts:2  [person-id]  *******003')
  })
})

describe('replay of the measured case: a chat id mocked into a test', () => {
  // The shape of the original miss: a test that mocks the chat-id environment variable with a
  // real owner id. Replayed with a synthetic listed id.
  const CASE = [
    "import { vi } from 'vitest'",
    "vi.stubEnv('CHANNEL_CHAT_ID', '9990000001')",
    "process.env.CHANNEL_CHAT_ID = '9990000001'",
  ]

  it('the pattern core alone still passes it: the gap the check closes', () => {
    expect(runGate([{ path: 'src/__tests__/router-ready.test.ts', content: `${CASE.join('\n')}\n` }]).ok).toBe(true)
  })

  it('the staged run now FAILS it, at both lines', () => {
    const repo = newRepo()
    mkdirSync(join(repo, 'src', '__tests__'), { recursive: true })
    writeFileSync(join(repo, 'src', '__tests__', 'router-ready.test.ts'), `${CASE.join('\n')}\n`)
    git(repo, ['add', '-A'])
    const r = runGateCli(repo, ['--staged'], fixture)
    expect(r.status).toBe(1)
    expect(r.out).toContain('src/__tests__/router-ready.test.ts:2  [person-id]  *******001')
    expect(r.out).toContain('src/__tests__/router-ready.test.ts:3  [person-id]  *******001')
  })
})
