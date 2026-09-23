#!/bin/bash
# Contract tests for the DATABASE half of scripts/pre-modify-backup.sh.
# Run: bash scripts/__tests__/pre-modify-backup-db-snapshot.test.sh
#
# Card 252ab361. The snapshot used to be `sqlite3 ... ".backup ..."`, a CLI that is
# not an install dependency. On a normal install it was a command that is not
# there, its `|| echo WARNING` turned that into a warning, and the script printed
# "backup ok" with exit 0 -- a backup without the database, believed. The script
# now snapshots through python3's sqlite3 backup API and fails LOUDLY when it
# cannot. The honest-exit suite covers the checksum half; this one pins:
#   1. no sqlite3 CLI on PATH -> the snapshot is a real, readable database, and the
#      snapshot manifest lists it with a real sum and its exact size;
#   2. the snapshot cannot be taken (no python3) -> exit 1, not 0 and not the
#      lighter 3, no "backup ok", and the directory is marked -INCOMPLETE so it can
#      never be mistaken for a usable snapshot later.
#
# Hermetic: a throwaway repo and curated PATHs of symlinks, never the live store.

set -u

PASS=0; FAIL=0
pass() { PASS=$((PASS + 1)); echo "  PASS: $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL: $1"; }
assert_eq() { if [ "$2" = "$3" ]; then pass "$1"; else fail "$1 (expected '$2', got '$3')"; fi; }
assert_contains() { case "$2" in *"$3"*) pass "$1" ;; *) fail "$1 (missing '$3')" ;; esac; }
assert_not_contains() { case "$2" in *"$3"*) fail "$1 (unexpected '$3')" ;; *) pass "$1" ;; esac; }

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
SCRIPT="$REPO/scripts/pre-modify-backup.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "pre-modify-backup: database snapshot without the sqlite3 CLI"
echo "============================================================"

FAKE="$TMP/repo"
mkdir -p "$FAKE/scripts" "$FAKE/store"
cp "$SCRIPT" "$FAKE/scripts/"
python3 - "$FAKE/store/claudeclaw.db" <<'PYFIXTURE'
import sqlite3, sys
con = sqlite3.connect(sys.argv[1])
con.execute("CREATE TABLE t(a)")
con.execute("INSERT INTO t VALUES (42)")
con.commit()
con.close()
PYFIXTURE

# A curated PATH: symlinks to the named commands and nothing else.
curated_path() {
  local dir="$1"; shift
  mkdir -p "$dir"
  for c in "$@"; do
    for d in /usr/bin /bin /usr/local/bin /opt/homebrew/bin /usr/sbin; do
      if [ -x "$d/$c" ]; then ln -sf "$d/$c" "$dir/$c"; break; fi
    done
  done
}
BASE_CMDS="bash find mv tr cp mkdir grep cut date du ls tail rm dirname basename git wc sed awk head sort uname sha256sum shasum"

# ---------------------------------------------------------------------------
# 1. No sqlite3 CLI anywhere on PATH, python3 present.
# ---------------------------------------------------------------------------
echo ""
echo "(1) No sqlite3 CLI on PATH"
NOCLI="$TMP/bin-nocli"
curated_path "$NOCLI" $BASE_CMDS python3
# The case proves nothing unless the CLI is really absent and the tools are there.
if PATH="$NOCLI" command -v sqlite3 >/dev/null 2>&1; then
  fail "the curated PATH really has no sqlite3 CLI"
else
  pass "the curated PATH really has no sqlite3 CLI"
fi
for need in python3 find grep; do
  [ -x "$NOCLI/$need" ] || fail "the curated PATH carries $need (otherwise this case proves nothing)"
done
rm -rf "$FAKE/store/backups"
OUT="$(PATH="$NOCLI" /usr/bin/env bash "$FAKE/scripts/pre-modify-backup.sh" nocli 2>&1)"; RC=$?
SNAP="$(ls -1dt "$FAKE/store/backups"/*/ 2>/dev/null | head -1)"
assert_eq "exit 0" "0" "$RC"
assert_contains "says the snapshot is consistent" "$OUT" "db: consistent snapshot ok"
assert_not_contains "never says command not found" "$OUT" "command not found"
# The load-bearing check: the snapshot is a DATABASE with the row in it, not a
# file that merely exists.
ROW="$(python3 - "${SNAP}claudeclaw.db" <<'PYREAD' 2>/dev/null
import sqlite3, sys
con = sqlite3.connect(f"file:{sys.argv[1]}?mode=ro", uri=True)
print(con.execute("SELECT a FROM t").fetchone()[0])
con.close()
PYREAD
)"
assert_eq "the snapshot is a readable database with the row" "42" "$ROW"
LINE="$(grep '  claudeclaw\.db$' "${SNAP}MANIFEST.sha256" 2>/dev/null)"
case "$LINE" in
  [0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]*"  claudeclaw.db") pass "the snapshot manifest lists the database with a real sum" ;;
  *) fail "the snapshot manifest lists the database with a real sum (got '$LINE')" ;;
esac
SIZE_LISTED="$(printf '%s' "$LINE" | awk '{print $2}')"
SIZE_REAL="$(wc -c < "${SNAP}claudeclaw.db" | tr -d ' ')"
assert_eq "and with its exact size in bytes" "$SIZE_REAL" "$SIZE_LISTED"

# ---------------------------------------------------------------------------
# 2. The snapshot cannot be taken: no python3 on PATH.
# ---------------------------------------------------------------------------
echo ""
echo "(2) The snapshot cannot be taken (no python3)"
NOPY="$TMP/bin-nopy"
curated_path "$NOPY" $BASE_CMDS
if PATH="$NOPY" command -v python3 >/dev/null 2>&1; then
  fail "the curated PATH really has no python3"
else
  pass "the curated PATH really has no python3"
fi
rm -rf "$FAKE/store/backups"
OUT="$(PATH="$NOPY" /usr/bin/env bash "$FAKE/scripts/pre-modify-backup.sh" nopy 2>&1)"; RC=$?
assert_eq "exit 1: a failed database snapshot is fatal, not the lighter 3" "1" "$RC"
assert_contains "it says so on stderr" "$OUT" "FATAL -- the database snapshot FAILED"
assert_not_contains "it does NOT report a clean run" "$OUT" "backup ok"
USABLE="$(ls -1d "$FAKE/store/backups"/*/ 2>/dev/null | grep -v -- '-INCOMPLETE/$' | wc -l | tr -d ' ')"
MARKED="$(ls -1d "$FAKE/store/backups"/*-INCOMPLETE/ 2>/dev/null | wc -l | tr -d ' ')"
assert_eq "no directory is left that looks like a usable snapshot" "0" "$USABLE"
assert_eq "the failed directory is marked -INCOMPLETE" "1" "$MARKED"

# ---------------------------------------------------------------------------
# 3. Retention: failed runs must not push good snapshots out.
# ---------------------------------------------------------------------------
echo ""
echo "(3) Retention: -INCOMPLETE directories do not count against the good ones"
rm -rf "$FAKE/store/backups"; mkdir -p "$FAKE/store/backups"
for i in 1 2 3; do
  d="$FAKE/store/backups/2026010${i}-000000-good${i}"; mkdir -p "$d"; touch -t "20260101010${i}" "$d"
done
for i in 1 2 3 4 5 6 7 8 9; do
  d="$FAKE/store/backups/2026020${i}-000000-bad${i}-INCOMPLETE"; mkdir -p "$d"; touch -t "2026020${i}0000" "$d"
done
OUT="$(PATH="$NOCLI" /usr/bin/env bash "$FAKE/scripts/pre-modify-backup.sh" retention 2>&1)"; RC=$?
assert_eq "the run succeeds" "0" "$RC"
GOOD_LEFT="$(ls -1d "$FAKE/store/backups"/*-good*/ 2>/dev/null | wc -l | tr -d ' ')"
assert_eq "all 3 older good snapshots survive 9 incomplete ones" "3" "$GOOD_LEFT"
INC_LEFT="$(ls -1d "$FAKE/store/backups"/*-INCOMPLETE/ 2>/dev/null | wc -l | tr -d ' ')"
assert_eq "incomplete directories are capped apart (the newest 3 are kept)" "3" "$INC_LEFT"

# ---------------------------------------------------------------------------
# 4. A snapshot file without a sum makes the run INCOMPLETE on its own.
# ---------------------------------------------------------------------------
echo ""
echo "(4) No checksum tool and no personal scripts: the snapshot manifest alone decides"
# An empty explicit list keeps PERSONAL_NOSUM at 0, so only the snapshot manifest
# can turn this run into exit 3.
NOSUMPATH="$TMP/bin-nosum"
curated_path "$NOSUMPATH" bash python3 find mv tr cp mkdir grep cut date du ls tail rm dirname basename git wc sed awk head sort uname
if PATH="$NOSUMPATH" command -v sha256sum >/dev/null 2>&1 || PATH="$NOSUMPATH" command -v shasum >/dev/null 2>&1; then
  fail "the curated PATH really has no checksum tool"
else
  pass "the curated PATH really has no checksum tool"
fi
rm -rf "$FAKE/store/backups"; : > "$FAKE/store/personal-scripts.txt"
OUT="$(PATH="$NOSUMPATH" /usr/bin/env bash "$FAKE/scripts/pre-modify-backup.sh" nosum 2>&1)"; RC=$?
SNAP="$(ls -1dt "$FAKE/store/backups"/*/ 2>/dev/null | head -1)"
assert_eq "exit 3" "3" "$RC"
assert_contains "it says the backup is INCOMPLETE" "$OUT" "backup INCOMPLETE"
assert_not_contains "no personal-scripts warning, the list is empty" "$OUT" "personal-scripts: WARNING"
assert_contains "the snapshot manifest records NOSUM" "$(cat "${SNAP}MANIFEST.sha256" 2>/dev/null)" "NOSUM  "

# ---------------------------------------------------------------------------
# 5. A run that fails its manifest check prunes nothing.
# ---------------------------------------------------------------------------
echo ""
echo "(5) A failed run prunes no older snapshot"
# No `find` on PATH: the database snapshot succeeds, but the snapshot manifest
# comes out empty, so the run must stop at "the manifest does not list
# claudeclaw.db". Rotation used to run BEFORE that check, and pruned good backups
# on a run that then failed.
rm -rf "$FAKE/store/backups"; mkdir -p "$FAKE/store/backups"
for i in 01 02 03 04 05 06 07 08 09 10 11; do
  d="$FAKE/store/backups/202601${i}-000000-old${i}"; mkdir -p "$d"; touch -t "202601${i}0000" "$d"
done
NOFIND="$TMP/bin-nofind"
curated_path "$NOFIND" bash python3 mv tr cp mkdir grep cut date du ls tail rm dirname basename git wc sed awk head sort uname sha256sum shasum
if PATH="$NOFIND" command -v find >/dev/null 2>&1; then
  fail "the curated PATH really has no find"
else
  pass "the curated PATH really has no find"
fi
OUT="$(PATH="$NOFIND" /usr/bin/env bash "$FAKE/scripts/pre-modify-backup.sh" nofind 2>&1)"; RC=$?
assert_eq "exit 1: the manifest cannot list the database" "1" "$RC"
assert_contains "it says why" "$OUT" "the manifest does not list claudeclaw.db"
OLD_LEFT="$(ls -1d "$FAKE/store/backups"/*-old*/ 2>/dev/null | wc -l | tr -d ' ')"
assert_eq "all 11 older snapshots are still there" "11" "$OLD_LEFT"

echo ""
echo "==================================="
echo "PASS: $PASS  FAIL: $FAIL"
[ "$FAIL" = 0 ] || exit 1
