// Kartya b2cd0f43 -- a WEB_PORT KETSZINTU validalasa, MINDKET iranyra merve.
//
// Az elso alak modul-szinten DOBOTT. Az meresre bukott meg: a WEB_PORT-ot tiz olyan hely
// is importalja, ami nem a webkiszolgalo (agens-sablonok, enroll-csomagok, a bridge
// port-utvonalai, az agens-utasitasokba irt pelda-parancsok). Egy modul-szintu dobas nem
// MEGALLITJA az elgepelest, hanem SZETTERITI.
//
// A megoldott alak: a modul-szint visszaesik es JELZEST allit (WEB_PORT_INVALID), a
// megtagadas pedig ott tortenik, ahol a rossz ertek pusztito vagy lathatatlan. ⛔ A
// masodik irany nelkul az elso eppen a rossz port CSENDES ELFOGADASA lenne -- ezert all
// itt mind a ketto, es ezert van kontroll mindkettohoz.

import { describe, it, expect, vi, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SRC = join(__dirname, '..')

const EREDETI = process.env.WEB_PORT

afterEach(() => {
  if (EREDETI === undefined) delete process.env.WEB_PORT
  else process.env.WEB_PORT = EREDETI
  vi.resetModules()
})

async function configgal(webPort: string | undefined) {
  vi.resetModules()
  if (webPort === undefined) delete process.env.WEB_PORT
  else process.env.WEB_PORT = webPort
  return import('../config.js')
}

describe('(i) a modul-szint VISSZAESIK, nem dob -- es a jelzes all', () => {
  it('⛔ KONTROLL: ervenyes WEB_PORT mellett NINCS jelzes (enelkul minden alabbi allitas uresen igaz lehetne)', async () => {
    const cfg = await configgal('39876')
    expect(cfg.WEB_PORT).toBe(39876)
    expect(cfg.WEB_PORT_INVALID).toBeUndefined()
    expect(() => cfg.assertWebPortUsable()).not.toThrow()
  })

  it('nem szam: az import NEM dob, a WEB_PORT a fallback, es a jelzes AZONOSITJA a nyers erteket', async () => {
    // Ha a modul-szint dobna, ez a sor maga bukna el -- vagyis a "nem dob" allitast
    // nem egy assert meri, hanem az, hogy a teszt eljut a kovetkezo sorig.
    const cfg = await configgal('nope')
    expect(cfg.WEB_PORT).toBe(3420)
    expect(cfg.WEB_PORT_INVALID).toBeDefined()
    expect(cfg.WEB_PORT_INVALID!.raw).toBe('nope')
    expect(cfg.WEB_PORT_INVALID!.source).toBe('process.env')
    expect(cfg.WEB_PORT_INVALID!.fallback).toBe(3420)
    expect(cfg.WEB_PORT_INVALID!.reason).toMatch(/not a number/)
  })

  it('tartomanyon kivul: ugyanugy visszaeses + jelzes, es a VALIDATOR sajat mondataval', async () => {
    const cfg = await configgal('70000')
    expect(cfg.WEB_PORT).toBe(3420)
    expect(cfg.WEB_PORT_INVALID!.raw).toBe('70000')
    expect(cfg.WEB_PORT_INVALID!.reason).toMatch(/out of range/)
  })

  it('a jelzes MERHETO, nem naplo-szoveg: a BOOT_KEY_SOURCES mellett all, ugyanarrol a kulcsrol', async () => {
    const cfg = await configgal('nope')
    // ⛔ A NAPLO NEM CIMZETT: a ketto egyutt mondja meg, hogy a kulcsot elolvastuk
    // (forras) ES hogy mi lett a sorsa (elutasitva).
    expect(cfg.BOOT_KEY_SOURCES.WEB_PORT).toBe('process.env')
    expect(cfg.WEB_PORT_INVALID).toBeDefined()
  })
})

describe('(ii) UGYANAKKOR a megtagadas megtortenik -- e nelkul az (i) csendes elfogadas lenne', () => {
  it('⛔ a startWebServer DOB, ha a jelzes all', async () => {
    vi.resetModules()
    process.env.WEB_PORT = 'nope'
    const { startWebServer } = await import('../web.js')
    expect(() => startWebServer(3420)).toThrow(/WEB_PORT is unusable/)
  })

  it('⛔ KONTROLL: ervenyes ertek mellett a startWebServer NEM a kapun bukik el', async () => {
    // Nem inditunk valodi kiszolgalot (az a teszt-kornyezetben ir a store-ba es portot
    // foglal). Amit itt merunk: a KAPU nem sul el. A kulonbseg a fenti esettel szemben a
    // bizonyitek arra, hogy a dobast a jelzes valtja ki, nem valami mas.
    vi.resetModules()
    process.env.WEB_PORT = '39876'
    const cfg = await import('../config.js')
    expect(cfg.WEB_PORT_INVALID).toBeUndefined()
    expect(() => cfg.assertWebPortUsable()).not.toThrow()
  })

  it('a dobas SZOVEGE kimondja: a modul-szint a fallbackre esett, ES melyik nyers ertek volt ervenytelen', async () => {
    const cfg = await configgal('nope')
    let uzenet = ''
    try { cfg.assertWebPortUsable() } catch (e) { uzenet = (e as Error).message }
    expect(uzenet).toContain('"nope"')            // MELYIK nyers ertek
    expect(uzenet).toContain('process.env')       // honnan jott
    expect(uzenet).toMatch(/fell back to 3420/)   // hogy a modul-szint visszaesett
    expect(uzenet).toMatch(/not a number/)        // a validator sajat mondata
  })

  it('EGY jel, KET helyen, ugyanabbol a forrasbol: a szoveg minden adata a jelzesbol jon', async () => {
    const cfg = await configgal('70000')
    let uzenet = ''
    try { cfg.assertWebPortUsable() } catch (e) { uzenet = (e as Error).message }
    const j = cfg.WEB_PORT_INVALID!
    expect(uzenet).toContain(j.raw)
    expect(uzenet).toContain(j.source)
    expect(uzenet).toContain(String(j.fallback))
    expect(uzenet).toContain(j.reason)
  })
})

describe('⛔ a kapu a PUSZTITO hasznalat ELOTT all, nem csak a webkiszolgaloban', () => {
  // Merve: az index.ts az acquirePortLock(WEB_PORT)-tal SIGTERM-et majd SIGKILL-t kuld
  // arra, ami a portot tartja -- a fallbacken az a sajat, FUTO dashboard. A
  // startWebServer ~115 sorral kesobb jon. Egy csak ott allo kapu eloszor megolne az elo
  // dashboardot, es utana tagadna meg az indulast: rosszabb, mint a hiba, amit javit.
  const index = readFileSync(join(SRC, 'index.ts'), 'utf-8')

  it('az assertWebPortUsable() hivasa MEGELOZI az acquirePortLock(WEB_PORT)-ot', () => {
    const kapu = index.indexOf('assertWebPortUsable()')
    const oles = index.indexOf('acquirePortLock(WEB_PORT')
    expect(kapu).toBeGreaterThan(-1)   // KONTROLL: a kereso talal, a -1 nem modszerhiba
    expect(oles).toBeGreaterThan(-1)   // KONTROLL: ugyanez a masik mintara
    expect(kapu).toBeLessThan(oles)
  })

  it('mindketto PONTOSAN egyszer szerepel -- kulonben az indexOf mast mer, mint amit allitok', () => {
    expect((index.match(/assertWebPortUsable\(\)/g) ?? []).length).toBe(1)
    expect((index.match(/acquirePortLock\(WEB_PORT/g) ?? []).length).toBe(1)
  })

  it('a webkiszolgalo kapuja is all (a masodik hely)', () => {
    const web = readFileSync(join(SRC, 'web.ts'), 'utf-8')
    expect(web).toMatch(/export function startWebServer[\s\S]{0,800}?assertWebPortUsable\(\)/)
  })
})
