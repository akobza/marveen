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
    ins.run('Teodor/Agent-A', 'ugyvezeto')
    ins.run('ugyvezeto', 'MARVEEN/Fejleszto')
    ins.run('teodor/agent-b', 'Plain-Name')
    initDatabase(dbPath) // the boot re-runs the backfill
    const rows = getDb().prepare('SELECT from_agent, to_agent FROM agent_messages ORDER BY id').all() as { from_agent: string; to_agent: string }[]
    expect(rows).toEqual([
      { from_agent: 'teodor/Agent-A', to_agent: 'ugyvezeto' },
      { from_agent: 'ugyvezeto', to_agent: 'marveen/Fejleszto' },
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
