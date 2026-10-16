#!/usr/bin/env python3
"""Quiet-hours SEND gate (card 20e178fc): scripts/hooks/telegram-quiet-gate.py,
telegram_quiet_hours.send_decision() and the quiet check of telegram_fallback_send.py.

Run: python3 scripts/__tests__/telegram-quiet-gate.test.py
Exit 0 = pass. Discovered and executed by src/__tests__/script-tests-runner.test.ts,
which invokes every scripts/__tests__/*.test.py WITHOUT arguments, so this file takes
none and needs nothing outside the repo (no network, no real configuration).

WHAT IT PINS
  - the decision at fixed instants on both sides of both DST changes (Europe/Budapest)
    for a 23:00-07:00 window: a CEST and a CET day, the doubled 02:30 of 2026-10-25,
    the skipped hour of 2027-03-28;
  - the config states (card 20e178fc): ok; empty (send); missing WITHOUT the
    install's quiet-hours.seen marker (send, no defect, at any hour); missing WITH the
    marker, unreadable (0 bytes, not JSON, not an object) and a malformed entry (the
    fallback window for every chat, and a defect either way); these run in installs
    whose zone is pinned to Europe/Budapest (SCHEDULER_TZ in the install's .env);
  - the marker: written only for a usable config that names a chat, only once,
    atomically (no temp file left behind), never by a probe call;
  - the fallback's windows (ISSUE1895 and the card 23724bf8 re-layer): no zone written
    into the module; an entry without "tz" reads the install's zone; an unusable config
    holds the LAST fully read config's windows with their own zone (Europe/Budapest on
    an install whose zone is UTC: 23:30 Budapest held, 07:30 Budapest sent); an install
    that never had a usable config holds 23:00-07:00 in the install's zone; the kept
    windows are not replaced by a partly malformed or an empty config, only by a
    changed usable one, and a broken kept file falls back to the install's zone;
  - a call that names no chat: held while any configured window holds;
  - the gate end to end in a throwaway install (subprocess, the real stdin payload):
    reply, react and edit_message held for the protected chat inside its window,
    download_attachment and another chat allowed, the window's outside allowed, a
    broken payload and a missing module blocked (fail-closed), the defect line in the
    error log, the marker written by a real send and not by the hook-load watcher's
    HookLoadProbe call or by download_attachment;
  - the fallback sender: exit 3 inside the window, and a pass at any hour on an install
    with neither a config nor a marker, with no network call possible either way;
  - the main agent's committed settings: the gate under a matcher that full-matches
    the three tools and not download_attachment, inside the card 723bbb70 fail-closed
    tail: run through bash, the intact gate's decision is unchanged and a gate file
    with a syntax error blocks (rc 2), where the raw call lets it through (rc 1).
    (The same matcher also covers Bash since card 23724bf8: the Bash branch is pinned
    in telegram-quiet-gate-bash.test.py.)

NEGATIVE CONTROL, IN THIS FILE
  The gate is copied with its decision cut out (the send_decision call replaced by a
  constant "send"), and the in-window probe must NOT block on that copy. The cut is
  verified (the marker found exactly once), so a marker drift fails loudly instead of
  turning the control vacuous. A probe that stays green on the cut copy measures nothing.
  For the last good windows: the same unusable config on the same UTC install WITHOUT
  the kept file sends at 23:30 Budapest -- what the fallback did before it kept them.

DATA
  No real identifier: the chat ids "999" (protected) and "888" (another chat) are
  fixtures, and every config lives in a temp dir this file creates and removes.
"""
import datetime
import importlib.util
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
from zoneinfo import ZoneInfo

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
HOOKS = os.path.join(REPO, "scripts", "hooks")
GATE = os.path.join(HOOKS, "telegram-quiet-gate.py")
TZ = ZoneInfo("Europe/Budapest")
PROTECTED, OTHER = "999", "888"
WINDOW = {"start": "23:00", "end": "07:00", "tz": "Europe/Budapest"}
TOOL = "mcp__plugin_telegram_telegram__"
GATED = [TOOL + "reply", TOOL + "react", TOOL + "edit_message"]
FAILS = []
TEMPS = []


def check(cond, label):
    print(("ok   " if cond else "FAIL ") + label)
    if not cond:
        FAILS.append(label)


def temp(prefix):
    d = tempfile.mkdtemp(prefix=prefix)
    TEMPS.append(d)
    return d


def load_module():
    spec = importlib.util.spec_from_file_location("quiet_hours_under_test", os.path.join(HOOKS, "telegram_quiet_hours.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def pinned_root(prefix, zone):
    """A throwaway install directory whose zone is pinned: <root>/.env with SCHEDULER_TZ=<zone>."""
    root = temp(prefix)
    with open(os.path.join(root, ".env"), "w", encoding="utf-8") as f:
        f.write("SCHEDULER_TZ=%s\n" % zone)
    return root


def state(cfg):
    """A state dir with the given quiet-hours.json (a dict, or a raw string), or none (None)."""
    d = temp("quiet-gate-state-")
    if cfg is not None:
        with open(os.path.join(d, "quiet-hours.json"), "w", encoding="utf-8") as f:
            f.write(cfg if isinstance(cfg, str) else json.dumps(cfg))
    return d


def z(iso):
    return int(datetime.datetime.strptime(iso, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=datetime.timezone.utc).timestamp())


def around_now(start_min, end_min):
    now = datetime.datetime.now(TZ)
    return {"start": (now + datetime.timedelta(minutes=start_min)).strftime("%H:%M"),
            "end": (now + datetime.timedelta(minutes=end_min)).strftime("%H:%M"), "tz": "Europe/Budapest"}


def install(cfg, gate_src=None, with_module=True, with_fallback=False):
    """A throwaway install: <root>/scripts/hooks/<the gate and its siblings>, <root>/.claude/channels/telegram/."""
    root = temp("quiet-gate-install-")
    hooks = os.path.join(root, "scripts", "hooks")
    os.makedirs(hooks)
    names = ["hook_errlog.py"] + (["telegram_quiet_hours.py"] if with_module else []) + (["telegram_fallback_send.py"] if with_fallback else [])
    for name in names:
        shutil.copy(os.path.join(HOOKS, name), hooks)
    with open(os.path.join(hooks, "telegram-quiet-gate.py"), "w", encoding="utf-8") as f:
        f.write(gate_src if gate_src is not None else open(GATE, encoding="utf-8").read())
    sd = os.path.join(root, ".claude", "channels", "telegram")
    os.makedirs(sd)
    if cfg is not None:
        with open(os.path.join(sd, "quiet-hours.json"), "w", encoding="utf-8") as f:
            json.dump(cfg, f)
    return root


def run_gate(root, payload=None, raw=None):
    env = dict(os.environ, HOOK_ERRLOG_PATH=os.path.join(root, "hook-errors.log"))
    p = subprocess.run([sys.executable, os.path.join(root, "scripts", "hooks", "telegram-quiet-gate.py")],
                       input=raw if raw is not None else json.dumps(payload), capture_output=True, text=True,
                       timeout=60, env=env)
    return p.returncode, p.stderr


def call(tool, chat=PROTECTED):
    return {"tool_name": tool, "tool_input": {"chat_id": chat, "text": "teszt"}}


q = load_module()

# 1. Fixed instants, both DST changes ------------------------------------------------
ok_dir = state({PROTECTED: WINDOW})
NO_SEEN = os.path.join(pinned_root("quiet-gate-noseen-", "Europe/Budapest"), "store", "quiet-hours.seen")  # a marker that does not exist


def decision(d, chat, at, seen=NO_SEEN):
    return q.send_decision(d, chat, at, seen)


def marker(zone="Europe/Budapest"):
    d = pinned_root("quiet-gate-seen-", zone)
    path = os.path.join(d, "store", "quiet-hours.seen")
    os.makedirs(os.path.dirname(path))
    open(path, "w").close()
    return path

POINTS = [
    ("2026-10-08T20:59:59Z", False, "CEST day 22:59:59"),
    ("2026-10-08T21:00:00Z", True, "CEST day 23:00:00"),
    ("2026-10-09T04:59:59Z", True, "CEST day 06:59:59"),
    ("2026-10-09T05:00:00Z", False, "CEST day 07:00:00"),
    ("2026-11-05T21:59:59Z", False, "CET day 22:59:59"),
    ("2026-11-05T22:00:00Z", True, "CET day 23:00:00"),
    ("2026-11-06T05:59:59Z", True, "CET day 06:59:59"),
    ("2026-11-06T06:00:00Z", False, "CET day 07:00:00"),
    ("2026-10-25T00:30:00Z", True, "fall-back night, the first 02:30 (CEST)"),
    ("2026-10-25T01:30:00Z", True, "fall-back night, the second 02:30 (CET)"),
    ("2026-10-25T05:59:59Z", True, "fall-back morning 06:59:59 CET"),
    ("2026-10-25T06:00:00Z", False, "fall-back morning 07:00:00 CET"),
    ("2027-03-28T00:59:59Z", True, "spring-forward night 01:59:59 CET"),
    ("2027-03-28T01:00:00Z", True, "spring-forward night 03:00:00 CEST (02:00-03:00 never happens)"),
    ("2027-03-28T04:59:59Z", True, "spring-forward morning 06:59:59 CEST"),
    ("2027-03-28T05:00:00Z", False, "spring-forward morning 07:00:00 CEST"),
]
for iso, want, label in POINTS:
    hold, why, defect = decision(ok_dir, PROTECTED, z(iso))
    check(hold == want and defect is None, "decision, %s (%s) -> %s" % (label, iso, "hold" if want else "send"))
for iso in ("2026-10-25T00:30:00Z", "2026-10-25T01:30:00Z"):
    check("helyi ido most 02:30" in decision(ok_dir, PROTECTED, z(iso))[1], "the doubled hour reads 02:30 local both times (%s)" % iso)
night, day = z("2026-10-08T21:30:00Z"), z("2026-10-08T12:00:00Z")
check(decision(ok_dir, OTHER, night)[:1] == (False,), "another chat inside the protected chat's window: send")
check(decision(ok_dir, int(PROTECTED), night)[0] is True, "a numeric chat_id is the same chat")

# 2. Config states -------------------------------------------------------------------------
hold, why, defect = decision(state({}), PROTECTED, night)
check(not hold and defect is None, "empty config (an install without quiet hours): send, no defect")
for at, when in ((night, "at night"), (day, "by day")):
    hold, why, defect = decision(state(None), PROTECTED, at)
    check(not hold and defect is None, "missing config WITHOUT the marker %s: send, no defect (an install that never had quiet hours)" % when)
seen = marker()
d = state(None)
hold, why, defect = decision(d, OTHER, night, seen)
check(hold and defect and "missing" in defect and "quiet-hours.json" in defect and seen in defect,
      "missing config WITH the marker at night: held for ANY chat, the defect names the file and the marker")
hold, why, defect = decision(d, OTHER, day, seen)
check(not hold and defect and "missing" in defect, "missing config WITH the marker by day: send, the defect is still reported")
for raw, what in (("", "a 0-byte file"), ("{not json", "a file that is not JSON"), ("[1, 2]", "a file that is not an object")):
    d = state(raw)
    hold, why, defect = decision(d, OTHER, night)
    check(hold and defect and "unreadable" in defect and "quiet-hours.json" in defect,
          "%s, no marker, at night: held for ANY chat, the defect names the file and 'unreadable'" % what)
    hold, why, defect = decision(d, OTHER, day)
    check(not hold and defect and "unreadable" in defect, "%s by day: send, the defect is still reported" % what)
for entry, what in (({"start": "25:00", "end": "07:00", "tz": "Europe/Budapest"}, "an hour out of range"),
                    ({"start": "23:00", "end": "07:60", "tz": "Europe/Budapest"}, "a minute out of range"),
                    ({"start": "23:00", "end": "07:00", "tz": "Nowhere/Nothing"}, "an unknown time zone"),
                    ("23:00-07:00", "an entry that is not an object")):
    d = state({PROTECTED: entry})
    hold, why, defect = decision(d, PROTECTED, night)
    check(hold and defect and PROTECTED in defect, "malformed entry (%s) at night: held, the defect names the chat" % what)
    check(not decision(d, PROTECTED, day)[0], "malformed entry (%s) by day: send" % what)

# 2b. The marker --------------------------------------------------------------------------
store = os.path.join(temp("quiet-gate-store-"), "store")  # does not exist yet: the writer creates it
seen_new = os.path.join(store, "quiet-hours.seen")
check(q.remember_configured(state({}), seen_new, "test") is False and not os.path.exists(seen_new), "marker: an empty {} config writes no marker")
check(q.remember_configured(state(None), seen_new, "test") is False and not os.path.exists(seen_new), "marker: a missing config writes no marker")
check(q.remember_configured(state(""), seen_new, "test") is False and not os.path.exists(seen_new), "marker: a 0-byte config writes no marker")
check(q.remember_configured(ok_dir, seen_new, "test") is True and os.path.exists(seen_new), "marker: a usable config naming a chat writes it (the store dir created)")
body = open(seen_new, encoding="utf-8").read()
check(json.loads(body).get("config") == os.path.join(ok_dir, "quiet-hours.json") and json.loads(body).get("by") == "test", "marker: it names the config and the writer")
check(q.remember_configured(ok_dir, seen_new, "again") is False and open(seen_new, encoding="utf-8").read() == body, "marker: a second call does not rewrite it")
check(sorted(os.listdir(store)) == ["quiet-hours.last-good.json", "quiet-hours.seen"], "marker and last good windows: no temp file left beside them")

# 2c. The fallback's windows: the install's zone, and the last good config's own ------------
check("Europe/Budapest" not in open(os.path.join(HOOKS, "telegram_quiet_hours.py"), encoding="utf-8").read(),
      "no zone is written into the module (ISSUE1895)")
NIGHT_BP, MORNING_BP = z("2026-10-08T21:30:00Z"), z("2026-10-09T05:30:00Z")  # 23:30 and 07:30 in Budapest, 21:30 and 05:30 UTC
NIGHT_NY, DAY_NY = z("2026-10-09T03:30:00Z"), z("2026-10-08T21:30:00Z")  # 23:30 and 17:30 in New York
no_tz = state({PROTECTED: {"start": "23:00", "end": "07:00"}})
ny_seen = os.path.join(pinned_root("quiet-gate-ny-", "America/New_York"), "store", "quiet-hours.seen")
check(decision(no_tz, PROTECTED, NIGHT_NY, ny_seen)[0] is True and decision(no_tz, PROTECTED, DAY_NY, ny_seen)[0] is False,
      "an entry without tz reads the install's zone: held 23:30 New York, sent 17:30 New York (= 23:30 Budapest)")
check("America/New_York" in decision(no_tz, PROTECTED, NIGHT_NY, ny_seen)[1], "the reason names the install's zone for an entry without tz")
# the install zone's own sources: config-overrides.json over .env, a quoted .env value, a zone that is not real
pin = temp("quiet-gate-pin-")
os.makedirs(os.path.join(pin, "store"))
with open(os.path.join(pin, ".env"), "w", encoding="utf-8") as f:
    f.write("SCHEDULER_TZ=Europe/Budapest\n")
with open(os.path.join(pin, "store", "config-overrides.json"), "w", encoding="utf-8") as f:
    json.dump({"SCHEDULER_TZ": "America/New_York"}, f)
check(q.install_zone(pin) == "America/New_York", "the install zone: SCHEDULER_TZ in config-overrides.json wins over the .env one")
pin_seen = os.path.join(pin, "store", "quiet-hours.seen")
check(decision(no_tz, PROTECTED, NIGHT_NY, pin_seen)[0] is True and decision(no_tz, PROTECTED, NIGHT_BP, pin_seen)[0] is False,
      "an entry without tz on that install: held 23:30 New York, sent 23:30 Budapest (the .env zone loses)")
with open(os.path.join(pin, "store", "config-overrides.json"), "w", encoding="utf-8") as f:
    json.dump({"SCHEDULER_TZ": "Nowhere/Nothing"}, f)
check(q.install_zone(pin) == (q._host_zone() or "UTC"), "an override that is no real zone: the host zone, the .env one is not read (the rule of config.ts)")
quoted = temp("quiet-gate-quoted-")
with open(os.path.join(quoted, ".env"), "w", encoding="utf-8") as f:
    f.write("SCHEDULER_TZ=Europe/Berlin\nSCHEDULER_TZ=\"America/New_York\"\n")
check(q.install_zone(quoted) == "America/New_York", "the .env: the last SCHEDULER_TZ line wins, one pair of quotes dropped")
utc_seen = marker("UTC")
check(decision(ok_dir, PROTECTED, NIGHT_BP, utc_seen)[:1] == (True,) and decision(ok_dir, PROTECTED, MORNING_BP, utc_seen)[:1] == (False,),
      "(1) a readable config is unchanged on a UTC install: its own Europe/Budapest window decides")
q.remember_configured(ok_dir, utc_seen, "test")
kept = json.load(open(q.last_good_path(utc_seen), encoding="utf-8"))
check(kept.get("windows") == [WINDOW] and kept.get("by") == "test", "the last good windows are kept beside the marker, with their own zone")
for raw, what in (("", "a 0-byte config"), ("{not json", "a config that is not JSON")):
    broken = state(raw)
    hold, why, defect = decision(broken, OTHER, NIGHT_BP, utc_seen)
    check(hold and "utolso hasznalhato konfig ablaka" in why and "Europe/Budapest" in why and defect,
          "(2) %s on a UTC install with last good windows: 23:30 Budapest held by the kept window, the defect reported" % what)
    check(decision(broken, OTHER, MORNING_BP, utc_seen)[0] is False,
          "(2) %s: 07:30 Budapest (05:30 UTC, inside a UTC 23-07) sent: the kept window, not the install's zone" % what)
hold, why, defect = decision(state(None), OTHER, NIGHT_BP, utc_seen)
check(hold and defect and "missing" in defect, "(2) a config lost after use: the kept window holds 23:30 Budapest")
bad_entry = state({PROTECTED: {"start": "23:00", "end": "07:60", "tz": "Europe/Budapest"}})
check(decision(bad_entry, PROTECTED, NIGHT_BP, utc_seen)[0] is True, "(2) a malformed entry: the kept window holds 23:30 Budapest")
nk_seen = marker("UTC")
hold, why, defect = decision(state(""), OTHER, NIGHT_BP, nk_seen)
check(not hold and "az alapablak" in why and "UTC" in why,
      "(4) NEGATIVE CONTROL: the same broken config on a UTC install without kept windows sends at 23:30 Budapest")
fresh_seen = marker("America/New_York")
hold, why, defect = decision(state(""), OTHER, NIGHT_NY, fresh_seen)
check(hold and "az alapablak" in why and "America/New_York" in why,
      "(3) an install that never had a usable config: 23:00-07:00 in the install's zone holds 23:30 New York")
check(decision(state(""), OTHER, DAY_NY, fresh_seen)[0] is False, "(3) and sends at 17:30 New York")
# the malformed config's readable entry differs from the kept one: a writer that kept the readable part would show
for cfg, what in (({OTHER: {"start": "22:00", "end": "06:00", "tz": "UTC"}, PROTECTED: {"start": "25:00", "end": "07:00", "tz": "UTC"}},
                   "a config with one malformed entry"),
                  ({}, "an empty config")):
    q.remember_configured(state(cfg), utc_seen, "later")
    check(json.load(open(q.last_good_path(utc_seen), encoding="utf-8")).get("by") == "test",
          "the kept windows are not replaced by %s" % what)
two = {PROTECTED: WINDOW, OTHER: {"start": "22:00", "end": "06:00"}}
q.remember_configured(state(two), utc_seen, "changed")
kept = json.load(open(q.last_good_path(utc_seen), encoding="utf-8"))
check(kept.get("by") == "changed" and kept.get("windows") == [WINDOW, {"start": "22:00", "end": "06:00", "tz": "UTC"}],
      "a changed usable config replaces them; an entry without tz is kept with the install's zone of that day")
check(decision(state(""), OTHER, z("2026-10-08T22:30:00Z"), utc_seen)[0] is True,
      "with two kept windows, a time inside either one holds (22:30 UTC: inside 22:00-06:00 UTC)")
q.remember_configured(state(two), utc_seen, "unchanged")
check(json.load(open(q.last_good_path(utc_seen), encoding="utf-8")).get("by") == "changed", "the same windows again do not rewrite the file")
open(q.last_good_path(nk_seen), "w").write("{broken")
check("az alapablak" in decision(state(""), OTHER, NIGHT_BP, nk_seen)[1], "a broken kept file: the install's zone default, no crash")

# 3. A call that names no chat ---------------------------------------------------------
for chat in (None, "", "  "):
    check(decision(ok_dir, chat, night)[0] is True, "no chat_id (%r) while a configured window holds: held" % (chat,))
    check(decision(ok_dir, chat, day)[0] is False, "no chat_id (%r) outside every window: send" % (chat,))

# 4. The gate end to end, in a throwaway install ----------------------------------------
inside = install({PROTECTED: around_now(-60, 60)})
for tool in GATED:
    rc, err = run_gate(inside, call(tool))
    check(rc == 2 and "CSENDES-IDO KAPU: TILTVA" in err, "gate: %s to the protected chat inside its window -> exit 2" % tool.rsplit("__", 1)[-1])
rc, err = run_gate(inside, call(TOOL + "download_attachment"))
check(rc == 0, "gate: download_attachment (it only reads) -> exit 0")
rc, err = run_gate(inside, call(TOOL + "reply", OTHER))
check(rc == 0, "gate: a reply to another chat inside the protected window -> exit 0")
rc, err = run_gate(inside, {"tool_name": TOOL + "reply", "tool_input": "not an object"})
check(rc == 2, "gate: a tool_input that is not an object (no chat) inside a window -> exit 2")
rc, err = run_gate(inside, raw="{")
check(rc == 2 and "hibazott" in err, "gate: a payload that is not JSON -> exit 2 (fail-closed)")
rc, err = run_gate(install({PROTECTED: around_now(-60, 60)}, with_module=False), call(TOOL + "reply"))
check(rc == 2 and "hibazott" in err, "gate: the shared module missing -> exit 2 (fail-closed)")
outside = install({PROTECTED: around_now(120, 180)})
rc, err = run_gate(outside, call(TOOL + "reply"))
check(rc == 0, "gate: the protected chat outside its window -> exit 0")


def errlog(root):
    p = os.path.join(root, "hook-errors.log")
    return open(p, encoding="utf-8").read() if os.path.exists(p) else ""


def seen_at(root):
    return os.path.join(root, "store", "quiet-hours.seen")


check(os.path.exists(seen_at(inside)), "gate: a real send evaluated against a usable config wrote the install's marker")
fresh = install({PROTECTED: around_now(-60, 60)})
probe = {"hook_event_name": "PreToolUse", "tool_name": "HookLoadProbe", "tool_input": {}}
rc, err = run_gate(fresh, probe)
check(rc == 0 and not os.path.exists(seen_at(fresh)), "gate: the hook-load watcher's HookLoadProbe call -> exit 0, and no marker written")
rc, err = run_gate(fresh, call(TOOL + "download_attachment"))
check(rc == 0 and not os.path.exists(seen_at(fresh)), "gate: download_attachment -> exit 0, and no marker written")
never = install(None)
rc, err = run_gate(never, call(TOOL + "reply", PROTECTED))
check(rc == 0 and errlog(never) == "" and not os.path.exists(seen_at(never)),
      "gate: no config and no marker -> exit 0 at any hour, no defect line, no marker")
lost = install(None)
expect_hold = q._window_holds(q.FALLBACK_WINDOW, time.time(), lost)[0]  # no kept windows there: the install's zone
edge = datetime.datetime.now(ZoneInfo(q.install_zone(lost))).strftime("%H:%M") in ("22:59", "23:00", "06:59", "07:00")
os.makedirs(os.path.join(lost, "store"))
open(seen_at(lost), "w").close()
rc, err = run_gate(lost, call(TOOL + "reply", OTHER))
check("quiet-hours.json" in err and "missing" in errlog(lost) and "telegram-quiet-gate" in errlog(lost),
      "gate: a config lost after use (the marker is there) leaves the defect on stderr and in the error log")
check(edge or rc == (2 if expect_hold else 0), "gate: a config lost after use -> the fallback window decides (now %s, exit %d)" % ("held" if expect_hold else "send", rc))
empty_file = install(None)
open(os.path.join(empty_file, ".claude", "channels", "telegram", "quiet-hours.json"), "w").close()
rc, err = run_gate(empty_file, call(TOOL + "reply", OTHER))
check("unreadable" in errlog(empty_file), "gate: a 0-byte config is a defect in the error log, with no marker needed")
check(edge or rc == (2 if expect_hold else 0), "gate: a 0-byte config -> the fallback window decides (now %s, exit %d)" % ("held" if expect_hold else "send", rc))

kept_inst = install({PROTECTED: around_now(-60, 60)})
rc, err = run_gate(kept_inst, call(TOOL + "reply", OTHER))
check(rc == 0 and os.path.exists(os.path.join(kept_inst, "store", "quiet-hours.last-good.json")),
      "gate: a real send evaluated against a usable config keeps its windows in the install's store")
os.remove(os.path.join(kept_inst, ".claude", "channels", "telegram", "quiet-hours.json"))
rc, err = run_gate(kept_inst, call(TOOL + "reply", OTHER))
check(rc == 2 and "utolso hasznalhato konfig ablaka" in err,
      "gate: the config lost after that -> the kept Budapest window (now inside it) holds any chat, exit 2")

# 5. The fallback sender -----------------------------------------------------------------
fb = install({PROTECTED: around_now(-60, 60)}, with_fallback=True)
token_dir = temp("quiet-gate-token-")  # no .env: a send attempt stops at the token, never at the network
fb_env = dict(os.environ, TELEGRAM_API_BASE="http://127.0.0.1:9", HOOK_ERRLOG_PATH=os.path.join(fb, "hook-errors.log"))
p = subprocess.run([sys.executable, os.path.join(fb, "scripts", "hooks", "telegram_fallback_send.py"), PROTECTED, "teszt",
                    "--state-dir", token_dir], capture_output=True, text=True, timeout=60, env=fb_env)
check(p.returncode == 3 and "NOT SENT, quiet hours" in p.stderr, "fallback sender: the protected chat inside its window -> exit 3, not sent")
p = subprocess.run([sys.executable, os.path.join(fb, "scripts", "hooks", "telegram_fallback_send.py"), OTHER, "teszt",
                    "--state-dir", token_dir], capture_output=True, text=True, timeout=60, env=fb_env)
check(p.returncode == 2 and "TELEGRAM_BOT_TOKEN" in p.stderr, "fallback sender: another chat passes the quiet check (and stops at the missing token)")
fb_none = install(None, with_fallback=True)
p = subprocess.run([sys.executable, os.path.join(fb_none, "scripts", "hooks", "telegram_fallback_send.py"), PROTECTED, "teszt",
                    "--state-dir", token_dir], capture_output=True, text=True, timeout=60,
                   env=dict(fb_env, HOOK_ERRLOG_PATH=os.path.join(fb_none, "hook-errors.log")))
check(p.returncode == 2 and "TELEGRAM_BOT_TOKEN" in p.stderr and "QUIET-HOURS DEFECT" not in p.stderr,
      "fallback sender: no config and no marker -> passes the quiet check at any hour, no defect")

# 6. The main agent's committed settings ----------------------------------------------------
settings = json.load(open(os.path.join(REPO, ".claude", "settings.json"), encoding="utf-8"))
entries = [e for e in settings.get("hooks", {}).get("PreToolUse", []) if "telegram-quiet-gate.py" in json.dumps(e)]
check(len(entries) == 1, "main settings: exactly one PreToolUse entry runs telegram-quiet-gate.py")
matcher = entries[0].get("matcher", "") if entries else ""
for tool in GATED:
    check(re.fullmatch(matcher, tool) is not None, "main settings: the matcher covers %s" % tool)
check(re.fullmatch(matcher, TOOL + "download_attachment") is None, "main settings: the matcher leaves download_attachment alone")
command = entries[0]["hooks"][0]["command"] if entries else ""
check("governance-kapu (fail-closed): telegram-quiet-gate.py" in command and command.endswith('exit "$rc"'),
      "main settings: the entry carries the 723bbb70 fail-closed tail")


def run_entry(root, payload, cmd):
    env = dict(os.environ, CLAUDE_PROJECT_DIR=root, HOOK_ERRLOG_PATH=os.path.join(root, "hook-errors.log"))
    p = subprocess.run(["bash", "-c", cmd], input=json.dumps(payload), capture_output=True, text=True, timeout=60, env=env, cwd=root)
    return p.returncode, p.stderr


tail_root = install({PROTECTED: around_now(-60, 60)})
rc, err = run_entry(tail_root, call(TOOL + "reply"), command)
check(rc == 2 and "CSENDES-IDO KAPU: TILTVA" in err and "fail-closed" not in err, "main entry, intact gate: the in-window reply is the gate's own 2")
rc, err = run_entry(tail_root, call(TOOL + "reply", OTHER), command)
check(rc == 0, "main entry, intact gate: another chat goes (0)")
with open(os.path.join(tail_root, "scripts", "hooks", "telegram-quiet-gate.py"), "a", encoding="utf-8") as f:
    f.write("\nthis is ( not python\n")
rc, err = run_entry(tail_root, call(TOOL + "reply", OTHER), command)
check(rc == 2 and "governance-kapu (fail-closed): telegram-quiet-gate.py" in err, "main entry, a syntax error in the gate file: blocked (2) by the tail")
raw_rc, _ = run_entry(tail_root, call(TOOL + "reply", OTHER), 'python3 "$CLAUDE_PROJECT_DIR/scripts/hooks/telegram-quiet-gate.py"')
check(raw_rc == 1, "negative control: the raw call on the same broken file exits 1, which Claude Code lets through")

# 7. NEGATIVE CONTROL: the same in-window probe on a copy with the decision cut out ----------------
src = open(GATE, encoding="utf-8").read()
marker = '        hold, why, defect = quiet.send_decision(state_dir, chat, now_epoch, seen_path)\n'
check(src.count(marker) == 1, "negative control: the decision marker is found exactly once in the gate")
cut = src.replace(marker, '        hold, why, defect = False, "", None\n')
check(cut != src and "send_decision" not in cut.split("def decide", 1)[1], "negative control: the cut removed the decision")
rc, err = run_gate(install({PROTECTED: around_now(-60, 60)}, gate_src=cut), call(TOOL + "reply"))
check(rc == 0, "negative control: without the decision the in-window reply goes through (the probe above measures the gate)")

for d in TEMPS:
    shutil.rmtree(d, ignore_errors=True)
print("\n%d failed" % len(FAILS) if FAILS else "\nall passed")
sys.exit(1 if FAILS else 0)
