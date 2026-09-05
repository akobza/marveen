import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  initDatabase,
  saveAgentMemory,
  updateMemory,
  getMemoryStats,
  getDb,
  getDailyLog,
  invalidateEmbeddings,
  embeddingSourceText,
  embeddingSourceHash,
} from '../db.js'

// Card e04bda19. updateMemory() rewrote a memory's text and left the OLD vector in
// place, so a corrected memory stayed searchable under its previous -- sometimes false --
// wording, and nothing said so: `embedding IS NOT NULL` still read 100%.
//
// The three tests below are the two directions plus the boundary, in the shape the
// fleet gate rule asks for:
//   vak-teszt      -- after an edit the row must NOT still claim a current vector
//   kontroll-minta -- an untouched, hashed row must be reported as fresh (otherwise
//                     the freshness check could "pass" by calling everything stale)
//   határ          -- a row with no hash at all is UNKNOWN, never fresh
//
// Ollama is not running in CI, so generateEmbedding() resolves to null and the
// fire-and-forget regeneration writes nothing. That is exactly the interesting case:
// the invalidation must hold on its own, without a successful re-embed.

function setVector(id: number, vector: number[], sourceHash: string | null): void {
  getDb()
    .prepare('UPDATE memories SET embedding = ?, embedding_source_sha256 = ? WHERE id = ?')
    .run(JSON.stringify(vector), sourceHash, id)
}

function readVector(id: number): { embedding: string | null; embedding_source_sha256: string | null } {
  return getDb()
    .prepare('SELECT embedding, embedding_source_sha256 FROM memories WHERE id = ?')
    .get(id) as { embedding: string | null; embedding_source_sha256: string | null }
}

describe('embeddingSourceText / embeddingSourceHash (kanonikus alap)', () => {
  it('a kulcsszavak reszei a forrasnak, es a hash ezt koveti', () => {
    expect(embeddingSourceText('alma', 'gyumolcs')).toBe('alma gyumolcs')
    expect(embeddingSourceText('alma')).toBe('alma')
    expect(embeddingSourceHash('alma', 'gyumolcs')).not.toBe(embeddingSourceHash('alma'))
  })

  it('ugyanaz a bemenet ugyanazt a hasht adja (kulonben a frissesseg-jelzes zajt adna)', () => {
    expect(embeddingSourceHash('alma', 'gyumolcs')).toBe(embeddingSourceHash('alma', 'gyumolcs'))
  })
})

describe('a helyben javitott emlek vektora nem maradhat a REGI szovegen', () => {
  beforeAll(() => {
    initDatabase(':memory:')
  })

  it('VAK-TESZT: updateMemory utan a sor nem allit ervenyes vektort', () => {
    const { id } = saveAgentMemory('teszt-agens', 'a regi, hibas allitas', 'warm', 'kulcs')
    setVector(id, [0.1, 0.2, 0.3], embeddingSourceHash('a regi, hibas allitas', 'kulcs'))
    expect(readVector(id).embedding).not.toBeNull()

    updateMemory(id, 'a javitott, helyes allitas', undefined, undefined, 'kulcs')

    const after = readVector(id)
    expect(after.embedding).toBeNull()
    expect(after.embedding_source_sha256).toBeNull()
  })

  it('KONTROLL-MINTA: az erintetlen, hashelt sor FRISS marad', () => {
    const { id } = saveAgentMemory('teszt-agens', 'valtozatlan tartalom', 'warm', 'kulcs')
    setVector(id, [0.4], embeddingSourceHash('valtozatlan tartalom', 'kulcs'))

    const stats = getMemoryStats()
    expect(stats.embeddingFresh).toBeGreaterThan(0)
    expect(readVector(id).embedding).not.toBeNull()
  })

  it('HATAR: hash nelkuli sor UNKNOWN, nem friss -- a bizonyitatlan nem szamit bizonyitottnak', () => {
    const { id } = saveAgentMemory('teszt-agens', 'regi sor hash nelkul', 'warm')
    setVector(id, [0.9], null)

    const stats = getMemoryStats()
    expect(stats.embeddingUnknown).toBeGreaterThan(0)
    expect(readVector(id).embedding_source_sha256).toBeNull()
  })

  it('a stale sor STALE-kent latszik, nem friss-kent', () => {
    const { id } = saveAgentMemory('teszt-agens', 'egyik szoveg', 'warm', 'kulcs')
    setVector(id, [0.5], embeddingSourceHash('EGY MASIK, nem ide tartozo szoveg', 'kulcs'))

    const stats = getMemoryStats()
    expect(stats.embeddingStale).toBeGreaterThan(0)
    // A regi mutato ugyanezt a sort "megvan"-kent szamolja -- ezert nem eleg onmagaban.
    expect(stats.withEmbedding).toBeGreaterThanOrEqual(stats.embeddingFresh + stats.embeddingStale)
  })
})

describe('invalidateEmbeddings (a torteneti sorok operatori javitasa)', () => {
  it('csak a megadott sorokat uriti, es megmondja hanyat', () => {
    const a = saveAgentMemory('teszt-agens', 'egyik regi sor', 'warm')
    const b = saveAgentMemory('teszt-agens', 'masik regi sor', 'warm')
    setVector(a.id, [0.1], null)   // hash nelkul: a backfill magatol NEM nyulna hozza
    setVector(b.id, [0.2], null)

    const cleared = invalidateEmbeddings([a.id])

    expect(cleared).toBe(1)
    expect(readVector(a.id).embedding).toBeNull()
    // KONTROLL: a masik sor erintetlen -- kulonben "mindent kiurit" is atmenne a teszten
    expect(readVector(b.id).embedding).not.toBeNull()
  })

  it('ures listara nem csinal semmit', () => {
    expect(invalidateEmbeddings([])).toBe(0)
  })
})

describe('a helyben-javitas nyomot hagy a napi naploban (mechanizmus, nem szabaly)', () => {
  it('updateMemory maga irja a naplo-sort, ugyanabban a hivasban', () => {
    const { id } = saveAgentMemory('naplo-agens', 'eredeti szoveg', 'warm')
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Budapest' })
    const before = getDailyLog('naplo-agens', today).length

    updateMemory(id, 'javitott szoveg')

    const after = getDailyLog('naplo-agens', today)
    expect(after.length).toBe(before + 1)
    expect(after[after.length - 1].content).toContain(`PUT ${id}`)
  })

  it('KONTROLL: a MENTES nem ir naplo-sort -- csak a helyben-javitas', () => {
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Budapest' })
    const before = getDailyLog('naplo-agens-2', today).length
    saveAgentMemory('naplo-agens-2', 'uj emlek, nem szerkesztes', 'warm')
    expect(getDailyLog('naplo-agens-2', today).length).toBe(before)
  })
})

// Structural, not behavioural, on purpose: the window between "text updated" and
// "vector cleared" cannot be observed from outside the function, but it is exactly
// what this card exists to close. A future refactor that splits the two statements
// apart would restore the bug silently, so the shape is pinned at source level --
// the same approach conversation-ledger-schema.test.ts uses for schema drift.
describe('az ervenytelenites ATOMI: egy UPDATE irja a szoveget es uriti a vektort', () => {
  const dbts = readFileSync(join(__dirname, '..', 'db.ts'), 'utf-8')

  // A keresest ELOSZOR az updateMemory torzsere szukitjuk, es CSAK azutan illesztunk.
  // Enelkul a `match()` (a /g hianyaban) a FAJL elso `const sets` sorat adna vissza -- ma az
  // eppen az updateMemory-e, de a db.ts-ben harom ilyen sor van (updateMemory, updateIdea,
  // updateVaultSshServer). Egy uj fuggveny az 1529. sor fole csendben athelyezne a merest, es
  // a teszt ZOLD MARADNA, mikozben az updateMemory mar visszaesett. Egy zold teszt, ami mar
  // mast mer, rosszabb a hianyzo tesztnel. (Talalta: fejlesztes-vezeto, msg 665.)
  const fnStart = dbts.indexOf('export function updateMemory')
  const rest = dbts.slice(fnStart)
  const updateMemoryBody = rest.slice(0, rest.indexOf('\nexport '))

  it('KONTROLL: a kimetszett torzs tenyleg az updateMemory-e, es csak az', () => {
    expect(fnStart).toBeGreaterThan(-1)
    expect(updateMemoryBody).toContain('export function updateMemory')
    // A hatar mukodik: a kovetkezo exportalt fuggvenyek NEM szivarognak bele.
    expect(updateMemoryBody).not.toContain('export function updateIdea')
    expect(updateMemoryBody).not.toContain('export function updateVaultSshServer')
  })

  it('a vektor-oszlopok a sets tombben vannak, nem kulon utasitasban', () => {
    const m = updateMemoryBody.match(/const sets: string\[\] = \[([^\]]*)\]/)
    expect(m).not.toBeNull()
    expect(m![1]).toContain("embedding = NULL")
    expect(m![1]).toContain("embedding_source_sha256 = NULL")
  })

  it('KONTROLL: az updateMemory NEM tartalmaz kulon ervenytelenito UPDATE-et', () => {
    expect(updateMemoryBody).not.toMatch(/UPDATE memories SET embedding = NULL[^\n]*WHERE id/)
  })
})
