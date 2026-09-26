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
#   large / multi-line content may come from STDIN when the 3rd arg is "-", from a QUOTED heredoc
#   (a backtick or $(...) inside double quotes runs in YOUR shell before this script sees the text):
#     cat > msg.txt <<'MSG'
#     <long text>
#     MSG
#     bash scripts/agent-msg.sh <from> <to> - < msg.txt
# Output: success -> "OK id=<n>"; failure -> "FAIL <reason>" + a line in store/agent-msg-failures.log, exit 1;
#   refused by the content gate (see below) -> "REFUSED: <reason>", nothing sent, nothing logged, exit 2.
#   refused by the homoglyph gate (see below) -> nothing sent, exit 3; the homoglyph checker itself failed -> exit 4.
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
#   MARVEEN_HOMOGLYPH_BIN  the checker (default <repo>/scripts/lib/homoglyph.py)
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
SRC=argv
if [ "$C" = "-" ]; then C="$(cat)"; SRC=stdin; fi
[ -r "$TOKEN_FILE" ] || { echo "FAIL: no token file at $TOKEN_FILE"; exit 1; }
TOKEN="$(cat "$TOKEN_FILE")"

# --- Homoglyph gate, BEFORE the payload is built (MSGGATE924) --------------
# On the RAW text, not on the JSON: json.dumps escapes a Cyrillic letter into
# \uXXXX, and a checker reading the encoded body would be looking at a string
# where the problem is no longer visible as a letter. The gate has to see what
# the sender typed.
#
# WHY IT IS HERE AND NOT IN EACH AGENT'S TOOLBOX. Measured 2026-09-24 across
# three agents: two had built this guard for themselves, independently, because
# both had been bitten by it; the third had no guard at all. And no CLAUDE.md
# prescribes those private wrappers -- they all name THIS helper. The result was
# predictable in hindsight: the agent who WROTE such a wrapper spent a whole day
# calling this script directly, with the check run beside it in a separate
# command instead of in front of it. One message went out contaminated while the
# checker printed "NEM KULDOM EL" next to it. The rule that needs remembering is
# not a rule; it has to sit in the path of the action.
#
# FAIL-OPEN ON A MISSING CHECKER, AND LOUDLY -- a deliberate exception to the
# repo's usual fail-closed stance for gates (see .git/hooks/pre-commit.d). This
# helper is the fleet's mandated message route: blocking every inter-agent
# message on an install whose lib file is absent would be a far worse failure
# than the one being prevented, and it would be a NEW failure, not today's. A
# missing checker is exactly today's state, so the honest behaviour is to send
# and say so. Contaminated text with the checker PRESENT is refused, which is
# where the closed direction belongs.
# Overridable so the suite can measure the missing-checker branch too.
HG="${MARVEEN_HOMOGLYPH_BIN:-$BASE/scripts/lib/homoglyph.py}"
if [ -r "$HG" ] && command -v python3 >/dev/null 2>&1; then
  # THE CHECKER IS A VERDICT, NOT A FILTER: what goes out is the text the
  # sender typed, never the checker's stdout. Measured in the 2026-09-24 review
  # of #1541: a checker that exits 0 with EMPTY stdout made this helper send an
  # empty message and report OK -- a broken tool silently replaced the message
  # instead of failing. The exit code is the only thing read here.
  printf '%s' "$C" | python3 "$HG" >/dev/null
  HG_RC=$?
  case "$HG_RC" in
    0) : ;;
    # 3 is the checker's one documented refusal code; anything else is the
    # CHECKER failing, not the text. They must not share a message: "refused"
    # sends the sender to rewrite a word that may be perfectly fine, while a
    # crashed checker is an unmeasured send and the operator's problem.
    3) echo "FAIL: homoglyph gate refused the message; nothing was sent." >&2
       exit 3 ;;
    *) echo "FAIL: homoglyph checker CRASHED (rc=$HG_RC) at $HG; nothing was sent." >&2
       echo "  This is not a verdict on the text -- fix or unset MARVEEN_HOMOGLYPH_BIN." >&2
       exit 4 ;;
  esac
else
  echo "WARN: homoglyph checker not found at $HG -- sending UNCHECKED." >&2
fi
# ---- outgoing content gate (card d49acca6) -----------------------------------
# ORDER, fixed (card d49acca6 on top of #1541): the homoglyph gate above runs FIRST,
# this content gate second. A text that trips both is refused by the homoglyph gate
# (exit 3) and this gate never runs; either refusal sends nothing, so the order only
# decides which reason the sender reads first. A test pins it.
# Measured 2026-09-05: a double-quoted body with a backtick in it did not lose a
# word -- the CALLER's shell ran the command and pasted its OUTPUT into the
# message: 38 420 characters, a whole work-tree diff and a settings file, into a
# durable queue that travels with backups. The expansion happens before this
# script runs, so it cannot be seen here; its result can. Three checks on that
# result, none of them resting on the sender remembering a rule:
#   - a body over ARGV_MAX characters that came on the command line is refused:
#     that is the shape an expanded $(...) produces, and a long body belongs in
#     a file on STDIN anyway;
#   - a secret-shaped value is refused: the shapes of SECRET_PATTERNS in
#     src/security/secret-gate.ts (a test pins the parity), and the dashboard
#     token's own value;
#   - a command-output signature (diff header, hunk header, index line) warns
#     and still sends: a message may quote a diff on purpose.
# A long base64 run is NOT refused: measured on 39 029 queued messages it matched
# 26, every one legitimate (SSH fingerprints and public keys, paths carrying a
# timestamp, a Message-Id) and none a secret.
content_gate() {
  C="$C" SRC="$SRC" TOKEN="$TOKEN" python3 - <<'GATE_PY'
import os, re
c = os.environ.get('C', '')
tok = os.environ.get('TOKEN', '').strip()
ARGV_MAX = 8000
out = []
if os.environ.get('SRC') == 'argv' and len(c) > ARGV_MAX:
    out.append('REFUSE %d characters on the command line (limit %d), the shape an expanded $(...) or backtick'
               ' produces. Send it from a file: bash scripts/agent-msg.sh <from> <to> - < <file>' % (len(c), ARGV_MAX))
SECRET_PATTERNS = [
    ('private key block', r'-----BEGIN [A-Z ]*PRIVATE KEY-----'),
    ('Stripe secret/restricted key', r'\b(sk|rk)_(live|test)_[A-Za-z0-9]{16,}'),
    ('ElevenLabs key header', r'(?i)xi-api-key["\'\s:=]+[A-Za-z0-9_-]{16,}'),
    ('ElevenLabs key literal', r'\bsk_[a-f0-9]{32,}'),
    ('bearer token literal', r'\bBearer\s+[A-Za-z0-9_-]{24,}\.?[A-Za-z0-9_.-]*'),
    ('JWT', r'\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}'),
    ('GitHub token', r'\bgh[pousr]_[A-Za-z0-9]{30,}'),
    ('Slack token', r'\bxox[baprs]-[A-Za-z0-9-]{10,}'),
    ('OpenAI project key', r'\bsk-proj-[A-Za-z0-9_-]{20,}'),
    ('generic vendor secret key (sk_ or sk-)', r'\bsk[-_][A-Za-z0-9_-]{24,}'),
    ('AWS access key id', r'\bAKIA[0-9A-Z]{16}\b'),
    ('Supabase service_role JWT hint', r'service_role["\'\s:=]+eyJ'),
    ('Supabase personal access token', r'\bsbp_[0-9a-f]{40}\b'),
]
for name, rx in SECRET_PATTERNS:
    if re.search(rx, c):
        out.append('REFUSE a secret-shaped value in the body (%s)' % name)
if len(tok) >= 16 and tok in c:
    out.append("REFUSE the dashboard token's value is in the body")
for name, rx in (('a diff header', r'(?m)^diff --git '), ('a hunk header', r'(?m)^@@ .* @@'),
                 ('an index line', r'(?m)^index [0-9a-f]{7,}\.\.[0-9a-f]{7,}')):
    if re.search(rx, c):
        out.append('WARN the body carries command output (%s)' % name)
print('\n'.join(out))
GATE_PY
}
GATE="$(content_gate)" || { echo "FAIL: the content gate could not run; nothing was sent"; exit 1; }
REFUSALS=""; WARNINGS=""
while IFS= read -r line; do
  case "$line" in
    "REFUSE "*) REFUSALS="${REFUSALS}REFUSED: ${line#REFUSE }"$'\n' ;;
    "WARN "*)   WARNINGS="${WARNINGS}WARNING: ${line#WARN }"$'\n' ;;
  esac
done <<EOF
$GATE
EOF
if [ -n "$REFUSALS" ]; then
  printf '%s' "$REFUSALS"
  echo "REFUSED from=$FROM to=$TO: nothing was sent."
  # The warnings too: a diff signature next to a length refusal tells the
  # sender WHAT their shell pasted in.
  [ -n "$WARNINGS" ] && printf '%s' "$WARNINGS" >&2
  exit 2
fi
[ -n "$WARNINGS" ] && printf '%s' "$WARNINGS" | sed 's/$/; sent anyway -- check it is the text you meant/' >&2

BODY="$(FROM="$FROM" TO="$TO" C="$C" python3 -c 'import json,os; print(json.dumps({"from":os.environ["FROM"],"to":os.environ["TO"],"content":os.environ["C"]}))')"

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
      echo "OK id=$ID (warning)"
    else
      echo "OK id=$ID"
    fi
    exit 0
  fi
  sleep 1
done
echo "FAIL from=$FROM to=$TO url=$URL http=${CODE:-?} id='$ID' (after $max tries)"
printf '%s\tFAIL\tfrom=%s\tto=%s\turl=%s\thttp=%s\tresp=%s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$FROM" "$TO" "$URL" "${CODE:-?}" "$(printf '%s' "${JSON:-}" | head -c 200)" >> "$LOG" 2>/dev/null || true
exit 1
