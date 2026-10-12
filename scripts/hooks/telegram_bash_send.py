#!/usr/bin/env python3
"""Direct Telegram Bot API sends written into a Bash command (card 23724bf8).

The quiet-hours send gate (telegram-quiet-gate.py, card 20e178fc) stops the Telegram reply, react and
edit_message tools and the manual fallback sender inside a chat's quiet hours. A model that writes the
Bot API call into a Bash command (curl or wget to api.telegram.org) walked past it. This module finds
such calls so the same gate can judge them with the same decision, telegram_quiet_hours.send_decision().

sends(command, cwd) -> [(method, chat), ...], one entry per Bot API send and recipient found:
  method  the Bot API method name, or None when it cannot be read (a variable in its place);
  chat    the literal chat id ("12345", "-100...", "@name"), or None when it cannot be read: a variable,
          a command substitution, stdin, an unreadable body file, or no chat_id at all. The caller
          treats None as "cannot say", and one None among the entries is enough for that.

What counts as a send: curl or wget in COMMAND position with an api.telegram.org/bot<token>/<method> URL
among its URL arguments and a sending method: send*, copyMessage(s), forwardMessage(s), editMessage*,
setMessageReaction (the Bot API's method names are case-insensitive, and so is this match). Command
position is read by a small shell lexer that knows quotes, escapes, comments, operators, redirections,
$( ), backticks, <( ), heredocs and here-strings: the first word after ';', '&&', '||', '|', '&', a
newline or '(', after variable assignments, reserved words (if, then, do, '!', '{', ...) and wrappers
(sudo, env, timeout, nohup, setsid, xargs, ...). A command run by another command is read too: bash/sh
-c, eval, $( ) and backticks, a heredoc or here-string fed to a shell, text piped into a shell, and the
runners whose arguments are a command (ssh, su -c, docker/podman/kubectl exec, flock, watch, tmux, ...).
A URL in a shell variable set in the same command is expanded; a URL argument whose host is a variable
or a substitution, in a command that names the Bot API host, is a send with an unknown method.

Where the chat is read from: chat_id in the URL's query string; curl's -d/--data*/--data-urlencode/-F/
--form*/--json/--url-query and wget's --post-data/--body-data values (form pairs or a JSON body); the
body file of curl's @file and of wget's --post-file/--body-file (at most 64 KB, a relative path taken
from the call's cwd). A literal chat is "-?digits" or "@name"; anything else is None.

What does not count: the host named in text (grep, echo, a commit message, the body of a request to
another host), a reading method (getMe, getUpdates, ...), and a heredoc that only writes a file
(cat > x <<EOF) which the same command does not run. A heredoc body IS read as commands when it is fed to
a shell, when the same command also runs a script file (bash x.sh, sh x, source x, ./x, a path to a .sh:
the body may be that script), and when its end line never comes (bash reads such a body to the end of the
text; a "<<" misread inside an arithmetic expression is caught the same way). Not covered, by the scope of
card 23724bf8 (curl and wget written into the command): a send made by an interpreter's own HTTP client
(python, node, ...), by a script file the command runs but did not write (scripts/notify.sh is one, see the
gate), and a host spelled so that the command text does not hold it.

Never raises: text the lexer cannot read (an unbalanced quote) is judged line by line, and that fallback
leans towards "send": a stopped send costs a retry, a missed one breaks the owner's rule. Pure: no
network, no clock; it only reads the request body files the command names.
"""
import os
import re

HOST = "api.telegram.org"
URL = re.compile(r"^(?:https?://)?api\.telegram\.org(?::\d+)?/bot[^/\s]*/(?P<method>[^/?#\s]*)", re.I)
SEND_METHOD = re.compile(r"^(send[a-z]*|copymessages?|forwardmessages?|editmessage[a-z]*|setmessagereaction)$", re.I)
LITERAL_CHAT = re.compile(r"^(-?\d+|@[A-Za-z][A-Za-z0-9_]{2,})$")
CHAT_JSON = re.compile(r"[\"']chat_id[\"']\s*:\s*(\"[^\"]*\"|'[^']*'|[^,}\s]+)")
CHAT_LINE = re.compile(r"chat_id[\"']?\s*[=:]\s*[\"']?([^&\s,}\"']*)")
ASSIGN = re.compile(r"^([A-Za-z_][A-Za-z0-9_]*)\+?=(.*)$", re.S)
VAR = re.compile(r"\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))")
BRACED = re.compile(r"\$\{[^}]*\}")
SPACE = re.compile(r"\s")

SUB = "$__SUB__"      # what a $( ), a backtick or a <( ) leaves in its word; its text is scanned on its own
REDIRECT = "\x00"     # marks a redirection target, which is no argument of the command

FETCHERS = {"curl", "wget"}
SHELLS = {"bash", "sh", "zsh", "dash", "ksh", "mksh", "ash", "fish"}
WRAPPERS = {"sudo", "doas", "env", "command", "exec", "nohup", "setsid", "time", "nice", "ionice", "stdbuf",
            "timeout", "xargs", "unbuffer", "chronic", "caffeinate", "busybox", "torsocks", "proxychains",
            "proxychains4", "taskset", "chrt", "strace", "ltrace"}
RUNNERS = {"ssh", "su", "runuser", "sg", "flock", "script", "docker", "podman", "kubectl", "nsenter", "chroot",
           "unshare", "firejail", "watch", "parallel", "tmux", "screen", "systemd-run"}
EXECUTORS = FETCHERS | SHELLS | RUNNERS | {"eval"}
RESERVED = {"!", "{", "}", "if", "then", "else", "elif", "fi", "do", "done", "while", "until", "esac", "coproc"}
DECLARERS = {"export", "local", "declare", "typeset", "readonly"}
OPERATORS = ("&&", "||", ";;", "|&", ";&")

CURL_SHORT_VALUE = set("AbcCdDEeFhHKmoPQrtTuUwxXyYz")
CURL_LONG_VALUE = {
    "--data", "--data-ascii", "--data-binary", "--data-raw", "--data-urlencode", "--json", "--form",
    "--form-string", "--url-query", "--url", "--header", "--proxy-header", "--user", "--proxy-user", "--output",
    "--output-dir", "--referer", "--user-agent", "--cookie", "--cookie-jar", "--proxy", "--preproxy",
    "--upload-file", "--request", "--write-out", "--config", "--max-time", "--connect-timeout", "--range",
    "--cert", "--key", "--cacert", "--capath", "--continue-at", "--retry", "--retry-delay", "--retry-max-time",
    "--limit-rate", "--speed-limit", "--speed-time", "--resolve", "--connect-to", "--interface", "--local-port",
    "--max-filesize", "--max-redirs", "--time-cond", "--trace", "--trace-ascii", "--stderr", "--dns-servers",
    "--doh-url", "--unix-socket", "--abstract-unix-socket", "--proto", "--proto-redir", "--noproxy",
    "--oauth2-bearer", "--aws-sigv4", "--variable", "--dump-header", "--etag-save", "--etag-compare",
}
CURL_DATA = {"-d", "--data", "--data-ascii", "--data-binary", "--data-raw", "--data-urlencode", "--json", "-F",
             "--form", "--form-string", "--url-query"}
CURL_AT_FILE = {"-d", "--data", "--data-ascii", "--data-binary", "--json"}
WGET_SHORT_VALUE = set("aABDeiIlOoPQRtTUwX")
WGET_LONG_VALUE = {
    "--output-file", "--append-output", "--execute", "--input-file", "--base", "--tries", "--output-document",
    "--timeout", "--dns-timeout", "--connect-timeout", "--read-timeout", "--wait", "--waitretry", "--quota",
    "--bind-address", "--limit-rate", "--directory-prefix", "--cut-dirs", "--user", "--password", "--http-user",
    "--http-password", "--header", "--proxy-user", "--proxy-password", "--referer", "--user-agent", "--post-data",
    "--post-file", "--body-data", "--body-file", "--method", "--load-cookies", "--save-cookies", "--certificate",
    "--private-key", "--ca-certificate", "--ca-directory", "--level", "--accept", "--reject", "--domains",
    "--exclude-domains", "--include-directories", "--exclude-directories", "--default-page", "--config",
}
WGET_DATA = {"--post-data", "--body-data"}
WGET_FILE = {"--post-file", "--body-file"}
MAX_DEPTH = 6
MAX_BODY_FILE = 65536


def sends(command, cwd=None):
    if not isinstance(command, str) or HOST not in command.lower():
        return []
    out = []
    for item in _sends(command, cwd, 0):
        if item not in out:
            out.append(item)
    return out


def _sends(text, cwd, depth):
    if HOST not in text.lower():
        return []
    if depth > MAX_DEPTH:
        return _fallback(text)
    try:
        cmds, subs, kept = _lex(text)
        if kept and any(_runs_file(words) for words, _op in cmds):
            subs += kept  # a heredoc may have written the script this command runs
        out = []
        for body in subs:
            out += _sends(body, cwd, depth + 1)
        assigns = {}
        for k, (words, op) in enumerate(cmds):
            out += _command(words, assigns, cwd, depth)
            if op in ("|", "|&") and k + 1 < len(cmds) and _shell_reads_stdin(cmds[k + 1][0]):
                fed = [w for w in words[1:] if not w.startswith(REDIRECT)]
                out += _sends("\n".join([" ".join(fed)] + [w for w in fed if SPACE.search(w)]), cwd, depth + 1)
        return out
    except Exception:  # the lexer gave up (an unbalanced quote, say): judge it line by line
        return _fallback(text)


# --- the lexer ----------------------------------------------------------------------------------------

def _close_backtick(text, i):
    j = i + 1
    while j < len(text):
        if text[j] == "\\":
            j += 2
            continue
        if text[j] == "`":
            return j
        j += 1
    raise ValueError("unbalanced backtick")


def _close_double(text, i):
    j = i + 1
    while j < len(text):
        c = text[j]
        if c == "\\":
            j += 2
            continue
        if c == '"':
            return j
        if text.startswith("$(", j):
            j = _close_paren(text, j + 1) + 1
            continue
        if c == "`":
            j = _close_backtick(text, j) + 1
            continue
        j += 1
    raise ValueError("unbalanced double quote")


def _close_paren(text, i):
    """The index of the ')' that closes the '(' at text[i]; quoted text inside is skipped."""
    depth, j = 0, i
    while j < len(text):
        c = text[j]
        if c == "\\":
            j += 2
            continue
        if c == "'":
            k = text.find("'", j + 1)
            if k < 0:
                raise ValueError("unbalanced quote")
            j = k + 1
            continue
        if c == '"':
            j = _close_double(text, j) + 1
            continue
        if c == "`":
            j = _close_backtick(text, j) + 1
            continue
        if c == "(":
            depth += 1
        elif c == ")":
            depth -= 1
            if depth == 0:
                return j
        j += 1
    raise ValueError("unbalanced parenthesis")


def _inner_double(s, subs):
    """The value of a double-quoted string's content: its escapes undone, its substitutions recorded."""
    out, j = [], 0
    while j < len(s):
        c = s[j]
        if c == "\\" and j + 1 < len(s) and s[j + 1] in '$`"\\\n':
            out.append("" if s[j + 1] == "\n" else s[j + 1])
            j += 2
        elif s.startswith("$(", j):
            k = _close_paren(s, j + 1)
            subs.append(s[j + 2:k])
            out.append(SUB)
            j = k + 1
        elif c == "`":
            k = _close_backtick(s, j)
            subs.append(s[j + 1:k])
            out.append(SUB)
            j = k + 1
        else:
            out.append(c)
            j += 1
    return "".join(out)


def _heredoc_body(text, i, delim, strip_tabs):
    """(body, the index after its end line, whether the end line came)."""
    lines = []
    while i < len(text):
        k = text.find("\n", i)
        line = text[i:] if k < 0 else text[i:k]
        i = len(text) if k < 0 else k + 1
        if (line.lstrip("\t") if strip_tabs else line) == delim:
            return "\n".join(lines), i, True
        lines.append(line)
    return "\n".join(lines), len(text), False


def _lex(text):
    """([(words, the operator after them)], [the command texts inside it], [the other heredoc bodies]): the
    command texts are the substitutions, the heredoc bodies fed to a shell and the bodies whose end line never
    came. Raises ValueError on an unbalanced quote."""
    cmds, subs, kept, cur, parts, line_words, pending = [], [], [], [], None, [], []
    redirect_next = False
    i, n = 0, len(text)

    def add(s):
        nonlocal parts
        if parts is None:
            parts = []
        parts.append(s)

    def end_word():
        nonlocal parts, redirect_next
        if parts is not None:
            word = "".join(parts)
            if redirect_next:
                word, redirect_next = REDIRECT + word, False
            cur.append(word)
            line_words.append(word)
            parts = None

    def end_cmd(op):
        nonlocal cur, redirect_next
        end_word()
        if cur:
            cmds.append((cur, op))
        cur, redirect_next = [], False

    while i < n:
        c = text[i]
        if c == "\\":
            if not text.startswith("\\\n", i):
                add(text[i + 1:i + 2])
            i += 2
        elif c == "'":
            k = text.find("'", i + 1)
            if k < 0:
                raise ValueError("unbalanced quote")
            add(text[i + 1:k])
            i = k + 1
        elif text.startswith("$'", i):
            k = i + 2
            while k < n and text[k] != "'":
                k += 2 if text[k] == "\\" else 1
            if k >= n:
                raise ValueError("unbalanced quote")
            add(text[i + 2:k])
            i = k + 1
        elif c == '"':
            k = _close_double(text, i)
            add(_inner_double(text[i + 1:k], subs))
            i = k + 1
        elif text.startswith(("$(", "<(", ">("), i):
            k = _close_paren(text, i + 1)
            subs.append(text[i + 2:k])
            add(SUB)
            i = k + 1
        elif c == "`":
            k = _close_backtick(text, i)
            subs.append(text[i + 1:k])
            add(SUB)
            i = k + 1
        elif c == "#" and parts is None:
            k = text.find("\n", i)
            i = n if k < 0 else k
        elif c in " \t\r":
            end_word()
            i += 1
        elif c == "\n":
            end_cmd("\n")
            i += 1
            fed = any(os.path.basename(w) in SHELLS or os.path.basename(w) == "ssh" for w in line_words)
            for delim, strip_tabs in pending:
                body, i, closed = _heredoc_body(text, i, delim, strip_tabs)
                (subs if fed or not closed else kept).append(body)
            pending, line_words = [], []
        elif text.startswith("<<<", i):
            end_word()
            cur.append("<<<")
            i += 3
        elif text.startswith("<<", i):
            end_word()
            k = i + 2
            strip_tabs = text.startswith("-", k)
            k += 1 if strip_tabs else 0
            while k < n and text[k] in " \t":
                k += 1
            start = k
            while k < n and text[k] not in " \t\n;&|()<>":
                k += 1
            delim = re.sub(r"[\"'\\]", "", text[start:k])
            if delim:
                pending.append((delim, strip_tabs))
            i = k
        elif c in "<>" or text.startswith("&>", i):
            if parts is not None and "".join(parts).isdigit():
                parts = None  # the fd number of "2>"
            end_word()
            i += 2 if c == "&" else 1
            while i < n and text[i] in "<>&|":
                i += 1
            redirect_next = True
        elif c in ";&|()":
            op = text[i:i + 2] if text[i:i + 2] in OPERATORS else c
            end_cmd(op)
            i += len(op)
        else:
            add(c)
            i += 1
    end_cmd("")
    return cmds, subs, kept


# --- commands -----------------------------------------------------------------------------------------

def _expand(word, assigns):
    word = VAR.sub(lambda m: assigns.get(m.group(1) or m.group(2), m.group(0)), word)
    return BRACED.sub("$__VAR__", word)


def _strip_prefix(words, assigns):
    """Drop the assignments (remembered), the reserved words and a declarer with its options."""
    i, declaring = 0, False
    while i < len(words):
        w = words[i]
        m = ASSIGN.match(w)
        if m:
            assigns[m.group(1)] = _expand(m.group(2), assigns)
        elif w in DECLARERS:
            declaring = True
        elif not (w in RESERVED or (declaring and w.startswith("-"))):
            break
        i += 1
    return words[i:]


def _command(words, assigns, cwd, depth):
    rest = _strip_prefix([w for w in words if not w.startswith(REDIRECT)], assigns)
    if not rest:
        return []
    head = _expand(rest[0], assigns)
    name, args = os.path.basename(head), rest[1:]
    if name in FETCHERS or "$" in head:  # $(which curl), an unknown $CURL: read as curl
        return _fetch(name, [_expand(a, assigns) for a in args], cwd)
    if name == "eval":
        return _sends(" ".join(_expand(a, assigns) for a in args), cwd, depth + 1)
    out = []
    if name in WRAPPERS or name in RUNNERS:
        for k, a in enumerate(args):
            if os.path.basename(_expand(a, assigns)) in EXECUTORS:
                out += _command(args[k:], dict(assigns), cwd, depth + 1)
                break
    if name in SHELLS or name in RUNNERS:  # bash -c '...', ssh host '...', bash <<< '...'
        for a in args:
            if HOST in a.lower() and SPACE.search(a):
                out += _sends(_expand(a, assigns), cwd, depth + 1)
    return out


def _runs_file(words):
    """True for a command that runs a script file: bash x.sh, sh -e x, source x, . x, ./x, a path to a .sh, also behind a wrapper."""
    rest = _strip_prefix([w for w in words if not w.startswith(REDIRECT)], {})
    for k, w in enumerate(rest):
        name = os.path.basename(w)
        if name in SHELLS:
            args = rest[k + 1:]
            return "-c" not in args and any(not a.startswith("-") for a in args)
        if w in ("source", ".") and k + 1 < len(rest):
            return True
        if "/" in w and (w.startswith("./") or w.endswith(".sh")):
            return True
        if k == 0 and name not in WRAPPERS:
            return False
    return False


def _shell_reads_stdin(words):
    """True for a pipeline's right side that runs its stdin as commands: bash, sh -s, sudo bash, ..."""
    rest = _strip_prefix([w for w in words if not w.startswith(REDIRECT)], {})
    while rest and os.path.basename(rest[0]) in WRAPPERS:
        nxt = [k for k, a in enumerate(rest[1:], 1) if os.path.basename(a) in SHELLS]
        if not nxt:
            return False
        rest = rest[nxt[0]:]
    if not rest or os.path.basename(rest[0]) not in SHELLS:
        return False
    return "-c" not in rest[1:] and all(a.startswith("-") for a in rest[1:])


# --- curl and wget ------------------------------------------------------------------------------------

def _options(args, short, long_):
    """[(option, value)] of a curl or wget command line: (None, word) is a positional argument (a URL),
    (option, None) a flag. Clustered short options and --opt=value are split; --expand-X is X."""
    out, i = [], 0
    while i < len(args):
        a = args[i]
        i += 1
        if a == "--":
            out += [(None, x) for x in args[i:]]
            break
        if a.startswith("--"):
            opt, eq, val = a.partition("=")
            if opt.startswith("--expand-"):
                opt = "--" + opt[len("--expand-"):]
            if eq:
                out.append((opt, val))
            elif opt in long_:
                out.append((opt, args[i] if i < len(args) else ""))
                i += 1
            else:
                out.append((opt, None))
        elif a.startswith("-") and len(a) > 1:
            for k in range(1, len(a)):
                if a[k] in short:
                    val = a[k + 1:]
                    if not val and i < len(args):
                        val = args[i]
                        i += 1
                    out.append(("-" + a[k], val))
                    break
        else:
            out.append((None, a))
    return out


def _host(url):
    return (url.split("://", 1)[1] if "://" in url else url).split("/", 1)[0]


def _fetch(name, args, cwd):
    wget = name == "wget"
    opts = _options(args, WGET_SHORT_VALUE if wget else CURL_SHORT_VALUE, WGET_LONG_VALUE if wget else CURL_LONG_VALUE)
    urls, methods, unknown = [], [], False
    for opt, val in opts:
        if val is None or (opt is not None and opt != "--url"):
            continue
        m = URL.match(val)
        if m:
            urls.append(val)
            methods.append(m.group("method"))
        elif "$" in _host(val):
            urls.append(val)
            unknown = True
    sending = [m for m in methods if not m or "$" in m or SEND_METHOD.match(m)]
    if not sending and not unknown:
        return []
    names = [m if m and "$" not in m else None for m in sending] + ([None] if unknown else [])
    chats = _chats(opts, urls, cwd, wget)
    return [(m, c) for m in names for c in chats]


def _chat(value):
    v = (value or "").strip().strip("\"'").strip()
    return v if LITERAL_CHAT.match(v) else None


def _file_text(path, cwd):
    if not path or path == "-" or "$" in path:
        return None
    if not os.path.isabs(path):
        if not cwd:
            return None
        path = os.path.join(cwd, path)
    try:
        if os.path.isfile(path) and os.path.getsize(path) <= MAX_BODY_FILE:
            with open(path, encoding="utf-8", errors="replace") as fh:
                return fh.read()
    except OSError:
        pass
    return None


def _form_chats(text):
    """Chats of form pairs or a query string ("a=1&chat_id=2"): a piece that is a variable could be the chat."""
    out = []
    for piece in text.split("&"):
        name, eq, value = piece.partition("=")
        if name.strip() == "chat_id":
            out.append(_chat(value))
        elif "$" in name:
            out.append(None)
    return out


def _body_chats(text):
    """Chats of a request body (a JSON object or form pairs); None for a body that cannot be read."""
    if text is None:
        return [None]
    if text.lstrip().startswith(("{", "[")):
        found = [_chat(v) for v in CHAT_JSON.findall(text)]
        return found or ([None] if re.search(r"[{,]\s*\$", text) else [])
    return _form_chats(text.strip())


def _data_chats(opt, val, cwd):
    if opt in ("-F", "--form", "--form-string"):
        name, eq, value = val.partition("=")
        if "$" in name:
            return [None]
        if name.strip() != "chat_id":
            return []
        if opt != "--form-string" and value.startswith("<"):
            return [_chat(_file_text(value[1:], cwd))]
        return [_chat(value)]
    if opt == "--data-urlencode":  # "content", "=content", "name=content", "@file", "name@file"
        cut = min([k for k in (val.find("="), val.find("@")) if k >= 0], default=-1)
        name = val[:cut] if cut >= 0 else ""
        if "$" in name or (cut < 0 and "$" in val):
            return [None]
        if cut < 0 or name.strip() != "chat_id":
            return []
        value = val[cut + 1:]
        return [_chat(_file_text(value, cwd) if val[cut] == "@" else value)]
    if opt in CURL_AT_FILE and val.startswith("@"):
        return _body_chats(_file_text(val[1:], cwd))
    return _body_chats(val)


def _chats(opts, urls, cwd, wget):
    found = []
    for u in urls:
        found += _form_chats(u.split("?", 1)[1].split("#", 1)[0]) if "?" in u else []
    for opt, val in opts:
        if opt is None or val is None:
            continue
        if wget and opt in WGET_DATA:
            found += _body_chats(val)
        elif wget and opt in WGET_FILE:
            found += _body_chats(_file_text(val, cwd))
        elif not wget and opt in CURL_DATA:
            found += _data_chats(opt, val, cwd)
    return found or [None]


def _fallback(text):
    """Line by line, when the lexer gave up: a fetcher word and a Bot API URL on one line = a send."""
    out = []
    for line in text.replace("\\\n", " ").split("\n"):
        if HOST not in line.lower() or not re.search(r"(^|[\s;&|(`$'\"])(curl|wget)(\s|$)", line, re.I):
            continue
        m = re.search(r"api\.telegram\.org(?::\d+)?/bot[^/\s'\"]*/([A-Za-z]*)", line, re.I)
        method = (m.group(1) if m else "") or None
        if method and not SEND_METHOD.match(method):
            continue
        chats = [_chat(v) for v in CHAT_LINE.findall(line)]
        out += [(method, c) for c in chats] if chats and None not in chats else [(method, None)]
    return out
