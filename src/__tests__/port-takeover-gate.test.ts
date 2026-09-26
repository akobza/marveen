import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  decidePortTakeover,
  planPortTakeover,
  formatForeignHolder,
  formatUnverifiableHolder,
} from '../process-lock.js'

// Card 853d94db. index.ts kills whatever holds WEB_PORT before binding. The victim
// selection is deliberately permissive -- a process it cannot attribute is left alone --
// but the DECISION inherited that shape, so "could not attribute" meant "carry on", and
// carrying on there is SIGKILL against a process that may belong to another install.
//
// The gate inverts the burden: taking over is the claim that must be proven.
//
// SECOND ROUND (Ugyvezeto diff review). The first version of this gate collapsed TWO
// different findings into one `refuse`, and the caller exited on both:
//   provably foreign      -> exit(1) is right
//   ownership unknown     -> exit(1) is WRONG, and worse than the bug it replaced
// On a host where the cwd probe cannot read (LSOFPATH805: a bare `lsof` was
// command-not-found under the launchd PATH and silently returned null), every boot lands
// in the second branch. Before the gate that host killed and started; after the gate it
// would never start again -- a routine restart turned into a permanent boot failure.
//
// So the interesting assertions here are about the CALLER's consequence. The function was
// "right" in both branches; process.exit(1) was the defect. A test that only checks `kind`
// would stay green through exactly this bug.
//
// The pidfile is not an input. The card brief gave "there is no pidfile" as the reason;
// measured, that premise was wrong. The app's own store/claudeclaw.pid EXISTS and is
// correct; only store/dashboard.pid (written by scripts/start.sh) is absent. The reason
// that does hold: a pidfile records who WROTE it, not who HOLDS the port.

const SELF = '/home/user/marveen'
const OTHER = '/home/user/marveen-worktree'

describe('decidePortTakeover: az atvetel a bizonyitando allitas', () => {
  it('nincs birtokos -> nincs mit atvenni', () => {
    expect(decidePortTakeover([], SELF, () => null)).toEqual({ kind: 'no-holder' })
  })

  it('a birtokos IGAZOLHATOAN a mienk -> atvehetjuk (a sajat ujrainditas mukodik)', () => {
    expect(decidePortTakeover([111], SELF, () => SELF)).toEqual({ kind: 'take-over', holders: [111] })
  })

  it('MAS telepites birtokolja -> refuse-FOREIGN, es megnevezzuk mindket gyokeret', () => {
    const d = decidePortTakeover([222], SELF, () => OTHER)
    expect(d.kind).toBe('refuse-foreign')
    if (d.kind !== 'refuse-foreign') return
    expect(d.holder).toBe(222)
    expect(d.holderRoot).toBe(OTHER)
    expect(d.selfRoot).toBe(SELF)
  })

  it('NEM OLVASHATO birtokos-gyoker -> refuse-UNVERIFIABLE, nem foreign', () => {
    // Ez az az ag, ami eloszor "valoszinuleg rendben"-t jelentett, aztan "valoszinuleg
    // idegen"-t. Mindketto ugyanaz a hiba: a hianyzo meresbol iteletet csinalni.
    const d = decidePortTakeover([333], SELF, () => null)
    expect(d.kind).toBe('refuse-unverifiable')
  })

  it('a SAJAT gyokerunk feloldatlan -> UNVERIFIABLE, meg ha a birtokos gyokere olvashato is', () => {
    // A regi hivo `selfProjectRoot ?? PROJECT_ROOT`-ot adott at. Egy symlinken at elerheto,
    // feloldatlan PROJECT_ROOT SOSEM egyezik a kernel altal mindig feloldott /proc cwd-vel,
    // tehat a sajat elodunk "idegennek" latszott volna -> exit(1) minden indulasnal.
    const d = decidePortTakeover([444], null, () => SELF)
    expect(d.kind).toBe('refuse-unverifiable')
    if (d.kind !== 'refuse-unverifiable') return
    expect(d.selfRoot).toBeNull()
    expect(d.holderRoot).toBe(SELF)
  })

  it('tobb birtokos: EGY IGAZOLTAN idegen is eleg a megallashoz', () => {
    const d = decidePortTakeover([111, 222], SELF, (pid) => (pid === 111 ? SELF : OTHER))
    expect(d.kind).toBe('refuse-foreign')
    if (d.kind !== 'refuse-foreign') return
    expect(d.holder).toBe(222)
  })

  it('KONTROLL: ha MINDEN birtokos a mienk, tobb birtokos mellett is atvesszuk', () => {
    // Kulonben a "tobb birtokos -> megallas" allitas ugy is atmenne, ha a fuggveny
    // egyszeruen mindig megallna kettonel.
    expect(decidePortTakeover([111, 112], SELF, () => SELF)).toEqual({
      kind: 'take-over', holders: [111, 112],
    })
  })

  it('a hasonlo nevu gyoker NEM ugyanaz (a /marveen nem /marveen2)', () => {
    expect(decidePortTakeover([444], SELF, () => SELF + '2').kind).toBe('refuse-foreign')
  })
})

describe('planPortTakeover: EZ a lelet -- a hiba a HIVO KOVETKEZMENYEBEN volt', () => {
  it('IGAZOLATLAN birtokos eseten a hivo NEM all le', () => {
    // A regressziot ez fogja meg. A dontes mindket agon "helyes" refuse volt; az exit(1)
    // volt a defektus. Ha valaki visszaallitja, ez pirosra valt.
    const d = decidePortTakeover([333], SELF, () => null)
    const plan = planPortTakeover(d)
    expect(plan.action).toBe('stand-down')
    expect(plan.action).not.toBe('stop')
  })

  it('a sajat gyoker feloldatlansaga sem allithatja le az inditast', () => {
    expect(planPortTakeover(decidePortTakeover([444], null, () => SELF)).action).toBe('stand-down')
  })

  it('IGAZOLTAN idegen birtokos eseten viszont IGENIS leall', () => {
    // A kontroll a fentiekhez: ha ez is "stand-down" lenne, a fenti ket allitas semmit
    // nem bizonyitana -- egy olyan fuggveny is atmenne, ami sosem mond stop-ot.
    expect(planPortTakeover(decidePortTakeover([222], SELF, () => OTHER)).action).toBe('stop')
  })

  it('birtokos nelkul es sajat birtokos eseten a normal ut megy', () => {
    expect(planPortTakeover({ kind: 'no-holder' }).action).toBe('proceed')
    expect(planPortTakeover({ kind: 'take-over', holders: [1] }).action).toBe('proceed')
  })
})

describe('a ket uzenet KULONBOZO, mert az uzemeltetonek mast kell tennie', () => {
  it('idegen birtokos: megnevezi a pid-et es MINDKET PROJECT_ROOT-ot', () => {
    const text = formatForeignHolder({ kind: 'refuse-foreign', holder: 222, holderRoot: OTHER, selfRoot: SELF })
    expect(text).toContain('222')
    expect(text).toContain(OTHER)
    expect(text).toContain(SELF)
    expect(text).toMatch(/REFUSING TO TAKE THE PORT/)
  })

  it('igazolatlan birtokos: NEM allitja idegennek, es nem kuldi a portot kezzel felszabaditani', () => {
    // A regi szoveg "free the port by hand"-et javasolt egy olyan birtokosra, ami akar a
    // sajat elodunk is lehet. Ez rossz tanacs volt, nem csak pontatlan megfogalmazas.
    const text = formatUnverifiableHolder({
      kind: 'refuse-unverifiable', holder: 333, holderRoot: null, selfRoot: SELF,
    })
    expect(text).toContain('could not be read')
    expect(text).toMatch(/NOT a claim that the holder is foreign/)
    expect(text).toContain('EADDRINUSE')
    expect(text).not.toMatch(/free the port by hand/)
    expect(text).not.toMatch(/\bnull\b/)
  })

  it('feloldatlan SAJAT gyoker eseten is mond valamit, nem "null"-t', () => {
    const text = formatUnverifiableHolder({
      kind: 'refuse-unverifiable', holder: 333, holderRoot: SELF, selfRoot: null,
    })
    expect(text).toContain('could not be resolved')
    expect(text).not.toMatch(/\bnull\b/)
  })

  it('KONTROLL: a ket uzenet tenyleg kulonbozik', () => {
    const foreign = formatForeignHolder({ kind: 'refuse-foreign', holder: 1, holderRoot: OTHER, selfRoot: SELF })
    const unknown = formatUnverifiableHolder({ kind: 'refuse-unverifiable', holder: 1, holderRoot: null, selfRoot: SELF })
    expect(foreign).not.toBe(unknown)
  })
})

describe('a kapu a KILL ELOTT all, es a kilepes CSAK az idegen agon', () => {
  const indexTs = readFileSync(join(__dirname, '..', 'index.ts'), 'utf-8')
  const acquire = indexTs.slice(indexTs.indexOf('async function acquireLock'))
  const body = acquire.slice(0, acquire.indexOf('\n// Delete the PID file'))

  it('KONTROLL: a kimetszett torzs tenyleg az acquireLock, es a hatar tart', () => {
    expect(body).toContain('async function acquireLock')
    expect(body).toContain('acquirePortLock(')
    expect(body).not.toContain('function releaseLock')
  })

  it('a decidePortTakeover MEGELOZI az acquirePortLock-ot', () => {
    const gateAt = body.indexOf('decidePortTakeover(')
    const killAt = body.indexOf('await acquirePortLock(')
    expect(gateAt).toBeGreaterThan(-1)
    expect(killAt).toBeGreaterThan(-1)
    expect(gateAt).toBeLessThan(killAt)
  })

  it('a process.exit CSAK a stop-agon all, es a stand-down ag elotte ter vissza', () => {
    // A tenyleges regresszio-vedelem a planPortTakeover-teszt; ez azt rogziti, hogy a
    // hivo tenyleg a tervet koveti, es nem ir melle egy sajat exit-et.
    const exits = body.match(/process\.exit\(/g) ?? []
    expect(exits.length).toBe(1)
    const stopAt = body.indexOf("plan.action === 'stop'")
    const standAt = body.indexOf("plan.action === 'stand-down'")
    const exitAt = body.indexOf('process.exit(')
    expect(stopAt).toBeGreaterThan(-1)
    expect(standAt).toBeGreaterThan(-1)
    expect(exitAt).toBeGreaterThan(stopAt)
    expect(exitAt).toBeLessThan(standAt)
  })

  it('a stand-down ag NEM eri el az acquirePortLock-ot (nem ol)', () => {
    const standAt = body.indexOf("plan.action === 'stand-down'")
    const killAt = body.indexOf('await acquirePortLock(')
    const standBlock = body.slice(standAt, killAt)
    expect(standBlock).toContain('return')
    expect(standBlock).not.toContain('acquirePortLock(')
  })

  it('a kapu NEM a pidfile-bol dolgozik, es NEM tesz `?? PROJECT_ROOT` fallbackot', () => {
    const gateBlock = body.slice(body.indexOf('const takeover ='), body.indexOf('const plan ='))
    expect(gateBlock).not.toContain('PID_FILE')
    expect(gateBlock).not.toContain('readRecordedPid')
    expect(gateBlock).toContain('procCtx.selfProjectRoot')
    expect(gateBlock).not.toContain('?? PROJECT_ROOT')
  })
})
