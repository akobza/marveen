import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { existsSync, mkdirSync, rmSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// 80d46c59 -- getEffectiveSettingWithSource: the value AND where it came from.
//
// The bug this serves: MAIN_AGENT_ISOLATED_CONFIG defaults to '0', so
// getEffectiveSettingValue returns the same '0' for a MISSING setting, an explicit
// override '0' and an explicit .env '0'. The respawn guard read "missing" into all
// three and told the operator every 6 hours that the setting was not configured,
// even when they had just turned it off on purpose.
//
// Same enforced sandbox as settings-store.test.ts (the 2026-07-27 incident), plus a
// CONTROLLABLE .env layer instead of a blank one, so the env source is measurable.
const SANDBOX = mkdtempSync(join(tmpdir(), 'settings-store-source-'))
const STORE = join(SANDBOX, 'store')
const envFake: Record<string, string> = {}

vi.mock('../config.js', async (orig) => {
  const actual = await orig<typeof import('../config.js')>()
  return { ...actual, PROJECT_ROOT: SANDBOX, STORE_DIR: STORE }
})
vi.mock('../env.js', async (orig) => {
  const actual = await orig<typeof import('../env.js')>()
  return {
    ...actual,
    readEnvFile: (keys?: string[]) =>
      Object.fromEntries(Object.entries(envFake).filter(([k]) => !keys || keys.includes(k))),
  }
})

const { OVERRIDES_PATH, getEffectiveSettingValue, getEffectiveSettingWithSource, setOverride, reloadOverridesForTest } =
  await import('../settings-store.js')
const { getSettingDefinition } = await import('../config-registry.js')

const KEY = 'MAIN_AGENT_ISOLATED_CONFIG'

/** The pre-80d46c59 body of getEffectiveSettingValue, kept here as the reference the
 *  delegating version must match: override > .env > registry default, int coerced. */
function regiFeloldas(key: string, overrides: Record<string, string | number>): string | number {
  const def = getSettingDefinition(key)
  if (!def) throw new Error(`Unknown setting key: ${key}`)
  const coerce = (raw: string | number) =>
    def.type === 'int' ? (typeof raw === 'number' ? raw : parseInt(raw, 10)) : String(raw)
  if (key in overrides) return coerce(overrides[key])
  if (envFake[key] !== undefined) return coerce(envFake[key])
  return def.default
}

describe('getEffectiveSettingWithSource', () => {
  beforeEach(() => {
    mkdirSync(STORE, { recursive: true })
    if (existsSync(OVERRIDES_PATH)) rmSync(OVERRIDES_PATH)
    reloadOverridesForTest()
    for (const k of Object.keys(envFake)) delete envFake[k]
  })

  afterAll(() => {
    rmSync(SANDBOX, { recursive: true, force: true })
  })

  it('resolves OVERRIDES_PATH inside the sandbox (the guard this suite relies on)', () => {
    expect(OVERRIDES_PATH).toBe(join(STORE, 'config-overrides.json'))
  })

  it('tells the four cases apart: missing, override 0, .env 0, and a non-zero registry default', () => {
    expect(getEffectiveSettingWithSource(KEY)).toEqual({ value: '0', source: 'default' })

    expect(setOverride(KEY, '0').ok).toBe(true)
    expect(getEffectiveSettingWithSource(KEY)).toEqual({ value: '0', source: 'override' })

    rmSync(OVERRIDES_PATH)
    reloadOverridesForTest()
    envFake[KEY] = '0'
    expect(getEffectiveSettingWithSource(KEY)).toEqual({ value: '0', source: 'env' })

    // A key whose default is not '0' and not a string: the type is kept, the source is 'default'.
    expect(getEffectiveSettingWithSource('KANBAN_WIP_WARN_PCT')).toEqual({ value: 80, source: 'default' })
  })

  it('NEGATIVE: the old value-only resolution cannot tell missing from an explicit 0 -- that is the bug', () => {
    const missing = getEffectiveSettingValue(KEY)
    setOverride(KEY, '0')
    const override0 = getEffectiveSettingValue(KEY)
    rmSync(OVERRIDES_PATH)
    reloadOverridesForTest()
    envFake[KEY] = '0'
    const env0 = getEffectiveSettingValue(KEY)
    expect(new Set([missing, override0, env0]).size).toBe(1)
  })

  it('keeps the precedence: an override beats .env, and .env beats the default', () => {
    envFake[KEY] = '0'
    setOverride(KEY, '1')
    expect(getEffectiveSettingWithSource(KEY)).toEqual({ value: '1', source: 'override' })
    rmSync(OVERRIDES_PATH)
    reloadOverridesForTest()
    envFake[KEY] = '1'
    expect(getEffectiveSettingWithSource(KEY)).toEqual({ value: '1', source: 'env' })
  })

  it('REGRESSION: getEffectiveSettingValue returns exactly what the pre-80d46c59 resolution returned', () => {
    const esetek: Array<{ override?: string; env?: string }> = [
      {},
      { override: '0' },
      { override: '1' },
      { env: '0' },
      { env: '1' },
      { override: '1', env: '0' },
    ]
    for (const eset of esetek) {
      if (existsSync(OVERRIDES_PATH)) rmSync(OVERRIDES_PATH)
      reloadOverridesForTest()
      for (const k of Object.keys(envFake)) delete envFake[k]
      const overrides: Record<string, string> = {}
      for (const key of [KEY, 'KANBAN_WIP_WARN_PCT']) {
        if (eset.override !== undefined) {
          const v = key === KEY ? eset.override : eset.override === '1' ? '90' : '70'
          expect(setOverride(key, v).ok).toBe(true)
          overrides[key] = v
        }
        if (eset.env !== undefined) envFake[key] = key === KEY ? eset.env : eset.env === '1' ? '60' : '50'
      }
      for (const key of [KEY, 'KANBAN_WIP_WARN_PCT', 'KANBAN_WIP_OK_COLOR']) {
        const vart = regiFeloldas(key, overrides)
        expect(getEffectiveSettingValue(key), `${key} ${JSON.stringify(eset)}`).toStrictEqual(vart)
        expect(getEffectiveSettingWithSource(key).value).toStrictEqual(vart)
      }
    }
  })

  it('an unknown key throws the same error from both functions', () => {
    expect(() => getEffectiveSettingValue('NOT_A_REAL_KEY')).toThrow('Unknown setting key: NOT_A_REAL_KEY')
    expect(() => getEffectiveSettingWithSource('NOT_A_REAL_KEY')).toThrow('Unknown setting key: NOT_A_REAL_KEY')
  })
})
