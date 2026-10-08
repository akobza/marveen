#!/usr/bin/env python3
"""PreToolUse gate: no Telegram send into a chat's quiet hours (card 20e178fc).

The owner's rule is "no Telegram message at all between 23:00 and 07:00, not even a
reply". Until this gate the rule had no machine behind it: telegram-reply-guard.py
only stops DEMANDING a reply inside the window (cards 30d968cd / 352c3b42), and the
reply tool itself sent whatever the model wrote. This gate stops it.

What it gates: the Telegram reply, react and edit_message tools (download_attachment
only reads). The decision is telegram_quiet_hours.send_decision(), shared with
telegram_fallback_send.py, so the manual Bot API fallback cannot slip past it.

Decision (card 20e178fc):
  - STOP, not queue: exit 2, the reason and the way forward on stderr. Nothing is
    stored for a later send: what the night produces goes out after the window, in
    ONE batched message, by the agent's own batching path.
  - A missing quiet-hours.json is a deployment defect only on an install that has
    used one: the quiet-hours.seen marker in the install's store directory, written
    atomically the first time a real send is evaluated against a usable config
    (never by a probe call, which names no gated tool). Without the marker a missing
    file means no quiet hours. With it, and for a file that exists but cannot be
    read or an entry that is malformed, every chat is stopped inside the fallback
    window (23:00-07:00 Europe/Budapest), the send goes outside it, and either way a
    line naming the file and the reason goes to the hook error log (hook_errlog.py)
    and to stderr. An earlier form of the rule, "missing = the fallback window",
    would have silenced every install without a config every night.
  - No exception path inside the gate: what the stopped model could open itself
    would not be a gate. The window is the config, and the config is the owner's.

Where the config is: <install>/.claude/channels/telegram/quiet-hours.json, the
install root resolved from THIS file's location, for every agent that runs the gate
(the main agent and every sub-agent with a Telegram bot alike). A private chat's id
is the user's id, the same under every bot, so the quiet hours belong to the person,
not to the bot; a sub-agent's own state dir has no quiet-hours.json and must not
count as "missing" (that would stop its bot every night towards its own principal).

The module is loaded from this file's OWN directory by path, never through
sys.path: telegram-reply-guard.py puts ~/.claude/hooks in front of its own directory
and so loads an unversioned copy there; a gate must not depend on what happens to
sit in a home directory.

Exit codes: 0 = allow, 2 = block (stderr goes back to the model). Any failure of the
gate itself at run time (unreadable payload, import error, a bug) is a block too: a
send gate that fails open is no gate. A failure before Python runs this file (a
syntax error, no python3) is the command wrapper's to turn into a block (card
723bbb70), not this file's.
"""
import importlib.util
import json
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
INSTALL_ROOT = os.path.realpath(os.path.join(HERE, "..", ".."))
STATE_DIR = os.path.join(INSTALL_ROOT, ".claude", "channels", "telegram")
SEEN_PATH = os.path.join(INSTALL_ROOT, "store", "quiet-hours.seen")

GATED_TOOLS = {
    "mcp__plugin_telegram_telegram__reply",
    "mcp__plugin_telegram_telegram__react",
    "mcp__plugin_telegram_telegram__edit_message",
}

HOOK = "telegram-quiet-gate"


def _load(name):
    """Import a sibling module by file path (see the docstring: never via sys.path)."""
    spec = importlib.util.spec_from_file_location("_quiet_gate_" + name, os.path.join(HERE, name + ".py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _report_defect(defect):
    sys.stderr.write("CSENDES-IDO KAPU, TELEPITESI HIBA: %s\n" % defect)
    try:
        _load("hook_errlog").report(HOOK, defect)
    except Exception:
        pass  # the stderr line above already carries it


def decide(payload, state_dir, now_epoch, seen_path):
    """(allow, stderr_text). Writes only the defect report and, for a real send, the marker;
    tests call it with their own clock and paths."""
    tool = str(payload.get("tool_name") or "")
    if tool not in GATED_TOOLS:
        return True, ""
    tool_input = payload.get("tool_input")
    chat_id = tool_input.get("chat_id") if isinstance(tool_input, dict) else None
    quiet = _load("telegram_quiet_hours")
    hold, why, defect = quiet.send_decision(state_dir, chat_id, now_epoch, seen_path)
    quiet.remember_configured(state_dir, seen_path, HOOK)
    if defect:
        _report_defect(defect)
    if not hold:
        return True, ""
    return False, (
        "CSENDES-IDO KAPU: TILTVA (%s). Oka: %s. A csendes idoben semmilyen Telegram-uzenet nem megy ki "
        "ebbe a chatbe: valasz, reakcio es szerkesztes sem, akkor sem, ha a reply-guard valaszt kerne. "
        "Ne probald mas uton (Bash, Bot API, tartalek-kuldo). Ami most keletkezett, az a csendes ido "
        "utan EGY kotegelt uzenetben megy." % (tool.rsplit("__", 1)[-1], why)
    )


def main():
    try:
        payload = json.load(sys.stdin)
        if not isinstance(payload, dict):
            raise ValueError("the hook payload is not a JSON object")
        allow, text = decide(payload, STATE_DIR, time.time(), SEEN_PATH)
    except Exception as e:
        sys.stderr.write(
            "CSENDES-IDO KAPU: TILTVA, mert a kapu maga hibazott (%s: %s). Egy kuldo kapu hibaja nem engedhet at.\n"
            % (type(e).__name__, str(e)[:300]))
        sys.exit(2)
    if not allow:
        sys.stderr.write(text + "\n")
        sys.exit(2)
    sys.exit(0)


if __name__ == "__main__":
    main()
