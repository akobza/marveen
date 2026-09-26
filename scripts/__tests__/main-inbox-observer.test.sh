#!/bin/bash
# Contract tests for scripts/main-inbox-observer.sh -- the OUT-OF-PROCESS
# observer of the main agent's pending inbox.
#
# Why the observer exists:
# the main agent's queue is the one delivery path nothing watches from outside
# the dashboard process. message-router.ts:539 `continue`s for MAIN before the
# abandon window, so a main-agent row is never failed and never raises a
# handoff-failure alert; inbox-nudge-watcher.ts is the only thing that reads
# getPendingMessages(MAIN_AGENT_ID), and graphify puts it inside web.ts ->
# index.ts, i.e. the very process whose death is the failure mode.
#
# Driven through `main-inbox-observer.sh --check <db>`, which evaluates a
# database and exits BEFORE any alert, stamp or state write -- so these run
# from fixtures with no live install, no bot token and no Telegram.
# Exit codes: 0 = ok, 1 = stalled, 2 = unknown (unreadable queue).
#
# Run: bash scripts/__tests__/main-inbox-observer.test.sh

set -u

PASS=0; FAIL=0
pass() { PASS=$((PASS + 1)); echo "  PASS: $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL: $1 -- got: $2"; }

INSTALL_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
# Overridable so the suite can be pointed at a deliberately-broken copy to
# confirm it actually fails on the bug (a green test that cannot go red is
# worse than no test -- it certifies health it never checked).
OBSERVER="${OBSERVER_BIN:-$INSTALL_DIR/scripts/main-inbox-observer.sh}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

if [ ! -f "$OBSERVER" ]; then
  echo "FAIL: observer not found at $OBSERVER"
  exit 1
fi

SCHEMA="CREATE TABLE agent_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_agent TEXT NOT NULL,
  to_agent TEXT NOT NULL,
  content TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  result TEXT,
  created_at INTEGER NOT NULL,
  delivered_at INTEGER,
  completed_at INTEGER
);"

# $1 = fixture name -> prints the db path. Creates an empty queue table.
make_db() {
  local db="$TMP/$1.db"
  rm -f "$db"
  sqlite3 "$db" "$SCHEMA"
  echo "$db"
}

# $1 = db, $2 = to_agent, $3 = status, $4 = age in seconds
add_msg() {
  sqlite3 "$1" "INSERT INTO agent_messages (from_agent,to_agent,content,status,created_at)
                VALUES ('sender-a','$2','proba','$3', CAST(strftime('%s','now') AS INTEGER) - $4);"
}

# $1 = label, $2 = db, $3 = expected verdict, $4 = expected exit code
expect_verdict() {
  local out rc verdict
  out=$(MAIN_AGENT_ID=marveen bash "$OBSERVER" --check "$2" 2>&1); rc=$?
  verdict=$(printf '%s' "$out" | sed -n 's/.*verdict=\([a-z]*\).*/\1/p')
  if [ "$verdict" = "$3" ] && [ "$rc" = "$4" ]; then
    pass "$1"
  else
    fail "$1" "verdict=$verdict rc=$rc (expected $3/$4) out: $out"
  fi
}

echo "main-inbox-observer contract tests"
echo "==================================="
echo ""

# ---------------------------------------------------------------------------
# (a) Empty check FIRST: an all-green suite that also passes on an empty queue
#     proves nothing. This case pins what "ok" means before anything else.
# ---------------------------------------------------------------------------
echo "(a) Empty and healthy queues read as ok"
DB_EMPTY="$(make_db empty)"
expect_verdict "empty queue is ok" "$DB_EMPTY" ok 0

DB_FRESH="$(make_db fresh)"
add_msg "$DB_FRESH" marveen pending 300
expect_verdict "a 5-minute-old pending row is ok (the in-process nudge still has time)" "$DB_FRESH" ok 0
echo ""

# ---------------------------------------------------------------------------
# (b) The bug itself: an aged pending row addressed to the main agent.
# ---------------------------------------------------------------------------
echo "(b) The stall this observer reports"
DB_STALL="$(make_db stall)"
add_msg "$DB_STALL" marveen pending 3600
expect_verdict "a 60-minute-old pending row to MAIN is stalled" "$DB_STALL" stalled 1

out=$(MAIN_AGENT_ID=marveen bash "$OBSERVER" --check "$DB_STALL" 2>&1)
case "$out" in
  *pending=1*) pass "the check line reports the pending count" ;;
  *) fail "the check line reports the pending count" "$out" ;;
esac
age=$(printf '%s' "$out" | sed -n 's/.*oldest_age_s=\([0-9]*\).*/\1/p')
if [ -n "$age" ] && [ "$age" -ge 3600 ] && [ "$age" -lt 3700 ]; then
  pass "the check line reports the age of the OLDEST row"
else
  fail "the check line reports the age of the OLDEST row" "$out"
fi

DB_TWO="$(make_db two)"
add_msg "$DB_TWO" marveen pending 3600
add_msg "$DB_TWO" marveen pending 60
out=$(MAIN_AGENT_ID=marveen bash "$OBSERVER" --check "$DB_TWO" 2>&1)
age=$(printf '%s' "$out" | sed -n 's/.*oldest_age_s=\([0-9]*\).*/\1/p')
if [ -n "$age" ] && [ "$age" -ge 3600 ]; then
  pass "the oldest row decides, not the newest"
else
  fail "the oldest row decides, not the newest" "$out"
fi
echo ""

# ---------------------------------------------------------------------------
# (c) POSITIVE CONTROL: the stalled verdict must come from the age comparison,
#     not from a constant. Raise the threshold above the fixture's age and the
#     SAME database has to read ok -- otherwise (b) proves nothing.
# ---------------------------------------------------------------------------
echo "(c) Positive control on the threshold"
out=$(MAIN_AGENT_ID=marveen MAIN_INBOX_STALL_SECONDS=999999 bash "$OBSERVER" --check "$DB_STALL" 2>&1); rc=$?
if printf '%s' "$out" | grep -q 'verdict=ok' && [ "$rc" = 0 ]; then
  pass "raising the threshold turns the same stalled db green (the age comparison is live)"
else
  fail "raising the threshold turns the same stalled db green" "rc=$rc out: $out"
fi
out=$(MAIN_AGENT_ID=marveen MAIN_INBOX_STALL_SECONDS=60 bash "$OBSERVER" --check "$DB_FRESH" 2>&1); rc=$?
if printf '%s' "$out" | grep -q 'verdict=stalled' && [ "$rc" = 1 ]; then
  pass "lowering the threshold turns the same healthy db red"
else
  fail "lowering the threshold turns the same healthy db red" "rc=$rc out: $out"
fi
echo ""

# ---------------------------------------------------------------------------
# (d) Scope: only PENDING rows, only to_agent = MAIN, exact match.
# ---------------------------------------------------------------------------
echo "(d) Scope of the predicate"
DB_OTHER="$(make_db other)"
add_msg "$DB_OTHER" sub-agent pending 7200
expect_verdict "an aged row to a SUB-agent is not this observer's business" "$DB_OTHER" ok 0

DB_FED="$(make_db fed)"
add_msg "$DB_FED" "peer/marveen" pending 7200
expect_verdict "a federated OUTBOUND row (peer/marveen) does not count as main-agent mail" "$DB_FED" ok 0

for st in delivered done failed; do
  DB_ST="$(make_db "st_$st")"
  add_msg "$DB_ST" marveen "$st" 7200
  expect_verdict "an aged $st row is not pending" "$DB_ST" ok 0
done

DB_ID="$(make_db otherid)"
add_msg "$DB_ID" other-main pending 7200
out=$(MAIN_AGENT_ID=other-main bash "$OBSERVER" --check "$DB_ID" 2>&1); rc=$?
if printf '%s' "$out" | grep -q 'verdict=stalled' && [ "$rc" = 1 ]; then
  pass "the main agent id is configuration, not the hardcoded 'marveen'"
else
  fail "the main agent id is configuration, not the hardcoded 'marveen'" "rc=$rc out: $out"
fi
echo ""

# ---------------------------------------------------------------------------
# (e) An unreadable queue must NEVER read as "nothing pending". That silent
#     zero is the failure this whole card is about, one layer down.
# ---------------------------------------------------------------------------
echo "(e) Unreadable queue is unknown, not ok"
expect_verdict "a missing database file is unknown" "$TMP/nincs-ilyen.db" unknown 2

DB_NOTABLE="$TMP/notable.db"
sqlite3 "$DB_NOTABLE" "CREATE TABLE valami (x INTEGER);"
expect_verdict "a database without agent_messages is unknown" "$DB_NOTABLE" unknown 2

DB_JUNK="$TMP/junk.db"
printf 'nem ez egy sqlite fajl' > "$DB_JUNK"
expect_verdict "a corrupt database file is unknown" "$DB_JUNK" unknown 2
echo ""

# ---------------------------------------------------------------------------
# (f) Full run: liveness stamp, alert, cooldown. Runs from a fixture install
#     dir with a stubbed alert (dry run), so nothing leaves the machine.
# ---------------------------------------------------------------------------
echo "(f) Full run: liveness stamp and alert cooldown"
FIX="$TMP/install"
mkdir -p "$FIX/scripts" "$FIX/store"
cp "$OBSERVER" "$FIX/scripts/main-inbox-observer.sh"
printf 'MAIN_AGENT_ID=marveen\n' > "$FIX/.env"
OBS="$FIX/scripts/main-inbox-observer.sh"
FIXDB="$FIX/store/claudeclaw.db"
sqlite3 "$FIXDB" "$SCHEMA"

MAIN_INBOX_OBSERVER_ALERT_DRYRUN=1 bash "$OBS" >"$TMP/run1.out" 2>&1
if [ -f "$FIX/store/.main-inbox-observer" ]; then
  pass "a healthy run still stamps its own liveness (the observer must be observable)"
else
  fail "a healthy run still stamps its own liveness" "$(cat "$TMP/run1.out")"
fi
if grep -q 'ALERT_DRYRUN' "$TMP/run1.out"; then
  fail "a healthy run stays silent" "$(cat "$TMP/run1.out")"
else
  pass "a healthy run stays silent"
fi

rm -f "$FIX/store/.main-inbox-observer"
sqlite3 "$FIXDB" "INSERT INTO agent_messages (from_agent,to_agent,content,status,created_at)
  VALUES ('sender-a','marveen','proba','pending', CAST(strftime('%s','now') AS INTEGER) - 3600);"
MAIN_INBOX_OBSERVER_ALERT_DRYRUN=1 bash "$OBS" >"$TMP/run2.out" 2>&1
if grep -q 'ALERT_DRYRUN' "$TMP/run2.out"; then
  pass "a stalled queue alerts the owner"
else
  fail "a stalled queue alerts the owner" "$(cat "$TMP/run2.out")"
fi
if grep -qE 'ALERT_DRYRUN.*(1 |60 min|3[0-9]{3})' "$TMP/run2.out"; then
  pass "the alert names the count and the age"
else
  fail "the alert names the count and the age" "$(cat "$TMP/run2.out")"
fi

MAIN_INBOX_OBSERVER_ALERT_DRYRUN=1 bash "$OBS" >"$TMP/run3.out" 2>&1
if grep -q 'ALERT_DRYRUN' "$TMP/run3.out"; then
  fail "the second tick is held by the cooldown" "$(cat "$TMP/run3.out")"
else
  pass "the second tick is held by the cooldown (no per-tick spam)"
fi

# A drained queue clears the spell, so the NEXT stall alerts again instead of
# sitting out the rest of the cooldown hour.
sqlite3 "$FIXDB" "UPDATE agent_messages SET status='done';"
MAIN_INBOX_OBSERVER_ALERT_DRYRUN=1 bash "$OBS" >/dev/null 2>&1
sqlite3 "$FIXDB" "INSERT INTO agent_messages (from_agent,to_agent,content,status,created_at)
  VALUES ('sender-a','marveen','masodik','pending', CAST(strftime('%s','now') AS INTEGER) - 3600);"
MAIN_INBOX_OBSERVER_ALERT_DRYRUN=1 bash "$OBS" >"$TMP/run4.out" 2>&1
if grep -q 'ALERT_DRYRUN' "$TMP/run4.out"; then
  pass "a NEW stall after the queue drained alerts again"
else
  fail "a NEW stall after the queue drained alerts again" "$(cat "$TMP/run4.out")"
fi

rm -f "$FIXDB" "$FIX/store/.main-inbox-observer"
MAIN_INBOX_OBSERVER_ALERT_DRYRUN=1 bash "$OBS" >"$TMP/run5.out" 2>&1
if [ -f "$FIX/store/.main-inbox-observer" ]; then
  pass "an unreadable queue still stamps liveness (silence must not look like health)"
else
  fail "an unreadable queue still stamps liveness" "$(cat "$TMP/run5.out")"
fi
echo ""

# ---------------------------------------------------------------------------
# (g) The unit that makes it run. A probe nobody schedules is a measured defect
#     in this tree already: scripts/watchdog.sh documents a cron line in its
#     header and nothing installs it. So the installers ship WITH the script, and
#     the two platforms must agree on the period -- a drifting pair is a fix on
#     one OS and a gap on the other.
# ---------------------------------------------------------------------------
echo "(g) Installers"
INSTALLER="$INSTALL_DIR/scripts/install-main-inbox-observer.sh"
SVC="$INSTALL_DIR/scripts/systemd/main-inbox-observer.service"
TMR="$INSTALL_DIR/scripts/systemd/main-inbox-observer.timer"

if [ -f "$INSTALLER" ]; then pass "the launchd installer ships with the observer"; else fail "the launchd installer ships with the observer" "missing $INSTALLER"; fi
if [ -f "$SVC" ] && [ -f "$TMR" ]; then pass "the systemd twin ships too (the fix is not macOS-only)"; else fail "the systemd twin ships too" "missing $SVC or $TMR"; fi

if [ -f "$INSTALLER" ]; then
  FAKEHOME="$TMP/home"
  mkdir -p "$FAKEHOME"
  PLIST_OUT="$FAKEHOME/Library/LaunchAgents/com.marveen.main-inbox-observer.plist"
  # The installer refuses to run anywhere but Darwin (it writes a launchd plist,
  # and a plist nothing reads plus a zero exit is worse than a failure). That
  # guard is the right behaviour AND it would make this block untestable on a
  # Linux CI runner -- measured: the suite went red there while passing on a
  # mac, which is the same "true on my machine" trap the guard exists to stop.
  # So the platform is stubbed here instead of asserted: what this block is
  # about is the CONTENT of the plist. The guard itself has its own assertions
  # in scripts/__tests__/main-inbox-observer-install.test.sh.
  UNAME_STUB="$TMP/uname-darwin"
  mkdir -p "$UNAME_STUB"
  printf '#!/bin/bash\necho Darwin\n' > "$UNAME_STUB/uname"
  chmod +x "$UNAME_STUB/uname"
  if PATH="$UNAME_STUB:$PATH" HOME="$FAKEHOME" bash "$INSTALLER" >"$TMP/install.out" 2>&1 && [ -f "$PLIST_OUT" ]; then
    pass "the installer writes a plist without loading it"
  else
    fail "the installer writes a plist without loading it" "$(cat "$TMP/install.out")"
  fi
  if [ -f "$PLIST_OUT" ]; then
    if command -v plutil >/dev/null 2>&1; then
      if plutil -lint "$PLIST_OUT" >/dev/null 2>&1; then
        pass "the generated plist is valid (launchd would accept it)"
      else
        fail "the generated plist is valid" "$(plutil -lint "$PLIST_OUT" 2>&1)"
      fi
    else
      pass "plutil absent -- plist validity not checked on this host (skipped, not asserted)"
    fi
    if grep -q "scripts/main-inbox-observer.sh" "$PLIST_OUT"; then
      pass "the plist runs THIS observer"
    else
      fail "the plist runs THIS observer" "$(cat "$PLIST_OUT")"
    fi
    LAUNCHD_SEC=$(sed -n '/StartInterval/{n;s/.*<integer>\([0-9]*\)<\/integer>.*/\1/p;}' "$PLIST_OUT")
    if [ "$LAUNCHD_SEC" = 300 ]; then
      pass "the launchd period is 300s (six ticks inside the 30-min threshold)"
    else
      fail "the launchd period is 300s" "got $LAUNCHD_SEC"
    fi
    # The one assertion that catches drift: both platforms must fire at the
    # same cadence, or the observer is a different instrument per OS.
    SYSTEMD_MIN=$(sed -n 's/^OnUnitActiveSec=\([0-9]*\)min.*/\1/p' "$TMR" 2>/dev/null | head -1)
    if [ -n "$LAUNCHD_SEC" ] && [ -n "$SYSTEMD_MIN" ] && [ "$LAUNCHD_SEC" = $(( SYSTEMD_MIN * 60 )) ]; then
      pass "launchd and systemd agree on the period (${LAUNCHD_SEC}s)"
    else
      fail "launchd and systemd agree on the period" "launchd=${LAUNCHD_SEC}s systemd=${SYSTEMD_MIN}min"
    fi
  fi
fi
if [ -f "$SVC" ] && grep -q "scripts/main-inbox-observer.sh" "$SVC"; then
  pass "the systemd service runs THIS observer"
else
  fail "the systemd service runs THIS observer" "$(cat "$SVC" 2>&1)"
fi
echo ""

# ---------------------------------------------------------------------------
# (h) The WAL case, which is the ONLY case that matters: the queue runs in WAL
#     mode, and SQLite removes the -wal/-shm pair when the last connection
#     closes. So a stopped dashboard leaves a WAL-mode file with NO -shm, and a
#     `-readonly` open cannot create one: it fails with "unable to open database
#     file (14)". The observer then reported verdict=unknown precisely when the
#     dashboard was down -- loud, and false, in the one situation it exists for.
#     The fix tries -readonly first and falls back to query_only=ON.
# ---------------------------------------------------------------------------
echo "(h) A WAL database with no -shm (the stopped-dashboard shape)"
# MEASURED, and the reason this section branches: whether `-readonly` fails on
# this shape is ENVIRONMENT-DEPENDENT. It fails on the macOS host where the
# defect was reported and reproduced (sqlite3 3.51.0), and it does NOT fail on
# the Linux CI runner, where the same fixture opens read-only without a -shm.
# The fix is correct either way -- where the open succeeds the fallback never
# runs -- but the CONTROL below can only assert where the problem exists.

WALDB="$TMP/wal.db"
rm -f "$WALDB" "$WALDB-wal" "$WALDB-shm"
sqlite3 "$WALDB" "PRAGMA journal_mode=wal;" >/dev/null
sqlite3 "$WALDB" "$SCHEMA"
sqlite3 "$WALDB" "INSERT INTO agent_messages (from_agent,to_agent,content,status,created_at)
  VALUES ('sender-a','marveen','proba','pending', CAST(strftime('%s','now') AS INTEGER) - 3600);"
# The shape under test: journal_mode is wal, and neither side file is present.
rm -f "$WALDB-wal" "$WALDB-shm"
MODE="$(sqlite3 "$WALDB" 'PRAGMA journal_mode;' 2>/dev/null)"
rm -f "$WALDB-wal" "$WALDB-shm"
if [ "$MODE" = "wal" ]; then
  pass "the fixture really is a WAL database (otherwise this section proves nothing)"
else
  fail "the fixture really is a WAL database" "journal_mode=$MODE"
fi

OUT="$(MAIN_AGENT_ID=marveen bash "$OBSERVER" --check "$WALDB" 2>&1)"; RC=$?
case "$OUT" in
  *"verdict=stalled"*) [ "$RC" = 1 ] && pass "a stalled row is SEEN on a WAL db with no -shm" \
                         || fail "a stalled row is seen on a WAL db with no -shm" "rc=$RC out: $OUT" ;;
  *) fail "a stalled row is SEEN on a WAL db with no -shm" "rc=$RC out: $OUT" ;;
esac

# NEGATIVE CONTROL -- and it has to ASK THE ENVIRONMENT first, because the
# defect itself is environment-dependent. Measured on a Linux CI runner: the
# same fixture opens fine with `-readonly`, so there the fallback has nothing
# to fall back from and a control demanding rc=2 fails on a perfectly good
# build. The control therefore runs where the problem EXISTS, and elsewhere is
# skipped WITH ITS REASON PRINTED -- a silent skip would be the measure quietly
# switching itself off, which is the failure this whole section is about.
rm -f "$WALDB-wal" "$WALDB-shm"
sqlite3 -readonly "$WALDB" "SELECT 1;" >/dev/null 2>&1
READONLY_RC=$?
rm -f "$WALDB-wal" "$WALDB-shm"
if [ "$READONLY_RC" = 0 ]; then
  pass "skipped: '-readonly' opens this fixture on this host (sqlite3 $(sqlite3 --version | awk '{print $1}')), so there is nothing to control against -- the defect is environment-dependent"
else
  PREFIX_OBS="$TMP/observer-without-fallback.sh"
  grep -v 'PRAGMA query_only=ON; \$sql' "$OBSERVER" > "$PREFIX_OBS"
  if [ "$(grep -c 'query_only=ON; \$sql' "$PREFIX_OBS")" = 0 ] && [ -s "$PREFIX_OBS" ]; then
    OUT="$(MAIN_AGENT_ID=marveen bash "$PREFIX_OBS" --check "$WALDB" 2>&1)"; RC=$?
    case "$OUT" in
      *"verdict=unknown"*) [ "$RC" = 2 ] && pass "NEGATIVE CONTROL: without the fallback the same file reads as unknown (rc=2)" \
                             || fail "NEGATIVE CONTROL: without the fallback the same file reads as unknown" "rc=$RC out: $OUT" ;;
      *) fail "NEGATIVE CONTROL: without the fallback the same file reads as unknown" "rc=$RC out: $OUT" ;;
    esac
  else
    fail "NEGATIVE CONTROL: the fallback line could be cut for the control run" "prefix script empty or unchanged"
  fi
fi

# The fallback opens the database without -readonly, so the other half of the
# promise needs measuring too: reading must not change the file or the rows.
rm -f "$WALDB-wal" "$WALDB-shm"
SUM_BEFORE="$(shasum -a 256 "$WALDB" | awk '{print $1}')"
ROWS_BEFORE="$(sqlite3 "$WALDB" 'SELECT COUNT(*) FROM agent_messages;')"
rm -f "$WALDB-wal" "$WALDB-shm"
MAIN_AGENT_ID=marveen bash "$OBSERVER" --check "$WALDB" >/dev/null 2>&1
SUM_AFTER="$(shasum -a 256 "$WALDB" | awk '{print $1}')"
ROWS_AFTER="$(sqlite3 "$WALDB" 'SELECT COUNT(*) FROM agent_messages;')"
if [ "$SUM_BEFORE" = "$SUM_AFTER" ] && [ "$ROWS_BEFORE" = "$ROWS_AFTER" ]; then
  pass "the read leaves the database byte-identical (the fallback still does not write)"
else
  fail "the read leaves the database byte-identical" "sum $SUM_BEFORE -> $SUM_AFTER, rows $ROWS_BEFORE -> $ROWS_AFTER"
fi

# And the ordinary case must not have regressed: a journal_mode=delete database
# still answers, through the -readonly path that works there.
DB_PLAIN="$(make_db walplain)"
add_msg "$DB_PLAIN" marveen pending 60
OUT="$(MAIN_AGENT_ID=marveen bash "$OBSERVER" --check "$DB_PLAIN" 2>&1)"; RC=$?
case "$OUT" in
  *"verdict=ok"*) [ "$RC" = 0 ] && pass "a non-WAL database still answers as before" \
                    || fail "a non-WAL database still answers as before" "rc=$RC out: $OUT" ;;
  *) fail "a non-WAL database still answers as before" "rc=$RC out: $OUT" ;;
esac
echo ""

# ---------------------------------------------------------------------------
# (i) A host WITHOUT the sqlite3 CLI -- the typical Linux install. The
#     installer's dependencies are ffmpeg, git, tmux, lsof, curl, python3, pipx
#     and unzip; sqlite3 is not among them. Measured live 2026-09-26: there
#     `sqlite3: command not found` vanished into 2>/dev/null, every tick read
#     verdict=unknown (51 in 4 hours) and the owner got an hourly false "cannot
#     READ the queue" alert. The observer now falls back to python3's stdlib
#     sqlite3. The fixtures are still BUILT with the CLI (full PATH); only the
#     observer runs under the stripped PATH.
# ---------------------------------------------------------------------------
echo "(i) No sqlite3 CLI on PATH: the python3 reader"
BASH_BIN="$(command -v bash)"
# $1 = dir, rest = tool names -> a PATH dir holding only those tools.
make_bin() {
  local dir="$1" t src; shift
  mkdir -p "$dir"
  for t in "$@"; do
    src="$(command -v "$t" 2>/dev/null)" || { echo "  (tool $t not found on this host)"; continue; }
    ln -sf "$src" "$dir/$t"
  done
}
BASE_TOOLS="date dirname cat grep head cut tr sed mkdir rm"
NOSQL="$TMP/bin-nosqlite3"
make_bin "$NOSQL" $BASE_TOOLS python3
NOREADER="$TMP/bin-noreader"
make_bin "$NOREADER" $BASE_TOOLS

# $1 = PATH dir, $2 = tool -> 0 if a FRESH shell on that PATH finds the tool.
# A fresh process on purpose: `PATH=x command -v` in this shell answers from
# the current PATH and the hash table, and says "found" for a tool that is gone.
on_path() { PATH="$1" "$BASH_BIN" -c 'command -v "$1"' _ "$2" >/dev/null 2>&1; }

# The control that makes this section mean anything: the stripped PATH really
# has no sqlite3, and really has python3.
if ! on_path "$NOSQL" sqlite3 && on_path "$NOSQL" python3; then
  pass "the stripped PATH has python3 and NO sqlite3 (otherwise this section proves nothing)"
else
  fail "the stripped PATH has python3 and NO sqlite3" "$(ls "$NOSQL")"
fi

# $1 = label, $2 = PATH dir, $3 = db, $4 = expected verdict, $5 = expected rc,
# $6 = expected reader
expect_on_path() {
  local out rc verdict reader
  out=$(PATH="$2" MAIN_AGENT_ID=marveen "$BASH_BIN" "$OBSERVER" --check "$3" 2>&1); rc=$?
  verdict=$(printf '%s' "$out" | sed -n 's/.*verdict=\([a-z]*\).*/\1/p')
  reader=$(printf '%s' "$out" | sed -n 's/.*reader=\([a-z0-9]*\).*/\1/p')
  if [ "$verdict" = "$4" ] && [ "$rc" = "$5" ] && [ "$reader" = "$6" ]; then
    pass "$1"
  else
    fail "$1" "verdict=$verdict rc=$rc reader=$reader (expected $4/$5/$6) out: $out"
  fi
}

expect_on_path "no sqlite3: an empty queue reads ok" "$NOSQL" "$DB_EMPTY" ok 0 python3
expect_on_path "no sqlite3: a 5-minute-old pending row reads ok" "$NOSQL" "$DB_FRESH" ok 0 python3
expect_on_path "no sqlite3: a 60-minute-old pending row reads STALLED (the discriminating input)" "$NOSQL" "$DB_STALL" stalled 1 python3
expect_on_path "no sqlite3: the predicate scope holds (aged row to a sub-agent is ok)" "$NOSQL" "$DB_OTHER" ok 0 python3

# Same numbers as the CLI, not just the same verdict: the python reader's
# output has to parse into the same count and oldest age.
CLI_OUT=$(MAIN_AGENT_ID=marveen bash "$OBSERVER" --check "$DB_TWO" 2>&1)
PY_OUT=$(PATH="$NOSQL" MAIN_AGENT_ID=marveen "$BASH_BIN" "$OBSERVER" --check "$DB_TWO" 2>&1)
CLI_P=$(printf '%s' "$CLI_OUT" | sed -n 's/.*pending=\([0-9]*\).*/\1/p')
PY_P=$(printf '%s' "$PY_OUT" | sed -n 's/.*pending=\([0-9]*\).*/\1/p')
CLI_A=$(printf '%s' "$CLI_OUT" | sed -n 's/.*oldest_age_s=\([0-9]*\).*/\1/p')
PY_A=$(printf '%s' "$PY_OUT" | sed -n 's/.*oldest_age_s=\([0-9]*\).*/\1/p')
if [ -n "$PY_P" ] && [ "$CLI_P" = "$PY_P" ] && [ -n "$PY_A" ] && [ $(( PY_A - CLI_A )) -ge 0 ] && [ $(( PY_A - CLI_A )) -le 2 ]; then
  pass "the python reader yields the same pending count ($PY_P) and oldest age as the CLI"
else
  fail "the python reader yields the same count and age as the CLI" "cli: $CLI_OUT / py: $PY_OUT"
fi

# Unreadable stays unknown -- the fallback must not turn an error into a zero.
expect_on_path "no sqlite3: a missing database file is unknown" "$NOSQL" "$TMP/nincs-py.db" unknown 2 python3
if [ -e "$TMP/nincs-py.db" ]; then
  fail "no sqlite3: reading a missing file does not create it" "$(ls -la "$TMP/nincs-py.db")"
else
  pass "no sqlite3: reading a missing file does not create it (mode=rw, never rwc)"
fi
expect_on_path "no sqlite3: a database without agent_messages is unknown" "$NOSQL" "$DB_NOTABLE" unknown 2 python3
expect_on_path "no sqlite3: a corrupt database file is unknown" "$NOSQL" "$DB_JUNK" unknown 2 python3

# The WAL-without-shm shape (see (h)): the stopped-dashboard case, which is the
# one the observer exists for, must also be read by the python reader.
rm -f "$WALDB-wal" "$WALDB-shm"
PY_RO_RC=$(python3 - "$WALDB" <<'PY'
import os, sqlite3, sys, urllib.parse
try:
    c = sqlite3.connect('file:' + urllib.parse.quote(os.path.abspath(sys.argv[1])) + '?mode=ro', uri=True)
    c.execute('SELECT 1 FROM agent_messages').fetchall(); c.close(); print(0)
except sqlite3.Error:
    print(1)
PY
)
rm -f "$WALDB-wal" "$WALDB-shm"
SUM_BEFORE="$(shasum -a 256 "$WALDB" | awk '{print $1}')"
expect_on_path "no sqlite3: a stalled row is SEEN on a WAL db with no -shm" "$NOSQL" "$WALDB" stalled 1 python3
SUM_AFTER="$(shasum -a 256 "$WALDB" | awk '{print $1}')"
if [ "$SUM_BEFORE" = "$SUM_AFTER" ]; then
  pass "no sqlite3: the WAL read leaves the database byte-identical"
else
  fail "no sqlite3: the WAL read leaves the database byte-identical" "sum $SUM_BEFORE -> $SUM_AFTER"
fi
rm -f "$WALDB-wal" "$WALDB-shm"
# Same environment-dependence as (h): the second (mode=rw + query_only) open can
# only be shown necessary where mode=ro fails on this shape.
if [ "$PY_RO_RC" = 0 ]; then
  pass "skipped: python mode=ro opens the no-shm WAL fixture on this host (sqlite $(python3 -c 'import sqlite3;print(sqlite3.sqlite_version)')), nothing to control against"
else
  NORW_OBS="$TMP/observer-without-py-rw.sh"
  sed "s/rows = run('rw', True)/raise/" "$OBSERVER" > "$NORW_OBS"
  if grep -q "run('rw', True)" "$NORW_OBS"; then
    fail "NEGATIVE CONTROL (python): the rw fallback could be cut" "sed did not apply"
  else
    OUT="$(PATH="$NOSQL" MAIN_AGENT_ID=marveen "$BASH_BIN" "$NORW_OBS" --check "$WALDB" 2>&1)"; RC=$?
    case "$OUT" in
      *"verdict=unknown"*) [ "$RC" = 2 ] && pass "NEGATIVE CONTROL (python): without the rw fallback the WAL file reads as unknown" \
                             || fail "NEGATIVE CONTROL (python): without the rw fallback" "rc=$RC out: $OUT" ;;
      *) fail "NEGATIVE CONTROL (python): without the rw fallback the WAL file reads as unknown" "rc=$RC out: $OUT" ;;
    esac
  fi
  rm -f "$WALDB-wal" "$WALDB-shm"
fi

# Neither reader: still unknown (never ok), but the alert must name the missing
# TOOL, not claim the database is unreadable.
if ! on_path "$NOREADER" python3 && ! on_path "$NOREADER" sqlite3; then
  expect_on_path "no sqlite3 and no python3: the verdict is unknown, not ok" "$NOREADER" "$DB_STALL" unknown 2 none
  FIX2="$TMP/install-noreader"
  mkdir -p "$FIX2/scripts/lib" "$FIX2/store"
  cp "$OBSERVER" "$FIX2/scripts/main-inbox-observer.sh"
  printf 'MAIN_AGENT_ID=marveen\n' > "$FIX2/.env"
  cp "$DB_STALL" "$FIX2/store/claudeclaw.db"
  PATH="$NOREADER" MAIN_INBOX_OBSERVER_ALERT_DRYRUN=1 "$BASH_BIN" "$FIX2/scripts/main-inbox-observer.sh" >"$TMP/run-noreader.out" 2>&1
  if grep -q 'ALERT_DRYRUN.*NO queue reader' "$TMP/run-noreader.out" && ! grep -q 'cannot READ the queue' "$TMP/run-noreader.out"; then
    pass "the alert names the missing reader tool instead of calling the queue unreadable"
  else
    fail "the alert names the missing reader tool" "$(cat "$TMP/run-noreader.out")"
  fi
  # Positive control on the wording: with a reader present, an unreadable file
  # still gets the "cannot READ" text.
  rm -f "$FIX2/store/claudeclaw.db" "$FIX2/store/.main-inbox-observer-alerted"
  PATH="$NOSQL" MAIN_INBOX_OBSERVER_ALERT_DRYRUN=1 "$BASH_BIN" "$FIX2/scripts/main-inbox-observer.sh" >"$TMP/run-unreadable.out" 2>&1
  if grep -q 'ALERT_DRYRUN.*cannot READ the queue' "$TMP/run-unreadable.out"; then
    pass "with a reader present, an unreadable queue keeps the 'cannot READ' alert"
  else
    fail "with a reader present, an unreadable queue keeps the 'cannot READ' alert" "$(cat "$TMP/run-unreadable.out")"
  fi
else
  fail "the no-reader PATH really lacks both readers" "$(ls "$NOREADER")"
fi
echo ""

echo "==================================="
echo "PASS: $PASS  FAIL: $FAIL"
[ "$FAIL" = 0 ] || exit 1
