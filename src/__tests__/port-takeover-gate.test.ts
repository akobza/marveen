import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { decidePortTakeover, formatTakeoverRefusal } from '../process-lock.js'

// Card 853d94db. index.ts kills whatever holds WEB_PORT before binding. The victim
// selection is deliberately permissive -- a process it cannot attribute is left alone --
// but the DECISION inherited that shape, so "could not attribute" meant "carry on", and
// carrying on there is SIGKILL against a process that may belong to another install.
//
// The gate inverts the burden: taking over is the claim that must be proven.
//
// The pidfile is not an input, and that is a measured decision: store/dashboard.pid does
// not exist on this host while the dashboard runs, so a pidfile-based gate would start
// from a missing signal -- and a missing file must never be read as "then it is ours".

const SELF = '/home/user/marveen'
const OTHER = '/home/user/marveen-worktree'

describe('decidePortTakeover: az atvetel a bizonyitando allitas', () => {
  it('nincs birtokos -> nincs mit atvenni', () => {
    expect(decidePortTakeover([], SELF, () => null)).toEqual({ kind: 'no-holder' })
  })

  it('a birtokos IGAZOLHATOAN a mienk -> atvehetjuk (a sajat ujrainditas mukodik)', () => {
    const d = decidePortTakeover([111], SELF, () => SELF)
    expect(d).toEqual({ kind: 'take-over', holders: [111] })
  })

  it('MAS telepites birtokolja -> NEM olunk, es megnevezzuk mindket gyokeret', () => {
    const d = decidePortTakeover([222], SELF, () => OTHER)
    expect(d.kind).toBe('refuse')
    if (d.kind !== 'refuse') return
    expect(d.holder).toBe(222)
    expect(d.holderRoot).toBe(OTHER)
    expect(d.selfRoot).toBe(SELF)
  })

  it('NEM OLVASHATO gyoker -> NEM olunk. Ez az az ag, ami korabban "valoszinuleg rendben"-t jelentett', () => {
    const d = decidePortTakeover([333], SELF, () => null)
    expect(d.kind).toBe('refuse')
    if (d.kind !== 'refuse') return
    expect(d.holderRoot).toBeNull()
  })

  it('tobb birtokos: EGY idegen is eleg a megallashoz', () => {
    const d = decidePortTakeover([111, 222], SELF, (pid) => (pid === 111 ? SELF : OTHER))
    expect(d.kind).toBe('refuse')
    if (d.kind !== 'refuse') return
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
    const d = decidePortTakeover([444], SELF, () => SELF + '2')
    expect(d.kind).toBe('refuse')
  })
})

describe('a megtagadas szovege megmondja, mit talalt es mit vart', () => {
  it('megnevezi a pid-et es MINDKET PROJECT_ROOT-ot', () => {
    const text = formatTakeoverRefusal({ kind: 'refuse', holder: 222, holderRoot: OTHER, selfRoot: SELF })
    expect(text).toContain('222')
    expect(text).toContain(OTHER)
    expect(text).toContain(SELF)
    expect(text).toMatch(/REFUSING TO TAKE THE PORT/)
  })

  it('olvashatatlan gyokernel is mond valamit, nem "null"-t', () => {
    const text = formatTakeoverRefusal({ kind: 'refuse', holder: 333, holderRoot: null, selfRoot: SELF })
    expect(text).toContain('could not be determined')
    expect(text).not.toMatch(/\bnull\b/)
  })
})

describe('a kapu a KILL ELOTT all, es a pidfile nem bemenet', () => {
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

  it('a kapu NEM a pidfile-bol dolgozik', () => {
    const gateBlock = body.slice(body.indexOf('const takeover ='), body.indexOf('await acquirePortLock('))
    expect(gateBlock).not.toContain('PID_FILE')
    expect(gateBlock).not.toContain('readRecordedPid')
  })
})
