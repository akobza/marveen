// channels.sh trigger 2 (the isolation-lost shell guard) says what was MEASURED, in the TS guard's own words
// (card 40ac420c).
//
// Since card 8a4056ad (#1714) the TS respawn guard builds its isolation-lost notice from what it can measure about
// MAIN_AGENT_ISOLATED_CONFIG: the effective value, the layer it came from, the state of store/config-overrides.json.
// The shell guard kept the old fixed sentence -- the setting "probably lost", the overrides file "deleted with no
// .env key", a 401 risk, "set it back to 1" -- which on 2026-09-21 was false on every point (the overrides file
// existed, .env held a deliberate 0). Now channels.sh asks scripts/main-agent-isolation-lost-notice.mjs, which
// imports the TS guard's own getters and isolationLostAdvice from dist, so there is one wording, not two.
//
// What is measured here, and how:
//  1. the helper, run for real as a child process against a stub dist (the way resolve-plan-token-env.test.ts
//     tests its script): it hands isolationLostAdvice EXACTLY the facts the TS guard reads, for the states the TS
//     suite names -- checked end to end against the TS guard's real notice, in the settings-store sandbox;
//  2. the shell function _isolation_lost_notice, lifted out of channels.sh and run: its notice line is valid JSON,
//     and without a helper answer it is the TS guard's own text for an unreadable source;
//  3. the trigger-2 block, lifted and run with a recording curl: the POST body is valid JSON carrying that notice,
//     the WARN line names the measured facts, and none of the old unmeasured sentences is left in the script.
// channels.sh as a whole is not executed (send-honesty-final.test.ts: unsafe even stubbed); only these two lifted
// pieces are, with every external effect stubbed and the dashboard port pointing at a closed one.

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, copyFileSync, chmodSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const CHANNELS = readFileSync(join(REPO, 'scripts', 'channels.sh'), 'utf-8')
const HELPER = join(REPO, 'scripts', 'main-agent-isolation-lost-notice.mjs')

// The settings-store sandbox, as in main-config-isolation-lost-advice.test.ts: STORE_DIR is baked into
// OVERRIDES_PATH at import, so it is mocked before the modules load; .env is a fake map.
const SANDBOX = mkdtempSync(join(tmpdir(), 'isolation-lost-notice-'))
const STORE = join(SANDBOX, 'store')
mkdirSync(STORE, { recursive: true })
let ENV: Record<string, string> = {}
const sent: string[] = []

vi.mock('../config.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  MAIN_AGENT_ID: 'boss',
  PROJECT_ROOT: SANDBOX,
  STORE_DIR: STORE,
}))
vi.mock('../env.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  readEnvFile: (keys?: string[]) =>
    Object.fromEntries(Object.entries(ENV).filter(([k]) => !keys || keys.includes(k))),
}))
vi.mock('../db.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  createAgentMessage: (_from: string, _to: string, content: string) => { sent.push(content); return 1 },
}))
vi.mock('../web/agent-process.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  resolveMainAgentConfigDir: () => null,
  resolveMainAgentRotatedConfigDir: () => null,
  resolveMainAgentRotatedTokenSecretId: () => null,
  ensureMainAgentIsolatedConfigDir: () => null,
  readMainSharedConfigState: (dir: string | null) => ({ isolatedConfigDir: dir, fleetToken: true, isolatedDirExists: true }),
}))

const { OVERRIDES_PATH, getEffectiveSettingSource, getOverridesFileState, reloadOverridesForTest } = await import('../settings-store.js')
const { isolationLostAdvice, resolveMainConfigDecision } = await import('../web/main-config-decision.js')

// A throwaway install root for the helper: the real script, and a stub dist that answers with given facts and
// returns the facts it was handed (so the test sees exactly what the helper passed to isolationLostAdvice).
const ROOT = mkdtempSync(join(tmpdir(), 'isolation-lost-notice-root-'))
const STUB_STORE = `export function getEffectiveSettingSource(key) {
  if (key !== 'MAIN_AGENT_ISOLATED_CONFIG') throw new Error('unexpected key ' + key)
  if (process.env.STUB_THROW === '1') throw new Error('settings unreadable')
  const v = process.env.STUB_VALUE_NUM === '1' ? Number(process.env.STUB_VALUE) : process.env.STUB_VALUE
  return { value: v, source: process.env.STUB_SOURCE }
}
export function getOverridesFileState() {
  return process.env.STUB_CAUSE === undefined ? { state: process.env.STUB_STATE } : { state: process.env.STUB_STATE, cause: process.env.STUB_CAUSE }
}
`
const STUB_DECISION = `process.stdout.write('pino-like noise on fd 1\\n')
export function isolationLostAdvice(f) { return 'FACTS:' + JSON.stringify(f) }
`

beforeAll(() => {
  mkdirSync(join(ROOT, 'scripts'), { recursive: true })
  mkdirSync(join(ROOT, 'dist', 'web'), { recursive: true })
  mkdirSync(join(ROOT, 'store'), { recursive: true })
  copyFileSync(HELPER, join(ROOT, 'scripts', 'main-agent-isolation-lost-notice.mjs'))
  writeFileSync(join(ROOT, 'dist', 'settings-store.js'), STUB_STORE)
  writeFileSync(join(ROOT, 'dist', 'web', 'main-config-decision.js'), STUB_DECISION)
})

afterAll(() => {
  rmSync(SANDBOX, { recursive: true, force: true })
  rmSync(ROOT, { recursive: true, force: true })
})

/** Run the helper with fd 3 as the contract channel, the way channels.sh calls it. */
function runHelper(env: Record<string, string>, root = ROOT): { contract: string; stdout: string; status: number | null } {
  const r = spawnSync(process.execPath, [join(root, 'scripts', 'main-agent-isolation-lost-notice.mjs')], {
    env: { PATH: process.env['PATH'] ?? '', ...env },
    stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
    encoding: 'utf-8',
    timeout: 20000,
  })
  return { contract: String(r.output?.[3] ?? ''), stdout: r.stdout, status: r.status }
}

function contractLine(contract: string, tag: string): string | undefined {
  return contract.split('\n').find((l) => l.startsWith(`${tag}\t`))?.slice(tag.length + 1)
}

/** The facts the helper handed isolationLostAdvice (the stub echoes them). */
function handedFacts(contract: string): unknown {
  const notice = contractLine(contract, 'notice')
  expect(notice, 'the helper printed no notice line').toBeDefined()
  const text = JSON.parse(notice as string) as string
  expect(text.startsWith('FACTS:')).toBe(true)
  return JSON.parse(text.slice('FACTS:'.length))
}

function overrides(o: Record<string, string> | null): void {
  if (existsSync(OVERRIDES_PATH)) rmSync(OVERRIDES_PATH, { recursive: true, force: true })
  if (o) writeFileSync(OVERRIDES_PATH, JSON.stringify(o))
  reloadOverridesForTest()
}
function overridesRaw(text: string): void {
  if (existsSync(OVERRIDES_PATH)) rmSync(OVERRIDES_PATH, { recursive: true, force: true })
  writeFileSync(OVERRIDES_PATH, text)
  reloadOverridesForTest()
}

beforeEach(() => {
  ENV = {}
  sent.length = 0
  overrides(null)
  rmSync(join(SANDBOX, 'store', '.main-config-guard-warned'), { force: true })
})

describe('1. the helper hands isolationLostAdvice the facts the TS guard reads, and the TS guard sends the same text', () => {
  // The states the TS suite names (main-config-isolation-lost-advice.test.ts), set up in the sandbox. For each:
  // what the real settings-store reports goes into the stub dist, the helper runs, and the facts it hands on are
  // fed to the REAL isolationLostAdvice; the result must equal the notice the TS guard itself sends for that state.
  const states: Array<[string, () => void]> = [
    ['THE 2026-09-21 STATE: overrides file without the key, .env=0', () => { overrides({ CLAUDE_ROTATION_ENABLED: '1' }); ENV = { MAIN_AGENT_ISOLATED_CONFIG: '0' } }],
    ['the setting really missing (no file, no key)', () => { overrides(null) }],
    ['an override of 0 over a .env of 1', () => { overrides({ MAIN_AGENT_ISOLATED_CONFIG: '0' }); ENV = { MAIN_AGENT_ISOLATED_CONFIG: '1' } }],
    ['.env=1 and still the shared root', () => { ENV = { MAIN_AGENT_ISOLATED_CONFIG: '1' } }],
    ['a value that is neither 0 nor 1, with spaces around it', () => { ENV = { MAIN_AGENT_ISOLATED_CONFIG: '  yes  ' } }],
    ['the key in a file that does not parse, .env=0', () => { overridesRaw('{"MAIN_AGENT_ISOLATED_CONFIG": "1",'); ENV = { MAIN_AGENT_ISOLATED_CONFIG: '0' } }],
    ['a file that does not parse, nothing in .env', () => { overridesRaw('not json') }],
  ]
  for (const [name, setUp] of states) {
    it(name, () => {
      setUp()
      const { value, source } = getEffectiveSettingSource('MAIN_AGENT_ISOLATED_CONFIG')
      const file = getOverridesFileState()
      const env: Record<string, string> = { STUB_VALUE: String(value), STUB_SOURCE: source, STUB_STATE: file.state }
      if (typeof value === 'number') env['STUB_VALUE_NUM'] = '1'
      if (file.cause !== undefined) env['STUB_CAUSE'] = file.cause
      const r = runHelper(env)
      expect(r.status).toBe(0)
      const viaShell = isolationLostAdvice(handedFacts(r.contract) as Parameters<typeof isolationLostAdvice>[0])
      resolveMainConfigDecision()
      expect(sent).toHaveLength(1)
      expect(viaShell).toBe(sent[0])
    })
  }

  it('an unreadable setting is handed on as null, and the setting line says so', () => {
    const r = runHelper({ STUB_THROW: '1', STUB_STATE: 'missing' })
    expect(handedFacts(r.contract)).toBeNull()
    expect(contractLine(r.contract, 'setting')).toBe('MAIN_AGENT_ISOLATED_CONFIG: source unreadable')
  })

  it('the setting line names the value, the layer and the file state, on one line', () => {
    const r = runHelper({ STUB_VALUE: '0\nnext', STUB_SOURCE: 'env', STUB_STATE: 'unreadable', STUB_CAUSE: 'EACCES' })
    expect(contractLine(r.contract, 'setting')).toBe('MAIN_AGENT_ISOLATED_CONFIG=0 next (source: env; store/config-overrides.json: unreadable, EACCES)')
  })

  it('the contract travels on fd 3 only: what the dist modules print on fd 1 never reaches it', () => {
    const r = runHelper({ STUB_VALUE: '0', STUB_SOURCE: 'env', STUB_STATE: 'missing' })
    expect(r.stdout).toContain('pino-like noise')
    expect(r.contract).not.toContain('pino-like noise')
    expect(r.contract.split('\n').filter(Boolean)).toHaveLength(2)
  })

  it('without a loadable dist it prints nothing and exits 0 (the caller falls back)', () => {
    const bare = mkdtempSync(join(tmpdir(), 'isolation-lost-notice-bare-'))
    try {
      mkdirSync(join(bare, 'scripts'), { recursive: true })
      copyFileSync(HELPER, join(bare, 'scripts', 'main-agent-isolation-lost-notice.mjs'))
      const r = runHelper({}, bare)
      expect(r.status).toBe(0)
      expect(r.contract).toBe('')
    } finally {
      rmSync(bare, { recursive: true, force: true })
    }
  })
})

/** A piece of channels.sh between two exact markers, both present once. */
function lift(start: string, end: string): string {
  const a = CHANNELS.indexOf(start)
  const b = a >= 0 ? CHANNELS.indexOf(end, a) : -1
  expect(a, `not found in channels.sh: ${start}`).toBeGreaterThanOrEqual(0)
  expect(CHANNELS.indexOf(start, a + 1), `twice in channels.sh: ${start}`).toBe(-1)
  expect(b, `no end marker after: ${start}`).toBeGreaterThan(a)
  return CHANNELS.slice(a, b + end.length)
}

describe('2. the shell function _isolation_lost_notice', () => {
  const fn = () => lift('_isolation_lost_notice() {', '\n}\n')

  function runFn(root: string): { setting: string; notice: string } {
    const r = spawnSync('bash', ['-c', `${fn()}\n_isolation_lost_notice`], {
      env: { PATH: process.env['PATH'] ?? '', INSTALL_DIR: root, _node_bin: process.execPath, STUB_VALUE: '0', STUB_SOURCE: 'env', STUB_STATE: 'readable' },
      encoding: 'utf-8',
      timeout: 20000,
    })
    expect(r.status).toBe(0)
    const lines = r.stdout.split('\n')
    return {
      setting: lines.find((l) => l.startsWith('setting\t'))?.slice('setting\t'.length) ?? '',
      notice: lines.find((l) => l.startsWith('notice\t'))?.slice('notice\t'.length) ?? '',
    }
  }

  it('passes the helper\'s measured facts and its notice through, the notice as valid JSON', () => {
    const out = runFn(ROOT)
    expect(out.setting).toBe('MAIN_AGENT_ISOLATED_CONFIG=0 (source: env; store/config-overrides.json: readable)')
    expect(JSON.parse(out.notice)).toBe('FACTS:' + JSON.stringify({ value: '0', source: 'env', overridesFile: 'readable' }))
  })

  it('without a helper answer it says "not measured", and the notice is the TS guard\'s own text for an unreadable source', () => {
    const bare = mkdtempSync(join(tmpdir(), 'isolation-lost-notice-fn-'))
    try {
      mkdirSync(join(bare, 'store'), { recursive: true })
      const out = runFn(bare)
      expect(out.setting).toBe('MAIN_AGENT_ISOLATED_CONFIG: not measured (the notice helper gave no contract line)')
      expect(JSON.parse(out.notice)).toBe(isolationLostAdvice(null))
    } finally {
      rmSync(bare, { recursive: true, force: true })
    }
  })
})

describe('3. trigger 2 sends that notice, and the old unmeasured sentence is gone', () => {
  const block = () => lift('  if [ -z "$CFG_ENV" ] && [ -d "$INSTALL_DIR/.channels-config" ]; then\n', '\n    unset _lost _lost_setting _lost_notice\n  fi\n')

  it('the POST body is valid JSON whose content is the measured notice; the WARN line names the facts', () => {
    const run = mkdtempSync(join(tmpdir(), 'isolation-lost-notice-t2-'))
    try {
      // the install root: the helper and the stub dist from ROOT, the .channels-config dir, a fake token, and a
      // dashboard port nobody listens on, in case the recording curl below were ever bypassed
      mkdirSync(join(run, 'scripts'), { recursive: true })
      mkdirSync(join(run, 'dist', 'web'), { recursive: true })
      mkdirSync(join(run, 'store'), { recursive: true })
      mkdirSync(join(run, '.channels-config'), { recursive: true })
      copyFileSync(HELPER, join(run, 'scripts', 'main-agent-isolation-lost-notice.mjs'))
      writeFileSync(join(run, 'dist', 'settings-store.js'), STUB_STORE)
      writeFileSync(join(run, 'dist', 'web', 'main-config-decision.js'), STUB_DECISION)
      writeFileSync(join(run, 'store', '.dashboard-token'), 'test-fixture-not-a-real-dashboard-token')
      writeFileSync(join(run, '.env'), 'WEB_PORT=1\n')
      // a curl that records its arguments (one per line) and answers HTTP 200 the way -w '%{http_code}' would
      const bin = join(run, 'bin')
      mkdirSync(bin)
      writeFileSync(join(bin, 'curl'), `#!/bin/bash\nprintf '%s\\n' "$@" > "${join(run, 'curl.args')}"\nprintf 200\n`)
      chmodSync(join(bin, 'curl'), 0o755)
      const sender = lift('_guard_sender() {', '\n}\n')
      const r = spawnSync('bash', ['-c', `${sender}\n${lift('_isolation_lost_notice() {', '\n}\n')}\nCFG_ENV=""\n${block()}`], {
        env: {
          PATH: `${bin}:${process.env['PATH'] ?? ''}`,
          INSTALL_DIR: run,
          _node_bin: process.execPath,
          MAIN_AGENT_ID: 'boss',
          STUB_VALUE: '0',
          STUB_SOURCE: 'env',
          STUB_STATE: 'readable',
        },
        encoding: 'utf-8',
        timeout: 20000,
      })
      expect(r.status, r.stderr).toBe(0)
      const args = readFileSync(join(run, 'curl.args'), 'utf-8').split('\n')
      const body = args[args.indexOf('-d') + 1]
      const parsed = JSON.parse(body) as { from: string; to: string; content: string }
      expect(parsed.to).toBe('boss')
      expect(parsed.content).toBe('FACTS:' + JSON.stringify({ value: '0', source: 'env', overridesFile: 'readable' }))
      const log = readFileSync(join(run, 'store', 'channels-failures.log'), 'utf-8')
      expect(log).toMatch(/channels\.sh: WARN main-agent starting on SHARED ~\/\.claude although isolated dir .*\.channels-config exists -- MAIN_AGENT_ISOLATED_CONFIG=0 \(source: env; store\/config-overrides\.json: readable\)\n/)
      expect(log).not.toContain('guard alert POST failed')
    } finally {
      rmSync(run, { recursive: true, force: true })
    }
  })

  it('none of the old unmeasured sentences is left in channels.sh', () => {
    for (const old of [
      'valoszinuleg elveszett',
      'torlodott es nincs .env kulcs',
      'MAIN_AGENT_ISOLATED_CONFIG=1 visszaallitasa',
      'overrides/.env key lost?',
      'Auth rides the rotating shared session and can 401',
    ]) {
      expect(CHANNELS, old).not.toContain(old)
    }
  })
})
