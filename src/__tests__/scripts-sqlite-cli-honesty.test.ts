// Kartya 252ab361, (4/b): az or hatokore kiterjed a scripts/*.sh fajlokra.
//
// ⛔ A KIKOTES ALAKJA (fejlesztes-vezeto): az or NE azt tiltsa, hogy egy szkript
// hasznal sqlite3-at, hanem azt KOVETELJE MEG, hogy aki hasznalja, annak legyen
// `command -v` kapuja ES ne jelentsen sikert, ha az eszkoz hianyzik. ⛔ Nevesitett
// kivetel-lista NINCS: egy fejbol irt nevsor elavul, es a besorolas csendben rossz
// lesz. Ami ma nem felel meg, az nem kivetel, hanem TALALAT.
//
// ⛔ ES AMIERT A MASODIK FELE FUTTATASSAL MEGY: a "hamis siker" a KIMENET
// tulajdonsaga, nem a forrase. A sajat, forras-alaku heurisztikam (`||` a hivas
// soraban + nincs `set -e`) ⛔ ALULBECSULT: a `pre-modify-backup.sh`-t "rendben"-nek
// jelolte, holott MERVE sikert jelentett -- mert a `||` egy folytatosoron allt.
// Ha az a heurisztika kapuva valt volna, ⛔ epp a legsulyosabb tetelt engedte volna at.
//
// ⛔ AMIT EZ AZ OR NEM TESZ, ES KIMONDOM: nem futtatja a repo VALODI szkriptjeit.
// A ma egyetlen CLI-hasznalo szkript (`backup.sh`) egy tar.gz-t keszit a repobol es
// a HOME-listakbol; egy teszt-futasa nem olcso es nem mellekhatas-mentes. Ezert a
// valodi szkriptekre a KAPU megletet merem, a "hamis siker" felismereset pedig
// ⛔ szintetikus paron, FUTTATVA -- kulonben az or sosem bizonyitana, hogy kepes
// megkulonboztetni a nema bukast a hangostol.

import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync, statSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

function shellScripts(dir: string): string[] {
  const out: string[] = []
  for (const e of readdirSync(dir)) {
    const p = join(dir, e)
    if (statSync(p).isDirectory()) out.push(...shellScripts(p))
    else if (e.endsWith('.sh')) out.push(p)
  }
  return out
}

/** Valodi (nem komment) sqlite3 CLI-hivasok szama egy szoveGBEN. */
function cliCalls(text: string): number {
  return text
    .split('\n')
    .filter((l) => !l.trimStart().startsWith('#'))
    .filter((l) => /(^|[^-\w])sqlite3\s/.test(l)).length
}

const SCRIPTS = shellScripts(join(ROOT, 'scripts'))

describe('scripts/*.sh: aki sqlite3-at hasznal, annak legyen kapuja', () => {
  it('⛔ KONTROLL: a kereso egyaltalan talal shell-szkriptet (a nulla itt modszerhiba lenne)', () => {
    expect(SCRIPTS.length).toBeGreaterThan(20)
  })

  it('minden CLI-t hasznalo szkriptnek van `command -v sqlite3` kapuja', () => {
    const talalat: string[] = []
    for (const p of SCRIPTS) {
      const t = readFileSync(p, 'utf-8')
      if (cliCalls(t) === 0) continue
      if (!/command -v sqlite3|which sqlite3/.test(t)) talalat.push(p.slice(ROOT.length + 1))
    }
    expect(talalat, `kapu nelkul hasznal sqlite3-at: ${talalat.join(', ')}`).toEqual([])
  })

  it('⛔ KONTROLL: a `cliCalls` mero LAT hivast -- kulonben a fenti allitas uresen igaz', () => {
    // A backup.sh ma is hivja (kapuval), tehat a mero nem nullat gyart.
    const backup = readFileSync(join(ROOT, 'scripts', 'backup.sh'), 'utf-8')
    expect(cliCalls(backup)).toBeGreaterThan(0)
    // Es a kommentet NEM szamolja bele.
    expect(cliCalls('# sqlite3 valami\n')).toBe(0)
  })
})

describe('⛔ a HAMIS SIKER felismerese KIMENETBOL, nem forras-alakbol', () => {
  // Szintetikus par: ugyanaz a feladat, ket alakban, sqlite3 NELKUL futtatva.
  function futtat(torzs: string): { code: number; out: string } {
    const dir = mkdtempSync(join(tmpdir(), 'cli-honesty-'))
    try {
      // Ures PATH-koltseg nelkul: sajat bin, amiben NINCS sqlite3, de van coreutils.
      const s = join(dir, 'p.sh')
      writeFileSync(s, torzs)
      const r = execFileSync('bash', [s], { encoding: 'utf-8', cwd: dir, env: { ...process.env, PATH: '/usr/bin:/bin' } })
      return { code: 0, out: r }
    } catch (e) {
      const err = e as { status?: number; stdout?: string; stderr?: string }
      return { code: err.status ?? -1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  const NEMA = `
sqlite3 x.db ".backup 'y.db'" \\
  && echo "  db: ok" \\
  || echo "  db: WARNING failed"
echo "backup ok"
`
  const HANGOS = `
set -e
if ! command -v sqlite3 >/dev/null 2>&1; then
  echo "FATAL: sqlite3 missing" >&2
  exit 1
fi
sqlite3 x.db ".backup 'y.db'"
echo "backup ok"
`

  it('⛔ A NEMA ALAK: siker-sort ir ES 0-val lep ki, holott a mentes elmaradt', () => {
    const r = futtat(NEMA)
    expect(r.code).toBe(0)
    expect(r.out).toContain('backup ok')
  })

  it('⛔ A HANGOS ALAK: NEM ir siker-sort, es NEM 0-val lep ki', () => {
    const r = futtat(HANGOS)
    expect(r.code).not.toBe(0)
    expect(r.out).not.toContain('backup ok')
  })

  it('⛔ ES A KETTO KULONBSEGE A BIZONYITEK: ugyanaz a feladat, ellentetes kimenet', () => {
    const a = futtat(NEMA)
    const b = futtat(HANGOS)
    expect(a.code === b.code).toBe(false)
    expect(a.out.includes('backup ok')).toBe(true)
    expect(b.out.includes('backup ok')).toBe(false)
  })

  it('⛔ KONTROLL a kornyezetre: a proba tenyleg sqlite3 NELKUL futott', () => {
    const r = futtat('command -v sqlite3 >/dev/null 2>&1 && echo VAN || echo NINCS\n')
    expect(r.out.trim()).toBe('NINCS')
  })
})
