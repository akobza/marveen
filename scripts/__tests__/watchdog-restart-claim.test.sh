#!/bin/bash
# Contract test for scripts/watchdog.sh: the dashboard restart LOG LINE must be
# bound to the OUTCOME, not to the attempt.
#
# Card c2f4e634. The success line was written unconditionally after the restart
# attempt, so a restart that brought nothing up still logged
# "Dashboard restarted (PID: ?)". A log that claims an action it did not
# achieve is worse than a silent one: the next reader stops looking.
#
# The script derives INSTALL_DIR from its own location, so the test runs a COPY
# inside a temp install root. It re-exports PATH with $HOME/.local/bin ahead of
# the system paths, so stubs placed there win over the real ps/npm/tmux.
#
# Run: bash scripts/__tests__/watchdog-restart-claim.test.sh

set -u

PASS=0; FAIL=0
pass() { PASS=$((PASS + 1)); echo "  PASS: $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL: $1"; }

SRC_DIR="$(cd "$(dirname "$0")/../.." && pwd)"

# $1 = what the stubbed `ps` reports AFTER the restart attempt:
#      "none"  -> nothing came up (failed restart)
#      "pid"   -> a process is there (successful restart)
run_watchdog() {
  local after="$1"
  local TMP; TMP="$(mktemp -d)"
  mkdir -p "$TMP/scripts" "$TMP/.local/bin" "$TMP/store" "$TMP/logs"
  cp "$SRC_DIR/scripts/watchdog.sh" "$TMP/scripts/watchdog.sh"
  chmod +x "$TMP/scripts/watchdog.sh"
  printf 'MAIN_AGENT_ID=testmain\n' > "$TMP/.env"

  # ps: first call (before restart) reports nothing -> the script takes the
  # restart path. The second call decides whether the restart "worked".
  cat > "$TMP/.local/bin/ps" <<PS
#!/bin/bash
if [ -f "$TMP/.ps-called" ]; then
  [ "$after" = "pid" ] && echo "user 4242 1 0 00:00 ?  00:00:00 node dist/index.js"
  exit 0
fi
touch "$TMP/.ps-called"
exit 0
PS
  for stub in npm sleep curl systemctl; do
    printf '#!/bin/bash\nexit 0\n' > "$TMP/.local/bin/$stub"
  done
  # tmux: every session "exists", so the rest of the script is a no-op and the
  # test measures only the dashboard branch.
  printf '#!/bin/bash\nexit 0\n' > "$TMP/.local/bin/tmux"
  chmod +x "$TMP/.local/bin/"*

  HOME="$TMP" timeout 60 bash "$TMP/scripts/watchdog.sh" >/dev/null 2>&1
  cat "$TMP/logs/watchdog.log" 2>/dev/null
  rm -rf "$TMP"
}

echo "watchdog dashboard-restart claim tests"
echo "====================================="

# NEGATIVE CONTROL -- the defect itself: nothing came up, so nothing may claim
# that something did.
OUT_FAILED="$(run_watchdog none)"
case "$OUT_FAILED" in
  *"Dashboard restarted"*) fail "a FAILED restart still logs 'Dashboard restarted': $OUT_FAILED" ;;
  *) pass "a failed restart does not claim success" ;;
esac
case "$OUT_FAILED" in
  *"down, restarting"*) pass "the attempt itself is still logged (the fix must not silence it)" ;;
  *) fail "the restart attempt is no longer logged at all: $OUT_FAILED" ;;
esac
# Case matters in a glob: the first version of this assertion looked for
# lowercase "failed" while the script logs "FAILED", so it stayed red against a
# correct fix. The matcher was wrong, not the code.
case "$OUT_FAILED" in
  *"restart FAILED"*) pass "the failure is stated, not merely omitted" ;;
  *) fail "a failed restart logs no failure line: $OUT_FAILED" ;;
esac

# POSITIVE CONTROL -- the success path must keep working, with the real pid.
OUT_OK="$(run_watchdog pid)"
case "$OUT_OK" in
  *"Dashboard restarted (PID: 4242)"*) pass "a successful restart logs success with the measured pid" ;;
  *) fail "a successful restart did not log the pid: $OUT_OK" ;;
esac

echo ""
echo "====================================="
TOTAL=$((PASS + FAIL))
echo "Results: $PASS/$TOTAL passed"
if [ "$FAIL" -gt 0 ]; then echo "FAILED: $FAIL tests"; exit 1; fi
echo "All tests passed."
