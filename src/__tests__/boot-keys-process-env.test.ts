import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createServer, type AddressInfo } from 'node:net'
import { resolveBootLayers, parseWebPort, dropTrailingComment } from '../config.js'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'

// Every sandboxed config import below is a fresh module graph (vi.resetModules), and config.js reaches logger.js through
// channel-provider.js: a real pino transport per import, each with its own exit listener, and the eleventh trips Node's
// MaxListeners warning. The logger is not under test here, so it gets the stub the other suites use.
vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}))

// Card b2cd0f43. readEnvFile() reads the .env FILE and nothing else, so
// `WEB_PORT=39876 node dist/index.js` came up SILENTLY on 3420 -- the variable was not
// rejected, it was never consulted. The operator had evidence they set it and the
// process had evidence it did not.
//
// Both halves are tested here: that process.env now wins for the one named key, and
// that the allowlist stayed narrow. The second is the one that matters more: the fix
// itself would be dangerous if it turned into a general process.env overlay.

// bc3f8fb0 (c): every test that imports config.js does it in a sandbox: CLAUDECLAW_ENV_DIR points .env AND (since
// bc3f8fb0) config-overrides.json at a temp dir, so the result does not depend on this install's own files.
async function configHomokozoban(o: { env?: string; override?: Record<string, unknown>; procPort?: string; procHost?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'boot-keys-env-'))
  const eredeti = { dir: process.env.CLAUDECLAW_ENV_DIR, port: process.env.WEB_PORT, host: process.env.WEB_HOST }
  const vissza = (k: 'CLAUDECLAW_ENV_DIR' | 'WEB_PORT' | 'WEB_HOST', v: string | undefined) => {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  try {
    writeFileSync(join(dir, '.env'), o.env ?? '')
    if (o.override) {
      mkdirSync(join(dir, 'store'))
      writeFileSync(join(dir, 'store', 'config-overrides.json'), JSON.stringify(o.override))
    }
    vi.resetModules()
    process.env.CLAUDECLAW_ENV_DIR = dir
    vissza('WEB_PORT', o.procPort)
    vissza('WEB_HOST', o.procHost)
    return await import('../config.js')
  } finally {
    vissza('CLAUDECLAW_ENV_DIR', eredeti.dir)
    vissza('WEB_PORT', eredeti.port)
    vissza('WEB_HOST', eredeti.host)
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('resolveBootLayers: process.env > config-overrides.json > .env > default', () => {
  it('a process.env nyer, ha van ertek', () => {
    expect(resolveBootLayers('39876', '3500', '3420')).toEqual({ value: '39876', source: 'process.env' })
  })

  it('process.env nelkul a feluliro jon, utana a .env, mindegyik a sajat forrasaval', () => {
    expect(resolveBootLayers(undefined, '3500', '3420')).toEqual({ value: '3500', source: 'config-overrides.json' })
    expect(resolveBootLayers(undefined, undefined, '3420')).toEqual({ value: '3420', source: '.env' })
  })

  it('egyik sincs -> undefined, es a hivo teszi ra a defaultot', () => {
    expect(resolveBootLayers(undefined, undefined, undefined)).toBeUndefined()
  })

  it('URES es CSAK-SZOKOZ ertek UNSET-nek szamit minden retegben, a feluliroban is (bc3f8fb0 (a))', () => {
    // `WEB_PORT=` es egy "   " feluliro nem blankolhatja a portot: atesik a kovetkezo forrasra.
    expect(resolveBootLayers('', undefined, '3420')?.source).toBe('.env')
    expect(resolveBootLayers('   ', undefined, '3420')?.source).toBe('.env')
    expect(resolveBootLayers(undefined, '   ', '39876')).toEqual({ value: '39876', source: '.env' })
    expect(resolveBootLayers(undefined, '', '39876')).toEqual({ value: '39876', source: '.env' })
    expect(resolveBootLayers('', '   ', '')).toBeUndefined()
  })

  it('a korulvago szokozok nem szivarognak at az ertekbe', () => {
    expect(resolveBootLayers(' 39876 ', undefined, undefined)?.value).toBe('39876')
    expect(resolveBootLayers(undefined, ' 3500 ', undefined)?.value).toBe('3500')
  })
})

describe('bc3f8fb0 (a): a csak szokozbol allo WEB_PORT-feluliro atesik a .env-re (a valodi config-lancon)', () => {
  it('⛔ .env 39876 + feluliro "   " -> 39876 a .env-bol (a v4-en 3420, a default)', async () => {
    const cfg = await configHomokozoban({ env: 'WEB_PORT=39876\n', override: { WEB_PORT: '   ' } })
    expect(cfg.WEB_PORT).toBe(39876)
    expect(cfg.BOOT_KEY_SOURCES.WEB_PORT).toBe('.env')
    expect(cfg.WEB_PORT_INVALID).toBeUndefined()
  })

  it('az ures feluliro ugyanigy atesik', async () => {
    const cfg = await configHomokozoban({ env: 'WEB_PORT=39876\n', override: { WEB_PORT: '' } })
    expect(cfg.WEB_PORT).toBe(39876)
    expect(cfg.BOOT_KEY_SOURCES.WEB_PORT).toBe('.env')
  })

  it('⛔ KONTROLL: az erteket hordozo feluliro tovabbra is nyer a .env felett, a sajat forrasaval', async () => {
    const cfg = await configHomokozoban({ env: 'WEB_PORT=39876\n', override: { WEB_PORT: '3500' } })
    expect(cfg.WEB_PORT).toBe(3500)
    expect(cfg.BOOT_KEY_SOURCES.WEB_PORT).toBe('config-overrides.json')
  })

  it('a WEB_PORT_INSTALL a fajlok erteke process.env nelkul: shell-export mellett is a .env-e', async () => {
    const cfg = await configHomokozoban({ env: 'WEB_PORT=39876\n', procPort: '3421' })
    expect(cfg.WEB_PORT).toBe(3421)
    expect(cfg.BOOT_KEY_SOURCES.WEB_PORT).toBe('process.env')
    expect(cfg.WEB_PORT_INSTALL).toEqual({ value: '39876', source: '.env' })
    const ures = await configHomokozoban({ procPort: '3421' })
    expect(ures.WEB_PORT_INSTALL).toEqual({ value: '3420', source: 'default' })
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

describe('bc3f8fb0 (d): a hibaszoveg azt mondja, amit a Node 22 tesz', () => {
  const uzenet = (raw: string) => { try { parseWebPort(raw, '.env', 3420) } catch (e) { return (e as Error).message } return '' }

  it('a nem-szam szovege a parseInt-csapdat es a listen() kesei bukasat nevezi, nem "tetszoleges szabad portot"', () => {
    const m = uzenet('39876x')
    expect(m).toMatch(/parseInt\("39876x"\) is 39876/)
    expect(m).toMatch(/fails only at listen\(\)/)
    expect(m).not.toMatch(/arbitrary free port/)
  })

  it('a tartomanyon kivuli szovege a 0-t es a 65535 felettit kulon nevezi', () => {
    expect(uzenet('0')).toMatch(/0 would bind an arbitrary free port/)
    expect(uzenet('65536')).toMatch(/listen\(\) rejects anything above 65535/)
  })

  it('⛔ a szoveg allitasai a FUTO Node-on igazak: NaN es 65535 felett a listen() dob, a 0 egy szabad portot kot', async () => {
    // Measured, not quoted: if a Node release changes this, the texts above go stale and this goes red first.
    for (const p of [Number.NaN, 65536]) {
      let code: string | undefined
      try { createServer().listen(p, '127.0.0.1') } catch (e) { code = (e as NodeJS.ErrnoException).code }
      expect(code, `listen(${p})`).toBe('ERR_SOCKET_BAD_PORT')
    }
    const srv = createServer()
    await new Promise<void>((ok) => srv.listen(0, '127.0.0.1', ok))
    expect((srv.address() as AddressInfo).port).toBeGreaterThan(0)
    await new Promise<void>((ok) => srv.close(() => ok()))
  })

  it('a b2cd0f43-fajlok kommentjei nem hivatkoznak sorszamra: a kovetkezo szerkesztes elavultta tenne', () => {
    // Three such references went stale between v3 and v4 (env.ts:11, index.ts:468, "~115 lines"); the texts now name
    // the line by what it does. Scoped to the files of this card, not a rule for the repo.
    const fajlok = ['config.ts', 'index.ts', '__tests__/web-port-two-level-validation.test.ts']
    for (const f of fajlok) {
      const src = readFileSync(join(__dirname, '..', f), 'utf-8')
      expect(src, f).not.toMatch(/\b(?:env|index|config|web)\.ts:\d+/)
      expect(src, f).not.toMatch(/~\d+ (?:lines|sorral)/)
    }
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
    // bc3f8fb0 (c): in the sandbox, so the install's own .env cannot decide the result; and the expected value is the
    // sandbox's, so the test also shows that the .env it read is the sandbox's, not the install's.
    const cfg = await configHomokozoban({ env: 'WEB_HOST=127.0.0.2\n', procHost: '0.0.0.0' })
    expect(cfg.WEB_HOST).toBe('127.0.0.2')
  })

  it('⛔ KONTROLL: a WEB_PORT viszont tovabbra is a process.env-bol jon (a fenti nem a modszer hibaja)', async () => {
    const cfg = await configHomokozoban({ env: 'WEB_PORT=3420\n', override: { WEB_PORT: '3500' }, procPort: '39876' })
    expect(cfg.WEB_PORT).toBe(39876)
    expect(cfg.BOOT_KEY_SOURCES).toEqual({ WEB_PORT: 'process.env' })
  })

  it('⛔ KONTROLL (c): a homokozo MINDKET fajl-reteget elfedi: a felulirot is a homokozobol olvassa, nem a telepitesbol', async () => {
    // Without this the sandbox above would cover .env only, and the install's store/config-overrides.json would
    // still decide every test that resolves WEB_PORT without process.env.
    const cfg = await configHomokozoban({ env: 'WEB_PORT=39876\n', override: { WEB_PORT: '3501' } })
    expect(cfg.WEB_PORT).toBe(3501)
    expect(cfg.BOOT_KEY_SOURCES.WEB_PORT).toBe('config-overrides.json')
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
    // the one bracket read is the boot key's own layer, inside bootLayers(key: BootKey)
    expect(configTs).toMatch(/function bootLayers\(key: BootKey\)[^]*?fromProcess: process\.env\[key\],/)
    expect(configTs).toMatch(/return resolveBootLayers\(l\.fromProcess, l\.fromOverride, l\.fromEnvFile\)/)
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

  const configAEnvvel = (sor: string, procEnv?: string) => configHomokozoban({ env: `${sor}\n`, procPort: procEnv })

  it('⛔ a .env "WEB_PORT=3420 # komment" sora ervenyes 3420, jelzes nelkul, a fajl-retegbol', async () => {
    const cfg = await configAEnvvel('WEB_PORT=3420 # komment')
    expect(cfg.WEB_PORT).toBe(3420)
    expect(cfg.WEB_PORT_INVALID).toBeUndefined()
    expect(cfg.BOOT_KEY_SOURCES.WEB_PORT).toBe('.env')
  })

  it('⛔ a .env tabbal elvalasztott megjegyzese is vagodik: "WEB_PORT=3420<TAB># komment" -> 3420', async () => {
    const cfg = await configAEnvvel('WEB_PORT=3420\t# komment')
    expect(cfg.WEB_PORT).toBe(3420)
    expect(cfg.WEB_PORT_INVALID).toBeUndefined()
  })

  it('⛔ a NEM VAGOTT alak: "WEB_PORT=3420#x" (szokoz nelkul) nem megjegyzes, hanem hibas ertek, mint a shellben', async () => {
    const cfg = await configAEnvvel('WEB_PORT=3420#x')
    expect(cfg.WEB_PORT_INVALID?.raw).toBe('3420#x')
    expect(cfg.WEB_PORT_INVALID?.source).toBe('.env')
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
