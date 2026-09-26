#!/usr/bin/env bash
# agent-msg.sh -- reliable inter-agent message send for the Marveen fleet.
#
# WHY: the common `curl -s ... >/dev/null && echo sent` pattern is DANGEROUS -- curl exits 0 even when
# the server REJECTED the request (401/400/5xx), producing a SILENT send failure: the recipient never
# gets the message and two agents can wait on each other forever. The /api/messages router itself is
# fine (HTTP 200 + a message id); the bug is that the SENDER never checks the result. This helper checks
# the HTTP status AND the returned message id, and RETRIES on failure. A message counts as sent only
# when an id came back.
#
# Usage:  bash scripts/agent-msg.sh <from> <to> "<content>"
#   content: plain text (quotes / newlines OK) -- the body is built with json.dumps (no quoting pitfalls).
#   large / multi-line content may come from STDIN when the 3rd arg is "-":
#     echo "<long text>" | bash scripts/agent-msg.sh <from> <to> -
# Output: success -> "OK id=<n>"; failure -> "FAIL <reason>" + a line in store/agent-msg-failures.log, exit 1.
#
# LOG FORMAT, store/agent-msg-failures.log (tab-separated, one line per failure):
#   <YYYY-MM-DD HH:MM:SS>  FAIL  from=<a>  to=<b>  url=<endpoint>  http=<code>  resp=<first 200 bytes>
# CHANGED 2026-09: the `url=` field is NEW. It was added together with the
# env-overridable base URL, because from that point a failure can mean "posted to
# the wrong address" and the old line could not distinguish that from a dead
# server. A parser written against the pre-2026-09 format sees one extra field;
# parse by the `key=` names, not by position.
# Env:
#   MARVEEN_API_BASE   full base URL, e.g. https://marveen.example.com (overrides host+port)
#   MARVEEN_WEB_PORT   port for the default localhost base (default 3420)
#   MARVEEN_TOKEN_FILE bearer token file (default <repo>/store/.dashboard-token)
# MEASURED 2026-09-13: a remote agent runs this helper OUTSIDE this repo, where localhost:3420
# does not exist -- it had to fall back to raw curl, i.e. exactly the unchecked pattern this file was
# written to eliminate. A hardcoded base URL silently un-installs the helper for everyone not on this
# VM, so the base is env-overridable and the two endpoints stay ONE script.
set -uo pipefail

# base dir = the parent of this script's dir (scripts/..), so it works from any CWD / any install
BASE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${MARVEEN_WEB_PORT:-3420}"
API_BASE="${MARVEEN_API_BASE:-http://localhost:${PORT}}"
API_BASE="${API_BASE%/}"
TOKEN_FILE="${MARVEEN_TOKEN_FILE:-$BASE/store/.dashboard-token}"
URL="${API_BASE}/api/messages"
LOG="$BASE/store/agent-msg-failures.log"

FROM="${1:?from required}"; TO="${2:?to required}"; C="${3:?content required (or - for STDIN)}"
[ "$C" = "-" ] && C="$(cat)"
[ -r "$TOKEN_FILE" ] || { echo "FAIL: no token file at $TOKEN_FILE"; exit 1; }
TOKEN="$(cat "$TOKEN_FILE")"

BODY="$(FROM="$FROM" TO="$TO" C="$C" python3 -c 'import json,os; print(json.dumps({"from":os.environ["FROM"],"to":os.environ["TO"],"content":os.environ["C"]}))')"

# ---- receiver queue depth on the success line (card a509fdf6) ----------------
# The id proves the row was CREATED, not that it was DELIVERED. Measured during
# a live outage on 2026-09-06: an urgent message to a busy agent sat in the queue
# for 14 minutes while the sender read a bare "OK id=..." and assumed it had
# arrived; the receiver's queue was 81 deep with a 3h31m head, so the realistic
# delivery estimate was ~7 hours. Nothing in the old output could have said so.
# The measurement is NOT invented here -- /api/messages/backlog already reports
# per-agent depth and the age of the oldest entry.
QUEUE_LOUD_COUNT=5      # chosen, not measured -- see the card comment
QUEUE_LOUD_AGE_SEC=600  # 10 min: past this, "sent" and "will be read" diverge
queue_note() {
  local to="$1" resp code json
  resp="$(curl -s -H "Authorization: Bearer $TOKEN" -w $'\n%{http_code}' \
          "${API_BASE}/api/messages/backlog" 2>/dev/null || true)"
  code="$(printf '%s' "$resp" | tail -n1)"
  json="$(printf '%s' "$resp" | sed '$d')"
  if [ "$code" != "200" ]; then
    # The note's OWN failure has to be visible. A silent `|| true` here would
    # rebuild the exact blindness this line exists to remove -- the sender would
    # again read a clean "OK" and learn nothing about the queue.
    printf ' [SORHOSSZ NEM MERHETO: /api/messages/backlog http=%s]' "${code:-?}"
    return 0
  fi
  printf '%s' "$json" | TO="$to" LOUD_N="$QUEUE_LOUD_COUNT" LOUD_A="$QUEUE_LOUD_AGE_SEC" python3 -c '
import sys, os, json
try:
    rows = json.load(sys.stdin)
except Exception:
    sys.stdout.write(" [SORHOSSZ NEM MERHETO: a backlog valasza nem JSON]")
    sys.exit(0)
to = os.environ["TO"]
row = next((r for r in rows if r.get("agent") == to), None)
if row is None:
    sys.exit(0)  # nothing queued for this receiver -- nothing to report
n = int(row.get("pending") or 0)
age = int(row.get("oldestAgeSeconds") or 0)
h, m = age // 3600, (age % 3600) // 60
age_s = ("%dh%02dm" % (h, m)) if h else ("%dm" % m)
if n >= int(os.environ["LOUD_N"]) or age >= int(os.environ["LOUD_A"]):
    sys.stdout.write(" (FIGYELEM: %d uzenet all a(z) %s soraban, a legregebbi %s ota"
                     " -- EZ NEM FOG HAMAR MEGERKEZNI. Surgos esetben menj kezzel.)" % (n, to, age_s))
else:
    sys.stdout.write(" (sor: %d, legregebbi %s)" % (n, age_s))
'
}

attempt=0; max=3; CODE=""; ID=""
while [ "$attempt" -lt "$max" ]; do
  attempt=$((attempt+1))
  RESP="$(curl -s -X POST "$URL" -H "Content-Type: application/json" -H "Authorization: Bearer $TOKEN" -d "$BODY" -w $'\n%{http_code}' 2>/dev/null || true)"
  CODE="$(printf '%s' "$RESP" | tail -n1)"
  JSON="$(printf '%s' "$RESP" | sed '$d')"
  # An id ALONE is not delivery. The router answers 200 WITH an id even when the
  # recipient is not running, and says so in a separate `warning` field
  # (src/web/routes/messages.ts) whose text spells out that such a message is
  # LOST rather than queued. This helper read only the id, so it printed
  # "OK id=..." for a message that never arrived -- the exact failure the header
  # above says it exists to prevent, one field further in. The exit code stays 0
  # on purpose: the row really was accepted, so this is not a send failure. It
  # just must not be silent.
  read -r ID WARN <<EOF
$(printf '%s' "$JSON" | python3 -c 'import sys,json
try:
  d=json.load(sys.stdin)
  if not isinstance(d,dict): d={}
except Exception:
  d={}
w=" ".join(str(d.get("warning","")).split())
print((d.get("id","") or "-"), w)' 2>/dev/null)
EOF
  [ "$ID" = "-" ] && ID=""
  if { [ "$CODE" = "200" ] || [ "$CODE" = "201" ]; } && [ -n "$ID" ]; then
    if [ -n "${WARN:-}" ]; then
      echo "OK id=$ID  WARNING: $WARN" >&2
      echo "OK id=$ID (warning)$(queue_note "$TO")"
    else
      echo "OK id=$ID$(queue_note "$TO")"
    fi
    exit 0
  fi
  sleep 1
done
echo "FAIL from=$FROM to=$TO url=$URL http=${CODE:-?} id='$ID' (after $max tries)"
printf '%s\tFAIL\tfrom=%s\tto=%s\turl=%s\thttp=%s\tresp=%s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$FROM" "$TO" "$URL" "${CODE:-?}" "$(printf '%s' "${JSON:-}" | head -c 200)" >> "$LOG" 2>/dev/null || true
exit 1
