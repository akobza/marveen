#!/bin/bash
# Contract tests for scripts/backup.sh as consolidated (card a95cada0): the
# consistent database snapshot and its machine-readable status line, the
# agents/ and file-based memory coverage, the default store/ skips, and the
# optional install-local layer (store/backup.local.rc) with its KEEP guard.
# Run: bash scripts/__tests__/backup-consolidate.test.sh
#
# Hermetic: every run uses a throwaway repo, HOME and BACKUP_DIR under one
# temp dir. Only scripts/backup.sh and scripts/lib/archive-list-has.sh are
# copied from this checkout; the real repo, $HOME and backups/ are not touched.

set -u

PASS=0; FAIL=0
pass() { PASS=$((PASS + 1)); echo "  PASS: $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL: $1"; }
check() { if eval "$2"; then pass "$1"; else fail "$1"; fi; }

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
for t in python3 git tar; do
  command -v "$t" >/dev/null 2>&1 || { echo "SKIP: $t missing"; exit 0; }
done

# make_repo DIR [nodb]: a tiny install with one file of every class the rules name.
make_repo() {
  local R="$1"
  mkdir -p "$R/scripts/lib" "$R/store/backups" "$R/store/scheduled-runs" "$R/store/keepme" \
           "$R/agents/a/tools" "$R/agents/a/reports" "$R/agents/a/node_modules/x" \
           "$R/agents/a/.claude-config/projects/p/memory" "$R/.channels-config/projects/p/memory"
  cp "$REPO/scripts/backup.sh" "$R/scripts/backup.sh"
  cp "$REPO/scripts/lib/archive-list-has.sh" "$R/scripts/lib/archive-list-has.sh"
  echo old-copy > "$R/store/backups/old.db"
  echo run > "$R/store/scheduled-runs/r1.json"
  echo keep > "$R/store/keepme/k.txt"
  echo tool > "$R/agents/a/tools/t.sh"
  echo report > "$R/agents/a/reports/r.md"
  echo dep > "$R/agents/a/node_modules/x/i.js"
  echo mem > "$R/agents/a/.claude-config/projects/p/memory/m.md"
  echo mem2 > "$R/.channels-config/projects/p/memory/m2.md"
  if [[ "${2:-}" != nodb ]]; then
    python3 - "$R/store/claudeclaw.db" <<'PY'
import sqlite3, sys
con = sqlite3.connect(sys.argv[1])
con.execute("PRAGMA journal_mode=WAL")
con.execute("create table t(x)")
con.execute("insert into t values ('row-1')")
con.commit()
con.close()
PY
  fi
  ( cd "$R" && git init -q && git add scripts \
      && git -c user.name=t -c user.email=t@example.invalid commit -qm init )
}

# run_backup DIR [VAR=value ...]: one run with its own HOME and BACKUP_DIR; output in DIR.out, rc in RC.
run_backup() {
  local R="$1"; shift
  # the two load-bearing $HOME items the verification requires on every install
  mkdir -p "$R.home/.claude/skills/s" "$R.home/.claude/scheduled-tasks/t" "$R.backups"
  [[ -f "$R.home/.claude/skills/s/SKILL.md" ]] || echo skill > "$R.home/.claude/skills/s/SKILL.md"
  [[ -f "$R.home/.claude/scheduled-tasks/t/task-config.json" ]] || echo '{}' > "$R.home/.claude/scheduled-tasks/t/task-config.json"
  env HOME="$R.home" BACKUP_DIR="$R.backups" MARVEEN_BACKUP_VIA=wrapper "$@" \
    bash "$R/scripts/backup.sh" > "$R.out" 2>&1
  RC=$?
}
newest() { ls -1t "$1.backups"/claudeclaw-*.tar.gz 2>/dev/null | head -1; }
listing() { tar -tzf "$(newest "$1")" 2>/dev/null; }
has() { listing "$1" | grep -qxF "$2"; }
has_under() { listing "$1" | grep -q "^$(printf '%s' "$2" | sed 's/[.[\*^$/]/\\&/g')"; }

echo "backup.sh: consolidated contract (a95cada0)"
echo "============================================"

echo "-- 1. default run"
R="$TMP/r1"; make_repo "$R"; run_backup "$R"
check "rc 0" '[[ $RC -eq 0 ]]'
check "status line: db-snapshot=consistent" 'grep -qx "backup: db-snapshot=consistent" "$R.out"'
check "verification ran and passed" 'grep -qE "verified [0-9]+ manifest entries" "$R.out"'
A="$(newest "$R")"
check "archive written, mode 600" '[[ -n "$A" && "$(stat -c %a "$A")" == 600 ]]'
check "the database is in the archive" 'has "$R" repo/store/claudeclaw.db'
check "no -wal/-shm next to a consistent snapshot" '! has "$R" repo/store/claudeclaw.db-wal && ! has "$R" repo/store/claudeclaw.db-shm'
check "store/backups skipped by default (decision D)" '! has_under "$R" repo/store/backups/'
check "store/scheduled-runs skipped by default" '! has_under "$R" repo/store/scheduled-runs/'
check "an ordinary store/ entry is taken" 'has "$R" repo/store/keepme/k.txt'
check "agents/: tools and reports taken" 'has "$R" repo/agents/a/tools/t.sh && has "$R" repo/agents/a/reports/r.md'
check "agents/: node_modules excluded by rule" '! has_under "$R" repo/agents/a/node_modules/'
check "sub-agent memory FILE taken" 'has "$R" repo/agents/a/.claude-config/projects/p/memory/m.md'
check "main-agent memory FILE taken (.channels-config)" 'has "$R" repo/.channels-config/projects/p/memory/m2.md'
check "no UNCOVERED.txt when every agents/ file matched a rule" '! has "$R" UNCOVERED.txt'
mkdir -p "$TMP/x1" && tar -xzf "$A" -C "$TMP/x1" MANIFEST.txt repo/store/claudeclaw.db 2>/dev/null
check "MANIFEST records the snapshot" 'grep -qx "db-snapshot: consistent" "$TMP/x1/MANIFEST.txt"'
check "the archived database is intact and holds the row" \
  '[[ "$(python3 -c "import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); print(c.execute(\"pragma integrity_check\").fetchone()[0], c.execute(\"select x from t\").fetchone()[0])" "$TMP/x1/repo/store/claudeclaw.db")" == "ok row-1" ]]'

echo "-- 2. install-local layer"
R="$TMP/r2"; make_repo "$R"
cat > "$R/store/backup.local.rc" <<'RC'
BACKUP_KEEP=2
STORE_SKIP_TAKE="backups"
STORE_SKIP_ADD="keepme"
RC
run_backup "$R"
check "rc 0" '[[ $RC -eq 0 ]]'
check "the layer is announced" 'grep -q "^backup: local layer sourced: " "$R.out"'
check "STORE_SKIP_TAKE brings a default-skipped entry back" 'has "$R" repo/store/backups/old.db'
check "STORE_SKIP_ADD leaves an entry out" '! has_under "$R" repo/store/keepme/'
check "the other default skip still applies" '! has_under "$R" repo/store/scheduled-runs/'
check "the layer file itself is archived" 'has "$R" repo/store/backup.local.rc'

echo "-- 3. KEEP from the layer rotates the archives"
for _ in 1 2; do sleep 1; run_backup "$R"; done
check "three runs, KEEP=2: two archives left" '[[ $(ls -1 "$R.backups"/claudeclaw-*.tar.gz | wc -l) -eq 2 ]]'

echo "-- 4. a bad KEEP is refused before anything is written"
R="$TMP/r4"; make_repo "$R"; run_backup "$R"; before=$(ls -1 "$R.backups"/claudeclaw-*.tar.gz | wc -l)
sleep 1; run_backup "$R" BACKUP_KEEP=0
check "BACKUP_KEEP=0: rc 2" '[[ $RC -eq 2 ]]'
check "BACKUP_KEEP=0: says why" 'grep -q "KEEP must be a positive integer" "$R.out"'
check "BACKUP_KEEP=0: no archive deleted or added" '[[ $(ls -1 "$R.backups"/claudeclaw-*.tar.gz | wc -l) -eq $before ]]'
run_backup "$R" BACKUP_KEEP=abc
check "BACKUP_KEEP=abc: rc 2" '[[ $RC -eq 2 ]]'

echo "-- 5. no database on the install"
# Only the status line is pinned here: the verification's load-bearing list still
# names repo/store/claudeclaw.db unconditionally (unchanged by this card), so a
# DB-less run reports no-database and then fails verification.
R="$TMP/r5"; make_repo "$R" nodb; run_backup "$R"
check "status line: db-snapshot=no-database" 'grep -qx "backup: db-snapshot=no-database" "$R.out"'

echo ""
echo "passed: $PASS, failed: $FAIL"
[[ $FAIL -eq 0 ]]
