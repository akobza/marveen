import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { resolveBootValue, parseWebPort } from '../config.js'

// Card b2cd0f43. readEnvFile() reads the .env FILE and nothing else, so
// `WEB_PORT=39876 node dist/index.js` came up SILENTLY on 3420 -- the variable was not
// rejected, it was never consulted. The operator had evidence they set it and the
// process had evidence it did not.
//
// Both halves are tested here: that process.env now wins for the two named keys, and
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
    // `WEB_HOST=` nem blankolhatja a hostot: atesik a kovetkezo forrasra.
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

  it('pontosan KET kulcs all a nevesitett listaban', () => {
    const m = configTs.match(/const PROCESS_ENV_BOOT_KEYS = \[([^\]]*)\]/)
    expect(m).not.toBeNull()
    const keys = m![1].split(',').map(k => k.trim().replace(/['"]/g, '')).filter(Boolean)
    expect(keys).toEqual(['WEB_PORT', 'WEB_HOST'])
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
    const dotReads = configTs.match(/process\.env\.[A-Z_]/g) ?? []
    expect(bracketReads.length).toBe(1)
    expect(dotReads.length).toBe(0)
    expect(configTs).toMatch(/return resolveBootValue\(process\.env\[key\], cfg\(key\)\)/)
  })

  it('KONTROLL: a kereso tenyleg talal, ha van mit -- a nulla nem a modszer hibaja', () => {
    // Ha ez a minta sem lenne meg, akkor a fenti nulla-allitasok semmit nem bizonyitananak.
    expect(configTs).toMatch(/PROCESS_ENV_BOOT_KEYS/)
  })
})
