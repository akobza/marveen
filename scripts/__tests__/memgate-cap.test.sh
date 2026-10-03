#!/usr/bin/env bash
# fe983f3d -- fleet-memory-gate.sh: the agent cap follows the configured fleet, and the cap alert is per agent.
#
# Measured before the change: the cap was MARVEEN_AGENT_CAP with a fixed default of 12, so every fleet growth needed a
# manual raise, and until it came the cap blocked starts the dashboard itself wanted; and the cap alert shared one
# "band:epoch" stamp with a 600 s cooldown, so the same agent was alerted every ten minutes, and any other band's alert
# reset the cooldown.
#
# HERMETIC: the gate runs from a sandbox install tree (its INSTALL_DIR, so its store and agents dir are the sandbox's),
# with a fake tmux (the running count), a curl stub that RECORDS instead of sending, a fake token and chat id. The real
# store, token and chat are never read, and nothing leaves the machine.
#
# Run:  bash scripts/__tests__/memgate-cap.test.sh      (MEMGATE_SCRIPT=<file> runs a mutant instead of the gate)
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
GATE_SRC="${MEMGATE_SCRIPT:-$ROOT/scripts/fleet-memory-gate.sh}"
FAILS=0; N=0
check() { N=$((N+1)); if [ "$2" = "0" ]; then echo "PASS  $1"; else echo "FAIL  $1${3:+  -- $3}"; FAILS=$((FAILS+1)); fi; }

SANDBOX="$(mktemp -d "${TMPDIR:-/tmp}/memgate-cap.XXXXXX")"
trap 'rm -rf "$SANDBOX"' EXIT
TREE="$SANDBOX/tree"
mkdir -p "$TREE/scripts/lib" "$TREE/store" "$TREE/agents" "$SANDBOX/chan" "$SANDBOX/bin"
cp "$GATE_SRC" "$TREE/scripts/fleet-memory-gate.sh"
cp "$ROOT/scripts/lib/send-telegram.sh" "$TREE/scripts/lib/send-telegram.sh"
GATE="$TREE/scripts/fleet-memory-gate.sh"
SDIR="$TREE/store"
printf 'TELEGRAM_BOT_TOKEN=123456:TESZT-TOKEN\n' > "$SANDBOX/chan/.env"
# 25% used: the band is "ok", so a block can only come from the cap.
printf 'MemTotal:       16000000 kB\nMemAvailable:   12000000 kB\n' > "$SANDBOX/meminfo"
cat > "$SANDBOX/bin/curl" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$@" >> "${STUB_ARGS_FILE:-/dev/null}"
echo '{"ok":true,"result":{"message_id":1}}'
STUB
cat > "$SANDBOX/bin/tmux" <<'STUB'
#!/usr/bin/env bash
[ "${1:-}" = "ls" ] && cat "${STUB_RUNNING_FILE:-/dev/null}"
exit 0
STUB
chmod +x "$SANDBOX/bin/curl" "$SANDBOX/bin/tmux"

running() { : > "$SANDBOX/running"; local i; for ((i = 1; i <= $1; i++)); do echo "agent-r$i: 1 windows" >> "$SANDBOX/running"; done; }
desired() { python3 -c 'import json,sys; print(json.dumps(["a%d" % i for i in range(int(sys.argv[1]))]))' "$1" > "$SDIR/agents-desired.json"; }

# gate <agent> [VAR=value ...] [-- <extra gate args>] -> rc; stdout in out.txt, the gate's log in log.txt, the curl calls
# in args.txt
gate() {
  local agent="$1"; shift
  local vars=() extra=()
  while [ $# -gt 0 ]; do [ "$1" = "--" ] && { shift; extra=("$@"); break; }; vars+=("$1"); shift; done
  : > "$SANDBOX/args.txt"
  env -u MARVEEN_AGENT_CAP -u MARVEEN_MEM_GATE_OBSERVE -u MARVEEN_MEM_GATE_DISABLE -u MARVEEN_CORE_AGENTS \
      -u MARVEEN_CAP_ALERT_WINDOW -u MARVEEN_STORE -u TELEGRAM_STATE_DIR \
      PATH="$SANDBOX/bin:$PATH" STUB_ARGS_FILE="$SANDBOX/args.txt" STUB_RUNNING_FILE="$SANDBOX/running" \
      MEMGATE_PROC_MEMINFO="$SANDBOX/meminfo" TELEGRAM_ENV="$SANDBOX/chan/.env" TELEGRAM_ACCESS="$SANDBOX/chan/access.json" \
      MARVEEN_ALERT_CHAT_ID=999888777 "${vars[@]}" \
      bash "$GATE" --check "$agent" "${extra[@]}" > "$SANDBOX/out.txt" 2> "$SANDBOX/log.txt"
  echo $?
}
sent() { grep -q 'chat_id=999888777' "$SANDBOX/args.txt" 2>/dev/null && echo 0 || echo 1; }
not_sent() { [ "$(sent)" = "1" ] && echo 0 || echo 1; }
cap_is() { grep -qF "cap=$1" "$SANDBOX/out.txt" && echo 0 || echo 1; }

# 1-2. the cap is the size of the dashboard's reconcile target (agents-desired.json in the store dir)
desired 5; running 4
check "1 the cap is the desired set (5): 4 running, a start is allowed" \
  "$([ "$(gate a1)" = 0 ] && [ "$(cap_is '5(desired)')" = 0 ] && echo 0 || echo 1)" "$(cat "$SANDBOX/out.txt")"
running 5
check "2 at 5/5 a non-core start is blocked by the cap, and the alert goes (positive control of the send)" \
  "$([ "$(gate a1)" = 10 ] && grep -q 'cap 5/5' "$SANDBOX/out.txt" && [ "$(sent)" = 0 ] && echo 0 || echo 1)" \
  "out: $(cat "$SANDBOX/out.txt") | log: $(cat "$SANDBOX/log.txt")"

# 3. MARVEEN_AGENT_CAP overrides
rm -rf "$SDIR/.fleet-memgate-cap.d"
check "3 MARVEEN_AGENT_CAP=8 wins over the desired set: 5 running, allowed, the source is env" \
  "$([ "$(gate a1 MARVEEN_AGENT_CAP=8)" = 0 ] && [ "$(cap_is '8(env)')" = 0 ] && echo 0 || echo 1)" "$(cat "$SANDBOX/out.txt")"

# 4. the desired file is read the way the dashboard reads it (getDesiredAgents): the distinct strings of a JSON list
printf '["a","a","b",5,null]' > "$SDIR/agents-desired.json"
r_dup="$(gate a1)"; c_dup="$(cap_is '2(desired)')"
printf '{"agents":["a","b","c"]}' > "$SDIR/agents-desired.json"
r_obj="$(gate a1)"; c_obj="$(cap_is '12(default)')"
printf '[]' > "$SDIR/agents-desired.json"
r_empty="$(gate a1)"; c_empty="$(cap_is '12(default)')"
check "4 desired file: a duplicate and the non-strings do not count (2), an object or an empty list is no desired set" \
  "$([ "$c_dup$c_obj$c_empty" = 000 ] && echo 0 || echo 1)" "dup rc=$r_dup cap2=$c_dup | object rc=$r_obj default=$c_obj | empty rc=$r_empty default=$c_empty"

# 5-6. without the desired file: every agent directory, the dashboard-hidden ones included, else 12
rm -f "$SDIR/agents-desired.json"
mkdir -p "$TREE/agents/x1" "$TREE/agents/x2" "$TREE/agents/x3" "$TREE/agents/rejtett"
touch "$TREE/agents/rejtett/.hidden-from-dashboard" "$TREE/agents/nem-konyvtar"
running 3
r3="$(gate x1)"; c3="$(cap_is '4(configured)')"
running 4
r4="$(gate x1)"
check "5 no desired file: the cap is all 4 agent dirs (the hidden one counts, a plain file does not): 3 allowed, 4 blocks" \
  "$([ "$r3$c3$r4" = 0010 ] && echo 0 || echo 1)" "3 running rc=$r3 cap4=$c3 | 4 running rc=$r4 | $(cat "$SANDBOX/out.txt")"
rm -rf "$TREE/agents"; mkdir -p "$TREE/agents"
check "6 neither source: the old default 12" \
  "$([ "$(gate x1)" = 0 ] && [ "$(cap_is '12(default)')" = 0 ] && echo 0 || echo 1)" "$(cat "$SANDBOX/out.txt")"

# 7. both sources: the larger wins -- a new agent has its directory before it is in the desired set
desired 3; mkdir -p "$TREE/agents/a0" "$TREE/agents/a1" "$TREE/agents/a2" "$TREE/agents/a3"; running 3
r_new="$(gate a3)"; c_new="$(cap_is '4(configured)')"
rm -rf "$TREE/agents/a2" "$TREE/agents/a3"
r_des="$(gate a1)"; c_des="$(cap_is '3(desired)')"
rm -rf "$TREE/agents"; mkdir -p "$TREE/agents"
check "7 both sources, the larger wins: 4 dirs over 3 desired let a new agent's first start through, 3 desired over 2 dirs block at 3" \
  "$([ "$r_new$c_new$r_des$c_des" = 00100 ] && echo 0 || echo 1)" "new rc=$r_new cap4=$c_new | desired rc=$r_des cap3=$c_des"

# 8-11. the cap alert, per agent
desired 2; running 2; rm -rf "$SDIR/.fleet-memgate-cap.d" "$SDIR/.fleet-memgate-alert"
gate a1 >/dev/null; first="$(sent)"
gate a1 >/dev/null; again="$(not_sent)"
gate a2 >/dev/null; other="$(sent)"
check "8 the first block of a1 alerts, the next a1 block within the window does not, and a2's first block does" \
  "$([ "$first$again$other" = 000 ] && echo 0 || echo 1)" "a1 first=$first a1 again(not sent)=$again a2=$other"
check "9 the cap alerts never touch the shared band stamp" \
  "$([ -e "$SDIR/.fleet-memgate-alert" ] && echo 1 || echo 0)"
running 1; gate a1 >/dev/null; running 2
check "10 an allowed start of a1 ends its blocked state: its next block alerts at once" \
  "$([ "$(gate a1)" = 10 ] && [ "$(sent)" = 0 ] && echo 0 || echo 1)" "log: $(cat "$SANDBOX/log.txt")"
# the window, with stamps written at a known age (no sleeping on a loaded host)
echo "cap:$(( $(date +%s) - 10 ))" > "$SDIR/.fleet-memgate-cap.d/a2"
gate a2 MARVEEN_CAP_ALERT_WINDOW=60 >/dev/null; within="$(not_sent)"
echo "cap:$(( $(date +%s) - 120 ))" > "$SDIR/.fleet-memgate-cap.d/a2"
gate a2 MARVEEN_CAP_ALERT_WINDOW=60 >/dev/null; after="$(sent)"
check "11 within the window the same agent is not alerted, after it again" \
  "$([ "$within$after" = 00 ] && echo 0 || echo 1)" "within(not sent)=$within after=$after"

# 12. --dry-run: no send, no stamp change
rm -rf "$SDIR/.fleet-memgate-cap.d"
rc="$(gate a1 -- --dry-run)"
check "12 --dry-run blocks the same way but sends nothing and writes no stamp" \
  "$([ "$rc" = 10 ] && [ "$(not_sent)" = 0 ] && [ ! -e "$SDIR/.fleet-memgate-cap.d/a1" ] && grep -q 'block non-core (cap 2/2)' "$SANDBOX/out.txt" && echo 0 || echo 1)" \
  "rc=$rc out: $(cat "$SANDBOX/out.txt")"

echo "---"
echo "$((N - FAILS))/$N passed"
[ "$FAILS" = 0 ]
