#!/usr/bin/env python3
"""
Shared quiet-hours check for the Telegram hooks (submit / stop / reply-guard / watchdog).

Config: <state_dir>/quiet-hours.json, e.g.
  {"<chat_id>": {"start": "23:00", "end": "07:00", "tz": "<IANA zone>"}}
Windows may wrap midnight (start > end). An entry without "tz" reads the install's zone
(install_zone(): SCHEDULER_TZ, else the host zone, the rule of APP_TZ in src/config.ts;
ISSUE1895), never a zone written into this file.

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
went unnoticed for ten days. Callers that want to KNOW ask config_case() and log what
defect_text() and not_configured_note_once() give them; see the reply guard, the Stop
fallback and the watchdog for the shape.
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


# ---------------------------------------------------------------------------
# WHAT A HOOK LOGS ABOUT THE CONFIG: three cases, not one (card 20e178fc).
#
# config_state() cannot tell an install that NEVER used quiet hours from one that
# LOST its config: both are MISSING. Logging every MISSING as a defect called the
# normal state of an install without quiet hours a defect, and the reply guard wrote
# that line on every Stop with an open question, so the log grew without bound. The
# install marker tells the two apart: a hook that sees a usable config naming a chat
# records that config's path in the quiet-hours.seen marker in the install's store
# directory (remember_configured). Then:
#   NOT_CONFIGURED  no file, and the marker never recorded this path: the normal state
#                   of an install (or a channel) without quiet hours; noted ONCE per
#                   state dir with the label 'quiet hours not configured';
#   LOST            no file, but the marker recorded this path: it was in use and is
#                   gone; a defect, loud on every run;
#   UNREADABLE      the file is there but cannot be read or parsed; a defect whatever
#                   the marker says (a file that is there says someone meant quiet hours).
# The marker is per config PATH, not per install: a fleet where only one channel uses
# quiet hours must not report the others as LOST.
# ---------------------------------------------------------------------------

CASE_OK = "ok"                          # usable, names at least one chat
CASE_EMPTY = "empty"                    # usable, names no chat: {} turns quiet hours off on purpose
CASE_NOT_CONFIGURED = "not-configured"  # no file, and the marker never recorded this path
CASE_LOST = "lost"                      # no file, but the marker recorded this path
CASE_UNREADABLE = "unreadable"          # the file exists but cannot be read or parsed

SEEN_NAME = "quiet-hours.seen"
NOTED_NAME = "quiet-hours-not-configured.noted"


def install_root():
    """The root whose store directory holds the marker: MARVEEN_ROOT when set (the installer pins it for
    the watchdog, the tests point it at a temp tree), else the root this module runs from
    (<root>/scripts/hooks, where every hook imports it from), else None."""
    env = os.environ.get("MARVEEN_ROOT")
    if env:
        return env
    here = os.path.dirname(os.path.abspath(__file__))
    if os.path.basename(here) == "hooks" and os.path.basename(os.path.dirname(here)) == "scripts":
        root = os.path.dirname(os.path.dirname(here))
        # the watchdog's own plausibility check: a stray copy in some other scripts/hooks tree is no install
        if os.path.isdir(os.path.join(root, ".claude")) or os.path.isdir(os.path.join(root, "agents")):
            return root
    return None


def seen_path(root=None):
    """The install marker: quiet-hours.seen in the root's store directory; None without a root."""
    root = root or install_root()
    return os.path.join(root, "store", SEEN_NAME) if root else None


def seen_configs(seen):
    """The config paths the marker records (resolved), one JSON object per line: {"config": <path>, ...}.
    A torn or foreign line is skipped; an absent or unreadable marker records nothing."""
    out = set()
    if not seen:
        return out
    try:
        with open(seen, encoding="utf-8") as f:
            for line in f:
                try:
                    d = json.loads(line)
                except ValueError:
                    continue
                if isinstance(d, dict) and isinstance(d.get("config"), str):
                    out.add(os.path.realpath(d["config"]))
    except Exception:
        pass
    return out


def remember_configured(state_dir, seen, by, keep_windows=True):
    """Record in the marker that this state dir's config is in use: only when it is usable AND names a chat
    (the loss of an empty {} is no defect), and only once per config path. One line per path, appended with a
    single write, so two hooks racing record the same path twice at worst. With keep_windows the same call
    keeps the config's windows as the last good ones (_remember_last_good), on every call, not only the
    first: the send gate and the fallback sender, which read the install's own config. The reply guard, the
    Stop fallback and the watchdog read their own state dir's config and pass keep_windows=False, so a
    channel's config never becomes the fallback of the install's. Returns True if this call wrote a marker
    line; never raises."""
    try:
        if not seen or config_state(state_dir) != STATE_OK:
            return False
        if keep_windows:
            _remember_last_good(state_dir, seen, by)
        path = os.path.realpath(config_path(state_dir))
        if path in seen_configs(seen):
            return False
        os.makedirs(os.path.dirname(seen), exist_ok=True)
        line = json.dumps({"config": path, "by": by,
                           "first_seen": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")})
        fd = os.open(seen, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600)
        try:
            os.write(fd, (line + "\n").encode("utf-8"))
        finally:
            os.close(fd)
        return True
    except Exception:
        return False


def config_case(state_dir, seen):
    """config_state() with the history the marker gives: MISSING splits into LOST (the marker recorded this
    config's path) and NOT_CONFIGURED (it did not, or there is no marker to ask)."""
    st = config_state(state_dir)
    if st == STATE_OK:
        return CASE_OK
    if st == STATE_EMPTY:
        return CASE_EMPTY
    if st == STATE_UNREADABLE:
        return CASE_UNREADABLE
    if os.path.realpath(config_path(state_dir)) in seen_configs(seen):
        return CASE_LOST
    return CASE_NOT_CONFIGURED


def defect_text(case, state_dir, seen):
    """The label of a config DEFECT, the same in the reply guard, the Stop fallback and the watchdog; None when
    the case is not a defect (ok, empty, not configured)."""
    path = config_path(state_dir)
    if case == CASE_LOST:
        return ("quiet-hours config lost: %s was in use on this install (recorded in %s) and is gone; restore it,"
                " or write {} to turn quiet hours off on purpose" % (path, seen))
    if case == CASE_UNREADABLE:
        return "quiet-hours config unreadable: %s exists but cannot be read or parsed" % path
    return None


def not_configured_note_once(state_dir):
    """The one 'quiet hours not configured' line, the first time a hook meets this state dir NOT_CONFIGURED;
    None every time after. A small noted-file beside where the config would be records it; if that cannot
    be written, the line is not given either: a normal state must not repeat on every run."""
    try:
        fd = os.open(os.path.join(state_dir, NOTED_NAME), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        os.close(fd)
    except Exception:
        return None
    return "quiet hours not configured: no %s on this install (noted once)" % config_path(state_dir)


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


# ---------------------------------------------------------------------------
# The install's zone (ISSUE1895, #1895): src/config.ts resolves ONE zone for the
# install (APP_TZ): SCHEDULER_TZ from store/config-overrides.json over .env, and
# the host zone when it is unset or not a real zone. scripts/lib/install-tz.sh is
# the shell side of the same rule, this is the hooks' side: they import only from
# their own directory, so the rule lives here once more instead of an import.
# ---------------------------------------------------------------------------

def _module_root():
    """The install this module belongs to: <root>/scripts/hooks/telegram_quiet_hours.py."""
    return os.path.realpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))


def _real_zone(name):
    try:
        from zoneinfo import ZoneInfo
        ZoneInfo(name)
        return True
    except Exception:
        return False


def _pinned_zone(root):
    """SCHEDULER_TZ, config-overrides.json over .env (the last .env line wins, one pair of quotes
    dropped), only when it names a real zone; '' otherwise."""
    value = ""
    try:
        with open(os.path.join(root, "store", "config-overrides.json"), encoding="utf-8") as f:
            ov = json.load(f)
        if isinstance(ov, dict) and isinstance(ov.get("SCHEDULER_TZ"), str):
            value = ov["SCHEDULER_TZ"].strip()
    except Exception:
        pass
    if not value:
        try:
            with open(os.path.join(root, ".env"), encoding="utf-8", errors="replace") as f:
                for line in f:
                    line = line.strip()
                    if line.startswith("SCHEDULER_TZ="):
                        value = line.split("=", 1)[1].strip()
                        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
                            value = value[1:-1]
        except Exception:
            pass
    return value if value and _real_zone(value) else ""


def _host_zone():
    """The host's zone by NAME (a ZoneInfo keeps the DST rules): TZ when it names one, else /etc/localtime."""
    tz = (os.environ.get("TZ") or "").lstrip(":").strip()
    if "/" in tz and _real_zone(tz):
        return tz
    try:
        target = os.path.realpath("/etc/localtime")
        if "/zoneinfo/" in target and _real_zone(target.split("/zoneinfo/", 1)[1]):
            return target.split("/zoneinfo/", 1)[1]
    except Exception:
        pass
    return ""


def install_zone(root=None):
    """The install's zone: the pinned SCHEDULER_TZ, else the host zone, else UTC. `root` is the
    install's directory; without it, the install this module was loaded from."""
    return _pinned_zone(root or _module_root()) or _host_zone() or "UTC"


def in_quiet(state_dir, chat_id, now=None):
    """True iff chat_id has a configured window and local time is inside it.
    [start, end) -- start inclusive, end exclusive."""
    cfg = load(state_dir).get(str(chat_id))
    if not cfg:
        return False
    try:
        tzname = cfg.get("tz") or install_zone()
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
        tz = ZoneInfo(cfg.get("tz") or install_zone())
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
# apart from "cannot say", and "cannot say" holds the send inside the fallback
# windows for every chat (the gate cannot tell which chat is protected without the file),
# lets it go outside, and reports the defect either way -- but only on an install
# that HAS used quiet hours: a missing file on an install that never had one is no
# defect at all (send, no line), or every fresh install and the upstream default
# would go silent every night (card 20e178fc). What tells the two apart is the
# quiet-hours.seen marker in the install's store directory, the same per config PATH
# record that config_case() reads above: remember_configured() records the install's
# config the first time a real send is evaluated against it while usable, and only a
# missing config whose path the marker records (LOST) is a defect here; a marker that
# records only other channels' configs says nothing about this one. A file that
# exists but cannot be read (0 bytes, truncated, not an object)
# and a malformed entry are defects whatever the marker says: a file that is there
# says someone meant quiet hours.
# ---------------------------------------------------------------------------

# What a missing or unusable config falls back to, for every chat (the file is what
# names the chat): the windows of the LAST config that was read in full, each with its
# own zone, kept in the install's store directory (quiet-hours.last-good.json, written
# by remember_configured() beside the marker). A broken config must not move an owner's
# window, and the install's zone need not be the owner's (an install on UTC, an owner an
# hour or two east of it): an install-zone fallback would let a send through for the
# first hours of that night. Only an install that never had a usable config has no last
# windows; there FALLBACK_WINDOW holds, in the install's zone.
FALLBACK_WINDOW = {"start": "23:00", "end": "07:00"}
LAST_GOOD_NAME = "quiet-hours.last-good.json"


def _strict_hm(s):
    """'HH:MM' -> minutes since midnight; raises on anything else (no '25:00', no '07:60')."""
    h, m = str(s).split(":")
    if not (h.isdigit() and m.isdigit() and len(m) == 2 and int(h) < 24 and int(m) < 60):
        raise ValueError("not a HH:MM time: %r" % (s,))
    return int(h) * 60 + int(m)


def _window_holds(cfg, at_epoch, root=None):
    """(inside, local 'HH:MM') for the instant at_epoch on cfg's own wall clock, [start, end).
    Raises on a malformed entry, unlike in_quiet(): the caller must be able to say 'cannot say'.
    The instant is converted with fromtimestamp(tz), so the answer is the local clock's
    even across a DST change (a UTC-aware datetime handed to in_quiet() would be read
    with its UTC hour)."""
    from zoneinfo import ZoneInfo
    if not isinstance(cfg, dict):
        raise ValueError("the entry is not an object")
    tz = ZoneInfo(cfg.get("tz") or install_zone(root))
    start, end = _strict_hm(cfg.get("start", "23:00")), _strict_hm(cfg.get("end", "07:00"))
    t = datetime.datetime.fromtimestamp(int(at_epoch), tz)
    cur = t.hour * 60 + t.minute
    inside = (start <= cur < end) if start <= end else (cur >= start or cur < end)
    return inside, t.strftime("%H:%M")


def _window_text(cfg, root=None):
    return "%s-%s %s" % (cfg.get("start", "23:00"), cfg.get("end", "07:00"), cfg.get("tz") or install_zone(root))


def last_good_path(seen):
    """The last fully read config's windows, beside the marker: <root>/store/quiet-hours.last-good.json."""
    return os.path.join(os.path.dirname(seen), LAST_GOOD_NAME)


def _root_of(seen):
    """The install directory a marker path names: <root>/store/quiet-hours.seen."""
    return os.path.dirname(os.path.dirname(seen))


def _usable_windows(cfg_all, root):
    """Every entry of a config as {start, end, tz}, the zone written out (an entry without one
    gets the install's zone of today), duplicates once; None when ANY entry is malformed: a config
    that is only partly readable is not the last good one."""
    if not isinstance(cfg_all, dict):
        return None
    out = []
    for cfg in cfg_all.values():
        if not isinstance(cfg, dict):
            return None
        w = {"start": str(cfg.get("start", "23:00")), "end": str(cfg.get("end", "07:00")),
             "tz": cfg.get("tz") or install_zone(root)}
        try:
            _window_holds(w, 0, root)
        except Exception:
            return None
        if w not in out:
            out.append(w)
    return out or None


def _remember_last_good(state_dir, seen, by):
    """Keep the windows of a config read in full beside the marker, so that a broken config later
    falls back to THEM (see FALLBACK_WINDOW). Written only when they differ from the kept ones,
    atomically (a temp file beside it, then replaced). Returns True if this call wrote; never raises."""
    try:
        root = _root_of(seen)
        windows = _usable_windows(load(state_dir), root)
        if not windows:
            return False
        path = last_good_path(seen)
        try:
            with open(path, encoding="utf-8") as f:
                if json.load(f).get("windows") == windows:
                    return False
        except Exception:
            pass
        d = os.path.dirname(path)
        os.makedirs(d, exist_ok=True)
        fd, tmp = tempfile.mkstemp(prefix="." + LAST_GOOD_NAME + ".", dir=d)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as fh:
                fh.write(json.dumps({"windows": windows, "config": config_path(state_dir), "by": by,
                                     "saved": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")}) + "\n")
            os.replace(tmp, path)
            return True
        finally:
            if os.path.exists(tmp):
                os.unlink(tmp)
    except Exception:
        return False


def _fallback_windows(seen, root):
    """(windows, source): the kept last-good windows when the file is there and every one of them
    is usable, else FALLBACK_WINDOW in the install's zone."""
    try:
        with open(last_good_path(seen), encoding="utf-8") as f:
            windows = json.load(f).get("windows")
        if isinstance(windows, list) and windows:
            for w in windows:
                _window_holds(w, 0, root)
            return windows, "last-good"
    except Exception:
        pass
    return [dict(FALLBACK_WINDOW, tz=install_zone(root))], "default"


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
    config missing, the marker
      does not record its path    -> send, no defect (this config was never in use);
    config missing, the marker
      records it (LOST),
      config unreadable, or the chat's
      entry malformed             -> the fallback windows for every chat (the last good
                                     config's, else FALLBACK_WINDOW in the install's
                                     zone), with a defect;
    chat_id unknown (None / '')   -> hold when ANY configured window holds now: the
                                     protected chat cannot be ruled out.
    """
    path = config_path(state_dir)
    root = _root_of(seen)
    chat = None if chat_id is None or str(chat_id).strip() == "" else str(chat_id).strip()

    def fallback(defect):
        windows, source = _fallback_windows(seen, root)
        inside, texts = False, []
        for w in windows:
            held, local = _window_holds(w, at_epoch, root)
            inside = inside or held
            texts.append("%s, helyi ido most %s" % (_window_text(w, root), local))
        why = "a quiet-hours konfig nem hasznalhato, ezert %s ervenyes minden chatre (%s)" % (
            "az utolso hasznalhato konfig ablaka" if source == "last-good" else "az alapablak", "; ".join(texts))
        return inside, why, defect

    state = config_state(state_dir)
    if state == STATE_EMPTY:
        return False, "nincs beallitott csendes ido", None
    if state == STATE_MISSING and config_case(state_dir, seen) != CASE_LOST:
        return False, "nincs csendes-ido konfig, es a telepites ezt a konfigot meg nem hasznalta", None
    if state == STATE_MISSING:
        return fallback("%s: missing, pedig a telepites mar hasznalt csendes-ido konfigot (%s); a tartalek ablak tart" % (path, seen))
    if state != STATE_OK:
        return fallback("%s: %s (a csendes ido nem olvashato, a tartalek ablak tart)" % (path, state))
    cfg_all = load(state_dir)
    if chat is not None:
        cfg = cfg_all.get(chat)
        if cfg is None:
            return False, "a(z) %s chatnek nincs csendes ideje" % chat, None
        try:
            inside, local = _window_holds(cfg, at_epoch, root)
        except Exception as e:
            return fallback("%s: a(z) %s chat bejegyzese hibas (%s: %s)" % (path, chat, type(e).__name__, e))
        return inside, "a(z) %s chat csendes ideje %s, helyi ido most %s" % (chat, _window_text(cfg, root), local), None
    for other, cfg in cfg_all.items():
        try:
            inside, local = _window_holds(cfg, at_epoch, root)
        except Exception as e:
            return fallback("%s: a(z) %s chat bejegyzese hibas (%s: %s)" % (path, other, type(e).__name__, e))
        if inside:
            return True, "a hivas nem nevez chatet, es a(z) %s chat csendes idejeben vagyunk (%s, helyi ido most %s)" % (
                other, _window_text(cfg, root), local), None
    return False, "a hivas nem nevez chatet, es egyik beallitott chat sincs csendes idoben", None
