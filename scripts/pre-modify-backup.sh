#!/usr/bin/env bash
# Pre-modification backup.
#
# RULE: before ANY system modification (schema change,
# feature deploy, config edit that the live service reads), snapshot the
# critical mutable state first. Code is already safe in git; this captures the
# state git does NOT track: the SQLite DB, the vault, and runtime config.
#
# Rolling retention: keep the newest $KEEP snapshots, prune the rest.
# Usage: scripts/pre-modify-backup.sh [label]
#   label is an optional short tag for the snapshot dir (e.g. "openrouter-ui").
set -uo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
STORE="$REPO/store"
BKDIR="$STORE/backups"
KEEP=10
LABEL="${1:-manual}"
TS="$(date +%Y%m%d-%H%M%S)"
DEST="$BKDIR/${TS}-${LABEL}"

mkdir -p "$DEST"

# Consistent SQLite snapshot (NOT a raw cp -- the live dashboard may be mid-write).
#
# Done through python3's sqlite3 module and its Connection.backup API, NOT the
# sqlite3 CLI. The CLI is not an install dependency (the documented list is
# ffmpeg, git, tmux, lsof, curl, python3, pipx, unzip), so on a normal install the
# old `sqlite3 ... ".backup ..."` line was a command that is not there -- and its
# `|| echo WARNING` turned that into a warning, after which the script carried on
# and printed "backup ok" with exit 0. Measured on 2026-09-14: this install's
# backup directory had NEVER received a snapshot, so the failure had never been
# seen -- it would have surfaced on the FIRST real use, which is exactly when the
# backup is needed. python3 IS an install dependency and its backup API takes the
# same consistent, live-safe snapshot the CLI dot-command did. (Card 252ab361.)
snapshot_db() {
  python3 - "$1" "$2" <<'PYBACKUP'
import sqlite3, sys
src, dst = sys.argv[1], sys.argv[2]
# Read-only source URI: a backup must never be able to write to the live file.
con = sqlite3.connect(f"file:{src}?mode=ro", uri=True)
try:
    out = sqlite3.connect(dst)
    try:
        con.backup(out)
    finally:
        out.close()
finally:
    con.close()
PYBACKUP
}

if [ -f "$STORE/claudeclaw.db" ]; then
  if snapshot_db "$STORE/claudeclaw.db" "$DEST/claudeclaw.db"; then
    echo "  db: consistent snapshot ok"
  else
    # LOUD and NON-ZERO. The whole point of this script is the recovery path; a
    # backup without the database that reports success is worse than no backup,
    # because it is believed. The directory is renamed so the failure cannot be
    # mistaken for a usable snapshot later, when someone is looking for one.
    echo "pre-modify-backup: FATAL -- the database snapshot FAILED." >&2
    echo "pre-modify-backup: this backup is NOT usable for recovery." >&2
    echo "pre-modify-backup: source: $STORE/claudeclaw.db" >&2
    mv "$DEST" "${DEST}-INCOMPLETE" 2>/dev/null \
      && echo "pre-modify-backup: directory marked ${DEST}-INCOMPLETE" >&2
    exit 1
  fi
fi

# Small critical state git does not track. Explicit list -- store/ also holds
# ~1.7G of large/regenerable data we deliberately do NOT copy.
for f in vault.json .vault-key .dashboard-token \
         openrouter-models.json agents-desired.json autonomy-config.json \
         auto-restart.json command-task-health.json schedule-last-run.json; do
  [ -f "$STORE/$f" ] && cp -p "$STORE/$f" "$DEST/" 2>/dev/null
done

# Personal, untracked scripts -- the ones git will NOT bring back.
#
# These hold install-specific data (chat ids, absolute home paths, account-bound
# token refreshers), so they are deliberately never pushed upstream -- which
# means git can never restore them, and this folder is the ONLY copy. On
# 2026-07-26 a branch switch silently deleted pre-modify-backup.sh itself (it
# lived only on a feature branch); nothing errored, it was simply gone.
#
# WHICH files count as personal is per-install, so the list is data, not code:
# store/personal-scripts.txt, one repo-relative path per line (# comments and
# blank lines ignored). With no such file we fall back to every untracked,
# executable script git already knows nothing about -- which is exactly the set
# at risk. Either way the manifest makes the post-update check possible: compare
# the live tree against personal-scripts/MANIFEST.txt after any update or
# branch switch.
PERSONAL_DIR="$DEST/personal-scripts"
PERSONAL_LIST="$STORE/personal-scripts.txt"
mkdir -p "$PERSONAL_DIR"
: > "$PERSONAL_DIR/MANIFEST.txt"
PERSONAL_MISSING=0
PERSONAL_SAVED=0

if [ -f "$PERSONAL_LIST" ]; then
  PERSONAL_FILES="$(grep -vE '^\s*(#|$)' "$PERSONAL_LIST")"
else
  # Untracked files under scripts/ are by definition the ones git cannot restore.
  PERSONAL_FILES="$(git -C "$REPO" ls-files --others --exclude-standard -- scripts/ 2>/dev/null)"
fi

for rel in $PERSONAL_FILES; do
  if [ -f "$REPO/$rel" ]; then
    mkdir -p "$PERSONAL_DIR/$(dirname "$rel")"
    cp -p "$REPO/$rel" "$PERSONAL_DIR/$rel" 2>/dev/null
    printf '%s  %s\n' "$(sha256sum "$REPO/$rel" | cut -d' ' -f1)" "$rel" >> "$PERSONAL_DIR/MANIFEST.txt"
    PERSONAL_SAVED=$((PERSONAL_SAVED + 1))
  else
    # Only reachable via an explicit list: a named file that is already gone is
    # the exact loss this backup exists to catch, so say so loudly.
    printf 'MISSING  %s\n' "$rel" >> "$PERSONAL_DIR/MANIFEST.txt"
    PERSONAL_MISSING=$((PERSONAL_MISSING + 1))
  fi
done
if [ "$PERSONAL_MISSING" -gt 0 ]; then
  echo "  personal-scripts: WARNING $PERSONAL_MISSING file(s) ALREADY MISSING from the live tree ($PERSONAL_SAVED saved)"
else
  echo "  personal-scripts: $PERSONAL_SAVED saved + manifest"
fi

# Code rollback reference (the code itself lives in git).
git -C "$REPO" rev-parse HEAD          > "$DEST/git-HEAD.txt"    2>/dev/null
git -C "$REPO" branch --show-current   > "$DEST/git-branch.txt"  2>/dev/null

# Rotate: keep the newest $KEEP snapshot dirs, remove older ones.
if [ -d "$BKDIR" ]; then
  ls -1dt "$BKDIR"/*/ 2>/dev/null | tail -n +$((KEEP + 1)) | while read -r old; do
    rm -rf "$old" && echo "  pruned old snapshot: $(basename "$old")"
  done
fi

# Manifest for the WHOLE snapshot: one line per file with size and sha256.
# Without it, "does this backup contain the database?" is a directory walk and a
# judgement call; with it, it is one grep. That question is not hypothetical: the
# defect this script just stopped having produced exactly that situation, and the
# only way to answer it for an OLD backup is a record written at the time.
MANIFEST="$DEST/MANIFEST.sha256"
(
  cd "$DEST" || exit 1
  find . -type f ! -name 'MANIFEST.sha256' -printf '%P\n' 2>/dev/null | LC_ALL=C sort | while read -r rel; do
    printf '%s  %s  %s\n' "$(sha256sum "$rel" | cut -d' ' -f1)" "$(stat -c %s "$rel")" "$rel"
  done
) > "$MANIFEST"

# The database is the reason this script exists, so its presence is asserted, not
# assumed: a manifest that silently lacks it would be the same quiet failure in a
# new place.
if [ -f "$STORE/claudeclaw.db" ] && ! grep -q '  claudeclaw\.db$' "$MANIFEST"; then
  echo "pre-modify-backup: FATAL -- the manifest does not list claudeclaw.db." >&2
  mv "$DEST" "${DEST}-INCOMPLETE" 2>/dev/null
  exit 1
fi

SIZE="$(du -sh "$DEST" 2>/dev/null | cut -f1)"
echo "  manifest: $(wc -l < "$MANIFEST") file(s) listed with size + sha256"
echo "backup ok: $DEST ($SIZE, retain newest $KEEP)"
