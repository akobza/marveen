// Guards scripts/lib/sqlite-cli.mjs -- the better-sqlite3 stand-in that replaced
// the sqlite3 CLI calls (card 252ab361).
//
// ⛔ WHY THIS FILE EXISTS, and it is a measurement not a guess: after the
// replacement landed, three mutations were run against it. Two were caught by the
// shell tests -- going back to the CLI, and breaking the output shape. The third
// was NOT: making the helper swallow a SQL error and exit 0 left every shell test
// GREEN. That is exactly the failure mode this card is about -- a quiet failure
// that reports success -- so the property has to be guarded here, not merely
// present in the source.
//
// The shell tests already cover the shape end-to-end; what they cannot see is the
// helper's own contract, so that is what this file pins.

import { describe, it, expect } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const CLI = join(ROOT, 'scripts', 'lib', 'sqlite-cli.mjs')

function freshDb(): { db: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'sqlite-cli-'))
  const db = join(dir, 't.db')
  execFileSync(process.execPath, [CLI, db], {
    input:
      'CREATE TABLE t (a TEXT, b TEXT);\n' +
      "INSERT INTO t VALUES ('x', 'y');\n" +
      'INSERT INTO t VALUES (NULL, NULL);\n',
  })
  return { db, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

function run(args: string[]): { code: number; out: string; err: string } {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf-8' })
  return { code: r.status ?? -1, out: r.stdout, err: r.stderr }
}

describe('sqlite-cli.mjs: the output shape callers parse', () => {
  it('SQL on stdin runs a multi-statement script (this is how the migrate fixture seeds)', () => {
    const { db, cleanup } = freshDb()
    try {
      expect(run([db, 'SELECT COUNT(*) FROM t']).out).toBe('2\n')
    } finally { cleanup() }
  })

  it('a scalar SELECT prints the BARE value -- no header, no padding', () => {
    // `COUNT=$(sqldb ...)` then compares with [ "$COUNT" = "1" ]. A header line or
    // an aligned column would break every such caller silently.
    const { db, cleanup } = freshDb()
    try {
      const r = run([db, "SELECT a FROM t WHERE a = 'x'"])
      expect(r.out).toBe('x\n')
      expect(r.code).toBe(0)
    } finally { cleanup() }
  })

  it('multiple columns are joined by "|" and NULL is the empty string', () => {
    const { db, cleanup } = freshDb()
    try {
      expect(run([db, 'SELECT a, b FROM t ORDER BY a IS NULL, a']).out).toBe('x|y\n|\n')
    } finally { cleanup() }
  })

  it('.tables lists the tables and hides sqlite internals', () => {
    const { db, cleanup } = freshDb()
    try {
      const out = run([db, '.tables']).out
      expect(out.trim()).toBe('t')
      expect(out).not.toMatch(/sqlite_/)
    } finally { cleanup() }
  })

  it('a write statement produces no output and exits 0', () => {
    const { db, cleanup } = freshDb()
    try {
      const w = run([db, "UPDATE t SET a = 'z' WHERE a = 'x'"])
      expect(w.out).toBe('')
      expect(w.code).toBe(0)
      expect(run([db, "SELECT COUNT(*) FROM t WHERE a = 'z'"]).out).toBe('1\n')
    } finally { cleanup() }
  })
})

describe('⛔ sqlite-cli.mjs FAILS LOUDLY -- the property no shell test can see', () => {
  it('a bad statement exits NON-ZERO and names the problem on stderr', () => {
    // ⛔ Measured: with this file absent, changing the helper's exit(1) to exit(0)
    // left all 30 shell assertions green. The defect this whole card removes is a
    // missing thing that reports success, so an error path that exits 0 would put
    // it straight back, one layer down.
    const { db, cleanup } = freshDb()
    try {
      const r = run([db, 'SELECT * FROM no_such_table'])
      expect(r.code).not.toBe(0)
      expect(r.err).toMatch(/no such table/i)
    } finally { cleanup() }
  })

  it('⛔ CONTROL: a valid statement on the same database exits 0 with empty stderr', () => {
    // Without this, the assertion above would also pass on a helper that fails at
    // everything -- including one that cannot open the database at all.
    const { db, cleanup } = freshDb()
    try {
      const r = run([db, 'SELECT 1'])
      expect(r.code).toBe(0)
      expect(r.err).toBe('')
      expect(r.out).toBe('1\n')
    } finally { cleanup() }
  })

  it('no database argument is a usage error, not a silent success', () => {
    const r = run([])
    expect(r.code).not.toBe(0)
    expect(r.err).toMatch(/usage/i)
  })
})
