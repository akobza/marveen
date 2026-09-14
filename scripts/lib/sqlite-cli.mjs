#!/usr/bin/env node
// A drop-in for the handful of `sqlite3` CLI forms this repo actually used.
//
// WHY THIS EXISTS (card 252ab361): the sqlite3 CLI is NOT an install dependency
// -- the documented list is ffmpeg, git, tmux, lsof, curl, python3, pipx, unzip --
// so on a normal Linux install every `sqlite3 ...` call is a command that is not
// there. Two shell tests went permanently red on it, and every future verdict had
// to step over that red before it could see its own result. The shipped scripts
// were worse: they did not all die loudly. See the card for the three measured
// failure shapes.
//
// better-sqlite3 is the engine src/db.ts already opens the database with, so this
// adds no dependency at all -- it reuses the one the product is built on.
//
// DELIBERATELY NOT a general sqlite3 emulator. It covers exactly the forms that
// were in use, and anything else should get its own decision rather than an
// accidental feature:
//   node scripts/lib/sqlite-cli.mjs <db> "<sql>"   -- run SQL, print SELECT rows
//   node scripts/lib/sqlite-cli.mjs <db> .tables   -- list table names
//   node scripts/lib/sqlite-cli.mjs <db> < file    -- run a SQL script from stdin
//
// OUTPUT SHAPE matches the CLI's default "list" mode, because callers parse it:
// no header, no padding, columns joined by "|", one row per line. A scalar query
// therefore prints the bare value, which is what `COUNT=$(...)` expects.
//
// RESOLUTION NOTE: this needs node_modules to be reachable from the file's own
// path. A real install has it; a throwaway fixture in /tmp does not, which is why
// the migrate test symlinks one in (measured: without it, ERR_MODULE_NOT_FOUND).

import { readFileSync } from 'node:fs'
import Database from 'better-sqlite3'

const [dbPath, ...rest] = process.argv.slice(2)
if (!dbPath) {
  process.stderr.write('usage: sqlite-cli.mjs <db> ["<sql>" | .tables]  (SQL may come on stdin)\n')
  process.exit(2)
}

// No SQL argument means "read the script from stdin", the same way `sqlite3 db < f`
// behaves. readFileSync(0) is used rather than an async stream so the exit code is
// not decided before the work is done.
const sql = rest.length > 0 ? rest.join(' ') : readFileSync(0, 'utf-8')

let db
try {
  db = new Database(dbPath)

  if (sql.trim() === '.tables') {
    // The CLI's .tables hides sqlite internals and sorts by name. It prints in
    // columns; one space-separated line carries the same information and is what
    // the callers grep for.
    const rows = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type IN ('table','view') " +
        "AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all()
    if (rows.length > 0) process.stdout.write(rows.map((r) => r.name).join(' ') + '\n')
  } else if (/^\s*(SELECT|WITH|PRAGMA|EXPLAIN)\b/i.test(sql)) {
    // Row-returning: print values only, "|"-joined, NULL as the empty string --
    // the CLI's list mode, which is what every caller here parses.
    for (const row of db.prepare(sql).raw().all()) {
      process.stdout.write(row.map((v) => (v === null ? '' : String(v))).join('|') + '\n')
    }
  } else {
    // Everything else (DDL, INSERT/UPDATE/DELETE, multi-statement scripts).
    db.exec(sql)
  }
} catch (e) {
  // Fail LOUDLY and non-zero. The defect this replaces was quiet: a missing
  // binary that some callers turned into a warning and a successful exit.
  process.stderr.write(`sqlite-cli: ${e instanceof Error ? e.message : String(e)}\n`)
  process.exit(1)
} finally {
  try { db?.close() } catch { /* closing a failed open is not an error worth reporting */ }
}
