// A stand-in for the `sqlite3` CLI, for shell suites that only need it to set up
// or inspect their own throwaway database (card 252ab361).
//
// WHY THIS EXISTS: `sqlite3` is not an installer dependency (ffmpeg, git, tmux,
// lsof, curl, python3, pipx, unzip), so on a clean machine three suites failed
// with "sqlite3: command not found" and the whole run stayed red. A permanently
// red run is worse than a missing test: the next tester has to rediscover that
// the red is not theirs, and a NEW failure lands in the same "oh, that old one"
// drawer. The framework itself reads this database through better-sqlite3, so the
// tests now take the same road, and the CLI stops being a hidden dependency.
//
// SCOPE, stated so nobody reads more into it: this serves the SUITES' own
// database access. It is not a general sqlite3 replacement, and a script under
// test that genuinely needs the CLI (pre-modify-backup.sh uses the `.backup`
// dot-command) is NOT covered by it.
import Database from 'better-sqlite3'
import { readFileSync } from 'node:fs'

const [dbPath, inlineSql] = process.argv.slice(2)
if (!dbPath) {
  console.error('sqlite3-cli: usage: sqlite3-cli.mjs <db> [sql]   (sql may also arrive on stdin)')
  process.exit(2)
}

// Read from stdin when no SQL argument was given -- this is the heredoc shape.
let sql = inlineSql
if (sql === undefined) {
  try {
    sql = readFileSync(0, 'utf-8')
  } catch {
    sql = ''
  }
}
sql = String(sql).trim()
if (sql === '') process.exit(0)

const db = new Database(dbPath)

// Dot-commands are a CLI feature, not SQL. Only the ones a suite actually uses
// are implemented, and anything else FAILS LOUDLY: a silent empty answer here
// would turn into a passing assertion that measured nothing.
if (sql.startsWith('.')) {
  const [cmd] = sql.split(/\s+/)
  if (cmd === '.tables') {
    const rows = db
      .prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all()
    for (const r of rows) console.log(r.name)
    process.exit(0)
  }
  console.error(`sqlite3-cli: unsupported dot-command '${cmd}'. Implement it here rather than letting a suite pass on an empty answer.`)
  process.exit(2)
}

// `prepare` handles ONE statement and tells us whether it returns rows; a setup
// block with several statements has to go through `exec`. Which error text
// better-sqlite3 uses for that is not part of its contract, so the fallback is on
// the FAILURE ITSELF, not on matching a message -- an earlier version keyed on the
// wording, the wording differed, and the setup block silently did not run.
let prepared = null
try {
  prepared = db.prepare(sql)
} catch {
  prepared = null
}
try {
  if (prepared === null) {
    db.exec(sql)
  } else if (prepared.reader) {
    for (const row of prepared.raw().all()) console.log(row.join('|'))
  } else {
    prepared.run()
  }
} catch (err) {
  console.error(`sqlite3-cli: ${err?.message ?? err}`)
  process.exit(1)
}
