import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { resolveBootValue, parseWebPort, dropTrailingComment } from '../config.js'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'

// Card b2cd0f43. readEnvFile() reads the .env FILE and nothing else, so
// `WEB_PORT=39876 node dist/index.js` came up SILENTLY on 3420 -- the variable was not
// rejected, it was never consulted. The operator had evidence they set it and the
// process had evidence it did not.
//
// Both halves are tested here: that process.env now wins for the one named key, and
// that the allowlist stayed narrow. The second is the one that matters more: the fix
// itself would be dangerous if it turned into a general process.env overlay.

describe('resolveBootValue: process.env > config-overrides/.env > default', () => {
  it('a process.env nyer, ha van ertek', () => {
    expect(resolveBootValue('39876', '3420')).toEqual({ value: '39876', source: 'process.env' })
  })

  it('process.env nelkul a fajl-reteg jon', () => {
    expect(resolveBootValue(undefined, '3420')).toEqual({
      value: '3420', source: 'config-overrides.json/.env',
    })
  })

  it('egyik sincs -> undefined, es a hivo teszi ra a defaultot', () => {
    expect(resolveBootValue(undefined, undefined)).toBeUndefined()
  })

  it('URES es CSAK-SZOKOZ ertek UNSET-nek szamit minden retegben', () => {
    // `WEB_PORT=` nem blankolhatja a portot: atesik a kovetkezo forrasra.
    expect(resolveBootValue('', '3420')?.source).toBe('config-overrides.json/.env')
    expect(resolveBootValue('   ', '3420')?.source).toBe('config-overrides.json/.env')
    expect(resolveBootValue('', '')).toBeUndefined()
  })

  it('a korulvago szokozok nem szivarognak at az ertekbe', () => {
    expect(resolveBootValue(' 39876 ', undefined)?.value).toBe('39876')
  })
})

describe('parseWebPort: ervenytelen port eseten ALLJON MEG, ne induljon NaN-nel', () => {
  it('ervenyes portot atenged', () => {
    expect(parseWebPort('39876', 'process.env', 3420)).toBe(39876)
    expect(parseWebPort('1', 'process.env', 3420)).toBe(1)
    expect(parseWebPort('65535', 'process.env', 3420)).toBe(65535)
  })

  it('hianyzo ertekre a default jon, csendben -- ez a normal eset', () => {
    expect(parseWebPort(undefined, 'default', 3420)).toBe(3420)
  })

  it('nem-szam eseten DOB, es megnevezi az erteket es a forrast', () => {
    expect(() => parseWebPort('nope', 'process.env', 3420)).toThrow(/not a number.*"nope".*process\.env/s)
  })

  it('a parseInt-csapda: "39876x" NEM 39876, hanem hiba', () => {
    // parseInt('39876x', 10) === 39876 -- egy elutes csendben mas portot adna.
    expect(() => parseWebPort('39876x', '.env', 3420)).toThrow(/not a number/)
  })

  it('tartomanyon kivuli port eseten DOB', () => {
    expect(() => parseWebPort('0', 'process.env', 3420)).toThrow(/out of range/)
    expect(() => parseWebPort('65536', 'process.env', 3420)).toThrow(/out of range/)
  })
})

describe('az allowlist SZUK marad -- ez fontosabb, mint maga a javitas', () => {
  const configTs = readFileSync(join(__dirname, '..', 'config.ts'), 'utf-8')

  it('pontosan EGY kulcs all a nevesitett listaban', () => {
    const m = configTs.match(/const PROCESS_ENV_BOOT_KEYS = \[([^\]]*)\]/)
    expect(m).not.toBeNull()
    const keys = m![1].split(',').map(k => k.trim().replace(/['"]/g, '')).filter(Boolean)
    expect(keys).toEqual(['WEB_PORT'])
  })

  it('⛔ a WEB_HOST NEM jon a process.env-bol: egy orokolt 0.0.0.0 nem nyitja meg a dashboardot', async () => {
    // The bind address stays .env-only. An inherited WEB_HOST must not reach WEB_HOST, the listen address.
    const eredeti = process.env.WEB_HOST
    try {
      vi.resetModules()
      process.env.WEB_HOST = '0.0.0.0'
      const cfg = await import('../config.js')
      expect(cfg.WEB_HOST).not.toBe('0.0.0.0')
    } finally {
      if (eredeti === undefined) delete process.env.WEB_HOST
      else process.env.WEB_HOST = eredeti
    }
  })

  it('⛔ KONTROLL: a WEB_PORT viszont tovabbra is a process.env-bol jon (a fenti nem a modszer hibaja)', async () => {
    const eredeti = process.env.WEB_PORT
    try {
      vi.resetModules()
      process.env.WEB_PORT = '39876'
      const cfg = await import('../config.js')
      expect(cfg.WEB_PORT).toBe(39876)
      expect(cfg.BOOT_KEY_SOURCES).toEqual({ WEB_PORT: 'process.env' })
    } finally {
      if (eredeti === undefined) delete process.env.WEB_PORT
      else process.env.WEB_PORT = eredeti
    }
  })

  it('NINCS altalanos process.env-ratoltés a configra', () => {
    // A tiltas lenyege: egy orokolt kornyezeti valtozo NE irhassa at az install
    // identitasat. Ezek a mintak mind ezt tennek.
    expect(configTs).not.toMatch(/\.\.\.process\.env/)
    expect(configTs).not.toMatch(/Object\.assign\([^)]*process\.env/)
  })

  it('a process.env-et CSAK a nevesitett uton OLVASSUK', () => {
    // A puszta "process.env" szoveg szamolasa rossz meres volt: a config.ts-ben hatszor
    // szerepel KOMMENTBEN es egyszer string-literalkent (a forras neveben). Ami szamit,
    // az a tenyleges OLVASAS: a `process.env[...]` es a `process.env.KULCS` alak.
    const bracketReads = configTs.match(/process\.env\[/g) ?? []
    // The one named exception: FLEET_PYTHON_VENV reads the CLAUDECLAW_ENV_DIR test seam (env.ts), which is a
    // path for the .env itself, not a config value. Counted exactly, so the exception cannot cover a second read.
    const dotReads = configTs.match(/process\.env\.[A-Z_]+/g) ?? []
    expect(bracketReads.length).toBe(1)
    expect(dotReads).toEqual(['process.env.CLAUDECLAW_ENV_DIR'])
    expect(configTs).toMatch(/return resolveBootValue\(process\.env\[key\], dropTrailingComment\(cfg\(key\)\)\)/)
  })

  it('KONTROLL: a kereso tenyleg talal, ha van mit -- a nulla nem a modszer hibaja', () => {
    // Ha ez a minta sem lenne meg, akkor a fenti nulla-allitasok semmit nem bizonyitananak.
    expect(configTs).toMatch(/PROCESS_ENV_BOOT_KEYS/)
  })
})

describe('a .env sorvegi megjegyzese nem okoz ujrainditas-hurkot (WEB_PORT=3420 # komment)', () => {
  it('a fajl-reteg levagja a szokozzel elvalasztott megjegyzest; szokoz nelkul nem (mint a shell)', () => {
    expect(dropTrailingComment('3420 # komment')).toBe('3420')
    expect(dropTrailingComment('3420\t#x')).toBe('3420')
    expect(dropTrailingComment('3420#x')).toBe('3420#x')
    expect(dropTrailingComment(undefined)).toBeUndefined()
  })

  async function configAEnvvel(sor: string, procEnv?: string) {
    const dir = mkdtempSync(join(tmpdir(), 'boot-keys-env-'))
    const eredetiDir = process.env.CLAUDECLAW_ENV_DIR
    const eredetiPort = process.env.WEB_PORT
    try {
      writeFileSync(join(dir, '.env'), `${sor}\n`)
      vi.resetModules()
      process.env.CLAUDECLAW_ENV_DIR = dir
      if (procEnv === undefined) delete process.env.WEB_PORT
      else process.env.WEB_PORT = procEnv
      return await import('../config.js')
    } finally {
      if (eredetiDir === undefined) delete process.env.CLAUDECLAW_ENV_DIR
      else process.env.CLAUDECLAW_ENV_DIR = eredetiDir
      if (eredetiPort === undefined) delete process.env.WEB_PORT
      else process.env.WEB_PORT = eredetiPort
      rmSync(dir, { recursive: true, force: true })
    }
  }

  it('⛔ a .env "WEB_PORT=3420 # komment" sora ervenyes 3420, jelzes nelkul, a fajl-retegbol', async () => {
    const cfg = await configAEnvvel('WEB_PORT=3420 # komment')
    expect(cfg.WEB_PORT).toBe(3420)
    expect(cfg.WEB_PORT_INVALID).toBeUndefined()
    expect(cfg.BOOT_KEY_SOURCES.WEB_PORT).toBe('config-overrides.json/.env')
  })

  it('⛔ a .env tabbal elvalasztott megjegyzese is vagodik: "WEB_PORT=3420<TAB># komment" -> 3420', async () => {
    const cfg = await configAEnvvel('WEB_PORT=3420\t# komment')
    expect(cfg.WEB_PORT).toBe(3420)
    expect(cfg.WEB_PORT_INVALID).toBeUndefined()
  })

  it('⛔ a NEM VAGOTT alak: "WEB_PORT=3420#x" (szokoz nelkul) nem megjegyzes, hanem hibas ertek, mint a shellben', async () => {
    const cfg = await configAEnvvel('WEB_PORT=3420#x')
    expect(cfg.WEB_PORT_INVALID?.raw).toBe('3420#x')
    expect(cfg.WEB_PORT_INVALID?.source).toBe('config-overrides.json/.env')
  })

  it('⛔ KONTROLL: a megjegyzes mogotti ERVENYTELEN ertek tovabbra is megtagadas (a vagas nem nyel el hibat)', async () => {
    const cfg = await configAEnvvel('WEB_PORT=abc # komment')
    expect(cfg.WEB_PORT_INVALID?.raw).toBe('abc')
  })

  it('⛔ KONTROLL: a process.env erteke NEM kap vagast: ott a # egy hibas ertek resze', async () => {
    const cfg = await configAEnvvel('WEB_PORT=3420', '3420 # x')
    expect(cfg.WEB_PORT_INVALID?.source).toBe('process.env')
    expect(cfg.WEB_PORT_INVALID?.raw).toBe('3420 # x')
  })
})
