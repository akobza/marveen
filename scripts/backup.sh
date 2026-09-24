#!/usr/bin/env bash
# Marveen backup.
#
# The archive has two top-level groups so a restore is unambiguous about
# where each file belongs (see docs/MIGRATION.md):
#
#   repo/   -> extract under the project root (this repo)
#     store/**                 (the DB as a consistent snapshot, see below; minus models,
#                               virtualenvs, browser profile and logs)
#     .env                     (project root secrets)
#     scheduled-tasks.json     (legacy, if present)
#     assets/meetings/**       (meeting transcripts/memos)
#     agents/*/CLAUDE.md, SOUL.md, .mcp.json
#     agents/*/.claude/channels/{telegram,slack,discord}/.env, access.json
#     + EVERYTHING else under agents/ (kanban 2e37ef3a), minus the NAMED
#       exclusion classes in AGENTS_EXCLUDE_* below. agents/ is gitignored in
#       full, so agent-built tooling, agent-local skills and reports have no
#       other copy than this archive.
#     agents/*/.claude-config/projects/*/memory/**  (agents' file-based memory)
#     .channels-config/projects/*/memory/**         (main agent's file-based memory)
#     + UNCOVERED.txt at the archive root: every file under agents/ that
#       matched NO rule above, named (kanban d38813a0). Absence is loud;
#       inclusion stays a human decision (the repo is public, a wide take
#       could carry a secret).
#
#   home/   -> extract under $HOME
#     .claude/skills/**            (the self-built skill library)
#     .claude/scheduled-tasks/**   (file-based scheduled tasks: SKILL.md + config)
#     .claude/channels/*/.env      (MAIN orchestrator channel token)
#     .claude/channels/*/access.json, invites.json, approved/**  (pairing state)
#     Library/LaunchAgents/com.<MAIN_AGENT_ID>.*.plist (launchd jobs)
#
# Output: backups/claudeclaw-YYYYmmdd-HHMMSS.tar.gz
# Retention: keeps the most recent KEEP archives (default 14; BACKUP_KEEP or the
# install-local layer raises it, see below), prunes the rest.
#
# Restore (preserve modes so the 0600 token files stay private):
#   tar -xpzf <archive> -C /tmp/restore        # inspect first
#   then copy repo/* into the project root and home/* into $HOME.
# Full runbook: docs/MIGRATION.md.

set -euo pipefail

# The archive carries live secrets (store/.claude-oauth-token, .dashboard-token,
# the vault master key next to vault.json, every channel .env). It must be
# born 0600 -- not chmod-ed afterwards, because a crash between tar and chmod
# would leave a world-readable copy (BACKUPTITOK915: measured 0644 on the
# owner host under the default umask 022). umask 077 covers the archive, the
# backups/ dir, the staging dir and every temp file this script creates.
umask 077

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# Literal membership test for the archive verification below (card a8a92d55).
# shellcheck source=lib/archive-list-has.sh
. "${REPO_ROOT}/scripts/lib/archive-list-has.sh"

# --- Install-local layer (optional, untracked; kanban a95cada0) ---------------
# An install keeps its own retention and store/ exclusions here instead of
# editing this tracked script (update.sh refuses to run on a dirty tracked tree).
# Plain bash, sourced. It may set:
#   BACKUP_KEEP=<n>          archives to keep (default 14)
#   STORE_SKIP_ADD="a b"     extra store/ entries to leave out of the archive
#   STORE_SKIP_TAKE="a b"    default-skipped store/ entries to take anyway
#   BACKUP_DIR=<dir>         where archives are written and rotated
# It adjusts the default store/ skip list by name instead of replacing it, so a
# default skip added here later still applies on an install that has a layer.
# store/ is gitignored, so the file is never tracked, and the store/ rule below
# archives it: a restore brings the layer back together with the data.
# It is sourced before BACKUP_DIR, ARCHIVE and KEEP are resolved, so whatever it
# sets is honoured by the archive and the rotation alike.
BACKUP_LOCAL_RC="${BACKUP_LOCAL_RC:-${REPO_ROOT}/store/backup.local.rc}"
if [[ -f "${BACKUP_LOCAL_RC}" ]]; then
  # shellcheck source=/dev/null
  . "${BACKUP_LOCAL_RC}"
  echo "backup: local layer sourced: ${BACKUP_LOCAL_RC}"
fi

# Overridable so a test can build a throwaway archive without touching the
# real backup directory (and its retention sweep).
BACKUP_DIR="${BACKUP_DIR:-${REPO_ROOT}/backups}"
STAMP="$(date +%Y%m%d-%H%M%S)"
ARCHIVE="${BACKUP_DIR}/claudeclaw-${STAMP}.tar.gz"
# KEEP counts archives, not days, so a day of manual runs can prune a day of
# history. An install raises it with BACKUP_KEEP (environment or the local layer
# above); an age-based rule would be the real fix.
KEEP="${BACKUP_KEEP:-14}"
# A zero, non-numeric or oversized KEEP would make the rotation at the end delete
# every archive, this run's included: the rotation counts in bash arithmetic,
# where 2^64 wraps to 0. Refuse before anything is written; 1..9999 is plenty.
if ! [[ "${KEEP}" =~ ^[1-9][0-9]{0,3}$ ]]; then
  echo "backup: ERROR -- KEEP must be an integer from 1 to 9999, got '${KEEP}'" >&2
  exit 2
fi

mkdir -p "${BACKUP_DIR}"
cd "${REPO_ROOT}"

# Checkpoint the WAL into the main DB file.
#
# This used to shell out to the `sqlite3` CLI and skip the checkpoint entirely
# when that CLI was missing -- the `|| true` guarded a command that never ran.
# `sqlite3` is NOT installed on a stock Linux box (measured on an install
# 2026-09-04), so the checkpoint never happened and the archive captured a live
# .db plus a 4 MB -wal written seconds apart. A restore from such a pair is not
# guaranteed to be intact.
#
# python3 carries an sqlite3 module in its standard library, so it is available
# wherever this project already requires python3 -- no new dependency.
#
# The checkpoint alone is still not a consistency guarantee (a write can land
# between it and the copy); the authoritative fix is the VACUUM INTO snapshot
# further down. DB_SNAPSHOT_STATUS carries the outcome to the end of the run,
# because a backup that degrades silently is worse than one that fails loudly.
DB_SNAPSHOT_STATUS="no-database"
if [[ -f store/claudeclaw.db ]]; then
  DB_SNAPSHOT_STATUS="degraded:checkpoint-failed"
  if python3 - store/claudeclaw.db <<'PYCHK' >/dev/null 2>&1
import sqlite3, sys
con = sqlite3.connect(sys.argv[1], timeout=30)
con.execute("PRAGMA wal_checkpoint(TRUNCATE)")
con.close()
PYCHK
  then
    DB_SNAPSHOT_STATUS="checkpointed"
  else
    echo "backup: WARNING -- WAL checkpoint failed (python3 sqlite3)." >&2
  fi
fi

# --- Build the two path lists (each relative to its own base). -------------
# tar refuses missing entries, which would fail the whole backup on a fresh
# machine (no agents yet) -- so we only list paths that actually exist.
REPOLIST="$(mktemp -t claudeclaw-repo.XXXXXX)"
HOMELIST="$(mktemp -t claudeclaw-home.XXXXXX)"
MANIFEST="$(mktemp -t claudeclaw-manifest.XXXXXX)"
STAGE="$(mktemp -d -t claudeclaw-stage.XXXXXX)"
BUNDLE=""
trap 'rm -f "${REPOLIST}" "${HOMELIST}" "${MANIFEST}"; [[ -n "${BUNDLE}" ]] && rm -f "${BUNDLE}"; [[ -n "${LOCAL_PATCH:-}" ]] && rm -f "${LOCAL_PATCH}"; rm -rf "${STAGE}"' EXIT

# add_if <listfile> <base> <relpath>  -- append relpath when <base>/<relpath> exists.
add_if() {
  local list="$1" base="$2" rel="$3"
  if [[ -e "${base}/${rel}" ]]; then echo "${rel}" >> "${list}"; fi
}

# repo/ group (relative to REPO_ROOT)
# store/ -- everything EXCEPT the bulky, regenerable and transient parts.
# Until 2026-09-04 this was a five-name whitelist (the DB, its -shm/-wal, the
# dashboard token, config-overrides.json) and every OTHER file in store/ sat
# outside the archive without ever saying so: the credential vault, the
# verified-recipients ledger that gates every outgoing letter, the egress
# allowlist, the autonomy levels, the per-service API tokens, and hand-made
# data that exists nowhere else (the mail-partner categorisation, the SEO
# baselines, the webshop change log). A whitelist is silent about every file
# added after it was written, so the rule is inverted here: take store/ and
# name only what must stay OUT.
#   whisper, health, cowork, venv-*, dhl-chrome-profile, fedex-labels,
#   fedex-vam, archery-basis  -- models, exports, virtualenvs, a browser
#     profile and generated PDFs: 3.2 GB, all re-downloadable or reproducible
#   *.log, *.out, *.pid       -- runtime noise, worthless in a restore
# What remains is ~4 MB next to the DB, so the archive stays small.
#   backups                   -- store/backups holds OTHER machines' tarballs (two 2026-07-13
#     hermes dumps, 701 MB): a backup inside the backup, and not this host's state
#   darwin-relay              -- relay.log (87 MB): a log, not state; nothing restores from it
#   scheduled-runs            -- SCHEDPROMPTREF917 fire-time snapshots, ~100 files/day,
#     7-day retention on disk already (scheduled-run-snapshot.ts); regenerated on every
#     large-task fire, so a restore losing yesterday's costs nothing
#   (measured 2026-09-16: these two were 788 MB of a 948 MB archive; excluding them
#    leaves ~150 MB. STORE_SKIP does not delete anything -- the files stay on disk.)
STORE_SKIP=" whisper health cowork venv-garmin venv-pdf dhl-chrome-profile fedex-labels fedex-vam archery-basis backups darwin-relay scheduled-runs "
# read -a splits on blanks WITHOUT pathname expansion, and the name is quoted in
# the pattern: an entry like "*" stays a literal name, never the repo root's file
# list or a match-everything pattern. The ${a[@]+...} form keeps an empty list
# safe under set -u on bash 3.2.
read -r -a _skip_add <<<"${STORE_SKIP_ADD:-}"
read -r -a _skip_take <<<"${STORE_SKIP_TAKE:-}"
for _n in ${_skip_add[@]+"${_skip_add[@]}"}; do STORE_SKIP="${STORE_SKIP}${_n} "; done
for _n in ${_skip_take[@]+"${_skip_take[@]}"}; do STORE_SKIP="${STORE_SKIP// "${_n}" / }"; done
if [[ -d store ]]; then
  while IFS= read -r _entry; do
    _name="$(basename "${_entry}")"
    case "${STORE_SKIP}" in *" ${_name} "*) continue ;; esac
    case "${_name}" in *.log|*.out|*.pid) continue ;; esac
    echo "store/${_name}" >> "${REPOLIST}"
  done < <(find store -mindepth 1 -maxdepth 1)
fi

# ---------------------------------------------------------------------------
# WHY -shm / -wal MUST KEEP REACHING THE ARCHIVE -- and why nothing above names
# them any more. The rule inverted above takes every store/ entry that is not in
# STORE_SKIP, so claudeclaw.db-shm and claudeclaw.db-wal come along on their own.
# The point of this note is the other direction: DO NOT add them to STORE_SKIP,
# and do not "tidy them away" as redundant. They look redundant. They are not.
#
# Normal path: the staging step further down replaces the copied .db with a
# `VACUUM INTO` snapshot and then removes the staged -wal/-shm, because a
# snapshot is self-contained. So on a healthy run these two files never reach
# the archive anyway -- skipping them would seem to change nothing.
#
# The reason they must stay is the FALLBACK path. If the snapshot fails for any
# reason (disk full, lock timeout, python3 missing), the archive falls back to
# the plain file copy -- and a copied .db WITHOUT its -wal is missing every
# transaction that had not been checkpointed yet. That is silent data loss: the
# archive still looks fine, still restores, and is quietly short of data.
#
# So: on a good run they cost nothing, and on a bad run they are the only thing
# standing between us and a truncated restore.
# (Raised 2026-09-04, kanban ef178faf. Carried over here
#  on 2026-09-07 when the whitelist became the inverted rule above: the rule
#  changed, the hazard did not.)
# ---------------------------------------------------------------------------
add_if "${REPOLIST}" "${REPO_ROOT}" .env
add_if "${REPOLIST}" "${REPO_ROOT}" scheduled-tasks.json
add_if "${REPOLIST}" "${REPO_ROOT}" assets/meetings

# --- push-guard layers (kanban 435131ca) ---------------------------------
# The 2026-09-05 owner ban is enforced by three files that live OUTSIDE the
# groups above, and on 2026-09-05 none of them were in the archive. A restore
# from such an archive silently drops every layer -- and the fleet cannot tell,
# because the files simply are not there to look stale.
#
# NOT git-covered either: push-target-gate.py and push-guard.json are UNTRACKED,
# and .claude/settings.json is gitignored per agent. For these the backup is the
# only copy. (repo/.claude/settings.json IS tracked -- git is the source there,
# it is listed only so a restore is self-contained.)
# --- the whole scripts/ tree (2026-09-12) --------------------------------
# Was: two named subtrees, scripts/hooks and an install-local tools subtree
# (both 2026-09-05), each added on the day its absence was
# measured. Measured 2026-09-12 on an archive of that day: the 108
# files at the TOP of scripts/ were all outside the archive -- among them
# scripts/agent-msg.sh (the fleet's message sender) and scripts/backup.sh
# itself -- and so were scripts/voice, scripts/lib, scripts/systemd,
# scripts/support-mail, scripts/__tests__, scripts/gitnexus. Not because of
# any property of those files: the list simply had no rule for them. That is
# the third name-list of this kind (agents/ dirs, the tool snapshot, now the
# scripts/ subdirs), so the fix is not a third name but ONE rule for the tree:
# every regular file under scripts/, minus generated caches. Tracked files
# cost nothing extra (a few MB) and make a restore self-contained; the
# untracked ones (install-local tools, hooks, the .bak copies) have
# no other copy at all. Secret check before widening (2026-09-12): every
# token-shaped match under scripts/ is a <=13-char prefix or regex literal in
# a tracked file, i.e. already public on origin.
while IFS= read -r h; do
  add_if "${REPOLIST}" "${REPO_ROOT}" "${h#./}"
done < <(find scripts -type f ! -path '*/__pycache__/*' ! -path '*/node_modules/*' 2>/dev/null)
# --- end scripts/ tree ---------------------------------------------------
add_if "${REPOLIST}" "${REPO_ROOT}" .claude/settings.json
# Our own git hooks only -- never the *.sample template files git ships with.
# (Measured 2026-09-05: a `pre-push` search matched a fixture's pre-push.sample
#  and was read as "the hook is backed up". It was not. Existence is not identity.)
if [[ -d .git/hooks ]]; then
  while IFS= read -r h; do
    add_if "${REPOLIST}" "${REPO_ROOT}" "${h#./}"
  done < <(find .git/hooks -maxdepth 1 -type f ! -name '*.sample' 2>/dev/null)
fi
# Per-agent settings (each is gitignored; the deny list lives here).
while IFS= read -r s; do
  add_if "${REPOLIST}" "${REPO_ROOT}" "${s#./}"
done < <(find agents -mindepth 3 -maxdepth 3 -path '*/.claude/settings.json' 2>/dev/null)
# --- end push-guard layers -----------------------------------------------
# Per-agent identity + channel secrets (glob; missing dir is not an error).
if [[ -d agents ]]; then
  find agents -type f \
    \( -name 'CLAUDE.md' -o -name 'SOUL.md' -o -name '.mcp.json' \
       -o -name 'access.json' -o -name '.env' \) \
    -print >> "${REPOLIST}"
fi
# Root persona of the MAIN agent (untracked, so ls-files never brings them in,
# and the agents/ glob above never reaches the repo root). Measured 2026-09-13:
# repo/CLAUDE.md, SOUL.md, DREAM.md, HANDOFF.md were
# in NONE of the last five archives -- the main agent's prompt lived in one copy.
for f in CLAUDE.md SOUL.md DREAM.md HANDOFF.md; do
  add_if "${REPOLIST}" "${REPO_ROOT}" "${f}"
done

# --- agents/: EVERYTHING else, minus named exclusions (kanban 2e37ef3a). -----
# 2026-09-12/13 decision: a directory-name list (agents/*/tools, tests, bin,
# scripts, ...) was wrong three times (2a79ce20, d38813a0, then 166 UNCOVERED
# files: 13 agent-config.json, 3 HANDOFF.md, an agent's notes/ decision records,
# 111 test reports). So the rule is inverted: under agents/ every regular
# file is TAKEN unless it falls in an exclusion class that is NAMED here with a
# reason. Measured cost of the 166 files: 12 MB against a 194 MB archive.
# The two arrays are shared with the coverage inventory below, so UNCOVERED.txt
# can only be non-empty if this block and the inventory disagree -- which is a
# bug in this script, not a missing directory name.
#   dirs  : node_modules (reinstallable), __pycache__ (generated),
#           .claude-config (runtime session state; ONLY projects/*/memory is
#           taken, in the memory block below), .next (build output),
#           .venv / venv* (recreatable Python envs)
#   files : *.pid (a live process id, meaningless after restore),
#           .claude/channels/*/progress/debug.log (poller debug stream, regrows)
AGENTS_EXCLUDE_DIRS=( node_modules __pycache__ .claude-config .next .venv 'venv*' )
AGENTS_EXCLUDE_FILES=( '*.pid' )
AGENTS_EXCLUDE_PATHS=( '*/.claude/channels/*/progress/debug.log' )
agents_prune_expr() {
  # Emits find(1) arguments: prune the excluded dirs, drop the excluded files,
  # leave every other regular file for the caller's -print.
  local d
  printf '%s\n' '(' '-type' 'd' '('
  local first=1
  for d in "${AGENTS_EXCLUDE_DIRS[@]}"; do
    [[ ${first} -eq 1 ]] || printf '%s\n' '-o'
    printf '%s\n' '-name' "${d}"; first=0
  done
  printf '%s\n' ')' ')' '-prune' '-o'
  for d in "${AGENTS_EXCLUDE_FILES[@]}"; do printf '%s\n' '!' '-name' "${d}"; done
  for d in "${AGENTS_EXCLUDE_PATHS[@]}"; do printf '%s\n' '!' '-path' "${d}"; done
}
if [[ -d agents ]]; then
  AGENTS_FIND_ARGS=()   # while-read, not mapfile: bash 3.2 (macOS) has no mapfile
  while IFS= read -r _arg; do AGENTS_FIND_ARGS+=("${_arg}"); done < <(agents_prune_expr)
  find agents "${AGENTS_FIND_ARGS[@]}" -type f -print >> "${REPOLIST}"
fi

# --- File-based memory, where it ACTUALLY lives. ---------------------------
# The 2026-09-04 fix took $HOME/.claude/projects/*/memory. Since the
# isolated-config layout, the main agent's memory lives under
# <repo>/.channels-config/projects/*/memory (108 files on 2026-09-12) and each
# sub-agent's under agents/<x>/.claude-config/projects/*/memory (142 for one
# of them). The $HOME directories still exist -- EMPTY -- so the
# "memory directories present" check below stayed green on two empty folders
# while every real memory file was outside the archive. (Measured 2026-09-12 on
# that night's archive: 0 memory files, 2 directory entries.)
for mroot in .channels-config/projects agents/*/.claude-config/projects; do
  [[ -d "${mroot}" ]] || continue
  find "${mroot}" -mindepth 2 -maxdepth 2 -type d -name memory -print >> "${REPOLIST}"
done

# --- agents/ coverage inventory (the CLASS fix for d38813a0). ---------------
# Every file under agents/ that no rule above selected is written to
# UNCOVERED.txt at the archive root and summarised on stderr. The excluded
# classes are the SAME arrays the take-everything block uses (AGENTS_EXCLUDE_*),
# so an exclusion is a stated decision in one place, not an omission in two.
# Since 2026-09-13 the expected count is 0: a non-empty UNCOVERED.txt means the
# take block and this inventory disagree, i.e. a defect in this script.
#   (agents/<x>/memory/ -- the per-agent MEMORY.md mirror -- is TAKEN above,
#    so it does not appear here)
UNCOVERED="$(mktemp -t claudeclaw-uncovered.XXXXXX)"
if [[ -d agents ]]; then
  find agents "${AGENTS_FIND_ARGS[@]}" -type f -print | LC_ALL=C sort > "${UNCOVERED}.all"
  # Expand REPOLIST directory entries so a file under a listed dir counts as covered.
  : > "${UNCOVERED}.cov"
  while IFS= read -r e; do
    case "${e}" in agents/*) ;; *) continue ;; esac
    if [[ -d "${e}" ]]; then find "${e}" -type f -print >> "${UNCOVERED}.cov"; else echo "${e}" >> "${UNCOVERED}.cov"; fi
  done < "${REPOLIST}"
  LC_ALL=C sort -u "${UNCOVERED}.cov" > "${UNCOVERED}.cov.s"
  LC_ALL=C comm -23 "${UNCOVERED}.all" "${UNCOVERED}.cov.s" > "${UNCOVERED}"
  rm -f "${UNCOVERED}.all" "${UNCOVERED}.cov" "${UNCOVERED}.cov.s"
  UNCOVERED_N="$(wc -l < "${UNCOVERED}" | awk '{print $1}')"
  echo "backup: agents/ excluded by rule (kanban 2e37ef3a): dirs ${AGENTS_EXCLUDE_DIRS[*]}; files ${AGENTS_EXCLUDE_FILES[*]}; paths ${AGENTS_EXCLUDE_PATHS[*]}"
  if [[ "${UNCOVERED_N}" -gt 0 ]]; then
    echo "backup: UNCOVERED under agents/: ${UNCOVERED_N} file(s) match no backup rule -- named in UNCOVERED.txt inside the archive. By agent/dir:" >&2
    awk -F/ '{ k=$2"/"$3; n[k]++ } END { for (k in n) printf "backup:   uncovered %5d  %s\n", n[k], k }' "${UNCOVERED}" | LC_ALL=C sort -k3 -rn >&2
  else
    echo "backup: agents/ coverage: every file matched a rule (0 uncovered)"
  fi
fi

# home/ group (relative to $HOME)
add_if "${HOMELIST}" "${HOME}" .claude/skills
add_if "${HOMELIST}" "${HOME}" .claude/scheduled-tasks
# The file-based auto-memory. Until 2026-09-04 this was NOT in the archive, and
# a restore test that day proved what that costs: 490 markdown memories for the
# main agent alone, none of them in the tarball. The SQLite copy is not a
# substitute -- it holds the prose, not the frontmatter, the type or the
# [[links]] between memories. Only the memory/ directories are taken, not the
# whole projects/ tree, which is full of transcripts and tool-result dumps.
if [[ -d "${HOME}/.claude/projects" ]]; then
  ( cd "${HOME}" && find .claude/projects -maxdepth 2 -type d -name memory -print ) >> "${HOMELIST}"
fi
# MAIN orchestrator channel tokens + pairing state, per provider. bot.pid and
# inbox/ are runtime/transient and intentionally excluded. Since #915 the
# main state dir is install-scoped (<repo>/.claude/channels/<provider>); the
# HOME base only still holds it on an unmigrated install -- take both, each
# from its own list so restore puts them back where they came from.
if [[ -d "${HOME}/.claude/channels" ]]; then
  ( cd "${HOME}" && find .claude/channels -maxdepth 2 \
      \( -name '.env' -o -name 'access.json' -o -name 'invites.json' \) \
      -print ) >> "${HOMELIST}"
  ( cd "${HOME}" && find .claude/channels -maxdepth 2 -type d -name 'approved' -print ) >> "${HOMELIST}"
fi
if [[ -d "${REPO_ROOT}/.claude/channels" ]]; then
  ( cd "${REPO_ROOT}" && find .claude/channels -maxdepth 2 \
      \( -name '.env' -o -name 'access.json' -o -name 'invites.json' \) \
      -print ) >> "${REPOLIST}"
  ( cd "${REPO_ROOT}" && find .claude/channels -maxdepth 2 -type d -name 'approved' -print ) >> "${REPOLIST}"
fi
# launchd jobs for this fleet. The job labels are com.<MAIN_AGENT_ID>.<service>
# (see src/web/main-agent.ts), so resolve MAIN_AGENT_ID the way the app does
# (src/env.ts: read from .env, default "marveen" when unset) instead of
# hardcoding one deployment's prefix. Parsing mirrors env.ts: last definition
# wins, surrounding matching quotes stripped.
MAIN_AGENT_ID="marveen"
if [[ -f "${REPO_ROOT}/.env" ]]; then
  # `|| true`: with `set -o pipefail`, a no-match grep would otherwise fail the
  # whole substitution (and, under `set -e`, abort the backup) on any install
  # that leaves MAIN_AGENT_ID unset and relies on the "marveen" default.
  _mid="$(grep -E '^[[:space:]]*MAIN_AGENT_ID[[:space:]]*=' "${REPO_ROOT}/.env" | tail -1 \
    | sed -E 's/^[^=]*=[[:space:]]*//; s/[[:space:]]*$//; s/^"(.*)"$/\1/; s/^'\''(.*)'\''$/\1/' || true)"
  [[ -n "${_mid}" ]] && MAIN_AGENT_ID="${_mid}"
fi
if [[ -d "${HOME}/Library/LaunchAgents" ]]; then
  ( cd "${HOME}" && find Library/LaunchAgents -maxdepth 1 -name "com.${MAIN_AGENT_ID}.*.plist" -print ) >> "${HOMELIST}"
fi

# --- Local commits that live on no remote. ---------------------------------
# This archive deliberately carries unversioned state, not the source: the
# source is supposed to live on a git remote. On 2026-09-04 that assumption
# broke -- nine days of work sat committed locally and pushed nowhere, so the
# only copy was this disk, and the tarball did not hold it either. A bundle of
# every local branch that origin does not already have closes the gap for a few
# hundred KB (the full history is 26 MB, but the shared part is recoverable by
# cloning origin). Restore, after cloning origin:
#   git fetch <restored>/repo/local-commits.bundle 'refs/heads/*:refs/heads/*'
if command -v git >/dev/null 2>&1 && [[ -d "${REPO_ROOT}/.git" ]]; then
  BUNDLE="$(mktemp -t claudeclaw-bundle.XXXXXX)"
  # An empty ref set makes `git bundle` refuse with "empty bundle", which is
  # the GOOD case (everything is already pushed), not an error -- so a failure
  # here just drops the file instead of failing the backup.
  if git -C "${REPO_ROOT}" bundle create "${BUNDLE}" \
       --branches --not --remotes=origin >/dev/null 2>&1; then
    echo "backup: local-commits.bundle $(wc -c < "${BUNDLE}" | awk '{print $1}') bytes"
  else
    rm -f "${BUNDLE}"; BUNDLE=""
    echo "backup: no local-only commits to bundle"
  fi
fi

# --- Local, uncommitted changes to TRACKED files (2026-09-12). --------------
# An install can run on a working tree that carries local patches on top of
# HEAD (measured on one install 2026-09-12: 116 tracked paths differed). The git
# bundle above carries only local COMMITS, and the rules above name files, not
# changes -- so a restore would put back the HEAD version of a patched file.
# The backup therefore carries the working-tree copy of every modified/added
# tracked file, plus one patch against HEAD (repo/local-changes.patch) so a
# reader can see WHAT differs and from WHICH commit. Deleted files cannot be
# staged and are listed in the patch only.
LOCAL_PATCH=""
if command -v git >/dev/null 2>&1 && [[ -d "${REPO_ROOT}/.git" ]]; then
  while IFS= read -r st; do
    rel="${st:3}"
    case "${st:0:2}" in *D*) continue ;; esac   # deleted: nothing on disk to copy
    rel="${rel##* -> }"                          # renames: take the new name
    add_if "${REPOLIST}" "${REPO_ROOT}" "${rel}"
  done < <(git -C "${REPO_ROOT}" status --porcelain=v1 -uno 2>/dev/null)
  LOCAL_PATCH="$(mktemp -t claudeclaw-localpatch.XXXXXX)"
  if git -C "${REPO_ROOT}" diff HEAD --binary > "${LOCAL_PATCH}" 2>/dev/null && [[ -s "${LOCAL_PATCH}" ]]; then
    echo "backup: local-changes.patch $(wc -c < "${LOCAL_PATCH}" | awk '{print $1}') bytes against $(git -C "${REPO_ROOT}" rev-parse --short HEAD)"
  else
    rm -f "${LOCAL_PATCH}"; LOCAL_PATCH=""
  fi
fi

# --- The whole TRACKED tree (2026-09-12). -----------------------------------
# Decision, written down because until today it was only implied: the archive
# is SELF-SUFFICIENT for the source, it does not assume origin is reachable.
# Measured 2026-09-12: the bundle held 16 fix/* heads and none of them reached
# HEAD (3d02f37); 85 clean tracked files under scripts/ alone were recoverable
# only by cloning github.com/Szotasz/marveen. That is a dependency on an
# external service on the restore path, and a restore is exactly the moment
# one does not want to discover it. The tracked tree is 31 MB on disk (1202
# files), a few MB more per archive: cheap. The local-changes.patch above still
# says WHAT differs from WHICH commit; this makes the files themselves present.
if command -v git >/dev/null 2>&1 && [[ -d "${REPO_ROOT}/.git" ]]; then
  while IFS= read -r rel; do
    add_if "${REPOLIST}" "${REPO_ROOT}" "${rel}"
  done < <(git -C "${REPO_ROOT}" ls-files 2>/dev/null)
fi
# Several rules above legitimately name the same path (hooks, scripts/, the
# modified-tracked block, the tracked tree). One copy each, or the manifest
# lists a file twice and cp runs twice.
sort -u -o "${REPOLIST}" "${REPOLIST}"
sort -u -o "${HOMELIST}" "${HOMELIST}"

if [[ ! -s "${REPOLIST}" && ! -s "${HOMELIST}" ]]; then
  echo "backup: nothing to archive" >&2
  exit 0
fi

# --- Manifest (stored at the archive root for self-description). -----------
{
  echo "Marveen backup ${STAMP}"
  echo "host: $(hostname 2>/dev/null || echo '?')   user: ${USER:-?}   home: ${HOME}"
  echo "repo root: ${REPO_ROOT}"
  echo "Restore: tar -xpzf <archive> -C <tmp>; copy repo/* -> project root, home/* -> \$HOME."
  echo "See docs/MIGRATION.md for the full runbook (TCC, launchd paths, one-bot-one-poller, venv rebuild)."
  echo "--- repo/ ---"; sed 's,^,repo/,' "${REPOLIST}" 2>/dev/null || true
  if [[ -n "${BUNDLE}" ]]; then
    echo "repo/local-commits.bundle   (git bundle: local branches absent from origin)"
  fi
  if [[ -n "${LOCAL_PATCH}" ]]; then
    echo "repo/local-changes.patch   (git diff HEAD: uncommitted local changes to tracked files; the files themselves are listed above)"
  fi
  echo "--- home/ ---"; sed 's,^,home/,' "${HOMELIST}" 2>/dev/null || true
} > "${MANIFEST}"

# --- Assemble the archive via a staging dir, then one plain tar. -----------
# The repo/ and home/ groups are produced by copying into a staging tree, NOT
# by tar name-substitution: bsdtar's `-s` and GNU tar's `--transform` are
# mutually incompatible (on GNU tar, `-s` is `--same-order` and takes no
# argument), so a substitution-based build is not portable. Staging + a single
# `tar -czf -C "${STAGE}" .` works identically on macOS (bsdtar) and Linux
# (GNU tar). Everything backed up is small (a few MB), so the copy is cheap;
# `cp -pR` preserves modes so the 0600 token files stay private.
cp "${MANIFEST}" "${STAGE}/MANIFEST.txt"

stage_group() {  # stage_group <listfile> <base> <group>
  local list="$1" base="$2" group="$3" rel parent
  [[ -s "${list}" ]] || return 0
  while IFS= read -r rel; do
    [[ -z "${rel}" ]] && continue
    parent="$(dirname "${rel}")"
    mkdir -p "${STAGE}/${group}/${parent}"
    cp -pR "${base}/${rel}" "${STAGE}/${group}/${parent}/"
  done < "${list}"
}

stage_group "${REPOLIST}" "${REPO_ROOT}" repo
stage_group "${HOMELIST}" "${HOME}" home

if [[ -n "${BUNDLE}" ]]; then
  mkdir -p "${STAGE}/repo"
  cp -p "${BUNDLE}" "${STAGE}/repo/local-commits.bundle"
  chmod 600 "${STAGE}/repo/local-commits.bundle"
fi
# Own branch, not nested in the bundle one: with every local branch pushed the
# bundle is empty and the patch must still travel (latent bug, 2026-09-12).
if [[ -n "${LOCAL_PATCH}" ]]; then
  mkdir -p "${STAGE}/repo"
  cp "${LOCAL_PATCH}" "${STAGE}/repo/local-changes.patch"
  chmod 600 "${STAGE}/repo/local-changes.patch"
fi

# --- Make the archived database a consistent snapshot. ---------------------
# `VACUUM INTO` writes one self-contained file under a read lock, so it is safe
# while the dashboard keeps writing -- unlike copying .db/-wal/-shm separately,
# which samples three files at three different moments.
#
# The snapshot keeps the SAME name and path inside the archive
# (repo/store/claudeclaw.db), so docs/MIGRATION.md and every existing restore
# instruction stay valid: only the contents get better. The -wal/-shm siblings
# are then meaningless (a snapshot has no WAL to replay) and are dropped, which
# is also why the archive shrinks.
STAGED_DB="${STAGE}/repo/store/claudeclaw.db"
if [[ -f "${STAGED_DB}" ]]; then
  SNAP="${STAGE}/repo/store/.snapshot-tmp.db"
  rm -f "${SNAP}"
  if python3 - "${REPO_ROOT}/store/claudeclaw.db" "${SNAP}" <<'PYSNAP' >/dev/null 2>&1
import sqlite3, sys
con = sqlite3.connect(sys.argv[1], timeout=60)
con.execute("VACUUM INTO ?", (sys.argv[2],))
con.close()
PYSNAP
  then
    mv -f "${SNAP}" "${STAGED_DB}"
    chmod 600 "${STAGED_DB}"
    rm -f "${STAGED_DB}-wal" "${STAGED_DB}-shm"
    DB_SNAPSHOT_STATUS="consistent"
  else
    rm -f "${SNAP}"
    DB_SNAPSHOT_STATUS="degraded:snapshot-failed"
    echo "backup: WARNING -- consistent snapshot failed; the archived .db/-wal/-shm are a live copy and may be torn." >&2
  fi
fi

# Record the outcome in the archive itself, so a restore six months from now
# can tell whether it is holding a snapshot or a live copy.
{
  echo "--- database ---"
  echo "db-snapshot: ${DB_SNAPSHOT_STATUS}"
  if [[ "${DB_SNAPSHOT_STATUS}" == "consistent" ]]; then
    echo "repo/store/claudeclaw.db is a consistent VACUUM INTO snapshot."
    echo "There is no -wal/-shm in this archive and none is needed: restore the .db alone."
  else
    echo "WARNING: repo/store/claudeclaw.db is a LIVE COPY, not a snapshot."
    echo "Restore .db together with -wal/-shm, and verify with PRAGMA integrity_check."
  fi
} >> "${STAGE}/MANIFEST.txt"

# --- Rebuild the file listing from what the archive ACTUALLY holds. ---------
# The listing above was generated from REPOLIST/HOMELIST, i.e. from what we
# INTENDED to stage, before staging happened. Since the snapshot step removes
# the staged -wal/-shm, that listing named files the archive does not contain.
# A manifest that lists a file it is not holding confuses exactly the person it
# exists for: the one opening this archive in six months. So the listing is
# regenerated here, from the staged tree itself, after every modification to it.
# (Raised 2026-09-04; the defect was introduced by the snapshot step.)
MANIFEST_HEAD="$(mktemp -t claudeclaw-mhead.XXXXXX)"
# Keep everything up to (but not including) the first listing header.
sed '/^--- repo\/ ---$/,$d' "${STAGE}/MANIFEST.txt" > "${MANIFEST_HEAD}"
{
  cat "${MANIFEST_HEAD}"
  echo "--- repo/ ---"
  ( cd "${STAGE}" && [[ -d repo ]] && find repo -type f | LC_ALL=C sort ) || true
  echo "--- home/ ---"
  ( cd "${STAGE}" && [[ -d home ]] && find home -type f | LC_ALL=C sort ) || true
  # Re-append the database section, which sed stripped along with the listing.
  echo "--- database ---"
  echo "db-snapshot: ${DB_SNAPSHOT_STATUS}"
  if [[ "${DB_SNAPSHOT_STATUS}" == "consistent" ]]; then
    echo "repo/store/claudeclaw.db is a consistent VACUUM INTO snapshot."
    echo "There is no -wal/-shm in this archive and none is needed: restore the .db alone."
  else
    echo "WARNING: repo/store/claudeclaw.db is a LIVE COPY, not a snapshot."
    echo "Restore .db together with -wal/-shm, and verify with PRAGMA integrity_check."
  fi
} > "${STAGE}/MANIFEST.txt.new"
mv -f "${STAGE}/MANIFEST.txt.new" "${STAGE}/MANIFEST.txt"
rm -f "${MANIFEST_HEAD}"

# Archive only the top-level entries that exist (a group dir is absent when
# its list was empty), so tar never errors on a missing entry and the names
# stay clean (no leading "./").
if [[ -n "${UNCOVERED:-}" && -s "${UNCOVERED}" ]]; then
  {
    echo "# Files under agents/ that matched NO backup rule at ${STAMP} (kanban d38813a0, 2e37ef3a)."
    echo "# They exist in ONE copy: agents/ is gitignored in full. Since 2026-09-13 the take"
    echo "# rule is EVERYTHING minus AGENTS_EXCLUDE_*; a line here means the take block and"
    echo "# the inventory in scripts/backup.sh disagree -- a script defect, not a missing name."
    cat "${UNCOVERED}"
  } > "${STAGE}/UNCOVERED.txt"
fi
rm -f "${UNCOVERED:-}"
( cd "${STAGE}" && tar -czf "${ARCHIVE}" MANIFEST.txt \
    $( [[ -f UNCOVERED.txt ]] && echo UNCOVERED.txt ) \
    $( [[ -d repo ]] && echo repo ) $( [[ -d home ]] && echo home ) )
echo "backup: wrote ${ARCHIVE} ($(wc -c < "${ARCHIVE}" | awk '{print $1}') bytes)"
# Machine-readable status line. A caller (a wrapper or unit that runs this
# script) greps for it and records a degraded run as degraded instead of "OK".
echo "backup: db-snapshot=${DB_SNAPSHOT_STATUS}"

# --- A direct run of this script must not be invisible. ---------------------
# backups/backup.log is written by the wrapper that runs this script, where an
# install has one. Running THIS script by hand therefore used to produce an
# archive that nothing recorded: no journal entry and no log line (one such
# archive was found only by counting archives against log lines). At a restore
# the question is which archive came from where, so a direct run logs itself.
# A wrapper sets MARVEEN_BACKUP_VIA=wrapper; without it, we are the entrance.
if [[ "${MARVEEN_BACKUP_VIA:-}" != "wrapper" ]]; then
  printf '%s  OK  via=direct-backup.sh  %s  %s bytes  db-snapshot=%s\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$(basename "${ARCHIVE}")" \
    "$(wc -c < "${ARCHIVE}" | tr -d ' ')" "${DB_SNAPSHOT_STATUS}" \
    >> "${BACKUP_DIR}/backup.log" 2>/dev/null || true
fi
if [[ "${DB_SNAPSHOT_STATUS}" != "consistent" && "${DB_SNAPSHOT_STATUS}" != "no-database" ]]; then
  echo "backup: WARNING -- DEGRADED backup: the database in this archive is not a consistent snapshot (${DB_SNAPSHOT_STATUS})." >&2
fi

# --- Verify the archive against the manifest. ------------------------------
# The manifest says what the backup INTENDED to carry; until now nothing
# checked what it actually carries. That gap is exactly how 2026-09-04
# happened: the store/ whitelist had been silently dropping files for weeks
# and the restore test was what finally noticed, not the backup itself. A
# backup that cannot say what is inside it is a promise, not a copy.
#
# Two checks, because they fail differently:
#   - every manifest entry has a matching path in the archive (a staging copy
#     that silently did nothing shows up here),
#   - a few load-bearing items are present by name (an archive that is valid,
#     small and useless -- the 09-04 shape -- shows up here even if the
#     manifest itself was built wrong).
ARCHIVE_LIST="$(mktemp -t claudeclaw-verify.XXXXXX)"
trap 'rm -f "${REPOLIST}" "${HOMELIST}" "${MANIFEST}" "${ARCHIVE_LIST}"; [[ -n "${BUNDLE}" ]] && rm -f "${BUNDLE}"; [[ -n "${LOCAL_PATCH:-}" ]] && rm -f "${LOCAL_PATCH}"; rm -rf "${STAGE}"' EXIT
tar -tzf "${ARCHIVE}" > "${ARCHIVE_LIST}"

missing=0
while IFS= read -r want; do
  # Manifest body lines only: the header block and the group separators are
  # prose, not paths.
  case "${want}" in repo/*|home/*) ;; *) continue ;; esac
  # kanban 8e1c8454 (2026-09-08..12: five nightly FAILs on a GOOD archive).
  # ${MANIFEST} is the INTENDED list, built before staging; the consistent
  # VACUUM INTO snapshot then removes the staged -wal/-shm BY DESIGN (see the
  # database section of MANIFEST.txt). So those two names, and ONLY those two,
  # and ONLY when the snapshot is consistent, are not a missing item -- they
  # are the snapshot working as specified. Any other absence still fails, and
  # a degraded snapshot (live copy) still requires the -wal/-shm to be there.
  if [[ "${DB_SNAPSHOT_STATUS}" == "consistent" ]]; then
    case "${want}" in
      repo/store/claudeclaw.db-wal|repo/store/claudeclaw.db-shm) continue ;;
    esac
  fi
  # A directory entry is listed once in the manifest and expands to many paths
  # in the archive, so match on the prefix, and anchor it so "store/x" cannot
  # be satisfied by "store/xyz". LITERALLY (card a8a92d55): as a regex, a route
  # dir like `[id]` never matched itself and failed a complete backup.
  if ! archive_list_has "${ARCHIVE_LIST}" "${want}"; then
    echo "backup: MISSING from the archive: ${want}" >&2
    missing=$((missing + 1))
  fi
done < <(sed -e 's/  *(.*)$//' "${MANIFEST}")

# Load-bearing by name. Each one has already been lost or nearly lost once:
# the memory directories and the local-commit bundle on 2026-09-04, the
# credential-carrying store/ files by the whitelist that preceded it.
for marker in "repo/store/claudeclaw.db" "home/.claude/skills" "home/.claude/scheduled-tasks"; do
  archive_list_has "${ARCHIVE_LIST}" "${marker}" || {
    echo "backup: MISSING load-bearing item: ${marker}" >&2
    missing=$((missing + 1))
  }
done
# The file-based memories: only required when this host actually has some, so
# a fresh install does not fail its first backup.
# 2026-09-12: the check used to accept a memory DIRECTORY entry, and the two
# $HOME directories it looked for were empty -- green on nothing. It now
# requires at least one memory FILE in the archive for every memory root that
# holds files on disk (main agent under .channels-config, sub-agents under
# agents/*/.claude-config, legacy $HOME layout).
for mroot in "${REPO_ROOT}/.channels-config/projects" "${HOME}/.claude/projects"; do
  [[ -d "${mroot}" ]] || continue
  src_n="$(find "${mroot}" -mindepth 3 -path '*/memory/*' -type f 2>/dev/null | wc -l | awk '{print $1}')"
  [[ "${src_n}" -gt 0 ]] || continue
  case "${mroot}" in
    "${REPO_ROOT}"/*) pat='^repo/\.channels-config/projects/[^/]+/memory/.+' ;;
    *)                pat='^home/\.claude/projects/[^/]+/memory/.+' ;;
  esac
  grep -qE "${pat}" "${ARCHIVE_LIST}" || {
    echo "backup: MISSING load-bearing item: the file-based memory FILES from ${mroot} (${src_n} on disk, 0 in the archive)" >&2
    missing=$((missing + 1))
  }
done
if [[ -d agents ]]; then
  src_n="$(find agents -path '*/.claude-config/projects/*/memory/*' -type f 2>/dev/null | wc -l | awk '{print $1}')"
  if [[ "${src_n}" -gt 0 ]]; then
    grep -qE '^repo/agents/[^/]+/\.claude-config/projects/[^/]+/memory/.+' "${ARCHIVE_LIST}" || {
      echo "backup: MISSING load-bearing item: the sub-agents' file-based memory FILES (${src_n} on disk, 0 in the archive)" >&2
      missing=$((missing + 1))
    }
  fi
fi

if [[ "${missing}" -gt 0 ]]; then
  echo "backup: FAILED verification -- ${missing} item(s) named in the manifest are not in ${ARCHIVE}." >&2
  echo "backup: the archive is kept for inspection, but do NOT treat it as a good copy." >&2
  # launchd sends this script's output to logs/backup.log, which nobody opens.
  # A loud failure into an unread file is the same silence the verification
  # above exists to break, so the failure also goes onto the agent message
  # queue, where it survives the agent being asleep at 04:30 and gets read on
  # the next turn. Best-effort: a messaging problem must not change the exit
  # code or mask the real failure.
  # To the install's own main agent: MAIN_AGENT_ID as resolved near the top of
  # this script (from .env the way the app reads it: last definition wins,
  # quotes stripped, default "marveen"), never a fixed name -- an id that does
  # not exist on this install makes the alert go nowhere (card a8a92d55). Do not
  # re-read .env here: a second, simpler parse took the FIRST definition, kept
  # the quotes, and without `|| true` aborted the script under pipefail on an
  # install with no MAIN_AGENT_ID line (card a95cada0).
  if [[ -x "${REPO_ROOT}/scripts/agent-msg.sh" ]]; then
    bash "${REPO_ROOT}/scripts/agent-msg.sh" "${MAIN_AGENT_ID}" "${MAIN_AGENT_ID}" \
      "[MENTES] A napi mentes ellenorzese ELBUKOTT ${STAMP}-kor: ${missing} tetel hianyzik az archivumbol (reszletek: logs/backup.log). Az archivum NEM tekintheto jo masolatnak." \
      >/dev/null 2>&1 || true
  fi
  exit 6
fi
echo "backup: verified $(grep -cE '^(repo|home)/' "${MANIFEST}") manifest entries against the archive"

# The archive contains sensitive tokens (dashboard bearer, channel bot tokens,
# project .env secrets). Do not auto-sync ${BACKUP_DIR} to iCloud, Dropbox,
# Google Drive, or any other cloud-backup folder. Keep it local.
echo "backup: WARNING -- archive contains sensitive tokens; keep ${BACKUP_DIR} out of cloud-sync folders (iCloud / Dropbox / Google Drive)." >&2

# Keep the newest ${KEEP} archives, drop the rest. while-read (not mapfile)
# for macOS bash 3.2 compatibility.
# Second guard, independent of the KEEP check at the top: this run's archive is
# never pruned, whatever the arithmetic below yields (an overflowing KEEP once
# made tail list every archive, the new one included).
ls -1t "${BACKUP_DIR}"/claudeclaw-*.tar.gz 2>/dev/null | tail -n +$((KEEP + 1)) | while IFS= read -r f; do
  [[ -z "${f}" ]] && continue
  [[ "${f}" == "${ARCHIVE}" ]] && { echo "backup: kept $(basename "${f}") (this run's archive is never pruned)" >&2; continue; }
  rm -f "${f}"
  echo "backup: pruned $(basename "${f}")"
done
