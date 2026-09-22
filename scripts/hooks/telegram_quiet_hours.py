#!/usr/bin/env python3
"""
Shared quiet-hours check for the Telegram progress hooks (submit / stop / watchdog).

Config: <state_dir>/quiet-hours.json, e.g.
  {"<OWNER_CHAT_ID>": {"start": "23:00", "end": "07:00", "tz": "Europe/Budapest"}}
Missing, empty or unparseable config -> in_quiet() is False for every chat, so the
hooks behave exactly as before. Windows may wrap midnight (start > end).
Why: an owner asked (three times, last 2026-09-11 23:17Z) for NO message between
23:00 and 07:00, not even an auto-reply; on 2026-09-12 00:0xZ the Stop hook's
transcript fallback delivered a message into that window anyway.
"""
import os, json, datetime

CONFIG_NAME = "quiet-hours.json"


def load(state_dir):
    try:
        with open(os.path.join(state_dir, CONFIG_NAME), encoding="utf-8") as f:
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
