import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { initDatabase, getDb, FEDERATION_CASE_FOLD_SQL } from '../db.js'

// Card 75693151, 2nd PR: what initDatabase and the boot do before the web listener. On the saturated 2026-10-19 disk the
// boot spent 57.7 s in initDatabase (on a store copy 324.7 MB of its 325.9 MB cold read was the federation case-fold
// backfill's table scan) and 13.3 s in the store watcher's first walk; the daily decay re-indexed FTS for every row.
//  (b1) the backfill still folds the system prefix of qualified ids, keeps the agent segment and leaves the rest alone;
//  (b2) its candidates come from a covering index, not a table scan (the plan of the exact boot statements);
//  (t1) memories_au fires only on an update of content or keywords, and an installed old body is replaced;
//  (t2) a text write still re-indexes FTS (content and keywords), a maintenance write (salience, accessed_at, embedding)
//       writes no FTS row, and the FTS stays consistent;
//  (w1) the store watcher starts only after the web listener is up.

let dir: string
let dbPath: string
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'boot-db-cost-'))
  dbPath = join(dir, 'boot.db')
  initDatabase(dbPath)
})
afterAll(() => {
  initDatabase(':memory:') // release the file before removing it
  rmSync(dir, { recursive: true, force: true })
})

describe('the federation case-fold backfill', () => {
  it('b1: folds the system prefix of qualified ids at boot, keeps the agent segment and the rest', () => {
    const ins = getDb().prepare("INSERT INTO agent_messages (from_agent, to_agent, content, status, created_at) VALUES (?, ?, 'x', 'done', 1)")
    ins.run('Teodor/Agent-A', 'local-main')
    ins.run('local-main', 'ARTHUR/Marketing')
    ins.run('teodor/agent-b', 'Plain-Name')
    initDatabase(dbPath) // the boot re-runs the backfill
    const rows = getDb().prepare('SELECT from_agent, to_agent FROM agent_messages ORDER BY id').all() as { from_agent: string; to_agent: string }[]
    expect(rows).toEqual([
      { from_agent: 'teodor/Agent-A', to_agent: 'local-main' },
      { from_agent: 'local-main', to_agent: 'arthur/Marketing' },
      { from_agent: 'teodor/agent-b', to_agent: 'Plain-Name' },
    ])
  })

  it('b2: the boot statements pick their candidates from a covering index, never a table scan', () => {
    for (const sql of [FEDERATION_CASE_FOLD_SQL.from, FEDERATION_CASE_FOLD_SQL.to]) {
      const plan = (getDb().prepare('EXPLAIN QUERY PLAN ' + sql).all() as { detail: string }[]).map((r) => r.detail)
      expect(plan.some((d) => /SCAN agent_messages USING COVERING INDEX/.test(d))).toBe(true)
      expect(plan.some((d) => /^SCAN agent_messages$/.test(d.trim()))).toBe(false)
    }
  })
})

describe('memories_au: FTS sync only on a text write', () => {
  const triggerSql = () => (getDb().prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'memories_au'").get() as { sql: string }).sql
  const changesOf = (sql: string, ...args: unknown[]) => {
    const before = (getDb().prepare('SELECT total_changes() AS n').get() as { n: number }).n
    getDb().prepare(sql).run(...args)
    return (getDb().prepare('SELECT total_changes() AS n').get() as { n: number }).n - before
  }
  const match = (q: string) => (getDb().prepare('SELECT count(*) AS n FROM memories_fts WHERE memories_fts MATCH ?').get(q) as { n: number }).n
  const integrity = () => getDb().exec("INSERT INTO memories_fts(memories_fts) VALUES('integrity-check')")

  it('t1: the trigger is UPDATE OF content, keywords, also after an old body was installed', () => {
    expect(triggerSql()).toMatch(/AFTER UPDATE OF content, keywords ON memories/)
    getDb().exec('DROP TRIGGER memories_au')
    getDb().exec("CREATE TRIGGER memories_au AFTER UPDATE ON memories BEGIN INSERT INTO memories_fts(memories_fts, rowid, content, keywords) VALUES('delete', old.id, old.content, old.keywords); INSERT INTO memories_fts(rowid, content, keywords) VALUES (new.id, new.content, new.keywords); END")
    initDatabase(dbPath)
    expect(triggerSql()).toMatch(/AFTER UPDATE OF content, keywords ON memories/)
  })

  it('t2: a text write re-indexes, a maintenance write does not, and the FTS stays consistent', () => {
    const now = Math.floor(Date.now() / 1000)
    const id = Number(getDb().prepare(
      "INSERT INTO memories (chat_id, content, sector, salience, created_at, accessed_at, keywords) VALUES ('boot-chat', 'alfa szoveg', 'semantic', 1.0, ?, ?, 'kulcsegy')",
    ).run(now, now).lastInsertRowid)
    expect(match('alfa')).toBe(1)
    // maintenance writes: only the row itself changes, no FTS write
    expect(changesOf('UPDATE memories SET salience = 0.5 WHERE id = ?', id)).toBe(1)
    expect(changesOf('UPDATE memories SET accessed_at = ? WHERE id = ?', now + 5, id)).toBe(1)
    expect(changesOf('UPDATE memories SET embedding = ? WHERE id = ?', '[0.1,0.2]', id)).toBe(1)
    // text writes: FTS follows
    getDb().prepare('UPDATE memories SET content = ? WHERE id = ?').run('beta szoveg', id)
    expect(match('alfa')).toBe(0)
    expect(match('beta')).toBe(1)
    getDb().prepare('UPDATE memories SET keywords = ? WHERE id = ?').run('kulcsketto', id)
    expect(match('kulcsegy')).toBe(0)
    expect(match('kulcsketto')).toBe(1)
    expect(() => integrity()).not.toThrow()
  })
})

// STRUCTURAL (the boot would need every subsystem up; the decay-sweep-schedule boot-wiring test makes the same trade).
describe('the boot wiring', () => {
  it('w1: startStoreWatcher runs only in the listening handler, after startWebServer', () => {
    const root = join(fileURLToPath(import.meta.url), '..', '..', '..')
    const src = readFileSync(join(root, 'src', 'index.ts'), 'utf-8').split('\n').filter((l) => !l.trimStart().startsWith('//')).join('\n')
    const calls = [...src.matchAll(/\bstartStoreWatcher\(\)/g)].map((m) => m.index ?? -1)
    expect(calls).toHaveLength(1)
    const handler = src.indexOf('const afterListening = (): void => {')
    expect(handler).toBeGreaterThan(src.indexOf('webServer = startWebServer(WEB_PORT)'))
    expect(calls[0]).toBeGreaterThan(handler)
    expect(src).toContain("webServer.once('listening', afterListening)")
    expect(src).toContain('if (webServer.listening) afterListening()')
  })
})
