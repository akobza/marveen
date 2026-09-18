# Makes `sqlite3` work in a suite without the CLI being installed (card 252ab361).
#
# Source this near the top of a suite, BEFORE the first `sqlite3` call:
#   . "$(dirname "$0")/lib/sqlite3-shim.sh"
#
# The call sites stay exactly as they were -- this defines a shell function with
# the same name, so `sqlite3 "$DB" "SELECT ..."` and the heredoc form both keep
# working. If the real CLI IS present, it is used, so nothing changes on a machine
# that has it; the shim is the fallback, not a replacement.
if ! command -v sqlite3 >/dev/null 2>&1; then
  sqlite3() {
    node "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/sqlite3-cli.mjs" "$@"
  }
fi
