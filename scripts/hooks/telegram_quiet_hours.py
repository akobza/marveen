#!/usr/bin/env python3
"""
Shared quiet-hours check for the Telegram hooks (submit / stop / reply-guard / watchdog).

Config: <state_dir>/quiet-hours.json, e.g.
  {"<chat_id>": {"start": "23:00", "end": "07:00", "tz": "Europe/Budapest"}}
Windows may wrap midnight (start > end).

Why this file lives in the repo (card e6680b3c): until 2026-09-22 it existed ONLY in
~/.claude/hooks, which is not version controlled. On 2026-09-12 15:32:53Z an update run
(update.sh -> scripts/sync-hooks.sh -> install-*-hook.sh) copied the repo versions of the
sibling hooks over their locally patched copies and the quiet-hours branch was lost; the
module itself survived only because it was not on the installer's copy list. The hooks now
import it from their OWN directory, so an installer can never again ship a hook whose
quiet-hours dependency is missing.

⛔ FAIL-OPEN IS THE DEFAULT, AND THAT IS DELIBERATE: a missing or unparseable config makes
in_quiet() False for every chat, i.e. the hooks behave as if no quiet hours were configured.
That is the right default for a notification path (never block delivery because a config is
absent) -- but it is silent, and a silent fail-open is exactly how the 2026-09-12 regression
went unnoticed for ten days. Callers that want to KNOW must ask config_state() and log it;
see the reply-guard and the watchdog for the shape.
"""
import os, json, datetime, tempfile

CONFIG_NAME = "quiet-hours.json"

# config_state() return values -- a caller can log these; they are not error conditions.
STATE_OK = "ok"              # file exists, parsed, at least one chat configured
STATE_EMPTY = "empty"        # file exists and parses, but configures no chat
STATE_MISSING = "missing"    # no such file at state_dir
STATE_UNREADABLE = "unreadable"  # exists but could not be read or parsed


def config_path(state_dir):
    return os.path.join(state_dir, CONFIG_NAME)


def config_state(state_dir):
    """Why a quiet-hours lookup found nothing. ⛔ The point is to tell MISSING from EMPTY:
    both make in_quiet() return False, but only one of them is a deployment defect."""
    path = config_path(state_dir)
    if not os.path.exists(path):
        return STATE_MISSING
    try:
        with open(path, encoding="utf-8") as f:
            d = json.load(f)
    except Exception:
        return STATE_UNREADABLE
    if not isinstance(d, dict):
        return STATE_UNREADABLE
    return STATE_OK if d else STATE_EMPTY


def load(state_dir):
    try:
        with open(config_path(state_dir), encoding="utf-8") as f:
            d = json.load(f)
        return d if isinstance(d, dict) else {}
    except Exception:
        return {}


def _hm(s):
    h, m = str(s).split(":")
    return int(h) * 60 + int(m)


def in_quiet(state_dir, chat_id, now=None):
    """True iff chat_id has a configured window and local time is inside it.
    [start, end) -- start inclusive, end exclusive."""
    cfg = load(state_dir).get(str(chat_id))
    if not cfg:
        return False
    try:
        tzname = cfg.get("tz") or "Europe/Budapest"
        try:
            from zoneinfo import ZoneInfo
            tz = ZoneInfo(tzname)
        except Exception:
            tz = None
        t = now or datetime.datetime.now(tz)
        if t.tzinfo is None and tz is not None:
            t = t.replace(tzinfo=tz)
        cur = t.hour * 60 + t.minute
        start, end = _hm(cfg.get("start", "23:00")), _hm(cfg.get("end", "07:00"))
        if start <= end:
            return start <= cur < end
        return cur >= start or cur < end
    except Exception:
        return False


def quiet_window_end(state_dir, chat_id, at_epoch):
    """If the instant at_epoch (unix seconds) falls inside chat_id's window, return
    the unix epoch of that window's END (local wall clock); else None."""
    cfg = load(state_dir).get(str(chat_id))
    if not cfg:
        return None
    try:
        from zoneinfo import ZoneInfo
        tz = ZoneInfo(cfg.get("tz") or "Europe/Budapest")
        t = datetime.datetime.fromtimestamp(int(at_epoch), tz)
        if not in_quiet(state_dir, chat_id, t):
            return None
        eh, em = divmod(_hm(cfg.get("end", "07:00")), 60)
        end = t.replace(hour=eh, minute=em, second=0, microsecond=0)
        if end <= t:
            end = end + datetime.timedelta(days=1)
        return int(end.timestamp())
    except Exception:
        return None


# ---------------------------------------------------------------------------
# The SEND gate's decision (card 20e178fc): telegram-quiet-gate.py (PreToolUse on
# the reply / react / edit_message tools) and telegram_fallback_send.py.
#
# ⛔ FAIL-CLOSED, ON PURPOSE, where everything above is fail-open. in_quiet() answers
# "is this chat quiet right now?" for hooks that would otherwise NAG or NOTIFY, and
# for those "no config -> not quiet" is the safe side. A gate that STOPS a send has
# the opposite safe side: a config that vanished must not reopen the quiet window
# without a trace (the 2026-09-12 regression stayed silent for ten days exactly
# because the fail-open path leaves none). So send_decision() tells "not quiet"
# apart from "cannot say", and "cannot say" holds the send inside FALLBACK_WINDOW
# for every chat (the gate cannot tell which chat is protected without the file),
# lets it go outside, and reports the defect either way -- but only on an install
# that HAS used quiet hours: a missing file on an install that never had one is no
# defect at all (send, no line), or every fresh install and the upstream default
# would go silent every night (card 20e178fc). What tells the two apart is the
# quiet-hours.seen marker in the install's store directory, written by
# remember_configured() the first time a real send is evaluated against a usable
# config. A file that exists but cannot be read (0 bytes, truncated, not an object)
# and a malformed entry are defects whatever the marker says: a file that is there
# says someone meant quiet hours.
# ---------------------------------------------------------------------------

# The window a missing or unusable config falls back to: the one owner window this
# install configures today. Every chat, because the file is what names the chat.
FALLBACK_WINDOW = {"start": "23:00", "end": "07:00", "tz": "Europe/Budapest"}


def _strict_hm(s):
    """'HH:MM' -> minutes since midnight; raises on anything else (no '25:00', no '07:60')."""
    h, m = str(s).split(":")
    if not (h.isdigit() and m.isdigit() and len(m) == 2 and int(h) < 24 and int(m) < 60):
        raise ValueError("not a HH:MM time: %r" % (s,))
    return int(h) * 60 + int(m)


def _window_holds(cfg, at_epoch):
    """(inside, local 'HH:MM') for the instant at_epoch on cfg's own wall clock, [start, end).
    Raises on a malformed entry, unlike in_quiet(): the caller must be able to say 'cannot say'.
    The instant is converted with fromtimestamp(tz), so the answer is the local clock's
    even across a DST change (a UTC-aware datetime handed to in_quiet() would be read
    with its UTC hour)."""
    from zoneinfo import ZoneInfo
    if not isinstance(cfg, dict):
        raise ValueError("the entry is not an object")
    tz = ZoneInfo(cfg.get("tz") or "Europe/Budapest")
    start, end = _strict_hm(cfg.get("start", "23:00")), _strict_hm(cfg.get("end", "07:00"))
    t = datetime.datetime.fromtimestamp(int(at_epoch), tz)
    cur = t.hour * 60 + t.minute
    inside = (start <= cur < end) if start <= end else (cur >= start or cur < end)
    return inside, t.strftime("%H:%M")


def _window_text(cfg):
    return "%s-%s %s" % (cfg.get("start", "23:00"), cfg.get("end", "07:00"), cfg.get("tz") or "Europe/Budapest")


SEEN_NAME = "quiet-hours.seen"


def seen_path(install_root):
    """The quiet-hours.seen marker in the install's store directory: this install has used a quiet-hours config."""
    return os.path.join(install_root, "store", SEEN_NAME)


def remember_configured(state_dir, seen, by):
    """Write the 'this install uses quiet hours' marker, only when the config is usable AND names a
    chat (an empty {} is a deliberate 'no quiet hours', and its loss is no defect), only when the
    marker is not there yet, and atomically: the content goes to a temp file beside it, which is then
    LINKED into place, so a racing writer cannot overwrite it and no half-written marker is ever
    visible. Called by the gate and the fallback sender only when they evaluate a real send (a probe
    call never reaches it). Returns True if this call wrote the marker; never raises."""
    try:
        if os.path.exists(seen) or config_state(state_dir) != STATE_OK:
            return False
        d = os.path.dirname(seen)
        os.makedirs(d, exist_ok=True)
        fd, tmp = tempfile.mkstemp(prefix="." + SEEN_NAME + ".", dir=d)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as fh:
                fh.write(json.dumps({"config": config_path(state_dir), "by": by,
                                     "first_seen": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")}) + "\n")
            os.link(tmp, seen)
            return True
        except FileExistsError:
            return False
        finally:
            try:
                os.unlink(tmp)
            except OSError:
                pass
    except Exception:
        return False


def send_decision(state_dir, chat_id, at_epoch, seen):
    """May a Telegram send to chat_id go at the instant at_epoch (unix seconds)?
    `seen` is the install's marker path (seen_path()): required, so no caller can forget it.

    Returns (hold, why, defect):
      hold    True = stop the send;
      why     one line naming the window and the local time (for the gate's stderr);
      defect  None, or one line naming the file and what is wrong with it -- set
              whenever the config could not be used, whether the send is held or not.

    config ok, chat configured   -> hold inside the chat's window;
    config ok, chat not in it     -> send;
    config empty                  -> send (an install with no quiet hours at all);
    config missing, no marker     -> send, no defect (this install never had quiet hours);
    config missing, marker there,
      config unreadable, or the chat's
      entry malformed             -> FALLBACK_WINDOW for every chat, with a defect;
    chat_id unknown (None / '')   -> hold when ANY configured window holds now: the
                                     protected chat cannot be ruled out.
    """
    path = config_path(state_dir)
    chat = None if chat_id is None or str(chat_id).strip() == "" else str(chat_id).strip()

    def fallback(defect):
        inside, local = _window_holds(FALLBACK_WINDOW, at_epoch)
        why = "a quiet-hours konfig nem hasznalhato, ezert az alapablak ervenyes minden chatre (%s, helyi ido most %s)" % (
            _window_text(FALLBACK_WINDOW), local)
        return inside, why, defect

    state = config_state(state_dir)
    if state == STATE_EMPTY:
        return False, "nincs beallitott csendes ido", None
    if state == STATE_MISSING and not os.path.exists(seen):
        return False, "nincs csendes-ido konfig, es ez a telepites meg nem hasznalt ilyet", None
    if state == STATE_MISSING:
        return fallback("%s: missing, pedig a telepites mar hasznalt csendes-ido konfigot (%s); az alapablak tart" % (path, seen))
    if state != STATE_OK:
        return fallback("%s: %s (a csendes ido nem olvashato, az alapablak tart)" % (path, state))
    cfg_all = load(state_dir)
    if chat is not None:
        cfg = cfg_all.get(chat)
        if cfg is None:
            return False, "a(z) %s chatnek nincs csendes ideje" % chat, None
        try:
            inside, local = _window_holds(cfg, at_epoch)
        except Exception as e:
            return fallback("%s: a(z) %s chat bejegyzese hibas (%s: %s)" % (path, chat, type(e).__name__, e))
        return inside, "a(z) %s chat csendes ideje %s, helyi ido most %s" % (chat, _window_text(cfg), local), None
    for other, cfg in cfg_all.items():
        try:
            inside, local = _window_holds(cfg, at_epoch)
        except Exception as e:
            return fallback("%s: a(z) %s chat bejegyzese hibas (%s: %s)" % (path, other, type(e).__name__, e))
        if inside:
            return True, "a hivas nem nevez chatet, es a(z) %s chat csendes idejeben vagyunk (%s, helyi ido most %s)" % (
                other, _window_text(cfg), local), None
    return False, "a hivas nem nevez chatet, es egyik beallitott chat sincs csendes idoben", None
