// Kartya b2cd0f43, NEGYEDIK kikotes (ugyvezeto 13372, fv 13483):
// "ahol a WEB_PORT sablonba/curl-parancsba irodik, ott a fallback eseten a kiirt
//  parancs melle kerüljön a jelzes is, hogy a lemasolt 3420 ne latsszon a
//  felhasznalo ertekenek."
//
// A masik ket kikotes ott all, AHOL A HIBA KELETKEZIK (a modul-szintu jelzes es a
// ket kapu). ⛔ Ez ott all, AHOL ELTERJED: a sablonban, az enroll-csomagban, a
// pelda-parancsban, amit valaki holnap lemasol.
//
// ⛔ EGY MERT TENY, AMI NELKUL EZ A FAJL FELREOLVASHATO: a nyolc iras-helybol HET
// szerkezetileg ELERHETETLEN ervenytelen port mellett, mert csak a dashboard
// folyamataban futnak, azt pedig a ket kapu megallitja indulas kozben. EGY erheto
// el: a scripts/remote-access-enroll.ts onallo CLI, ami a configot kozvetlenul
// importalja es egyik kapun sem megy at. A tobbi jelzes MELYSEGI VEDELEM -- azert
// all ott, hogy a vedelem ne egy elerhetosegi ERVEN mulljon, ami egy uj belepesi
// ponttal csendben megszunne.

import { describe, it, expect, vi, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..', '..')
const EREDETI = process.env.WEB_PORT

afterEach(() => {
  if (EREDETI === undefined) delete process.env.WEB_PORT
  else process.env.WEB_PORT = EREDETI
  vi.resetModules()
})

async function modul(webPort: string | undefined, ut: string) {
  vi.resetModules()
  if (webPort === undefined) delete process.env.WEB_PORT
  else process.env.WEB_PORT = webPort
  return import(ut)
}

describe('a jelzes EGY forrasbol jon', () => {
  it('ervenytelen port -> a jelzes all, es NEVEZI a nyers erteket es a fallbacket', async () => {
    const cfg = await modul('nope', '../config.js')
    expect(cfg.WEB_PORT_COPY_WARNING).toContain('"nope"')
    expect(cfg.WEB_PORT_COPY_WARNING).toContain('3420')
    expect(cfg.WEB_PORT_COPY_WARNING).toMatch(/NOT your configured port/)
  })

  it('⛔ KONTROLL: ervenyes port -> a jelzes null (enelkul minden alabbi allitas uresen igaz lehetne)', async () => {
    const cfg = await modul('39876', '../config.js')
    expect(cfg.WEB_PORT_COPY_WARNING).toBeNull()
  })

  it('withWebPortWarning a TISZTA uton bajtra valtozatlanul ad vissza', async () => {
    // Ez teszi merhetove a "tiszta uton NINCS ott" allitast: nem "kevesebb", hanem
    // PONTOSAN ugyanaz a szoveg.
    const cfg = await modul('39876', '../config.js')
    const t = 'curl -s http://localhost:39876/api/x\n'
    expect(cfg.withWebPortWarning(t)).toBe(t)
  })

  it('⛔ a tiz hely NEM sajat mondatot ir: mind a KONSTANSRA hivatkozik', () => {
    // Ha valaki sajat szoveget fogalmaz, ez a teszt nem fogja meg -- de azt igen,
    // ha egy hely elfelejti behuzni a kozos forrast.
    for (const f of [
      'src/web/voice-directive.ts',
      'src/web/channel-monitor.ts',
      'scripts/remote-access-enroll.ts',
    ]) {
      expect(readFileSync(join(ROOT, f), 'utf-8'), f).toMatch(/WEB_PORT_COPY_WARNING/)
    }
    expect(readFileSync(join(ROOT, 'src/web/agent-scaffold.ts'), 'utf-8')).toMatch(/withWebPortWarning/)
  })
})

describe('⛔ A KERT VISELKEDESI PAR: egy helyen OTT van, a tiszta uton NINCS', () => {
  const TPL = 'dashboard: http://localhost:{{WEB_PORT}}/api\n'

  it('ervenytelen port mellett a rendereltbe BEKERUL a jelzes', async () => {
    const m = await modul('nope', '../web/agent-scaffold.js')
    const out = m.resolveTemplatePlaceholders(TPL, '# ')
    expect(out).toMatch(/^# WEB_PORT was INVALID at boot/)
    expect(out).toContain('"nope"')
    expect(out).toContain('http://localhost:3420/api')
  })

  it('⛔ ES A TISZTA UTON NINCS -- a kimenet a jelzes nelkul all elo', async () => {
    const m = await modul('39876', '../web/agent-scaffold.js')
    const out = m.resolveTemplatePlaceholders(TPL, '# ')
    expect(out).toBe('dashboard: http://localhost:39876/api\n')
    expect(out).not.toMatch(/INVALID/)
  })

  it('sablon {{WEB_PORT}} NELKUL nem kap jelzest, meg a hibas uton sem', async () => {
    // Egy szoveg, amiben nem all port, senkit nem tud felrevezetni.
    const m = await modul('nope', '../web/agent-scaffold.js')
    expect(m.resolveTemplatePlaceholders('csak szoveg\n', '# ')).toBe('csak szoveg\n')
  })
})

describe('⛔ LEFEDETTSEG: minden iras-hely BESOROLVA, besorolatlan maradek NELKUL', () => {
  // A besorolas TULAJDONSAGRA all (hova kerul az ertek), nem egy fejbol irt
  // nevsorra -- es a kulcs a HARMADIK rekesz: ami egyik listan sincs, az HIBA,
  // nem csendes kimaradas. Egy uj iras-hely igy pirosit, amig valaki be nem sorolja.
  const MASOLT = new Set([
    'src/web/agent-scaffold.ts',
    'src/web/heartbeat-agent-scaffold.ts',
    'src/web/voice-directive.ts',
    'src/web/channel-monitor.ts',
    'scripts/remote-access-enroll.ts',
  ])
  const BELSO = new Map([
    ['src/index.ts', 'port-zar, log -- a folyamaton belul marad'],
    ['src/web.ts', 'strukturalt startup-log, nem masolt parancs'],
    ['src/web/routes/kanban.ts', 'belso base URL ugyanabban a folyamatban'],
    ['src/web/routes/bridge-service-ports.ts', 'API-valasz JSON, nem masolt parancs'],
    ['src/web/federation/onboarding.ts', 'identity-objektum, gepi fogyaszto'],
    // ⛔ MERT KIVETEL, nem feledekenyseg: a kimenete NEM olvasott szoveg, hanem
    // egy authorized_keys SOR es egy base64 csomag -- mindketto gepi fogyaszto,
    // es egy ele tett komment-sor elrontana. Ez a hely ezen felul a dashboard
    // folyamataban fut, tehat a ket kapu mar megallitotta az indulast.
    ['src/web/bridge-enroll.ts', 'authorized_keys sor + base64 csomag: gepi fogyaszto'],
  ])

  function irasHelyek(): string[] {
    const out: string[] = []
    const walk = (rel: string) => {
      const fs = require('node:fs') as typeof import('node:fs')
      for (const e of fs.readdirSync(join(ROOT, rel), { withFileTypes: true })) {
        const p = `${rel}/${e.name}`
        if (e.isDirectory()) { if (!['node_modules', 'dist', '__tests__'].includes(e.name)) walk(p) }
        else if (e.name.endsWith('.ts') && p !== 'src/config.ts') {
          const t = fs.readFileSync(join(ROOT, p), 'utf-8')
          if (!/from '(\.\.\/)+(src\/)?config\.js'/.test(t) && !/from '\.\/config\.js'/.test(t)) continue
          if (!/\bWEB_PORT\b/.test(t.replace(/WEB_PORT_COPY_WARNING|WEB_PORT_INVALID|\{\{WEB_PORT\}\}/g, ''))) continue
          out.push(p)
        }
      }
    }
    walk('src'); walk('scripts')
    return out.sort()
  }

  const helyek = irasHelyek()

  it('⛔ KONTROLL: a kereso egyaltalan talal iras-helyeket (a nulla itt modszerhiba lenne)', () => {
    expect(helyek.length).toBeGreaterThan(5)
  })

  it('⛔ NINCS BESOROLATLAN MARADEK -- ha ez pirosodik, uj iras-hely kerult be', () => {
    const maradek = helyek.filter((p) => !MASOLT.has(p) && !BELSO.has(p))
    expect(maradek, `besorolatlan iras-hely(ek): ${maradek.join(', ')}`).toEqual([])
  })

  it('a MASOLT rekesz minden tagja HASZNALJA a kozos forrast (nem csak importalja)', () => {
    // ⛔ MERT JAVITAS: elobb a puszta emlitest kerestem, es egy mutacio, ami a
    // HIVAST vette ki de az importot benne hagyta, ZOLDEN maradt. Az import-sorok
    // kizarasa teszi a feltetelt HASZNALATTA -- a jelenlet nem a hatas.
    const hianyzik = [...MASOLT].filter((p) => {
      const torzs = readFileSync(join(ROOT, p), 'utf-8')
        .split('\n')
        .filter((l) => !/^\s*(import\b|\s*withWebPortWarning,\s*$|\s*WEB_PORT_COPY_WARNING,\s*$)/.test(l))
        .join('\n')
      return !/WEB_PORT_COPY_WARNING|withWebPortWarning/.test(torzs)
    })
    expect(hianyzik, `a jelzest nem HASZNALO masolt hely: ${hianyzik.join(', ')}`).toEqual([])
  })

  it('⛔ VISELKEDESI par egy MASODIK helyen is: a heartbeat CLAUDE.md', async () => {
    // A sablon-ut mellett ez egy fuggetlen renderelo, es tisztan hivhato.
    const m = await modul('nope', '../web/heartbeat-agent-scaffold.js')
    const id = { ownerName: 'X', mainAgentId: 'a', botName: 'B', storePath: '/s',
                 calendarAccount: null, dashboardOrigin: 'http://localhost:3420', lang: 'hu' }
    const out = m.renderHeartbeatClaudeMd(id as never)
    expect(out).toMatch(/^# WEB_PORT was INVALID at boot/)
  })

  it('⛔ KONTROLL ugyanoda: tiszta uton a heartbeat CLAUDE.md jelzes NELKUL all elo', async () => {
    const m = await modul('39876', '../web/heartbeat-agent-scaffold.js')
    const id = { ownerName: 'X', mainAgentId: 'a', botName: 'B', storePath: '/s',
                 calendarAccount: null, dashboardOrigin: 'http://localhost:39876', lang: 'hu' }
    const out = m.renderHeartbeatClaudeMd(id as never)
    expect(out).toMatch(/^# Heartbeat agent/)
    expect(out).not.toMatch(/INVALID/)
  })

  it('⛔ A MEGNEVEZETT KIVETEL: a settings.json.template utja NEM kaphat jelzest', () => {
    // Merve, es ezert nevesitett kivetel, nem feledekenyseg: a rendereltet a
    // scaffold JSON.parse()-olja, tehat egy ele tett komment-sor dobna.
    const t = readFileSync(join(ROOT, 'src/web/agent-scaffold.ts'), 'utf-8')
    expect(t).toMatch(/JSON\.parse\(raw\)/)
    expect(t).toMatch(/resolveTemplatePlaceholders\(readFileSync\(tplPath, 'utf-8'\)\)/)
  })
})
