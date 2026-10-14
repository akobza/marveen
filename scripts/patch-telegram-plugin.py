#!/usr/bin/env python3
"""
Take /status and /help away from the Telegram channel plugin (ELSOKOR922 D-4),
mark forwarded messages in the inbound meta (forwarded="1"), record every
inbound message the bot receives (the evidence owner WRITE commands need),
and -- only while TELEGRAM_TOPICS_ENABLED is on -- carry the topic of a
message in and the answer back into it (see TOPICS_STEPS).

The official plugin (claude-plugins-official/telegram/<ver>/server.ts) answers
/status ("Paired as ...") and /help itself, inside its bot poller -- those
messages never reach the session, so Marveen's command hook
(scripts/hooks/marveen-commands.py) cannot answer them. This script removes
the two handlers (and the plugin's own command menu, which would advertise
them with the plugin's meaning), leaving /start and everything else intact.
Without the handlers the two words arrive as ordinary text messages, exactly
like /usage does today, and the hook takes them.

Runs at every channel start (scripts/channels.sh), before the plugin is
spawned, over every cached plugin version in ONE cache: the one this install
launches from ($CLAUDE_CONFIG_DIR/plugins/cache, or ~/.claude/plugins/cache
when the variable is unset). Never both: an install with its own config dir
must not rewrite the user-level cache other Claude Code sessions load
(maintainer review on #1529, 2026-09-25).

- idempotent: a file carrying the marker is left alone (a patch that superseded
  an earlier marker also removes that marker's line, see the reply patch);
- all-or-nothing per patch: if ANY anchor of a patch is missing (a plugin
  update changed the code), that patch is left out and one loud line says so
  -- /status and /help then fall back to the plugin's own answers, or a
  forwarded command is not refused; the channel itself is not touched;
- always exits 0: a failed patch must never stop the channel from starting
  (the one exception is a --topics value other than on or off: exit 2, nothing
  patched; channels.sh never passes --topics);
- the reply-keyboard patch (c67f5f34) inserts WHOLE LINES only, each carrying
  its marker, so taking it back is deleting the lines that carry
  "MARVEEN-PATCH(c67f5f34-kbd)" (the file is then byte-identical to the one
  patched without it; tested);
- the permission-approver patch (fc8629d7) works the same way, and it is the
  one patch that fails CLOSED: when its anchors are not all there, a one-line
  fallback (perm-off) takes the plugin's permission capability away, so a
  permission request reaches nobody's chat instead of every allowlisted one;
- the reply patch (426fa59f) is one marked line in the inbound meta: the
  replied-to message's id and, when its author is the bot itself or an
  allowlisted sender, its first 200 characters, never in the content. Its
  marker says v3: the earlier marker (the v2 line, which gave the text of ANY
  replied-to author, and the first v3 build) is superseded, and a line
  carrying it is removed before the v3 line goes in, so a file the v2 patched
  becomes v3 on the next run instead of saying "already" (review finding
  D10); if an anchor is missing the file is left as it was (all or nothing);
- with --state FILE, the outcome per file (and per patch) is written there as
  JSON, so /status can say in one line when a patch is missing
  (src/web/system-status.ts) instead of the command silently falling back.

Usage: patch-telegram-plugin.py [--state FILE] [--topics on|off] [<plugins cache root>]
(default root: $CLAUDE_CONFIG_DIR/plugins/cache, else ~/.claude/plugins/cache;
without --topics the TELEGRAM_TOPICS_ENABLED setting of this install decides)
"""
import json
import os
import re
import sys
import time

MARKER = "// MARVEEN-PATCH(elsokor922-d4): /status and /help belong to the command hook"
FWD_MARKER = "// MARVEEN-PATCH(elsokor922-fwd): forwarded flag for the command hook"
EVID_MARKER = "// MARVEEN-PATCH(cmd920-evid): inbound evidence for owner write commands"
KBD_MARKER = "// MARVEEN-PATCH(c67f5f34-kbd): one-tap answer buttons"
PERM_MARKER = "// MARVEEN-PATCH(fc8629d7-perm): permission requests only for the approver list"
PERM_OFF_MARKER = "// MARVEEN-PATCH(fc8629d7-perm-off): permission relay off, the approver patch did not apply"
REPLY_MARKER = "// MARVEEN-PATCH(426fa59f-reply-v3): the message this one replies to, in the meta only"
# The earlier reply marker (the v2 line, and the first v3 build carried it too): superseded, its line is removed.
REPLY_MARKER_V2 = "// MARVEEN-PATCH(426fa59f-reply): the message this one replies to, in the meta only"

# Each anchor is the handler's full block, up to its closing `})` at column 0.
ANCHORS = [
    ("help handler", re.compile(r"^bot\.command\('help', async ctx => \{\n.*?^\}\)\n", re.DOTALL | re.MULTILINE)),
    ("status handler", re.compile(r"^bot\.command\('status', async ctx => \{\n.*?^\}\)\n", re.DOTALL | re.MULTILINE)),
    ("setMyCommands menu", re.compile(r"^( *)void bot\.api\.setMyCommands\(\n.*?\n\1\)\.catch\(\(\) => \{\}\)\n", re.DOTALL | re.MULTILINE)),
]

# The inbound meta says nothing about forwarding, so a forwarded message that
# carries a command is byte-identical to one the owner typed (measured on the
# test bot, 2026-09-23: a forwarded /status ran). One meta key more, right
# after user_id, and the hook refuses to run a forwarded command.
FWD_ANCHOR = ("inbound meta user_id", re.compile(r"^( *)user_id: String\(from\.id\),\n", re.MULTILINE))

# Owner WRITE commands (/model, /context clear, ...) run only when the message
# they came in is on record HERE, in the plugin process, the one place that
# only a real Telegram update reaches (#1530 review: the dashboard token is
# shared by every fleet agent, and the prompt text is not evidence -- anything
# typed into the session pane can carry a <channel> block). One JSON line per
# inbound message into <STATE_DIR>/inbound-evidence.jsonl, written just before
# the message is handed to Claude Code; the dashboard reads it
# (src/web/write-evidence.ts). Bounded: past 256 KiB the file becomes .1.
# Uses only names server.ts already imports (writeFileSync, statSync,
# renameSync, join) and the handler's own chat_id / msgId / text.
EVID_ANCHOR = ("channel notification", re.compile(
    r"^( *)mcp\.notification\(\{\n *method: 'notifications/claude/channel',\n", re.MULTILINE))
EVID_INSERT = (
    "{indent}try {{ const evidFile = join(STATE_DIR, 'inbound-evidence.jsonl'); "
    "try {{ if (statSync(evidFile).size > 262144) renameSync(evidFile, evidFile + '.1') }} catch {{}}; "
    "writeFileSync(evidFile, JSON.stringify({{ chat_id, message_id: msgId != null ? String(msgId) : null, "
    "text, at: Date.now() }}) + '\\n', {{ flag: 'a', mode: 0o600 }}) }} catch {{}} " + EVID_MARKER + "\n"
)

# An owner answers with Telegram's reply ("igen", "nem jo") and the inbound meta
# does not say to WHICH message (426fa59f): the session had to guess from the
# order. One meta line more, after image_path: the id of the replied-to message
# (reply_to_message_id, the ledger already stores it,
# scripts/hooks/ledger-capture.py) and its first 200 characters (reply_to_text:
# its text or caption, on one line). In that text '"' becomes "'", '<' and '>'
# become '(' and ')', so the value cannot close the attribute or open a tag in
# the channel tag, and '=' becomes the fullwidth equals sign (U+FF1D): a text
# ending in 'attachment_file_id=' would otherwise turn the value's closing quote
# into the opening quote of a later attribute for a regex reader of the tag.
# Meta only, like image_path: a "[reply to: ...]" line in the content would be
# forgeable by any allowlisted sender typing it. No reply, no key.
# The text comes only when the replied-to message's author is the bot itself
# (ctx.me) or a sender on the allowlist (access.allowFrom, the list the gate
# admits by): in a group, a reply to a member who is not allowlisted would
# otherwise bring that member's words into the session. Any other author (a
# group member, an anonymous admin, a channel post) gives the id only. The
# line reads the handler's `const access = result.access`, so that line is
# a second anchor (inserting nothing): without it the patch is left out loudly.
REPLY_ACCESS = ("inbound handler access", re.compile(r"^ *const access = result\.access\n", re.MULTILINE),
                "insert-after", "")
REPLY_ANCHOR = ("inbound meta image_path", re.compile(
    r"^( *)\.\.\.\(imagePath \? \{ image_path: imagePath \} : \{\}\),\n", re.MULTILINE))
REPLY_INSERT = (
    "{indent}...((r, ok) => (r ? {{ reply_to_message_id: String(r.message_id), "
    "...(ok ? ((t) => (t ? {{ reply_to_text: t }} : {{}}))(Array.from(String(r.text ?? r.caption ?? '')"
    ".replace(/\\s+/g, ' ').trim().replace(/[\"<>=]/g, (c) => ({{ '\"': \"'\", '<': '(', '>': ')', '=': '\\uff1d' }})[c]))"
    ".slice(0, 200).join('')) : {{}}) }} : {{}}))(ctx.message?.reply_to_message, "
    "((a, me) => a !== '' && (a === me || access.allowFrom.includes(a)))"
    "(String(ctx.message?.reply_to_message?.from?.id ?? ''), String(ctx.me?.id ?? ''))), " + REPLY_MARKER + "\n"
)

# The staff are asked one question at a time, with lettered options (A/B/C),
# and today they type the letter back (c67f5f34, owner request). The reply
# tool can send no button: its schema has no such field and the send passes
# only reply_parameters and parse_mode. A reply keyboard needs nothing on the
# inbound side: a tapped text-only button arrives as the user's ordinary text
# message, through the same gate, evidence log and channel notification as a
# typed letter. So three lines, all in the reply tool: an optional `buttons`
# list in the schema (after `files`), its check before anything is sent (the
# tool-call handler turns the throw into a tool error), and the keyboard on
# the LAST text chunk (an empty list removes a keyboard shown earlier). The
# labels are outgoing text: the copy gate (scripts/hooks/outgoing-copy-gate.py)
# audits them together with `text`.
KBD_SCHEMA = ("reply schema files property", re.compile(
    r"^ *description: 'Absolute file paths to attach\. [^\n]*',\n( *)\},\n", re.MULTILINE), "insert-after",
    "{indent}buttons: {{ type: 'array', items: {{ type: 'string' }}, description: 'Optional one-tap answer buttons, "
    "shown as a keyboard under the input field and hidden after one tap; the tapped label comes back as an ordinary "
    "text message from the user. Also write the options into text, so the question can be answered by typing. An "
    "empty list removes a keyboard shown earlier. At most 12 labels, each non-empty and at most 64 characters.' }}, "
    + KBD_MARKER + "\n")
KBD_CHECK = ("reply chat check", re.compile(r"^( *)assertAllowedChat\(chat_id\)\n", re.MULTILINE), "insert-after",
    "{indent}const kbdButtons = args.buttons == null ? undefined : Array.isArray(args.buttons) && args.buttons.length <= 12 "
    "&& args.buttons.every(b => typeof b === 'string' && b.trim() !== '' && b.length <= 64) ? (args.buttons as string[]) "
    ": (() => {{ throw new Error('buttons: a list of at most 12 non-empty labels, each at most 64 characters') }})() "
    + KBD_MARKER + "\n")
KBD_SEND = ("reply send options", re.compile(
    r"^( *)\.\.\.\(parseMode \? \{ parse_mode: parseMode \} : \{\}\),\n",
    re.MULTILINE), "insert-after",
    "{indent}...(kbdButtons && i === chunks.length - 1 ? {{ reply_markup: kbdButtons.length ? {{ keyboard: "
    "kbdButtons.map(label => [{{ text: label }}]), one_time_keyboard: true, resize_keyboard: true }} : "
    "{{ remove_keyboard: true as const }} }} : {{}}), " + KBD_MARKER + "\n")

# The plugin relays the main agent's tool-permission request to EVERY chat in
# access.allowFrom, with Allow / Deny buttons, and takes an answer -- a button or
# a "yes <id>" text -- from any of them (fc8629d7: an owner who is not the
# operator got "Permission: Bash" buttons). Allowlisted means "may talk to the
# agent", not "may approve its tool calls". So the approvers are a list of their
# own, TELEGRAM_PERMISSION_APPROVERS (comma-separated chat ids) in the channel's
# .env next to TELEGRAM_BOT_TOKEN (the file the plugin loads itself) or in the
# real environment, and all three paths check it: the relay sends only to them,
# the button and the text answer count only from them. An empty or missing list
# leaves the permission capability undeclared, so Claude Code relays nothing:
# the request stays in the terminal (fail-closed). Five lines, one per anchor.
PERM_LIST = ("mcp server construction", re.compile(r"^const mcp = new Server\(\n", re.MULTILINE), "insert-before",
    "const PERMISSION_APPROVERS = (process.env.TELEGRAM_PERMISSION_APPROVERS ?? '').split(',')"
    ".map(s => s.trim()).filter(Boolean) " + PERM_MARKER + "\n")
PERM_CAP = ("permission capability", re.compile(r"^( *)'claude/channel/permission': \{\},\n", re.MULTILINE), "insert-after",
    "{indent}...(PERMISSION_APPROVERS.length ? {{}} : {{ 'claude/channel/permission': undefined }}), " + PERM_MARKER + "\n")
PERM_RELAY = ("permission relay loop", re.compile(r"^( *)for \(const chat_id of access\.allowFrom\) \{\n", re.MULTILINE),
    "insert-after", "{indent}  if (!PERMISSION_APPROVERS.includes(chat_id)) continue " + PERM_MARKER + "\n")
PERM_BUTTON = ("permission button answer", re.compile(r"^( *)const \[, behavior, request_id\] = m\n", re.MULTILINE),
    "insert-after",
    "{indent}if (!PERMISSION_APPROVERS.includes(senderId)) {{ await ctx.answerCallbackQuery({{ text: 'Not authorized.' }})"
    ".catch(() => {{}}); return }} " + PERM_MARKER + "\n")
# A "yes <id>" from someone who may not approve is not relayed as chat either
# (the plugin never did that for this shape); it is dropped.
PERM_TEXT = ("permission text answer", re.compile(r"^( *)if \(permMatch\) \{\n", re.MULTILINE), "insert-after",
    "{indent}  if (!PERMISSION_APPROVERS.includes(String(from.id))) return " + PERM_MARKER + "\n")
# The fallback, applied only when the approver patch could not be: the
# capability is taken away for good, whatever the list says.
PERM_OFF = ("permission capability", PERM_CAP[1], "insert-after",
    "{indent}...({{ 'claude/channel/permission': undefined }}), " + PERM_OFF_MARKER + "\n")

# Independent patches: each has its own marker and is all-or-nothing on its
# own, so a plugin update that moves one anchor does not undo the other.
# "only_if_failed" names a patch whose anchor-missing is this one's condition.
PATCHES = [
    {"name": "d4", "marker": MARKER, "anchors": ANCHORS, "mode": "remove",
     "fallback": "/status and /help fall back to the plugin's own answers"},
    {"name": "fwd", "marker": FWD_MARKER, "anchors": [FWD_ANCHOR], "mode": "insert-after",
     "insert": "{indent}...(ctx.message?.forward_origin ? {{ forwarded: '1' }} : {{}}), " + FWD_MARKER + "\n",
     "fallback": "forwarded messages are not marked, a forwarded command runs like a typed one"},
    {"name": "reply", "marker": REPLY_MARKER, "supersedes": [REPLY_MARKER_V2], "anchors": [REPLY_ACCESS, REPLY_ANCHOR],
     "mode": "insert-after", "insert": REPLY_INSERT,
     "fallback": "a reply does not say which message it answers: the session guesses from the order"},
    {"name": "evid", "marker": EVID_MARKER, "anchors": [EVID_ANCHOR], "mode": "insert-before",
     "insert": EVID_INSERT,
     "fallback": "no inbound evidence is recorded, owner write commands are refused"},
    # an anchor may carry its own mode and insert (name, regex, mode, insert): the three kbd lines differ
    {"name": "kbd", "marker": KBD_MARKER, "anchors": [KBD_SCHEMA, KBD_CHECK, KBD_SEND], "mode": "insert-after",
     "fallback": "the reply tool has no buttons: a question goes out without them and is answered by typing"},
    {"name": "perm", "marker": PERM_MARKER, "anchors": [PERM_LIST, PERM_CAP, PERM_RELAY, PERM_BUTTON, PERM_TEXT],
     "mode": "insert-after",
     "fallback": "the perm-off line takes the permission relay away instead (next line), so approvals stay in the terminal"},
    {"name": "perm-off", "marker": PERM_OFF_MARKER, "anchors": [PERM_OFF], "mode": "insert-after", "only_if_failed": "perm",
     "fallback": "the plugin still relays permission requests to EVERY allowlisted chat, with Allow / Deny buttons"},
]

# Topics (TELEGRAM_TOPICS_ENABLED, default off). A private chat with topic mode
# enabled in BotFather, or a forum, delivers each message with the topic it was
# written in -- but the plugin drops that id from the inbound meta and its reply
# tool cannot address a topic, so every answer lands outside the topic. This
# patch carries message_thread_id in (meta, only for a real topic message) and
# back out (reply text chunks, attached files, the typing indicator).
#
# Unlike the patches above it is switchable, so it must also come OFF again:
# every line it adds ends with TOPICS_TAG, and every line it replaces is kept
# verbatim behind TOPICS_ORIG at column 0. Removing all TOPICS_TAG lines and
# the TOPICS_ORIG prefixes gives back the unpatched text byte for byte.
# Without a topic every changed call gets exactly the arguments it gets today.
TOPICS_TAG = "// MARVEEN-PATCH(tgtopics)"
TOPICS_ORIG = "// MARVEEN-PATCH(tgtopics-orig) "
TOPICS_SETTING = "TELEGRAM_TOPICS_ENABLED"
# The values src/config.ts reads as on; the Settings page itself writes "1".
TRUTHY = ("1", "true", "yes", "on")
# What JavaScript's String.prototype.trim() removes. Python's own strip() set
# differs both ways: it keeps U+FEFF (a BOM) and removes U+001C-U+001F and U+0085.
JS_TRIM = "\t\n\v\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"

_INBOUND_THREAD = "ctx.message?.is_topic_message && ctx.message.message_thread_id != null"
TOPICS_STEPS = [
    ("inbound meta ts", "insert-after",
     re.compile(r"^( *)ts: new Date\(\(ctx\.message\?\.date \?\? 0\) \* 1000\)\.toISOString\(\),\n", re.MULTILINE),
     ["...(" + _INBOUND_THREAD + " ? { message_thread_id: String(ctx.message.message_thread_id) } : {}),"]),
    ("typing indicator", "replace",
     re.compile(r"^( *)void bot\.api\.sendChatAction\(chat_id, 'typing'\)\.catch\(\(\) => \{\}\)\n", re.MULTILINE),
     ["void bot.api.sendChatAction(chat_id, 'typing', ...(" + _INBOUND_THREAD
      + " ? [{ message_thread_id: ctx.message.message_thread_id }] : [])).catch(() => {})"]),
    ("instructions inbound tag", "insert-after",
     re.compile(r"^( *)'Messages from Telegram arrive as <channel source=\"telegram\" [^\n]*\n", re.MULTILINE),
     ["'In a topic (a private chat with topics enabled, or a forum) the tag also has message_thread_id: "
      "pass it back to reply as message_thread_id, so the answer lands in the same topic.',"]),
    ("reply schema files", "insert-before",
     re.compile(r"^( *)files: \{\n *type: 'array',\n *items: \{ type: 'string' \},\n *description: 'Absolute file paths",
                re.MULTILINE),
     ["message_thread_id: {",
      "  type: 'string',",
      "  description: 'Topic to post into. Pass message_thread_id from the inbound <channel> block when it has one; omit it otherwise.',",
      "},"]),
    ("reply args", "insert-after",
     re.compile(r"^( *)const reply_to = args\.reply_to != null \? Number\(args\.reply_to\) : undefined\n", re.MULTILINE),
     ["const message_thread_id = args.message_thread_id != null && args.message_thread_id !== '' ? Number(args.message_thread_id) : undefined",
      "if (message_thread_id !== undefined && !(Number.isSafeInteger(message_thread_id) && message_thread_id > 0)) "
      "throw new Error(`invalid message_thread_id: ${String(args.message_thread_id)}`)"]),
    ("reply text options", "insert-after",
     re.compile(r"^( *)\.\.\.\(shouldReplyTo \? \{ reply_parameters: \{ message_id: reply_to \} \} : \{\}\),\n", re.MULTILINE),
     ["...(message_thread_id != null ? { message_thread_id } : {}),"]),
    ("reply file options", "replace",
     re.compile(r"^( *)const opts = reply_to != null && replyMode !== 'off'\n *\? \{ reply_parameters: \{ message_id: reply_to \} \}\n *: undefined\n",
                re.MULTILINE),
     ["const replyOpts = reply_to != null && replyMode !== 'off' ? { reply_parameters: { message_id: reply_to } } : undefined",
      "const opts = message_thread_id != null ? { ...replyOpts, message_thread_id } : replyOpts"]),
]
TOPICS_FALLBACK = "replies and the typing indicator land outside the topic the message came from"


def log(msg):
    sys.stderr.write(f"{time.strftime('%Y-%m-%d %H:%M:%S')} patch-telegram-plugin: {msg}\n")


def apply_patch(text, patch):
    """Returns (new_text, status). status: 'patched' | 'already' | 'anchor-missing:<name>'.
    A "supersedes" marker's whole line is removed first (also when the patch's own line is already there: an older
    patcher run after a newer one puts the old line back); an anchor missing returns the text as it was."""
    stale = [old for old in patch.get("supersedes", ()) if old in text]
    if patch["marker"] in text and not stale:
        return text, "already"
    out = text
    for old in stale:
        out = re.sub(r"^[^\n]*" + re.escape(old) + r"[^\n]*(?:\n|\Z)", "", out, flags=re.MULTILINE)
    if patch["marker"] in out:
        return out, "patched"
    for anchor in patch["anchors"]:
        name, rx = anchor[0], anchor[1]
        mode = anchor[2] if len(anchor) > 2 else patch["mode"]
        insert = anchor[3] if len(anchor) > 3 else patch.get("insert", "")
        found = list(rx.finditer(out))
        if len(found) != 1:
            return text, f"anchor-missing:{name}"
        m = found[0]
        indent = m.group(1) if rx.groups else ""
        if mode == "remove":
            out = out[:m.start()] + f"{indent}{patch['marker']} ({name} removed)\n" + out[m.end():]
        elif mode == "insert-before":
            out = out[:m.start()] + insert.format(indent=indent) + out[m.start():]
        else:
            out = out[:m.end()] + insert.format(indent=indent) + out[m.end():]
    return out, "patched"


def apply_topics(text):
    """Returns (new_text, status), all-or-nothing like apply_patch."""
    if TOPICS_TAG in text:
        return text, "already"
    out = text
    for name, mode, rx, lines in TOPICS_STEPS:
        found = list(rx.finditer(out))
        if len(found) != 1:
            return text, f"anchor-missing:{name}"
        m = found[0]
        indent = m.group(1)
        added = "".join(f"{indent}{line} {TOPICS_TAG}\n" for line in lines)
        if mode == "insert-before":
            out = out[:m.start()] + added + out[m.start():]
        elif mode == "insert-after":
            out = out[:m.end()] + added + out[m.end():]
        else:
            kept = "".join(TOPICS_ORIG + line for line in m.group(0).splitlines(keepends=True))
            out = out[:m.start()] + kept + added + out[m.end():]
    return out, "patched"


def remove_topics(text):
    """Returns (new_text, 'removed'), or (text, None) when the patch is not there."""
    if TOPICS_TAG not in text and TOPICS_ORIG not in text:
        return text, None
    out = []
    for line in text.splitlines(keepends=True):
        if line.rstrip("\n").endswith(" " + TOPICS_TAG):
            continue
        out.append(line[len(TOPICS_ORIG):] if line.startswith(TOPICS_ORIG) else line)
    return "".join(out), "removed"


TOPICS_PATCH = {"name": "topics", "fallback": TOPICS_FALLBACK}


def patch_text(text, topics=False):
    """Returns (new_text, [(patch, status), ...]). The topics entry is there
    when the switch is on, or when switching it off took the patch out. A
    patch with only_if_failed runs only when that patch is anchor-missing in
    this run; otherwise its status is 'not-needed'."""
    results = []
    statuses = {}
    for patch in PATCHES:
        dep = patch.get("only_if_failed")
        if dep and not statuses.get(dep, "").startswith("anchor-missing"):
            status = "not-needed"
        else:
            text, status = apply_patch(text, patch)
        statuses[patch["name"]] = status
        results.append((patch, status))
    if topics:
        text, status = apply_topics(text)
        results.append((TOPICS_PATCH, status))
    else:
        text, status = remove_topics(text)
        if status:
            results.append((TOPICS_PATCH, status))
    return text, results


def file_status(results):
    """One word for the file: 'already' when every patch was there (or not
    needed), 'patched' when this run wrote (or took out) one, else the first anchor-missing."""
    statuses = [st for _, st in results]
    if "patched" in statuses or "removed" in statuses:
        return "patched"
    if all(st in ("already", "not-needed") for st in statuses):
        return "already"
    return next(st for st in statuses if st.startswith("anchor-missing"))


def patch_file(path, topics=False):
    """Returns (file status, {patch name: status})."""
    try:
        with open(path, encoding="utf-8") as f:
            text = f.read()
    except Exception as e:
        log(f"cannot read {path}: {type(e).__name__}")
        return "unreadable", {}
    new, results = patch_text(text, topics)
    per_patch = {p["name"]: st for p, st in results}
    for patch, status in results:
        if status.startswith("anchor-missing"):
            log(f"LOUD: {status.split(':', 1)[1]} not found exactly once in {path} (plugin changed?) -- "
                f"the {patch['name']} patch left out, {patch['fallback']}")
    patched = [p["name"] + (" removed" if st == "removed" else "") for p, st in results if st in ("patched", "removed")]
    if not patched:
        return file_status(results), per_patch
    tmp = path + ".marveen-tmp"
    try:
        with open(tmp, "w", encoding="utf-8") as f:
            f.write(new)
        os.replace(tmp, path)
    except Exception as e:
        log(f"cannot write {path}: {type(e).__name__} -- left unpatched ({', '.join(patched)})")
        try:
            os.remove(tmp)
        except Exception:
            pass
        return "unwritable", {n: ("unwritable" if st in ("patched", "removed") else st) for n, st in per_patch.items()}
    log(f"patched {path} ({', '.join(patched)})")
    return file_status(results), per_patch


def default_root():
    cfg = os.environ.get("CLAUDE_CONFIG_DIR")
    if cfg:
        return os.path.join(cfg, "plugins", "cache")
    return os.path.expanduser("~/.claude/plugins/cache")


def write_state(state_path, state):
    tmp = state_path + ".tmp"
    try:
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(state, f, indent=1)
        os.replace(tmp, state_path)
    except Exception as e:
        log(f"cannot write state {state_path}: {type(e).__name__}")


def parse_env_content(content):
    """src/env-parse.ts parseEnvContent, rule for rule: lines split on \\n only,
    trimmed like JS trim(), comments and blank lines skipped, the key trimmed
    around the first =, ONE pair of matching surrounding quotes stripped, and
    a later line for the same key wins."""
    result = {}
    for line in content.split("\n"):
        trimmed = line.strip(JS_TRIM)
        if not trimmed or trimmed.startswith("#"):
            continue
        eq = trimmed.find("=")
        if eq == -1:
            continue
        key = trimmed[:eq].strip(JS_TRIM)
        value = trimmed[eq + 1:].strip(JS_TRIM)
        if (value.startswith('"') and value.endswith('"')) or (value.startswith("'") and value.endswith("'")):
            value = value[1:-1]
        result[key] = value
    return result


def is_on(value):
    """src/setting-flag.ts isSettingValueOn."""
    return str(value).strip(JS_TRIM).lower() in TRUTHY


def topics_setting(install_dir):
    """TELEGRAM_TOPICS_ENABLED as the dashboard settings store resolves it:
    store/config-overrides.json, then .env, then the registry default (off)."""
    try:
        with open(os.path.join(install_dir, "store", "config-overrides.json"), encoding="utf-8") as f:
            overrides = json.load(f)
        if isinstance(overrides, dict) and TOPICS_SETTING in overrides:
            return is_on(overrides[TOPICS_SETTING])
    except Exception:
        pass
    try:
        # As Node's readFileSync(path, 'utf-8') reads it: no newline translation
        # (a lone \r does not end a line there), a bad byte becomes U+FFFD
        # instead of failing the whole file.
        with open(os.path.join(install_dir, ".env"), encoding="utf-8", errors="replace", newline="") as f:
            env = parse_env_content(f.read())
        if TOPICS_SETTING in env:
            return is_on(env[TOPICS_SETTING])
    except Exception:
        pass
    return False


def main(argv):
    args = argv[1:]
    state_path = None
    topics = None
    while len(args) >= 2 and args[0] in ("--state", "--topics"):
        if args[0] == "--state":
            state_path = args[1]
        elif args[1] in ("on", "off"):
            topics = args[1] == "on"
        else:
            # An explicit switch: anything else is a typo, and reading it as
            # "off" would silently take the topics patch off.
            print(f"patch-telegram-plugin.py: --topics takes on or off, got {args[1]!r}; nothing patched", file=sys.stderr)
            return 2
        args = args[2:]
    if topics is None:
        topics = topics_setting(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    root = args[0] if args else default_root()
    files = []
    base = os.path.join(root, "claude-plugins-official", "telegram")
    if os.path.isdir(base):
        for ver in sorted(os.listdir(base)):
            path = os.path.join(base, ver, "server.ts")
            if os.path.isfile(path):
                status, patches = patch_file(path, topics)
                files.append({"version": ver, "path": path, "status": status, "patches": patches})
    if state_path:
        write_state(state_path, {"at": int(time.time()), "root": root, "topics": "on" if topics else "off", "files": files})
    return 0


if __name__ == "__main__":
    code = 0
    try:
        # Non-zero only for a mistyped --topics, which channels.sh never passes.
        code = main(sys.argv)
    except Exception as e:  # never stop the channel from starting
        log(f"unexpected {type(e).__name__}, nothing patched")
    sys.exit(code)
