#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Scan a diff (or files) for person identifiers before they reach a public fork.

WHY (card 3646faec): on 2026-09-22 two real owner Telegram chat ids stood in a PR aimed at a
public fork. The prescribed data-safety pattern (IP + company name) matches neither, and the
pre-commit secret gate does not cover this either (measured: a file holding a real chat id PASSes).
Until now the only protection was the agent reading the diff.

The identifier list is built AT RUNTIME from the live configuration, never hardcoded:
  * every  <root>/**/.claude/channels/<provider>/access.json  ->  allowFrom[]
  * store/principals.json                                     ->  principals{} keys

EXIT CODES (three states, deliberately distinct):
  0  clean      - the scanned content holds no known identifier
  1  findings   - at least one identifier found (reported masked, file:line)
  2  unmeasured - configuration missing/unreadable/empty, or the self-check did not fire.
                  This is NOT "clean": it means the scan could not answer the question.

An identifier is NEVER printed in full: only the last 3 characters, prefixed with asterisks.
"""
import argparse
import glob
import io
import json
import os
import re
import subprocess
import sys

REPO_DEFAULT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def unmeasured(msg):
    """Stop loudly. An empty finding list must never be mistaken for a clean result."""
    print("UNMEASURED: %s" % msg, file=sys.stderr)
    print("UNMEASURED: this is not a clean result -- fix the scan, do not treat it as a pass.",
          file=sys.stderr)
    sys.exit(2)


def mask(ident):
    """Last 3 characters only. Short ids are fully masked rather than partially revealed."""
    s = str(ident)
    return "*" * max(len(s) - 3, 0) + (s[-3:] if len(s) > 3 else "*" * len(s))


def main_worktree(start):
    """The live configuration (.claude/, store/) is gitignored, so a linked worktree does not
    carry it. Resolve the MAIN worktree from the common git dir, so the scan reads the same
    configuration the fleet actually runs on."""
    try:
        out = subprocess.run(["git", "-C", start, "rev-parse", "--path-format=absolute",
                              "--git-common-dir"], capture_output=True, timeout=30, check=True)
        common = out.stdout.decode().strip()
    except Exception:
        return None
    if not common:
        return None
    if os.path.basename(common) == ".git":
        return os.path.dirname(common)
    return None


def resolve_root(explicit):
    """Return (root, tried). An explicit --root is used as given: if it holds no configuration the
    scan stops loudly rather than wandering off to another tree. Without --root we try this
    repository first, then its main worktree -- and we always print which one was used, because a
    silent fallback is exactly how a scan ends up reading the wrong configuration."""
    if explicit != REPO_DEFAULT:
        return explicit, [explicit]
    tried = [REPO_DEFAULT]
    if glob.glob(os.path.join(REPO_DEFAULT, "**", ".claude", "channels", "*", "access.json"),
                 recursive=True):
        return REPO_DEFAULT, tried
    main = main_worktree(REPO_DEFAULT)
    if main and main != REPO_DEFAULT:
        tried.append(main)
        if glob.glob(os.path.join(main, "**", ".claude", "channels", "*", "access.json"),
                     recursive=True):
            return main, tried
    return REPO_DEFAULT, tried


def load_identifiers(root):
    """Union of every allowFrom[] and every principals{} key.
    Returns (ids, report_lines, source_count, unreadable_sources).

    Each channel-owning agent keeps its OWN access.json, so a single hardcoded path is not
    enough: an id paired on a sub-agent channel but not yet in principals.json would be
    invisible, and the scan would pass while the id sits in the diff.
    """
    report, ids, unreadable = [], set(), []
    pattern = os.path.join(root, "**", ".claude", "channels", "*", "access.json")
    sources = sorted(glob.glob(pattern, recursive=True))
    for path in sources:
        try:
            data = json.load(io.open(path, encoding="utf-8"))
        except Exception as exc:
            report.append("  UNREADABLE %s (%s)" % (os.path.relpath(path, root), type(exc).__name__))
            unreadable.append(os.path.relpath(path, root))
            continue
        allow = [str(x).strip() for x in (data.get("allowFrom") or []) if str(x).strip()]
        ids |= set(allow)
        report.append("  %-58s allowFrom: %d" % (os.path.relpath(path, root), len(allow)))

    principals_path = os.path.join(root, "store", "principals.json")
    try:
        data = json.load(io.open(principals_path, encoding="utf-8"))
        keys = [str(k).strip() for k in (data.get("principals") or {}) if str(k).strip()]
        ids |= set(keys)
        report.append("  %-58s principals: %d" % ("store/principals.json", len(keys)))
    except Exception as exc:
        # A MISSING principals.json is unreadable too: it is a required source, not an optional one.
        report.append("  UNREADABLE store/principals.json (%s)" % type(exc).__name__)
        unreadable.append("store/principals.json")

    return ids, report, len(sources), unreadable


def build_matcher(ids):
    """One alternation, longest first, with non-digit boundaries so a longer id is not
    reported twice via a shorter substring."""
    if not ids:
        return None
    ordered = sorted(ids, key=len, reverse=True)
    return re.compile(r"(?<![0-9A-Za-z_])(" + "|".join(re.escape(i) for i in ordered)
                      + r")(?![0-9A-Za-z_])")


def self_check(matcher, ids):
    """Positive control: a synthetic line built in memory from a live identifier must match.

    Without this the scan can report "clean" while the matcher is simply blind. The identifier
    never touches disk and never reaches the output.
    """
    sample = sorted(ids)[0]
    probe = "+  chat_id = %s  # synthetic, in memory only" % sample
    if not matcher.search(probe):
        unmeasured("self-check did not fire: the matcher cannot see a live identifier")
    negative = "+  chat_id = 0000000000  # id that is deliberately not in the list"
    if sample != "0000000000" and matcher.search(negative):
        unmeasured("self-check matched an identifier that is not in the list (matcher too broad)")


def iter_added_lines(diff_text):
    """Yield (path, line_no_in_new_file, text) for added lines of a unified diff."""
    path, new_no = None, 0
    for line in diff_text.splitlines():
        if line.startswith("+++ "):
            target = line[4:].strip()
            path = target[2:] if target.startswith(("a/", "b/")) else target
            continue
        if line.startswith("@@"):
            m = re.search(r"\+(\d+)", line)
            new_no = int(m.group(1)) if m else 0
            continue
        if line.startswith("+") and not line.startswith("+++"):
            yield path, new_no, line[1:]
            new_no += 1
        elif line.startswith((" ", "-")) or line == "":
            if not line.startswith("-"):
                new_no += 1


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    src = ap.add_mutually_exclusive_group()
    src.add_argument("--diff", metavar="FILE", help="unified diff file, or - for stdin")
    src.add_argument("--rev-range", metavar="A..B", help="run git diff over this range")
    src.add_argument("--files", nargs="+", metavar="PATH", help="scan whole files")
    ap.add_argument("--root", default=REPO_DEFAULT,
                    help="repository root that holds the configuration (default: the repo of this script)")
    args = ap.parse_args()

    root, tried = resolve_root(args.root)
    ids, report, source_count, unreadable = load_identifiers(root)
    if len(tried) > 1:
        print("root resolution: %s" % " -> ".join(tried))
    print("identifier sources under %s" % root)
    for line in report:
        print(line)
    if source_count == 0:
        unmeasured("no access.json found under %s (tried: %s) -- wrong root, or the "
                   "configuration moved" % (root, ", ".join(tried)))
    if unreadable:
        # A PARTIAL list is as dangerous as an empty one: the ids of the unreadable source are unknown, so a
        # diff carrying one of them would come back "clean" (tester verdict 31718 / 16721 on 3646faec).
        unmeasured("unreadable identifier source(s): %s -- the list is partial, its missing ids would "
                   "pass as clean" % ", ".join(unreadable))
    if not ids:
        unmeasured("the identifier list is empty -- every scan would pass vacuously")
    print("  => %d distinct identifiers (values are never printed)\n" % len(ids))

    matcher = build_matcher(ids)
    self_check(matcher, ids)
    print("self-check: the matcher sees a live identifier, and ignores one outside the list\n")

    if args.rev_range:
        try:
            text = subprocess.run(["git", "-C", args.root, "diff", args.rev_range],
                                  capture_output=True, timeout=120, check=True).stdout.decode(
                                      "utf-8", "replace")
        except Exception as exc:
            unmeasured("git diff %s failed: %r" % (args.rev_range, exc))
        units = list(iter_added_lines(text))
    elif args.files:
        units = []
        for path in args.files:
            try:
                content = io.open(path, encoding="utf-8", errors="replace").read()
            except Exception as exc:
                unmeasured("cannot read %s (%s)" % (path, type(exc).__name__))
            for i, line in enumerate(content.splitlines(), 1):
                units.append((path, i, line))
    else:
        stream = sys.stdin if (not args.diff or args.diff == "-") else io.open(
            args.diff, encoding="utf-8", errors="replace")
        units = list(iter_added_lines(stream.read()))

    findings = []
    for path, line_no, text in units:
        for m in matcher.finditer(text):
            findings.append((path or "(unknown file)", line_no, mask(m.group(1))))

    if not findings:
        print("clean: no known identifier in the scanned content (%d lines scanned)" % len(units))
        return 0
    print("FOUND %d identifier occurrence(s):" % len(findings))
    for path, line_no, masked in findings:
        print("  %s:%d  %s" % (path, line_no, masked))
    print("\nThese are person identifiers from the live configuration. They must not reach a "
          "public fork.")
    return 1


if __name__ == "__main__":
    sys.exit(main())
