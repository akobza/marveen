// A binaryPattern-ag NEM olhet idegen gyokerbol futo folyamatot (kartya: 853d94db).
// Eredetileg a fejlesztes-vezeto egy kerdesenek eldontesere keszult (13029); allando tesztte a
// 13236-os GO tette. ⛔ Az indok nem az, hogy 'hasznos': a tulajdonsag, amit bizonyit
// (idegen gyoker -> kizarva), pontosan az, amit egy kesobbi refaktor CSENDBEN eltorne -- es a
// kapu akkor is zold maradna, mert o nem is latja ezt az agat.
// A kerdes: egy IDEGEN install dashboard-folyamata, ami MAR ELENGEDTE a portot, atmegy-e?
// A kapu (decidePortTakeover) nem latja, mert nem port-birtokos. A binaryPattern-ag viszont
// megtalalja. Ez a fajl azt meri, mit tesz a binaryPattern-ag egy IDEGEN cwd-ju folyamattal.

import { describe, it, expect } from 'vitest'
import { findOwnBinaryMatches } from '../process-lock.js'

const SELF = '/home/user/marveen'
const OTHER = '/home/user/marveen-masik-install'

function ctx(opts: { pids: number[]; cwd: (pid: number) => string | null; selfRoot: string | null }) {
  return {
    currentPid: 1,
    uid: null,
    selfProjectRoot: opts.selfRoot,
    listOwnProcessesMatching: () => opts.pids,
    getProcessCommand: () => 'node /some/path/dist/index.js',
    getProcessUid: () => null,
    getProcessCwd: opts.cwd,
    log: { warn: () => {}, info: () => {}, error: () => {} },
  } as never
}

describe('binaryPattern-ag: atmegy-e az IDEGEN, portot mar elengedett folyamat?', () => {
  it('⛔ A KERDES: idegen gyokerbol futo binary-match -> KIZARVA (nem olheto)', () => {
    const holders = findOwnBinaryMatches(/dist\/index\.js/, ctx({
      pids: [999], cwd: () => OTHER, selfRoot: SELF,
    }))
    expect(holders).toEqual([])
  })

  it('KONTROLL: sajat gyokerbol futo binary-match -> BENNE (kulonben a mero vak lenne)', () => {
    const holders = findOwnBinaryMatches(/dist\/index\.js/, ctx({
      pids: [999], cwd: () => SELF, selfRoot: SELF,
    }))
    expect(holders).toEqual([999])
  })

  it('⛔ A RES, AMIT A KOD MAGA KIMOND: OLVASHATATLAN cwd -> BENNE MARAD', () => {
    const holders = findOwnBinaryMatches(/dist\/index\.js/, ctx({
      pids: [999], cwd: () => null, selfRoot: SELF,
    }))
    expect(holders).toEqual([999])
  })

  it('sajat gyoker feloldatlan -> a cwd-szures ki sem kapcsol, minden jelolt benne marad', () => {
    const holders = findOwnBinaryMatches(/dist\/index\.js/, ctx({
      pids: [999], cwd: () => OTHER, selfRoot: null,
    }))
    expect(holders).toEqual([999])
  })
})
