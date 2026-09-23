#!/usr/bin/env python3
"""Branch tests for person-id-scan, run entirely against fixture configuration.

The point of this file is that NO REAL IDENTIFIER APPEARS IN IT. The scanner's job is to keep
person identifiers out of a public fork; a test that pasted a real one in to prove the scanner
works would put it exactly where it must never be. Every id here is synthetic (9990000001..4),
and every run points --root at a throwaway fixture tree.

The three exit states are asserted separately, because the dangerous confusion is not
"found vs not found" but "clean vs could not measure": an unreadable configuration yields an
empty identifier list, and an empty list makes every scan pass. Those cases must exit 2.

Run: python3 scripts/test_person_id_scan.py
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

SCAN = str(Path(__file__).resolve().parent / "person-id-scan.py")
FIXTURE_IDS = ["9990000001", "9990000002", "9990000003", "9990000004"]

RESULTS: list[bool] = []


def check(label: str, condition: bool, detail: str = "") -> None:
    RESULTS.append(bool(condition))
    print("  %s  %s%s" % ("ok  " if condition else "FAIL", label,
                          ("  | " + detail) if detail else ""))


def make_root(tmp: str, *, allow_main=None, allow_sub=None, principals=None,
              corrupt=False) -> str:
    root = Path(tmp)
    main = root / ".claude" / "channels" / "telegram"
    sub = root / "agents" / "sub" / ".claude" / "channels" / "telegram"
    store = root / "store"
    for d in (main, sub, store):
        d.mkdir(parents=True, exist_ok=True)
    if corrupt:
        (main / "access.json").write_text("{ this is not json", encoding="utf-8")
    elif allow_main is not None:
        (main / "access.json").write_text(json.dumps({"allowFrom": allow_main}), encoding="utf-8")
    if allow_sub is not None:
        (sub / "access.json").write_text(json.dumps({"allowFrom": allow_sub}), encoding="utf-8")
    if principals is not None:
        (store / "principals.json").write_text(json.dumps({"principals": principals}),
                                               encoding="utf-8")
    return str(root)


def run(root: str, diff_text: str = "", extra=()) -> tuple[int, str]:
    proc = subprocess.run([sys.executable, SCAN, "--root", root, *extra,
                           *(() if extra else ("--diff", "-"))],
                          input=diff_text.encode("utf-8"), capture_output=True, timeout=120)
    return proc.returncode, (proc.stdout + proc.stderr).decode("utf-8", "replace")


def full_root(tmp: str) -> str:
    return make_root(tmp, allow_main=FIXTURE_IDS[:2], allow_sub=[FIXTURE_IDS[2]],
                     principals={FIXTURE_IDS[0]: "owner", FIXTURE_IDS[3]: "staff"})


DIFF_HIT = """diff --git a/scripts/hooks/telegram_progress.py b/scripts/hooks/telegram_progress.py
--- a/scripts/hooks/telegram_progress.py
+++ b/scripts/hooks/telegram_progress.py
@@ -10,6 +10,8 @@ def deliver():
     chats = load()
+    QUIET_CHATS = {"9990000002"}
     for c in chats:
+        if c == 9990000003: continue
         send(c)
"""

DIFF_CLEAN = """diff --git a/docs/readme.md b/docs/readme.md
--- a/docs/readme.md
+++ b/docs/readme.md
@@ -1,1 +1,2 @@
 intro
+a line with a harmless number 12345 and a version 1.2.3
"""

DIFF_EMBEDDED = """diff --git a/x.md b/x.md
--- a/x.md
+++ b/x.md
@@ -1,1 +1,2 @@
 intro
+order number 19990000001234 is not a chat id
"""


def main() -> int:
    print("fixture identifiers: %s (synthetic, not real)\n" % ", ".join(FIXTURE_IDS))

    with tempfile.TemporaryDirectory() as tmp:
        root = full_root(tmp)
        print("A) the two evening cases, reproduced with fixture ids")
        rc, out = run(root, DIFF_HIT)
        check("exit 1 (findings)", rc == 1, "rc=%d" % rc)
        check("both occurrences reported", out.count("telegram_progress.py:") == 2,
              "%d reported" % out.count("telegram_progress.py:"))
        check("reported as file:line", "telegram_progress.py:11" in out
              and "telegram_progress.py:13" in out)
        # the load-bearing one: nothing in the output may be a full identifier
        leaked = [i for i in FIXTURE_IDS if i in out]
        check("NO identifier printed in full", not leaked, "leaked: %s" % (leaked or "none"))
        check("masked form shown instead", "*******002" in out and "*******003" in out)

        print("\nB) a clean diff is clean")
        rc, out = run(root, DIFF_CLEAN)
        check("exit 0", rc == 0, "rc=%d" % rc)
        check("says clean", "clean:" in out)

        print("\nC) an identifier embedded in a longer number is NOT a match")
        rc, out = run(root, DIFF_EMBEDDED)
        check("exit 0 (no false positive)", rc == 0, "rc=%d" % rc)

        print("\nD) --files mode scans whole files")
        target = Path(tmp) / "leak.txt"
        target.write_text("harmless\nchat = %s\n" % FIXTURE_IDS[1], encoding="utf-8")
        rc, out = run(root, extra=("--files", str(target)))
        check("exit 1 and the line number is right", rc == 1 and "leak.txt:2" in out,
              "rc=%d" % rc)
        check("still masked", FIXTURE_IDS[1] not in out)

    print("\nE) UNMEASURED beats a vacuous pass (this is the dangerous direction)")
    with tempfile.TemporaryDirectory() as tmp:
        bare = make_root(tmp)                       # directories exist, no config files
        rc, out = run(bare, DIFF_HIT)
        check("no configuration at all -> exit 2", rc == 2, "rc=%d" % rc)
        check("and it says so, loudly", "UNMEASURED" in out)
        check("it does NOT claim a clean result", "clean:" not in out)
    with tempfile.TemporaryDirectory() as tmp:
        empty = make_root(tmp, allow_main=[], principals={})
        rc, out = run(empty, DIFF_HIT)
        check("present but EMPTY configuration -> exit 2", rc == 2, "rc=%d" % rc)
        check("names the reason (an empty list passes everything)",
              "empty" in out.lower(), "")
    with tempfile.TemporaryDirectory() as tmp:
        broken = make_root(tmp, corrupt=True, principals={})
        rc, out = run(broken, DIFF_HIT)
        check("unreadable configuration -> exit 2", rc == 2, "rc=%d" % rc)
        check("the unreadable source is named", "UNREADABLE" in out)

    print("\nF) the identifier list is a UNION of every source")
    with tempfile.TemporaryDirectory() as tmp:
        # only the SUB-agent channel knows 9990000003, and principals does not
        only_sub = make_root(tmp, allow_main=[FIXTURE_IDS[0]], allow_sub=[FIXTURE_IDS[2]],
                             principals={FIXTURE_IDS[0]: "owner"})
        rc, out = run(only_sub, DIFF_HIT)
        check("an id known ONLY to a sub-agent channel is still found", rc == 1 and "*******003" in out,
              "rc=%d" % rc)
        # control: the same tree WITHOUT the sub-agent source must not find it
        sub_file = Path(tmp) / "agents" / "sub" / ".claude" / "channels" / "telegram" / "access.json"
        sub_file.unlink()
        rc2, out2 = run(only_sub, DIFF_HIT)
        check("CONTROL: without that source it is NOT found (so F proves the union)",
              "*******003" not in out2, "rc=%d" % rc2)

    total = len(RESULTS)
    print("\n=> %d/%d ok" % (sum(RESULTS), total))
    return 0 if all(RESULTS) else 1


if __name__ == "__main__":
    sys.exit(main())
