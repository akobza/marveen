#!/bin/bash
# Contract tests for the archive verification of scripts/backup.sh (card a8a92d55).
# Run: bash scripts/__tests__/backup-verify-literal-paths.test.sh
#
# The defect, measured on 2026-09-24: the verification matched every manifest
# path against the `tar -t` listing with `grep -qE "^${want}(/|$)"`, so the path
# was a REGULAR EXPRESSION. Next.js route directories like `[id]` became a
# character class, and fourteen files that were in the archive (checked one by
# one against the listing) were reported MISSING: the 12:14Z backup of that day
# failed and was labelled "do NOT treat it as a good copy". The same run would
# have repeated every night while those directories existed.
#
# Also pinned: the failure alert went to a fixed agent id that does not exist
# on every install; it now goes to MAIN_AGENT_ID from the install's .env.
#
# Hermetic: a throwaway listing file, no archive and no backup run.

set -u

PASS=0; FAIL=0
pass() { PASS=$((PASS + 1)); echo "  PASS: $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL: $1"; }

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
# shellcheck source=../lib/archive-list-has.sh
. "$REPO/scripts/lib/archive-list-has.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
LIST="$TMP/listing.txt"

echo "backup.sh: literal archive verification"
echo "======================================="

cat > "$LIST" <<'EOF'
repo/agents/x/reports/r1/app/dashboard/leadek/[id]/szerzodes/uj/wizard-form.tsx
repo/app/(group)/a+b.ts
repo/app/q?/x{1}/y|z^$.ts
repo/store/
repo/store/claudeclaw.db
repo/storex/y
home/.claude/skills/
home/.claude/skills/a/SKILL.md
EOF

has()  { if archive_list_has "$LIST" "$2"; then pass "$1"; else fail "$1 (not found: $2)"; fi; }
hasnt() { if archive_list_has "$LIST" "$2"; then fail "$1 (unexpectedly found: $2)"; else pass "$1"; fi; }

# The measured case: a path with a route directory in brackets.
has "the [id] path from the 2026-09-24 failure is found" \
  "repo/agents/x/reports/r1/app/dashboard/leadek/[id]/szerzodes/uj/wizard-form.tsx"
# And the old regex form fails on exactly that line: this is what the test guards against.
want="repo/agents/x/reports/r1/app/dashboard/leadek/[id]/szerzodes/uj/wizard-form.tsx"
if grep -qE "^${want}(/|$)" "$LIST"; then fail "control: the old regex form should MISS the [id] path"; else pass "control: the old regex form misses the [id] path (the defect)"; fi

has "parentheses and plus are literal" "repo/app/(group)/a+b.ts"
has "? { } | ^ \$ are literal" 'repo/app/q?/x{1}/y|z^$.ts'
has "a directory named once matches its members" "repo/store"
has "a load-bearing file marker" "repo/store/claudeclaw.db"
has "a load-bearing directory marker" "home/.claude/skills"

hasnt "the character-class reading of [id] does not match" \
  "repo/agents/x/reports/r1/app/dashboard/leadek/i/szerzodes/uj/wizard-form.tsx"
hasnt "a prefix without a path boundary does not match" "repo/sto"
hasnt "store/x is not satisfied by store/xyz" "repo/store/claudeclaw.dbx"
hasnt "a longer file name does not match" "repo/app/(group)/a+b.tsx"
hasnt "an empty path never matches" ""
: > "$TMP/empty.txt"
if archive_list_has "$TMP/empty.txt" "repo/store"; then fail "an empty listing holds nothing"; else pass "an empty listing holds nothing"; fi

# Wiring: backup.sh must use the helper for the manifest and the markers, and
# must not carry a fixed alert recipient.
B="$REPO/scripts/backup.sh"
n=$(grep -c 'archive_list_has "${ARCHIVE_LIST}"' "$B")
if [ "$n" -eq 2 ]; then pass "backup.sh checks the manifest and the markers through the helper"; else fail "backup.sh helper call sites: expected 2, got $n"; fi
if grep -qE 'grep -qE "\^\$\{(want|marker)\}' "$B"; then fail "backup.sh still matches a manifest path as a regex"; else pass "no regex match on manifest paths is left"; fi
if grep -q 'agent-msg.sh" "${MAIN_AGENT_ID}" "${MAIN_AGENT_ID}"' "$B"; then pass "the alert is addressed to MAIN_AGENT_ID, not a fixed id"; else fail "the alert is not addressed to MAIN_AGENT_ID"; fi
if grep -q "grep -E '^MAIN_AGENT_ID=' \"\${REPO_ROOT}/.env\"" "$B"; then pass "the alert recipient comes from MAIN_AGENT_ID in .env"; else fail "the alert recipient is not read from .env"; fi

echo
echo "passed: $PASS, failed: $FAIL"
[ "$FAIL" -eq 0 ]
