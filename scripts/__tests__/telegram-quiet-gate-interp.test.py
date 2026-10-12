#!/usr/bin/env python3
"""Quiet-hours SEND gate, the interpreter branch (card 25af1415): the Bot API sends written into the code
text a Bash command gives python or node, found by scripts/hooks/telegram_bash_send.py and judged by
scripts/hooks/telegram-quiet-gate.py with the same decision as the curl and wget sends (card 23724bf8).

Run: python3 scripts/__tests__/telegram-quiet-gate-interp.test.py
Exit 0 = pass. Discovered and executed by src/__tests__/script-tests-runner.test.ts, which invokes every
scripts/__tests__/*.test.py WITHOUT arguments, so this file takes none and needs nothing outside the repo
(no network, no real configuration, no real token).

WHAT IT PINS (the card's ELFOGADAS)
  (1) python -c, a python heredoc and node -e sends to the protected chat are held inside its window;
  (2) the same sends go outside it;
  (3) python and node code that is no Bot API send goes: a call to the dashboard /api/*, a reading
      method (getUpdates, getMe), the host only printed, a sending method name of another service;
  (4) the mutant: the code rule copied with its host match removed turns the last negative case of (3)
      into a "send", so the probe measures the host match itself;
  (5) the gate's header comment states the two limits of the machine gate (a script file the command did
      not write, a host the command text does not hold);
  (6) the 13 negative cases of card 23724bf8 stay no send, by name, and they are the same 13 commands the
      23724bf8 test file lists (read from that file, so a drift between the two shows here).
  Besides: the forms the parser reads the code from (python -c with options before it or attached,
  python - and stdin, a heredoc, a here-string, a pipe, node -e/--eval/--eval=/-p, a node heredoc, a
  python script a heredoc of the same command writes and the command runs, wrappers, runners, bash -c,
  $( )), where the chat comes from (a query string, a dict, a JSON object, a shell variable set in the
  command, a variable of the code = None, none = None), and the forms that are no code text here (a
  script file the command did not write, python -m, stdin data of a script).

DATA
  No real identifier: "999" is the protected chat, "888" another chat; the configs and the mutant copy live
  in temp dirs this file creates and removes.
"""
import contextlib
import datetime
import importlib.util
import io
import json
import os
import re
import shutil
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
HOOKS = os.path.join(REPO, "scripts", "hooks")
GATE = os.path.join(HOOKS, "telegram-quiet-gate.py")
PARSER = os.path.join(HOOKS, "telegram_bash_send.py")
BASH_TEST = os.path.join(HERE, "telegram-quiet-gate-bash.test.py")
WINDOW = {"start": "23:00", "end": "07:00", "tz": "Europe/Budapest"}
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


os.environ["HOOK_ERRLOG_PATH"] = os.path.join(temp("quiet-interp-errlog-"), "hook-errors.log")
parser = load("interp_send_under_test", PARSER)
gate = load("interp_gate_under_test", GATE)
cwd = temp("quiet-interp-cwd-")

# 1. The parser: the forms --------------------------------------------------------------------------
S = "sendMessage"
PY_URL = "import urllib.request as u; u.urlopen('%s?chat_id=999&text=x')" % U
SENDS = [
    ("python3 -c, the chat in the query", 'python3 -c "%s"' % PY_URL, [(S, "999")]),
    ("python -c, a dict body", 'python -c \'import requests; requests.post("https://api.telegram.org/bot1/sendMessage", '
     'data={\"chat_id\": 888, \"text\": \"x\"})\'', [(S, "888")]),
    ("python3 -u -c", 'python3 -u -c "%s"' % PY_URL, [(S, "999")]),
    ("python3 -Ic, clustered", 'python3 -Ic "%s"' % PY_URL, [(S, "999")]),
    ("python3 -c with the code attached", 'python3 -c"%s"' % PY_URL, [(S, "999")]),
    ("python3.11 -c", 'python3.11 -c "%s"' % PY_URL, [(S, "999")]),
    ("a python heredoc", "python3 <<'PY'\nimport requests\nrequests.post('%s', json={'chat_id': 999})\nPY" % U, [(S, "999")]),
    ("python3 - with arguments and a heredoc", "python3 - a b <<'PY'\nimport requests\nrequests.post('%s', data={'chat_id': 999})\nPY" % U,
     [(S, "999")]),
    ("a heredoc piped into python", "cat <<'PY' | python3\nimport requests\nrequests.post('%s', data={'chat_id': 999})\nPY" % U,
     [(S, "999")]),
    ("a python heredoc whose end line never comes", "python3 <<'PY'\nimport requests\nrequests.post('%s', data={'chat_id': 999})" % U,
     [(S, "999")]),
    ("a here-string into python", 'python3 <<< "%s"' % PY_URL, [(S, "999")]),
    ("echo piped into python", 'echo "%s" | python3' % PY_URL, [(S, "999")]),
    ("node -e, a template URL", "node -e 'fetch(`https://api.telegram.org/bot${T}/sendMessage?chat_id=999&text=x`)'", [(S, "999")]),
    ("node --eval, a JSON body with a channel", 'node --eval \'fetch("https://api.telegram.org/bot1/sendMessage", '
     '{method: "POST", body: JSON.stringify({chat_id: "@chan_x", text: "x"})})\'', [(S, "@chan_x")]),
    ("node --eval=", "node --eval='fetch(\"https://api.telegram.org/bot1/sendMessage?chat_id=999\")'", [(S, "999")]),
    ("node -p", "node -p 'fetch(\"https://api.telegram.org/bot1/sendMessage?chat_id=999\")'", [(S, "999")]),
    ("a node heredoc", "node <<'JS'\nfetch('https://api.telegram.org/bot1/sendMessage?chat_id=999')\nJS", [(S, "999")]),
    ("sudo and timeout before python", 'sudo -u bob timeout 10 python3 -c "%s"' % PY_URL, [(S, "999")]),
    ("ssh with a python command", "ssh root@host \"python3 -c 'import urllib.request as u; "
     "u.urlopen(\\\"https://api.telegram.org/bot1/sendMessage?chat_id=999\\\")'\"", [(S, "999")]),
    ("bash -c around python", "bash -c \"python3 -c 'import urllib.request as u; "
     "u.urlopen(\\\"https://api.telegram.org/bot1/sendMessage?chat_id=999\\\")'\"", [(S, "999")]),
    ("$( ) around python", 'R=$(python3 -c "%s")' % PY_URL, [(S, "999")]),
    ("a python script a heredoc writes and the command runs", "cat > /tmp/s.py <<'PY'\nimport requests\n"
     "requests.post('%s', data={'chat_id': 999})\nPY\npython3 /tmp/s.py" % U, [(S, "999")]),
    ("the code file written after the heredoc's redirection, run as ./", "cat <<'PY' > s.py\nimport requests\n"
     "requests.post('%s', data={'chat_id': 999})\nPY\npython3 ./s.py" % U, [(S, "999")]),
    ("the code file written by tee", "tee /tmp/t.py > /dev/null <<'PY'\nimport requests\n"
     "requests.post('%s', data={'chat_id': 999})\nPY\npython3 /tmp/t.py" % U, [(S, "999")]),
    ("the chat from a shell variable set in the command", "C=999; python3 -c \"import urllib.request as u; u.urlopen('%s?chat_id=$C')\"" % U,
     [(S, "999")]),
    ("the chat from a variable of the code", 'python3 -c \'import os, requests; requests.post("https://api.telegram.org/bot1/sendMessage", '
     'data={"chat_id": os.environ["CHAT"]})\'', [(S, None)]),
    ("no chat_id at all", 'python3 -c \'import requests; requests.post("https://api.telegram.org/bot1/sendMessage", data={"text": "x"})\'',
     [(S, None)]),
    ("the method added to a base URL", 'python3 -c \'B = "https://api.telegram.org/bot1/"; import requests; '
     'requests.post(B + "sendMessage", data={\"chat_id\": 999})\'', [(S, "999")]),
    ("two chats in one code text", "python3 -c \"import urllib.request as u; u.urlopen('%s?chat_id=888'); "
     "u.urlopen('%s?chat_id=999')\"" % (U, U), [(S, "888"), (S, "999")]),
    ("sendPhoto", "python3 -c 'import requests; requests.post(\"https://api.telegram.org/bot1/sendPhoto\", data={\"chat_id\": 999})'",
     [("sendPhoto", "999")]),
    ("upper-case host", "python3 -c 'import urllib.request as u; u.urlopen(\"https://API.Telegram.org/bot1/sendMessage?chat_id=999\")'",
     [(S, "999")]),
    ("copyMessage: the chat_id counts, not from_chat_id", "python3 -c 'import requests; requests.post("
     "\"https://api.telegram.org/bot1/copyMessage\", data={\"chat_id\": 999, \"from_chat_id\": 888})'", [("copyMessage", "999")]),
    ("a heredoc fed to python behind sudo", "sudo -u bob python3 <<'PY'\nimport requests\n"
     "requests.post('%s', data={'chat_id': 999})\nPY" % U, [(S, "999")]),
    ("curl run by python", "python3 -c \"import os; os.system('curl -s %s -d chat_id=999')\"" % U, [(S, "999")]),
    # not sends: code that is no Bot API send (the card's (3)), and the forms that are no code text here
    ("python to the dashboard API", "python3 -c 'import urllib.request as u; u.urlopen(\"http://localhost:3420/api/messages\", data=b\"{}\")'", []),
    ("python reading updates only", 'python3 -c \'import requests; requests.get("https://api.telegram.org/bot1/getUpdates")\'', []),
    ("node reading getMe", "node -e 'fetch(\"https://api.telegram.org/bot1/getMe\")'", []),
    ("a sender variable next to a reading call", "python3 -c 'import requests; r = requests.get(\"https://api.telegram.org/bot1/getUpdates\"); "
     "sender = r.json(); sendall = 1'", []),
    ("python printing the host only", "python3 -c 'print(\"api.telegram.org\")'", []),
    ("a sendMessage of another service", "echo api.telegram.org; python3 -c 'client.sendMessage(chat_id=999)'", []),
    ("echo of a python send", "echo \"python3 -c 'u.urlopen(\\\"%s?chat_id=999\\\")'\"" % U, []),
    ("a commit message with a python send", "git commit -m \"gate: python3 -c 'u.urlopen(%s?chat_id=999)' is held\"" % U, []),
    ("a heredoc that writes a python file nobody runs", "cat > /tmp/s.py <<'PY'\nimport requests\n"
     "requests.post('%s', data={'chat_id': 999})\nPY" % U, []),
    ("a script file the command did not write", 'python3 scripts/send.py "api.telegram.org sendMessage chat_id=999"', []),
    ("python -m with the host in its stdin", "python3 -m json.tool <<< '{\"url\": \"%s\", \"chat_id\": 999}'" % U, []),
    ("a heredoc writes one python file, the command runs another", "cat > /tmp/a.py <<'PY'\nimport requests\n"
     "requests.post('%s', data={'chat_id': 999})\nPY\npython3 /tmp/b.py" % U, []),
    ("a heredoc fed to a python script as data", "python3 x.py <<'EOF'\n{\"url\": \"%s\", \"chat_id\": 999}\nEOF" % U, []),
]
for label, cmd, want in SENDS:
    got = parser.sends(cmd, cwd)
    check(got == want, "parser, %s -> %r%s" % (label, want, "" if got == want else " (got %r)" % (got,)))
lexed = []
for label, cmd, _want in SENDS:
    try:
        parser._lex(cmd)
    except Exception as e:
        lexed.append("%s (%s)" % (label, e))
check(lexed == [], "the lexer reads every case above itself, no fallback (%s)" % (", ".join(lexed) or "all %d" % len(SENDS)))
check(parser.sends('python3 -c "%s' % PY_URL) == [(S, "999")], "fallback: an unbalanced quote around python code, the send still found")
check(parser.sends("python3 -c 'print(1)") == [], "fallback: unbalanced python code without the host is no send")

# 6. The 23724bf8 negative cases, by name --------------------------------------------------------------
NEG_23724BF8 = [
    ("grep for the host", 'grep -rn "api.telegram.org" scripts/'),
    ("echo of a send", 'echo "%s chat_id=999"' % U),
    ("echo of an unquoted curl line", "echo curl %s -d chat_id=999" % U),
    ("a heredoc that writes a file", "cat > /tmp/x.sh <<'EOF'\ncurl -s %s -d chat_id=999\nEOF" % U),
    ("a JSON body to another host", "curl -s -X POST http://localhost:3420/api/messages -H 'Content-Type: application/json' "
     "-d '{\"content\":\"curl https://api.telegram.org/bot$T/sendMessage -d chat_id=999\"}'"),
    ("a Bot API URL as data to another host", 'curl -s http://localhost:3420/x -d "https://api.telegram.org/bot1/sendMessage"'),
    ("getMe", "curl -s https://api.telegram.org/bot$T/getMe"),
    ("getUpdates", 'curl -s "https://api.telegram.org/bot$T/getUpdates?offset=1"'),
    ("the emergency path", 'bash scripts/notify.sh "lemez 95%: api.telegram.org nem erheto el"'),
    ("a comment", "true # curl %s -d chat_id=999" % U),
    ("a commit message", 'git commit -m "gate: curl %s -d chat_id=999 is held"' % U),
    ("grep for a curl line", "grep -c 'curl.*api.telegram.org' log.txt"),
    ("no host at all", "curl -s http://localhost:3420/api/kanban"),
]
for label, cmd in NEG_23724BF8:
    check(parser.sends(cmd, cwd) == [], "(6) the 23724bf8 negative case %r stays no send" % label)
with open(BASH_TEST, encoding="utf-8") as f:
    block = f.read().split("    # not sends\n", 1)[1].split("\n]\n", 1)[0]
theirs = re.findall(r'^    \("([^"]+)",', block, re.M)
check(len(NEG_23724BF8) == 13 and theirs == [label for label, _cmd in NEG_23724BF8],
      "(6) the 13 names are the 23724bf8 test's own negative cases, in its order (theirs: %r)" % (theirs,))

# 2. The decision, in-process, at fixed instants ----------------------------------------------------------


def z(iso):
    return int(datetime.datetime.strptime(iso, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=datetime.timezone.utc).timestamp())


NIGHT, DAY = z("2026-10-08T21:30:00Z"), z("2026-10-08T12:00:00Z")  # 23:30 and 14:00 in Budapest
state = temp("quiet-interp-state-")
with open(os.path.join(state, "quiet-hours.json"), "w", encoding="utf-8") as f:
    json.dump({"999": WINDOW}, f)


def decide(cmd, at):
    seen = os.path.join(temp("quiet-interp-seen-"), "store", "quiet-hours.seen")
    payload = {"hook_event_name": "PreToolUse", "tool_name": "Bash", "tool_input": {"command": cmd}, "cwd": cwd}
    with contextlib.redirect_stderr(io.StringIO()):
        return gate.decide(payload, state, at, seen)


PY_999 = 'python3 -c "%s"' % PY_URL
HEREDOC_999 = "python3 <<'PY'\nimport requests\nrequests.post('%s', json={'chat_id': 999})\nPY" % U
NODE_999 = "node -e 'fetch(`https://api.telegram.org/bot${T}/sendMessage?chat_id=999&text=x`)'"
for label, cmd in (("python -c", PY_999), ("a python heredoc", HEREDOC_999), ("node -e", NODE_999)):
    allow, text = decide(cmd, NIGHT)
    check(not allow and "CSENDES-IDO KAPU: TILTVA (Bash" in text and "chat 999" in text and "python, node" in text,
          "(1) %s to the protected chat inside its window: held, the refusal names the chat" % label)
    check(decide(cmd, DAY)[0], "(2) %s to the protected chat outside its window: goes" % label)
check(decide('python3 -c "%s"' % PY_URL.replace("999", "888"), NIGHT)[0], "(1) python -c to another chat inside the window: goes")
VAR_CHAT = 'python3 -c \'import os, requests; requests.post("https://api.telegram.org/bot1/sendMessage", data={"chat_id": os.environ["C"]})\''
allow, text = decide(VAR_CHAT, NIGHT)
check(not allow and "ismeretlen cimzett" in text and "ird ki a chat_id-t literalisan" in text,
      "(1) a chat the code does not spell out, inside the window: held, the refusal asks for the chat_id written out")
check(decide(VAR_CHAT, DAY)[0], "(2) the same outside every window: goes")
for label, cmd, _want in SENDS:
    if not _want:
        check(decide(cmd, NIGHT)[0], "(3) no send in %r -> goes inside the window" % label)

# 4. The mutant: the host match taken out of the code rule ------------------------------------------------
src = open(PARSER, encoding="utf-8").read()
cut = "    if not code or HOST not in code.lower():\n        return []\n"
check(src.count(cut) == 1, "(4) the code rule's host match is where the mutant cuts it")
mutant_dir = temp("quiet-interp-mutant-")
with open(os.path.join(mutant_dir, "telegram_bash_send.py"), "w", encoding="utf-8") as f:
    f.write(src.replace(cut, "    if not code:\n        return []\n"))
mutant = load("interp_send_mutant", os.path.join(mutant_dir, "telegram_bash_send.py"))
probe = "echo api.telegram.org; python3 -c 'client.sendMessage(chat_id=999)'"
check(parser.sends(probe, cwd) == [] and mutant.sends(probe, cwd) == [(S, "999")],
      "(4) NEGATIVE CONTROL: without the host match the sendMessage of another service turns into a send, so (3) measures it")

# 5. The gate's header comment states the two limits ------------------------------------------------------
doc = gate.__doc__ or ""
check("a script file the command runs but did not write in the same command" in doc,
      "(5) the gate's header names the first limit: a script file the command did not write")
check("a Bot API host that the command text does not hold" in doc,
      "(5) the gate's header names the second limit: a host the command text does not hold")

for d in TEMPS:
    shutil.rmtree(d, ignore_errors=True)
if FAILS:
    print("\n%d FAIL" % len(FAILS))
    sys.exit(1)
print("\nall checks passed")
