#!/usr/bin/env python3
"""Quiet-hours SEND gate, Bash branch (card 23724bf8): scripts/hooks/telegram_bash_send.py, the Bash
branch of scripts/hooks/telegram-quiet-gate.py, its wiring, and the scripts/notify.sh emergency path.

Run: python3 scripts/__tests__/telegram-quiet-gate-bash.test.py
Exit 0 = pass. Discovered and executed by src/__tests__/script-tests-runner.test.ts, which invokes
every scripts/__tests__/*.test.py WITHOUT arguments, so this file takes none and needs nothing outside
the repo (no network, no real configuration, no real token).

WHAT IT PINS
  - the parser: which Bash commands are Bot API sends and to which chat, over the forms the decision
    names (curl and wget; -d, --data-urlencode, -F, --json, a JSON body, the URL's query, @file and
    --post-file bodies; bash -c, eval, $( ), backticks, a heredoc, here-string or pipe fed to a shell,
    wrappers and runners; a URL in a variable), and the commands that are not sends (the host in grep,
    echo, a commit message, a comment, a heredoc that only writes a file, the body of a request to
    another host, a reading method, scripts/notify.sh). A chat it cannot read is None, never a guess;
  - the lexer reads every well-formed case itself (the line-level fallback is for unreadable text
    only), and the fallback still finds the send in a command with an unbalanced quote;
  - the decision, in-process at fixed instants: a send to the protected chat held inside its window and
    sent outside it, another chat sent, an unknown chat held inside any window and sent outside every
    window, one held send stopping a command that also has others; the refusal naming the held chat, or
    asking for the chat_id written out, and naming the emergency path; the config states (missing
    without the marker: send; missing with it: the fallback window, with the defect); the marker
    written by a Bash send and never by a Bash call that sends nothing;
  - end to end in a throwaway install (subprocess, the real stdin payload): held, sent, the emergency
    path let through, and a missing parser module blocking a Bot API command (fail-closed) while every
    other Bash call goes on (the module is not even loaded for them);
  - the main agent's committed entry: its matcher full-matches Bash, and run as written, through its
    fail-closed tail, it holds the in-window send and lets an ordinary command go;
  - scripts/notify.sh, the one exception: it reads no argument but $1, its chat comes only from the
    owner resolver (or is empty), its one send goes to that chat, and nothing else in it reaches the
    Bot API; run in a sandbox with a fake curl, an extra argument and chat-looking environment
    variables do not move its target. If the script's target or parameters change, this file fails:
    the exception must not turn into a way around the gate.

NEGATIVE CONTROLS, IN THIS FILE
  - the gate copied with its Bash branch cut (the parser call replaced by "no sends"): the in-window
    send must go through on that copy, so the probes above measure the branch, not something else;
  - the notify.sh checks run on three mutants (a second argument used as the chat, a chat from the
    environment, a second send path) and must flag each; the first mutant, run in the sandbox, must
    send to the chat it was given, so the sandbox probe can see a moved target.

DATA
  No real identifier: "999" is the protected chat, "888" another chat, "111" the sandbox owner's chat,
  "sandbox-token" the sandbox bot token; every config, body file and install lives in a temp dir this
  file creates and removes.
"""
import contextlib
import datetime
import importlib.util
import io
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from zoneinfo import ZoneInfo

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
HOOKS = os.path.join(REPO, "scripts", "hooks")
GATE = os.path.join(HOOKS, "telegram-quiet-gate.py")
NOTIFY = os.path.join(REPO, "scripts", "notify.sh")
TZ = ZoneInfo("Europe/Budapest")
PROTECTED, OTHER, OWNER = "999", "888", "111"
WINDOW = {"start": "23:00", "end": "07:00", "tz": "Europe/Budapest"}
TOOL = "mcp__plugin_telegram_telegram__"
U = "https://api.telegram.org/bot$TOKEN/sendMessage"
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


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


os.environ["HOOK_ERRLOG_PATH"] = os.path.join(temp("quiet-bash-errlog-"), "hook-errors.log")
parser = load("bash_send_under_test", os.path.join(HOOKS, "telegram_bash_send.py"))
gate = load("quiet_gate_under_test", GATE)

bodies = temp("quiet-bash-bodies-")
for name, text in (("body888.json", json.dumps(dict(chat_id=888, text="x"))), ("form999.txt", "chat_id=999&text=x"),
                   ("id999.txt", "999\n")):
    with open(os.path.join(bodies, name), "w", encoding="utf-8") as f:
        f.write(text)

# 1. The parser ------------------------------------------------------------------------------------
S, M = "sendMessage", None
SENDS = [
    ("curl -d", 'curl -s -X POST "%s" -d chat_id=999 -d text=hi' % U, [(S, "999")]),
    ("another chat, the text from a variable", 'curl -s "%s" -d chat_id=888 --data-urlencode "text=$MSG"' % U, [(S, "888")]),
    ("the chat from an unset variable", 'curl -s "%s" -d "chat_id=$CHAT" -d text=hi' % U, [(S, None)]),
    ("the chat from a variable set in the command", 'C=999; curl -s "%s" -d "chat_id=$C"' % U, [(S, "999")]),
    ("the chat in the URL query", 'curl "https://api.telegram.org/bot$T/sendMessage?chat_id=999&text=hi"', [(S, "999")]),
    ("a JSON body", "curl -H 'Content-Type: application/json' -d '{\"chat_id\": 999, \"text\": \"x\"}' %s" % U, [(S, "999")]),
    ("--json with a channel name", "curl --json '{\"chat_id\":\"@chan_x\",\"text\":\"x\"}' %s" % U, [(S, "@chan_x")]),
    ("wget --post-data=", 'wget -qO- --post-data="chat_id=999&text=hi" "%s"' % U, [(S, "999")]),
    ("wget --post-data, separate value", 'wget -q -O - --post-data "chat_id=999" "%s"' % U, [(S, "999")]),
    ("--data-urlencode", '%s --data-urlencode chat_id=999 --data-urlencode "text=$X"' % ("curl " + U), [(S, "999")]),
    ("-d attached", "curl %s -dchat_id=999" % U, [(S, "999")]),
    ("-sSd clustered", "curl -sSd chat_id=999 %s" % U, [(S, "999")]),
    ("an @file JSON body", "curl -d @body888.json %s" % U, [(S, "888")]),
    ("an @file form body", "curl --data-binary @form999.txt %s" % U, [(S, "999")]),
    ("an @file that cannot be read", "curl -d @nope.json %s" % U, [(S, None)]),
    ("a body from stdin", "echo x | curl -d @- %s" % U, [(S, None)]),
    ("wget --post-file", "wget --post-file=form999.txt %s" % U, [(S, "999")]),
    ("-F chat_id=<file", 'curl -F "chat_id=<id999.txt" -F text=x %s' % U, [(S, "999")]),
    ("--data-urlencode chat_id@file", "curl --data-urlencode chat_id@id999.txt %s" % U, [(S, "999")]),
    ("bash -c", "bash -c 'curl %s -d chat_id=999'" % U, [(S, "999")]),
    ("eval", "eval \"curl %s -d chat_id=999\"" % U.replace("$", "\\$"), [(S, "999")]),
    ("sudo and timeout", "sudo -u bob timeout -k 1 10 curl %s -d chat_id=999" % U, [(S, "999")]),
    ("$( )", "R=$(curl -s %s -d chat_id=999)" % U, [(S, "999")]),
    ("unquoted backticks", "R=`curl -s %s -d chat_id=999`" % U, [(S, "999")]),
    ("a heredoc fed to bash", "bash <<'EOF'\ncurl -s %s -d chat_id=999\nEOF" % U, [(S, "999")]),
    ("a heredoc piped into bash", "cat <<'EOF' | bash\ncurl -s %s -d chat_id=999\nEOF" % U, [(S, "999")]),
    ("echo piped into bash", "echo 'curl -s %s -d chat_id=999' | bash" % U, [(S, "999")]),
    ("a here-string fed to bash", "bash <<< 'curl -s %s -d chat_id=999'" % U, [(S, "999")]),
    ("the URL in a variable", 'API="https://api.telegram.org/bot$TOKEN"; curl "$API/sendMessage" -d chat_id=999', [(S, "999")]),
    ("an unknown URL variable while the host is named", 'echo api.telegram.org; curl "$TG_URL" -d chat_id=999', [(M, "999")]),
    ("a substitution in the token", "curl https://api.telegram.org/bot$(cat /tmp/t x)/sendMessage -d chat_id=999", [(S, "999")]),
    ("a substitution as the host", 'curl "https://$(echo api.telegram.org)/bot1/sendMessage" -d chat_id=999', [(M, "999")]),
    ("upper-case host and method", "curl -d chat_id=999 https://API.Telegram.org/bot1/SENDMESSAGE", [("SENDMESSAGE", "999")]),
    ("ssh with a quoted remote command", "ssh root@host 'curl -s %s -d chat_id=999'" % U, [(S, "999")]),
    ("docker exec", "docker exec -it ctr curl %s -d chat_id=999" % U, [(S, "999")]),
    ("line continuations", 'curl -s -X POST \\\n  "%s" \\\n  -d chat_id=999' % U, [(S, "999")]),
    ("a redirection to a variable", 'curl -s "%s" -d chat_id=888 > "$OUT" 2>&1' % U, [(S, "888")]),
    ("a loop variable", "for c in 999 888; do curl -s %s -d chat_id=$c; done" % U, [(S, None)]),
    ("the method in a variable", "curl https://api.telegram.org/bot$T/$M -d chat_id=999", [(M, "999")]),
    ("copyMessage", "curl https://api.telegram.org/bot$T/copyMessage -d chat_id=999 -d from_chat_id=1", [("copyMessage", "999")]),
    ("forwardMessages", "curl https://api.telegram.org/bot$T/forwardMessages -d chat_id=999", [("forwardMessages", "999")]),
    ("editMessageText", "curl https://api.telegram.org/bot$T/editMessageText -d chat_id=999", [("editMessageText", "999")]),
    ("setMessageReaction", "curl https://api.telegram.org/bot$T/setMessageReaction -d chat_id=999", [("setMessageReaction", "999")]),
    ("sendPhoto by form upload", "curl -F chat_id=999 -F photo=@pic.jpg https://api.telegram.org/bot$T/sendPhoto", [("sendPhoto", "999")]),
    ("two chats in one command", "curl %s -d chat_id=888; curl %s -d chat_id=999" % (U, U), [(S, "888"), (S, "999")]),
    ("a shell function", 'tg() { curl -s %s -d chat_id=$1 -d text="$2"; }; tg 999 hi' % U, [(S, None)]),
    ("curl in a variable", "CURL=curl; $CURL %s -d chat_id=999" % U, [(S, "999")]),
    ("$(which curl)", "$(which curl) %s -d chat_id=999" % U, [(S, "999")]),
    ("xargs", "echo 999 | xargs -I{} curl %s -d chat_id={}" % U, [(S, None)]),
    ("inside if", "if true; then curl %s -d chat_id=999; fi" % U, [(S, "999")]),
    ("no chat_id at all", "curl %s -d text=hi" % U, [(S, None)]),
    # not sends
    ("grep for the host", 'grep -rn "api.telegram.org" scripts/', []),
    ("echo of a send", 'echo "%s chat_id=999"' % U, []),
    ("echo of an unquoted curl line", "echo curl %s -d chat_id=999" % U, []),
    ("a heredoc that writes a file", "cat > /tmp/x.sh <<'EOF'\ncurl -s %s -d chat_id=999\nEOF" % U, []),
    ("a JSON body to another host", "curl -s -X POST http://localhost:3420/api/messages -H 'Content-Type: application/json' "
     "-d '{\"content\":\"curl https://api.telegram.org/bot$T/sendMessage -d chat_id=999\"}'", []),
    ("a Bot API URL as data to another host", 'curl -s http://localhost:3420/x -d "https://api.telegram.org/bot1/sendMessage"', []),
    ("getMe", "curl -s https://api.telegram.org/bot$T/getMe", []),
    ("getUpdates", 'curl -s "https://api.telegram.org/bot$T/getUpdates?offset=1"', []),
    ("the emergency path", 'bash scripts/notify.sh "lemez 95%: api.telegram.org nem erheto el"', []),
    ("a comment", "true # curl %s -d chat_id=999" % U, []),
    ("a commit message", 'git commit -m "gate: curl %s -d chat_id=999 is held"' % U, []),
    ("grep for a curl line", "grep -c 'curl.*api.telegram.org' log.txt", []),
    ("no host at all", "curl -s http://localhost:3420/api/kanban", []),
]
for label, cmd, want in SENDS:
    got = parser.sends(cmd, bodies)
    check(got == want, "parser, %s -> %r%s" % (label, want, "" if got == want else " (got %r)" % (got,)))
lexed = []
for label, cmd, _want in SENDS:
    try:
        parser._lex(cmd)
    except Exception as e:
        lexed.append("%s (%s)" % (label, e))
check(lexed == [], "the lexer reads every case above itself, no fallback (%s)" % (", ".join(lexed) or "all %d" % len(SENDS)))
check(parser.sends('curl %s -d chat_id=999 -d "text=oops' % U) == [(S, "999")], "fallback: an unbalanced quote, the send still found")
check(parser.sends('curl %s -d chat_id=$C -d "text=oops' % U) == [(S, None)], "fallback: an unbalanced quote, a variable chat is None")
check(parser.sends('curl https://api.telegram.org/bot1/getMe -d "x') == [], "fallback: a reading method is no send")
nested = "curl %s -d chat_id=999" % U
for _ in range(parser.MAX_DEPTH + 3):
    nested = "bash -c '" + nested.replace("'", "'\\''") + "'"
check(parser.sends(nested) == [(S, "999")], "beyond the nesting limit the fallback still finds the send")
check(parser.sends(None) == [] and parser.sends("") == [], "no command, no send")

# 2. The decision, in-process, at fixed instants ------------------------------------------------------


def z(iso):
    return int(datetime.datetime.strptime(iso, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=datetime.timezone.utc).timestamp())


def state(cfg):
    d = temp("quiet-bash-state-")
    if cfg is not None:
        with open(os.path.join(d, "quiet-hours.json"), "w", encoding="utf-8") as f:
            json.dump(cfg, f)
    return d


def bash(cmd):
    return {"hook_event_name": "PreToolUse", "tool_name": "Bash", "tool_input": {"command": cmd}, "cwd": bodies}


NIGHT, DAY = z("2026-10-08T21:30:00Z"), z("2026-10-08T12:00:00Z")  # 23:30 and 14:00 in Budapest
ok_dir = state({PROTECTED: WINDOW})
SEND_999 = "curl -s %s -d chat_id=999 -d text=x" % U
SEND_888 = "curl -s %s -d chat_id=888 -d text=x" % U
SEND_ANY = 'curl -s %s -d "chat_id=$CHAT" -d text=x' % U


def decide(payload, d=ok_dir, at=NIGHT, seen=None):
    """gate.decide() with stderr captured; without a marker path, a fresh one per call (a real send
    against a usable config writes the marker, and a shared path would carry it into the next case)."""
    seen = seen or os.path.join(temp("quiet-bash-noseen-"), "store", "quiet-hours.seen")
    err = io.StringIO()
    with contextlib.redirect_stderr(err):
        allow, text = gate.decide(payload, d, at, seen)
    return allow, text, err.getvalue()


allow, text, _ = decide(bash(SEND_999))
check(not allow and "CSENDES-IDO KAPU: TILTVA (Bash" in text and "chat 999" in text,
      "decision: a curl send to the protected chat inside its window is held, the refusal names the chat")
check("scripts/notify.sh" in text and "ird ki a chat_id-t" not in text,
      "decision: the refusal names the emergency path, and asks nothing about a chat it could read")
check(decide(bash(SEND_999), at=DAY)[0], "decision: the same send outside the window goes")
check(decide(bash(SEND_888))[0], "decision: a send to another chat inside the protected window goes")
allow, text, _ = decide(bash(SEND_ANY))
check(not allow and "ismeretlen cimzett" in text and "ird ki a chat_id-t literalisan" in text and "scripts/notify.sh" in text,
      "decision: a chat the command does not spell out, inside a window: held, the refusal asks for the chat_id written out")
check(decide(bash(SEND_ANY), at=DAY)[0], "decision: the unknown chat outside every window goes")
allow, text, _ = decide(bash(SEND_888 + "; " + SEND_999))
check(not allow and "chat 999" in text and "chat 888" not in text, "decision: one held send stops the command, and only the held chat is named")
for cmd in ('bash scripts/notify.sh "lemez 95%"', 'grep -rn "api.telegram.org" scripts/', "curl -s https://api.telegram.org/bot$T/getUpdates",
            "cat > /tmp/x.sh <<'EOF'\n%s\nEOF" % SEND_999, "ls -la", "true"):
    check(decide(bash(cmd))[0], "decision: no send in %r -> allowed inside the window" % cmd.split("\n")[0][:60])
allow, text, _ = decide({"tool_name": TOOL + "reply", "tool_input": {"chat_id": PROTECTED, "text": "x"}})
check(not allow and text.startswith("CSENDES-IDO KAPU: TILTVA (reply)"), "decision: the reply tool keeps its own refusal")
check(decide({"tool_name": "Bash", "tool_input": "not an object"})[0] and decide({"tool_name": "Bash"})[0],
      "decision: a Bash payload without a command string sends nothing")

no_cfg = state(None)
allow, text, err = decide(bash(SEND_ANY), d=no_cfg)
check(allow and err == "", "config missing WITHOUT the marker: an unknown chat goes at night, no defect (an install without quiet hours)")
seen_dir = os.path.join(temp("quiet-bash-seen-"), "store")
os.makedirs(seen_dir)
seen = os.path.join(seen_dir, "quiet-hours.seen")
open(seen, "w").close()
allow, text, err = decide(bash(SEND_888), d=no_cfg, seen=seen)
check(not allow and "TELEPITESI HIBA" in err and "quiet-hours.json" in err,
      "config missing WITH the marker, at night: any chat held by the fallback window, the defect on stderr")
check(decide(bash(SEND_888), d=no_cfg, at=DAY, seen=seen)[0], "config missing WITH the marker, by day: sent")

store = os.path.join(temp("quiet-bash-store-"), "store")
seen_new = os.path.join(store, "quiet-hours.seen")
decide(bash("ls -la"), seen=seen_new)
decide(bash('grep -rn "api.telegram.org" scripts/'), seen=seen_new)
check(not os.path.exists(seen_new), "marker: a Bash call that sends nothing does not write it")
decide(bash(SEND_888), seen=seen_new)
check(os.path.exists(seen_new), "marker: a Bash send evaluated against a usable config writes it")

# 3. End to end, in a throwaway install ------------------------------------------------------------


def around_now(start_min, end_min):
    now = datetime.datetime.now(TZ)
    return {"start": (now + datetime.timedelta(minutes=start_min)).strftime("%H:%M"),
            "end": (now + datetime.timedelta(minutes=end_min)).strftime("%H:%M"), "tz": "Europe/Budapest"}


def install(cfg, gate_src=None, with_parser=True):
    root = temp("quiet-bash-install-")
    hooks = os.path.join(root, "scripts", "hooks")
    os.makedirs(hooks)
    for name in ["hook_errlog.py", "telegram_quiet_hours.py"] + (["telegram_bash_send.py"] if with_parser else []):
        shutil.copy(os.path.join(HOOKS, name), hooks)
    with open(os.path.join(hooks, "telegram-quiet-gate.py"), "w", encoding="utf-8") as f:
        f.write(gate_src if gate_src is not None else open(GATE, encoding="utf-8").read())
    sd = os.path.join(root, ".claude", "channels", "telegram")
    os.makedirs(sd)
    if cfg is not None:
        with open(os.path.join(sd, "quiet-hours.json"), "w", encoding="utf-8") as f:
            json.dump(cfg, f)
    return root


def run(root, payload, cmd=None):
    env = dict(os.environ, CLAUDE_PROJECT_DIR=root, HOOK_ERRLOG_PATH=os.path.join(root, "hook-errors.log"),
               PYTHONDONTWRITEBYTECODE="1")
    argv = ["bash", "-c", cmd] if cmd else [sys.executable, os.path.join(root, "scripts", "hooks", "telegram-quiet-gate.py")]
    p = subprocess.run(argv, input=json.dumps(payload), capture_output=True, text=True, timeout=60, env=env, cwd=root)
    return p.returncode, p.stderr


inside = install({PROTECTED: around_now(-60, 60)})
rc, err = run(inside, bash(SEND_999))
check(rc == 2 and "CSENDES-IDO KAPU: TILTVA (Bash" in err, "gate: the in-window curl send to the protected chat -> exit 2")
check(run(inside, bash(SEND_888))[0] == 0, "gate: a send to another chat inside the window -> exit 0")
check(run(inside, bash('bash scripts/notify.sh "lemez 95%"'))[0] == 0, "gate: the emergency path inside the window -> exit 0")
check(run(inside, bash("true"))[0] == 0, "gate: an ordinary Bash call inside the window -> exit 0")
outside = install({PROTECTED: around_now(120, 180)})
check(run(outside, bash(SEND_999))[0] == 0 and run(outside, bash(SEND_ANY))[0] == 0,
      "gate: outside every window a literal and an unknown chat both go -> exit 0")
no_parser = install({PROTECTED: around_now(-60, 60)}, with_parser=False)
rc, err = run(no_parser, bash(SEND_888))
check(rc == 2 and "hibazott" in err, "gate: the parser module missing, a Bot API command -> exit 2 (fail-closed)")
check(run(no_parser, bash("ls -la"))[0] == 0, "gate: the parser module missing, any other Bash call -> exit 0 (it is not loaded)")

# 4. The main agent's committed entry ---------------------------------------------------------------
settings = json.load(open(os.path.join(REPO, ".claude", "settings.json"), encoding="utf-8"))
entries = [e for e in settings.get("hooks", {}).get("PreToolUse", []) if "telegram-quiet-gate.py" in json.dumps(e)]
check(len(entries) == 1, "main settings: exactly one PreToolUse entry runs telegram-quiet-gate.py")
matcher = entries[0].get("matcher", "") if entries else ""
check(re.fullmatch(matcher, "Bash") is not None, "main settings: the matcher covers Bash")
command = entries[0]["hooks"][0]["command"] if entries else "false"
rc, err = run(inside, bash(SEND_999), command)
check(rc == 2 and "TILTVA (Bash" in err and "fail-closed" not in err, "main entry, run as written: the in-window send is the gate's own 2")
check(run(inside, bash("ls -la"), command)[0] == 0, "main entry, run as written: an ordinary command goes (0)")

# 5. NEGATIVE CONTROL: the same in-window probe on a copy with the Bash branch cut ------------------
src = open(GATE, encoding="utf-8").read()
cut_line = '    found = _load("telegram_bash_send").sends(command, payload.get("cwd"))\n'
check(src.count(cut_line) == 1, "negative control: the parser call is found exactly once in the gate")
cut = src.replace(cut_line, "    found = []\n")
check(run(install({PROTECTED: around_now(-60, 60)}, gate_src=cut), bash(SEND_999))[0] == 0,
      "negative control: without the Bash branch the in-window send goes through (the probes above measure it)")

# 6. scripts/notify.sh, the exception --------------------------------------------------------------
SEND_CALL = ' "$TOKEN" "$CHAT_ID" "$MESSAGE" --data-urlencode "parse_mode=HTML"; then'
CHAT_SOURCES = ['"$(resolve_owner_chat_id "$ENV_FILE")" || CHAT_OK=0', '""']
SOURCED = ['"$SCRIPT_DIR/lib/owner-chat.sh"', '"$SCRIPT_DIR/lib/send-telegram.sh"']


def notify_violations(text):
    code = "\n".join(l for l in text.split("\n") if not l.lstrip().startswith("#"))
    out = []
    if re.search(r"\$\{?[2-9@*#]|\bshift\b|\bgetopts\b", code):
        out.append("reads an argument other than $1")
    sets = re.findall(r"(?m)^\s*(?:export\s+|local\s+|readonly\s+)?CHAT_ID\+?=(.*)$", code)
    if sorted(sets) != sorted(CHAT_SOURCES) or len(re.findall(r"\bCHAT_ID\b", code)) != 3:
        out.append("the chat is set or used otherwise than the owner resolver and the one send: %r" % sets)
    if re.findall(r"send_telegram_message\b(.*)", code) != [SEND_CALL]:
        out.append("the send is not the one call to the resolved chat")
    if re.search(r"api\.telegram\.org|\bcurl\b|\bwget\b|telegram_api_call|telegram_fallback_send", code):
        out.append("a second way to the Bot API")
    if re.findall(r"(?m)^\s*(?:\.|source)\s+(\S+)", code) != SOURCED:
        out.append("sources something other than the two libraries")
    return out


notify_src = open(NOTIFY, encoding="utf-8").read()
check(notify_violations(notify_src) == [], "notify.sh: $1 only, the chat from the owner resolver only, one send to it (%s)"
      % ("; ".join(notify_violations(notify_src)) or "clean"))
anchor = 'MESSAGE="$1"\n'
check(notify_src.count(anchor) == 1 and notify_src.count('CHAT_ID=""\n') == 1, "notify.sh: the mutation anchors are found exactly once")
mutant_arg = notify_src.replace(anchor, anchor + 'CHAT_ID="${2:-$CHAT_ID}"\n')
mutant_env = notify_src.replace('CHAT_ID=""\n', 'CHAT_ID="${TELEGRAM_CHAT_ID:-}"\n')
mutant_send = notify_src + 'curl -s "https://api.telegram.org/bot$TOKEN/sendMessage" -d chat_id=999 -d text=x\n'
for mutant, what in ((mutant_arg, "a second argument as the chat"), (mutant_env, "a chat from the environment"),
                     (mutant_send, "a second send path")):
    check(notify_violations(mutant) != [], "negative control: the notify.sh check flags %s" % what)


def sandbox_send(script_text):
    """Run a notify.sh text in a sandbox install with a fake curl; the arguments curl got, one per line."""
    root = temp("quiet-bash-notify-")
    os.makedirs(os.path.join(root, "scripts", "lib"))
    with open(os.path.join(root, "scripts", "notify.sh"), "w", encoding="utf-8") as f:
        f.write(script_text)
    for lib in ("owner-chat.sh", "send-telegram.sh"):
        shutil.copy(os.path.join(REPO, "scripts", "lib", lib), os.path.join(root, "scripts", "lib", lib))
    with open(os.path.join(root, ".env"), "w", encoding="utf-8") as f:
        f.write("TELEGRAM_BOT_TOKEN=sandbox-token\nALLOWED_CHAT_ID=%s\n" % OWNER)
    fake = temp("quiet-bash-fakebin-")
    log = os.path.join(root, "curl.log")
    with open(os.path.join(fake, "curl"), "w", encoding="utf-8") as f:
        f.write('#!/bin/sh\nfor a in "$@"; do printf \'%s\\n\' "$a" >> "$FAKE_CURL_LOG"; done\nprintf \'{"ok":true}\'\n')
    os.chmod(os.path.join(fake, "curl"), 0o755)
    env = {k: v for k, v in os.environ.items() if k not in ("TMUX", "VITEST", "NODE_ENV", "TELEGRAM_API_BASE")}
    env.update(PATH=fake + os.pathsep + os.environ.get("PATH", ""), HOME=temp("quiet-bash-home-"), FAKE_CURL_LOG=log,
               ALLOWED_CHAT_ID=PROTECTED, TELEGRAM_CHAT_ID=PROTECTED, CHAT_ID=PROTECTED, TELEGRAM_STATE_DIR=temp("quiet-bash-tgstate-"))
    p = subprocess.run(["bash", os.path.join(root, "scripts", "notify.sh"), "proba", PROTECTED, "--chat_id=" + PROTECTED],
                       capture_output=True, text=True, timeout=60, env=env, cwd=root)
    return p.returncode, (open(log, encoding="utf-8").read() if os.path.exists(log) else "")


rc, sent = sandbox_send(notify_src)
check(rc == 0 and "chat_id=%s" % OWNER in sent.split("\n") and PROTECTED not in sent,
      "notify.sh in a sandbox: an extra argument and chat-looking variables leave the target the owner's chat")
rc, sent = sandbox_send(mutant_arg)
check("chat_id=%s" % PROTECTED in sent.split("\n"), "negative control: the mutant that reads $2 sends to it in the sandbox (the probe sees a moved target)")

for d in TEMPS:
    shutil.rmtree(d, ignore_errors=True)
print("\n%d failed" % len(FAILS) if FAILS else "\nall passed")
sys.exit(1 if FAILS else 0)
