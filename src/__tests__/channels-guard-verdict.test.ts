import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

// 80d46c59 -- channels.sh's LOUD REGRESSION GUARD, run for real.
//
// The guard used to read every '0' of MAIN_AGENT_ISOLATED_CONFIG as "unset" (with a fleet token)
// or "lost" (with a .channels-config dir), so an operator who had turned isolation off on purpose
// was told it was not configured. It now asks the helper for the respawn guard's own verdict
// (`--verdict`) and says what that verdict says. This file cuts the guard block out of the real
// channels.sh and runs it in bash against a temp INSTALL_DIR with a FAKE helper that prints a
// chosen verdict on fd 3 -- so what is measured is the shell's case mapping and its fallback,
// not the source text. No .dashboard-token is written, so no POST can leave the box.

const __dirname = dirname(fileURLToPath(import.meta.url))
const CHANNELS = readFileSync(join(__dirname, '..', '..', 'scripts', 'channels.sh'), 'utf-8')
const START = '  # LOUD REGRESSION GUARD. Every notice'
const END = '  unset _cfg_raw _cfg_line _cfg_mode _cfg_dir\n'
const BLOCK = CHANNELS.slice(CHANNELS.indexOf(START), CHANNELS.indexOf(END, CHANNELS.indexOf(START)))

let dir = ''
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'chguard-'))
  mkdirSync(join(dir, 'store'), { recursive: true })
  mkdirSync(join(dir, 'scripts'), { recursive: true })
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

/** Runs the guard block. `verdict` is what the fake helper prints on fd 3 (null = nothing). */
function futtat(opts: { verdict: string | null; token?: boolean; channelsConfig?: boolean }): string {
  const helper = opts.verdict === null
    ? '' // the helper ran and printed nothing, e.g. its verdict could not be computed
    : `import { writeSync } from 'node:fs'\nwriteSync(3, ${JSON.stringify(opts.verdict + '\n')})\n`
  writeFileSync(join(dir, 'scripts', 'main-agent-isolated-config.mjs'), helper)
  if (opts.token) writeFileSync(join(dir, 'store', '.claude-oauth-token'), 'fake-token-not-real')
  if (opts.channelsConfig) mkdirSync(join(dir, '.channels-config'))
  const script = `set -u\nINSTALL_DIR='${dir}'\n_node_bin='${process.execPath}'\nCFG_ENV=""\n${BLOCK}\n`
  const r = spawnSync('bash', ['-c', script], { encoding: 'utf-8' })
  expect(r.status, r.stderr).toBe(0)
  const log = join(dir, 'store', 'channels-failures.log')
  return existsSync(log) ? readFileSync(log, 'utf-8') : ''
}

describe('the guard block was found (the cut is the thing under test)', () => {
  it('starts at the guard and ends before the _cfg unset line', () => {
    expect(BLOCK.startsWith(START)).toBe(true)
    expect(BLOCK).toContain('--verdict')
    expect(BLOCK.length).toBeGreaterThan(2000)
  })
})

describe('the verdict decides the notice', () => {
  it('none: a stock install stays silent', () => {
    expect(futtat({ verdict: 'shared\tnone', token: true })).toBe('')
  })

  it('fleet-token-unused: the unset notice, word for word as before', () => {
    const log = futtat({ verdict: 'shared\tfleet-token-unused' })
    expect(log).toContain('although a fleet setup-token exists (store/.claude-oauth-token) -- MAIN_AGENT_ISOLATED_CONFIG is unset')
  })

  it('isolation-lost: the lost notice, word for word as before', () => {
    const log = futtat({ verdict: 'shared\tisolation-lost' })
    expect(log).toContain('.channels-config exists -- MAIN_AGENT_ISOLATED_CONFIG resolution came back empty (overrides/.env key lost?)')
  })

  it('isolation-declined: says EXPLICITLY not 1, and never "unset" or "lost"', () => {
    const log = futtat({ verdict: 'shared\tisolation-declined', token: true, channelsConfig: true })
    expect(log).toContain('MAIN_AGENT_ISOLATED_CONFIG is EXPLICITLY not 1')
    expect(log).not.toMatch(/is unset|key lost/)
  })

  it('isolation-unresolved: says the setting IS 1 and nothing resolved', () => {
    const log = futtat({ verdict: 'shared\tisolation-unresolved' })
    expect(log).toContain('although MAIN_AGENT_ISOLATED_CONFIG=1 -- isolation is on')
    expect(log).not.toMatch(/is unset|key lost/)
  })
})

describe('no verdict: the old conditions still fire, with a text that does not guess', () => {
  it('a token on disk and no verdict: the no-verdict notice', () => {
    const log = futtat({ verdict: null, token: true })
    expect(log).toContain('gave no verdict')
    expect(log).not.toMatch(/is unset|key lost|EXPLICITLY/)
  })

  it('a .channels-config on disk and no verdict: the same', () => {
    expect(futtat({ verdict: null, channelsConfig: true })).toContain('gave no verdict')
  })

  it('nothing on disk and no verdict: silent, like before', () => {
    expect(futtat({ verdict: null })).toBe('')
  })

  it('a malformed verdict counts as none given', () => {
    expect(futtat({ verdict: 'shared\tsomething-else', token: true })).toContain('gave no verdict')
  })
})

describe('POSITIVE CONTROL', () => {
  it('different verdicts give different lines -- a guard that always printed one text cannot pass', () => {
    const vonalak = ['fleet-token-unused', 'isolation-lost', 'isolation-declined', 'isolation-unresolved'].map((t) => {
      rmSync(join(dir, 'store', 'channels-failures.log'), { force: true })
      return futtat({ verdict: `shared\t${t}` }).replace(/^\S+ \S+ /, '')
    })
    expect(new Set(vonalak).size).toBe(4)
  })
})

describe('the helper --verdict mode (source): the same decision, and no provisioning', () => {
  const HELPER = readFileSync(join(__dirname, '..', '..', 'scripts', 'main-agent-isolated-config.mjs'), 'utf-8')
  const verdictAg = HELPER.slice(HELPER.indexOf('if (verdictMode) {'), HELPER.indexOf('} else {', HELPER.indexOf('if (verdictMode) {')))

  it('prints shared\\t<trigger> from mainSharedConfigTrigger(readMainSharedConfigState(null)), none for null', () => {
    expect(verdictAg).toMatch(/mainSharedConfigTrigger\(readMainSharedConfigState\(null\)\) \?\? 'none'/)
  })

  it('the verdict branch never provisions a dir', () => {
    expect(verdictAg.length).toBeGreaterThan(0)
    expect(verdictAg).not.toContain('ensureMainAgentIsolatedConfigDir')
  })
})
