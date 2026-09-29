#!/usr/bin/env python3
"""Negative controls for test_tulajdonosi_keres_par.py: every mutant must turn the suite red (17 since the v3 round).

Each mutant is one targeted change to tulajdonosi_keres_par.py, written to a COPY in a temporary
directory next to a copy of the test file; the files in this directory are never touched. A mutant
that leaves the suite green names a behaviour no test pins down.

Run: python3 mutation_check.py   (exit 1 if a mutant survives, crashes or misses its anchor; exit 2 if the
     unmutated copy is not green, then nothing is measured)
"""

from __future__ import annotations

import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent

MUTANTS = [
    ("M1 no date guard", r'_ID_END = r"(?!\d|[-.:]\d|T\d)"', r'_ID_END = r"(?!\d)"'),
    ("M2 range not limited to the chat", "if chat_of.get(str(n)) == chat)", "if True)"),
    (
        "M3 archived cards dropped",
        '"SELECT id, title, description FROM kanban_cards WHERE created_at <= ?"',
        '"SELECT id, title, description FROM kanban_cards WHERE created_at <= ? AND archived_at IS NULL"',
    ),
    (
        "M4 comments ignore asof",
        '"SELECT card_id, content FROM kanban_comments WHERE created_at <= ?", (asof,)',
        '"SELECT card_id, content FROM kanban_comments WHERE ? IS NOT NULL", (asof,)',
    ),
    ("M5 read-write open", 'f"file:{db}?mode=ro"', 'f"file:{db}?mode=rw"'),
    ("M6 no acknowledgement check", 'if all(w in ACK_WORDS for w in words):\n        return "ack"', 'if False:\n        return "ack"'),
    ("M7 no question rule", 'if "?" in body:', "if False:"),
    ("M8 indicative -od/-ed taken as imperative", 're.search(r"[^aeiou]d$", word)', 're.search(r"d$", word)'),
    ("M9 no span limit", "RANGE_MAX = 50", "RANGE_MAX = 10**9"),
    (
        "M10 list continuation takes 1-2 digit numbers",
        '_NEXT_ITEM = r"\\d{3,9}(?:-\\d{3,9})?" + _ID_END',
        '_NEXT_ITEM = r"\\d{1,9}(?:-\\d{3,9})?" + _ID_END',
    ),
    ("M11 collision not reported", "if collisions:", "if False:"),
    ("M12 voice not a request", 'if kind in ("voice", "document"):\n        return "request"', 'if False:\n        return "request"'),
    ("M13 comment-only folded into paired", "elif only_in_comment:", "elif False:"),
    ("M14 description mode ignored", 'or (pair_in == "any" and only_in_comment)', "or only_in_comment"),
    ("M15 comma-joined number pairs", "            explicit = False\n", "            explicit = True\n"),
    (
        "M16 first-person imperative not a request",
        '        or re.search(r"(j|ss|zz|ts)(am|em)$", word)  # lassam, nezzem, irjam, tudjam, mentsem\n',
        "",
    ),
    (
        "M17 comma-only request folded into the main list",
        'if not m["paired"] and m["comma_cards"] and not m["comment_cards"]:',
        "if False:",
    ),
]


def run_suite(src: str) -> tuple[int, list[str], bool]:
    """The suite on a copy with `src` as the module: (rc, FAIL lines, crashed). The test file reads the
    README next to it, so the README is copied too; a crash is not a catch."""
    with tempfile.TemporaryDirectory() as tmp:
        shutil.copy(HERE / "test_tulajdonosi_keres_par.py", tmp)
        shutil.copy(HERE / "README.md", tmp)
        (Path(tmp) / "tulajdonosi_keres_par.py").write_text(src, encoding="utf-8")
        r = subprocess.run([sys.executable, "test_tulajdonosi_keres_par.py"], cwd=tmp, capture_output=True, text=True)
    fails = [ln.strip() for ln in r.stdout.splitlines() if ln.startswith("  FAIL")]
    crashed = "Traceback" in r.stderr or "Traceback" in r.stdout
    return r.returncode, fails, crashed


def main() -> int:
    src = (HERE / "tulajdonosi_keres_par.py").read_text(encoding="utf-8")
    rc, fails, crashed = run_suite(src)
    if rc != 0 or fails or crashed:
        print(f"CONTROL: the unmutated copy is not green (rc {rc}, {len(fails)} FAIL, crashed {crashed}); nothing measured")
        return 2
    print("CONTROL: the unmutated copy is green")
    bad = 0
    for name, old, new in MUTANTS:
        if src.count(old) != 1:
            print(f"{name}: ANCHOR FOUND {src.count(old)} TIMES, mutant not applied")
            bad += 1
            continue
        rc, fails, crashed = run_suite(src.replace(old, new))
        if crashed:
            print(f"{name}: CRASHED (rc {rc}), not a catch")
            bad += 1
        elif rc == 0 or not fails:
            print(f"{name}: SURVIVED (rc {rc}, {len(fails)} FAIL)")
            bad += 1
        else:
            print(f"{name}: red, {len(fails)} check(s) failed, first: {fails[0][5:90]}")
    print(f"{len(MUTANTS) - bad} of {len(MUTANTS)} mutants caught")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
