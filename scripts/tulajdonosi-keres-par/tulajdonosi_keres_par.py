#!/usr/bin/env python3
"""Owner requests without a kanban card: the evening list.

An owner asked for this (owner-b, tg 2575): agreed rules should not get lost. This script is
the mechanical half of the answer. Every inbound owner Telegram message of a time window that looks
like a request is PAIRED with the kanban when its Telegram message id appears on a card (title or
description) or in a comment, open or archived. The requests without a pair are listed for the main
agent, who opens a card or writes the id onto the existing one.

READ-ONLY. The database is opened with mode=ro: SQLite itself refuses any write, and a missing file is
an error instead of a new empty database.

WHAT COUNTS AS A REFERENCE (shapes measured on the kanban board on 2026-09-28)
  - "tg 2575", "TG 2575", "tg:2575", "tg #2575", and a list right after it: "tg 2375/2380/2385",
    "tg 1680 + 1682", "tg 2563, 2572, 2580", "tg 2375 es 2380";
  - a range, "tg 2253-2255": the ids between the ends count when they belong to
    the chat of the first end, and a span wider than RANGE_MAX pairs its two ends only;
  - "tg-1802", as in the created_by value "owner-a-tg-1802";
  - "Telegram 486", the early form (on the board, many of its numbers are inbound message ids).
  A number that continues as a date, a time or a decimal is NOT an id. In "tg 2575, 2026-09-28T15:11Z"
  the 2026 is a year, and a naive list reader paired it with the outbound message 2026. A list
  continues only with numbers of at least three digits ("tg 2575, 3. pont" is not a pair for 3).
  From the first COMMA of a reference on, a number is COMMA-JOINED and never pairs: "tg 2491, 90150"
  names an inter-agent message 90150, and no property of the number tells an internal id from a
  Telegram id for good (v2's "within 1000" wore out as the counter climbed, teszter-2's measurement). A request
  named only comma-joined is listed apart, see below; the rule has no threshold, so it cannot wear out.
  "tg800" (a device name, no separator) and "msg 90255" (inter-agent message ids) are not
  references. Not followed on purpose: a number that only stands near a reference ("tg 1104, a
  1100/1102 kerdesre"). A missed pair lists a request once more; a false pair hides it, and this list
  exists against hiding.

WHERE A REFERENCE PAIRS (--pair-in; the default decided by fejlesztes-vezeto)
  any (default): a card title or description pairs (the main list). A request named in comments only
    is listed apart, "CSAK KOMMENTBEN EMLITVE, ELLENORIZENDO", with the cards whose comments name it:
    a mention in another card's comment is not an owning card, but it must not vanish either. The
    brief's own examples were such cases (tg 1295/1315 and tg 1742
    stood in comments of other cards before their cards were opened on 2026-09-28 14:20Z). The header
    carries both numbers and the rule.
  description: only a card title or description pairs; the comment-only requests join the main list.
  In both: a request named nowhere explicitly but comma-joined somewhere is listed apart, "CSAK
    VESSZOVEL CSATOLVA, KETERTELMU, ELLENORIZENDO", with the cards (fejlesztes-vezeto: the safe
    side of an ambiguous number is no pair, and what falls out stays on the evening list).
  Neither sees a request whose card was closed with a different delivery (tg 1235: its
  card was archived as done the next day); that needs a person reading the card.

WHAT COUNTS AS A REQUEST (the plan: a question or an instruction, not an acknowledgement)
  1. an acknowledgement is not: nothing but emoji and punctuation, or only acknowledgement words
     (ok, koszi, rendben, szuper, mehet, igen ...);
  2. a question is: a "?" anywhere;
  3. a voice message or a document is (the owners give instructions by voice), unless 1;
  4. an instruction is: a request word (kerlek, kell, kellene, szeretnem, fontos ...), an irregular
     imperative (legyen, gyere, menj ...), or a word with an imperative ending, the first person
     included (lassam, nezzem), see is_imperative();
  5. a one-word message is an acknowledgement ("egyszavas visszaigazolas");
  6. anything else is a statement: counted, not listed (--all lists it).

MEASURED FACTS THIS RELIES ON (2026-09-28)
  - conversation_log holds the main agent's channel only (agent_id ugyvezeto). The owners' chats are
    the principals.json entries with role owner or sysadmin_owner; a staff member's chat has 0 rows here.
  - Telegram message ids are unique across the owner chats (0 collisions among the inbound rows), so a
    bare "tg NNNN" is unambiguous. The window's collisions are counted and reported if any appear.
  - reply_to_message_id is empty in every row, so a request cannot be paired through the answer to it.

Exit codes:
  0 -- the list was built (it may be empty; the warnings say when an empty list proves nothing)
  2 -- input problem: missing database or principals file, bad arguments, unreadable table

Environment:
  CLAUDECLAW_ROOT -- project root (default: the nearest parent of this file that holds
                     store/claudeclaw.db, else the working directory)

Run: python3 tulajdonosi_keres_par.py [--hours 24] [--since ISO] [--until ISO] [--asof ISO]
                                      [--pair-in any|description] [--format text|json] [--all]
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sqlite3
import sys
import time
import unicodedata
from datetime import datetime, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

AGENT = "ugyvezeto"
OWNER_ROLES = ("sysadmin_owner", "owner")
TEXT_WIDTH = 120
BUDAPEST = ZoneInfo("Europe/Budapest")


def find_root() -> Path:
    env = os.environ.get("CLAUDECLAW_ROOT")
    if env:
        return Path(env)
    for parent in Path(__file__).resolve().parents:
        if (parent / "store" / "claudeclaw.db").is_file():
            return parent
    return Path.cwd()


# ---------------------------------------------------------------------------------------------------
# References on the board
# ---------------------------------------------------------------------------------------------------

# An item is an id or a range ("tg 2253-2255"). It must not continue as a longer
# number, a date ("2026-09-28": two digits after the dash, "2026.09.28"), a time ("21:38") or an ISO
# date-time. A Hungarian suffix ("486-ban") is fine.
_ID_END = r"(?!\d|[-.:]\d|T\d)"
_FIRST_ITEM = r"\d{1,9}(?:-\d{3,9})?" + _ID_END
_NEXT_ITEM = r"\d{3,9}(?:-\d{3,9})?" + _ID_END
_SEP = r"\s*(?:/|\+|,|\bés\b|\bes\b|\band\b)\s*"
_REF = re.compile(
    r"(?<![0-9A-Za-z_])(?:tg|telegram)(?:\s*[:#]\s*|\s+#?|-)"
    r"(" + _FIRST_ITEM + r"(?:" + _SEP + _NEXT_ITEM + r")*)",
    re.IGNORECASE,
)
# A range covers at most this many ids. The ids come from one counter shared by the chats, so a range
# is widened only over the messages of its first end's chat; a wider span ("Telegram 1375-1460, 13
# darab") pairs its two ends only.
RANGE_MAX = 50
# A comma also joins a Telegram id to an INTERNAL one: "tg 2491, 90150" (90150 is an inter-agent
# message id; such ids stood on the board on 2026-09-28, teszter-2). No property of the number tells
# the two apart for good: v2 accepted a comma-joined number within 1000 of the item before it, and that
# wears out as the Telegram counter climbs into the range of old internal ids (from about 2026-10-03,
# teszter-2), after which a new text naming a fresh tg id and an old internal id pairs the wrong
# message. So from the FIRST COMMA of a reference on, every number is COMMA-JOINED: it never pairs, and a
# request named only that way is listed apart as ambiguous (fejlesztes-vezeto: the safe side of an
# ambiguous number is no pair, and what falls out stays on the evening list). The rule has no threshold
# and no date, so it cannot wear out. "tg" covers the first item and the items joined to it by /, + or
# "es" (on the board nearly all such continuations were near, one was a real list).
_ITEM = re.compile(r"(\d+(?:-\d+)?)(" + _SEP + r")?")


def _items(group: str) -> list[tuple[str, bool]]:
    """The items of one reference in order, each with whether it is EXPLICIT (the first one and those joined to it
    by /, + or "es"); from the first comma on, every item is comma-joined."""
    out: list[tuple[str, bool]] = []
    explicit, sep_before = True, None
    for m in _ITEM.finditer(group):
        if sep_before is not None and sep_before.strip() == ",":
            explicit = False
        out.append((m.group(1), explicit))
        sep_before = m.group(2)
    return out


def _expand(item: str, chat_of: dict[str, str] | None) -> set[str]:
    """An id, or a range's two ends plus, for a range of at most RANGE_MAX, the ids between them in the first end's chat."""
    a, _, b = item.partition("-")
    if not b:
        return {a}
    out = {a, b}
    lo, hi = int(a), int(b)
    chat = (chat_of or {}).get(a)
    if chat and lo < hi <= lo + RANGE_MAX:
        out.update(str(n) for n in range(lo + 1, hi) if chat_of.get(str(n)) == chat)
    return out


def references(text: str, chat_of: dict[str, str] | None = None) -> tuple[set[str], set[str]]:
    """(the ids a card or comment text names explicitly, the ids it names only comma-joined). `chat_of` (message id
    -> chat id) widens a range to the messages of the same chat; without it a range gives its two ends."""
    explicit: set[str] = set()
    comma: set[str] = set()
    for m in _REF.finditer(text or ""):
        for item, is_explicit in _items(m.group(1)):
            (explicit if is_explicit else comma).update(_expand(item, chat_of))
    return explicit, comma - explicit


def referenced_ids(text: str, chat_of: dict[str, str] | None = None) -> set[str]:
    """The ids a text names explicitly, the only ones that pair."""
    return references(text, chat_of)[0]


# ---------------------------------------------------------------------------------------------------
# Request or not
# ---------------------------------------------------------------------------------------------------


def fold(s: str) -> str:
    """Lower case without accents: "Köszönöm" -> "koszonom"."""
    return "".join(c for c in unicodedata.normalize("NFKD", s.lower()) if not unicodedata.combining(c))


# A channel topic tag in front of the text: "[#P32 Téma (PR #7)] ..."
_TOPIC_TAG = re.compile(r"^\s*\[#[^\]]{0,80}\]\s*")

ACK_WORDS = frozenset(
    """
    ok oke okes okay okey oki okidoki okszi k kk
    kosz koszi koszike koszonom koszonjuk koszonet koszonom thx thanks thank you
    rendben rendbe rendicsek jo jol van szuper super remek kiraly tokeletes klassz nagyszeru
    ertem ertettem vettem latom lattam megvan igen persze nana mehet ja jah aha aham yes yep
    szia sziasztok hello hali helo udv reggelt estet ejszakat napot hajra gratulalok gratula
    szep szepen munka nagyon egyetertek na hat akkor most is mar ez az es de meg tenyleg igazan
    """.split()
)

REQUEST_WORDS = frozenset(
    """
    kerlek kerem kernem kernek kernenk kerjuk legyszi legyszives szives szeretnem szeretnek
    szeretnenk kell kellene kene kelljen muszaj tudnad tudnatok tudnal lehetne fontos surgos
    azonnal mielobb asap mehet
    """.split()
)

IRREGULAR_IMPERATIVES = frozenset(
    """
    legyen legyenek legyel legyetek tegyen tegyel tegyetek vegyen vegyel vegyetek vigyen vigyel
    vigyetek egyen gyere gyertek jojj jojjetek jojjon menj menjetek menjen menjenek hozz hozzatok
    hozzon nezz nezzetek nezzen nezzuk keress keressetek olvass olvassatok
    """.split()
)

# Words with an imperative-looking ending that are nouns, place or personal names, English words or
# indicative forms in the owners' messages (from the 21-day word list, 2026-09-28).
NOT_IMPERATIVE = frozenset(
    """
    rend sorrend gond zold erd rekord build and end kind send found systemd grid dashboard david conrad
    lorand coord baj zaj haj vaj dij fej ujj jon megjon elejen tetejen fejen hajon mind fold hold kard
    kuld mond old kezd tudjuk mondjuk latjuk ertjuk kapjuk varjuk folytatjuk beszeljuk rajuk hozzajuk
    hozzam hajam fejem dijam ujjam vajam
    """.split()
)


def is_imperative(word: str) -> bool:
    """An informal imperative by its ending (the word is folded): nezd, csinald, irj, csinaljatok,
    menjen, haladjunk, kuldjuk, javits, keress, and the first person lassam, nezzem, irjam (teszter-2:
    tg 2315 was a statement for want of it). The indicative "-od/-ed" (tudod, latod, kezeled)
    and the past "-tad/-ted" (megkaptad) end in a vowel before the d, so they do not match; neither do
    the indicative first person (latom, nezem) and its past (lattam), and the nouns with "-am/-em"
    after a j (hajam, fejem) and "hozzam" (hozzam, to me) are listed in NOT_IMPERATIVE. The third
    person (lassa, irja) is left out on purpose: for many verbs it is the indicative too."""
    if len(word) < 3 or word in NOT_IMPERATIVE:
        return False
    if word in IRREGULAR_IMPERATIVES:
        return True
    return bool(
        re.search(r"[^aeiou]d$", word)  # nezd, csinald, tedd, kuldd, ird, javitsd
        or re.search(r"[^aeiouj]j$", word)  # csinalj, irj, szolj, figyelj, kuldj
        or re.search(r"(j|ts|ss|zz)(atok|etek)$", word)  # csinaljatok, javitsatok, keressetek
        or re.search(r"(j|ts|ss|zz)(on|en)$", word)  # menjen, maradjon, alljon, keruljon
        or re.search(r"j(unk|uk)$", word)  # haladjunk, kuldjuk, csinaljuk
        or re.search(r"its$", word)  # javits, keszits, segits
        or re.search(r"(j|ss|zz|ts)(am|em)$", word)  # lassam, nezzem, irjam, tudjam, mentsem
    )


def classify(text: str, kind: str | None) -> str:
    """'ack', 'request' or 'statement', by the rules in the module docstring."""
    body = _TOPIC_TAG.sub("", text or "")
    words = re.findall(r"[a-z0-9]+", fold(body))
    if not words:
        return "request" if kind == "document" else "ack"  # a bare file is sent to be handled
    if all(w in ACK_WORDS for w in words):
        return "ack"
    if "?" in body:
        return "request"
    if kind in ("voice", "document"):
        return "request"
    if any(w in REQUEST_WORDS or is_imperative(w) for w in words):
        return "request"
    if len(words) == 1:
        return "ack"
    return "statement"


# ---------------------------------------------------------------------------------------------------
# Data
# ---------------------------------------------------------------------------------------------------


class InputError(Exception):
    pass


def load_owners(principals: Path) -> dict[str, str]:
    """chat id -> name of the owners (role owner or sysadmin_owner)."""
    if not principals.is_file():
        raise InputError(f"principals file not found: {principals}")
    data = json.loads(principals.read_text(encoding="utf-8"))
    owners = {
        str(k): str(v.get("name") or k)
        for k, v in (data.get("principals") or {}).items()
        if isinstance(v, dict) and v.get("role") in OWNER_ROLES
    }
    if not owners:
        raise InputError(f"no owner in {principals} (roles {', '.join(OWNER_ROLES)})")
    return owners


def open_ro(db: Path) -> sqlite3.Connection:
    if not db.is_file():
        raise InputError(f"database not found: {db}")
    return sqlite3.connect(f"file:{db}?mode=ro", uri=True)


def board_references(
    con: sqlite3.Connection, asof: int
) -> tuple[set[str], dict[str, set[str]], dict[str, set[str]], dict[str, int]]:
    """The ids named on the board as it stood at `asof`, in three parts: explicitly in a card title or description;
    explicitly in a comment (id -> the cards whose comments name it); and only comma-joined anywhere (id -> the cards).
    Cards created by then count, open and archived (the description is today's text, there is no history of it), and
    comments written by then."""
    chat_of = {
        str(mid): str(chat)
        for mid, chat in con.execute(
            "SELECT message_id, chat_id FROM conversation_log WHERE agent_id = ? AND message_id IS NOT NULL", (AGENT,)
        )
    }
    in_description: set[str] = set()
    in_comment: dict[str, set[str]] = {}
    comma_joined: dict[str, set[str]] = {}
    counts = {"cards": 0, "comments": 0}
    for card_id, title, desc in con.execute(
        "SELECT id, title, description FROM kanban_cards WHERE created_at <= ?", (asof,)
    ):
        counts["cards"] += 1
        explicit, comma = references(f"{title or ''}\n{desc or ''}", chat_of)
        in_description |= explicit
        for i in comma:
            comma_joined.setdefault(i, set()).add(str(card_id))
    for card_id, content in con.execute(
        "SELECT card_id, content FROM kanban_comments WHERE created_at <= ?", (asof,)
    ):
        counts["comments"] += 1
        explicit, comma = references(content or "", chat_of)
        for i in explicit:
            in_comment.setdefault(i, set()).add(str(card_id))
        for i in comma:
            comma_joined.setdefault(i, set()).add(str(card_id))
    return in_description, in_comment, comma_joined, counts


def inbound(con: sqlite3.Connection, owners: dict[str, str], since: int, until: int) -> list[dict]:
    marks = ",".join("?" * len(owners))
    rows = con.execute(
        f"SELECT message_id, chat_id, created_at, text, attachment_kind FROM conversation_log "
        f"WHERE agent_id = ? AND direction = 'in' AND chat_id IN ({marks}) "
        f"AND created_at >= ? AND created_at < ? ORDER BY created_at, id",
        (AGENT, *owners, since, until),
    ).fetchall()
    return [
        {"tg": str(mid), "chat": str(chat), "owner": owners[str(chat)], "created_at": int(ts), "text": text or "", "kind": kind}
        for mid, chat, ts, text, kind in rows
    ]


PAIR_IN = ("any", "description")


def build(
    con: sqlite3.Connection, owners: dict[str, str], since: int, until: int, asof: int, pair_in: str = "any"
) -> dict:
    """pair_in "any": a request is paired when its id stands in a title, a description or a comment;
    a request named in comments only is paired but listed apart ("comment_only"), because a brief that
    lives in a comment gets lost. pair_in "description": only a title or a description pairs.
    A request named nowhere explicitly but COMMA-JOINED somewhere is not paired and is listed apart
    ("comma_only"), with the cards: the number may be an internal id, see _items()."""
    if pair_in not in PAIR_IN:
        raise InputError(f"pair_in must be one of {', '.join(PAIR_IN)}")
    msgs = inbound(con, owners, since, until)
    in_description, in_comment, comma_joined, board = board_references(con, asof)
    refs = in_description | set(in_comment)
    warnings: list[str] = []
    per_id: dict[str, set[str]] = {}
    for m in msgs:
        per_id.setdefault(m["tg"], set()).add(m["chat"])
    collisions = sorted(i for i, chats in per_id.items() if len(chats) > 1)
    if collisions:
        warnings.append(
            f"ugyanaz a Telegram-azonosító több tulajdonosi chatben: {', '.join(collisions)}; "
            "ezeknél a 'tg NNNN' nem egyértelmű, a pár feltételezett"
        )
    if not msgs:
        last = con.execute(
            "SELECT MAX(created_at) FROM conversation_log WHERE agent_id = ? AND direction = 'in'", (AGENT,)
        ).fetchone()[0]
        warnings.append(
            "az ablakban 0 bejövő tulajdonosi sor: csend volt, VAGY a naplózás állt; "
            f"a legutolsó bejövő sor: {iso(last) if last else 'nincs'}"
        )
    if not refs:
        warnings.append("a kanbanon 0 tg-hivatkozás: a párosítás vak, a lista nem bizonyít semmit")
    counts = {
        "inbound": len(msgs), "request": 0, "paired": 0, "comment_only": 0, "comma_only": 0, "unpaired": 0,
        "ack": 0, "statement": 0,
    }
    unpaired, comment_only, comma_only, others = [], [], [], []
    for m in msgs:
        m["class"] = classify(m["text"], m["kind"])
        m["comment_cards"] = sorted(in_comment.get(m["tg"], ()))
        m["comma_cards"] = sorted(comma_joined.get(m["tg"], ()))
        only_in_comment = m["tg"] not in in_description and bool(m["comment_cards"])
        m["paired"] = m["tg"] in in_description or (pair_in == "any" and only_in_comment)
        if m["class"] == "request":
            counts["request"] += 1
            if not m["paired"] and m["comma_cards"] and not m["comment_cards"]:
                counts["comma_only"] += 1
                comma_only.append(m)
            elif not m["paired"]:
                counts["unpaired"] += 1
                unpaired.append(m)
            elif only_in_comment:
                counts["comment_only"] += 1
                comment_only.append(m)
            else:
                counts["paired"] += 1
        else:
            counts[m["class"]] += 1
            if not m["paired"]:
                others.append(m)
    return {
        "window": {"since": iso(since), "until": iso(until), "asof": iso(asof), "pair_in": pair_in},
        "board": {**board, "referenced_ids": len(refs), "comma_joined_ids": len(comma_joined)},
        "counts": counts,
        "unpaired": unpaired,
        "comment_only": comment_only,
        "comma_only": comma_only,
        "unpaired_other": others,
        "warnings": warnings,
    }


# ---------------------------------------------------------------------------------------------------
# Output
# ---------------------------------------------------------------------------------------------------


def iso(ts: int) -> str:
    return datetime.fromtimestamp(ts, timezone.utc).strftime("%Y-%m-%dT%H:%MZ")


def line(m: dict) -> str:
    utc = datetime.fromtimestamp(m["created_at"], timezone.utc)
    bp = utc.astimezone(BUDAPEST).strftime("%H:%M")
    text = " ".join(m["text"].split())[:TEXT_WIDTH]
    kind = f" [{'hang' if m['kind'] == 'voice' else m['kind']}]" if m["kind"] else ""
    cards = m.get("comment_cards") or []
    where = f" | kommentben: {', '.join(c[:8] for c in cards)}" if cards else ""
    comma = m.get("comma_cards") or []
    if comma:
        where += f" | vesszővel: {', '.join(c[:8] for c in comma)}"
    return f"{utc:%Y-%m-%d %H:%M}Z ({bp} Bp) | {m['owner']} | tg {m['tg']}{kind} | {text}{where}"


COMMENT_ONLY_LABEL = "CSAK KOMMENTBEN EMLÍTVE, ELLENŐRIZENDŐ"
COMMA_ONLY_LABEL = "CSAK VESSZŐVEL CSATOLVA, KÉTÉRTELMŰ, ELLENŐRIZENDŐ"


def render_text(r: dict, show_all: bool) -> str:
    w, b, c = r["window"], r["board"], r["counts"]
    if w["pair_in"] == "any":
        rule = (
            "pár = a kérés tg-azonosítója egy lap címében vagy leírásában (nyitott vagy archivált lap); "
            "a csak kommentben említett kérés külön szakaszban, a lap-azonosítóval"
        )
    else:
        rule = "pár = a kérés tg-azonosítója egy lap címében vagy leírásában; a csak kommentben említett is a fő listán"
    rule += "; a vesszővel csatolt szám nem pároz (lehet belső azonosító), az így említett kérés külön szakaszban"
    out = [
        f"TULAJDONOSI KÉRÉSEK PÁR NÉLKÜL | ablak {w['since']} .. {w['until']} | kanban állapot {w['asof']}",
        f"PÁR NÉLKÜL {c['unpaired']} | {COMMENT_ONLY_LABEL} {c['comment_only']} | {COMMA_ONLY_LABEL} {c['comma_only']} | {rule}",
        f"bejövő {c['inbound']} | kérés {c['request']} | lapon (cím vagy leírás) {c['paired']} | nyugta {c['ack']} | "
        f"egyéb (nem kérés) {c['statement']} | kanban: {b['cards']} lap, {b['comments']} komment, "
        f"{b['referenced_ids']} hivatkozott tg-azonosító, {b['comma_joined_ids']} csak vesszővel csatolt",
    ]
    out += [f"FIGYELEM: {x}" for x in r["warnings"]]
    out += [line(m) for m in r["unpaired"]] or ["(nincs pár nélküli kérés)"]
    if r["comment_only"]:
        out.append(f"--- {COMMENT_ONLY_LABEL} ({len(r['comment_only'])}), a lap-azonosító a sor végén:")
        out += [line(m) for m in r["comment_only"]]
    if r["comma_only"]:
        out.append(f"--- {COMMA_ONLY_LABEL} ({len(r['comma_only'])}), a lap-azonosító a sor végén:")
        out += [line(m) for m in r["comma_only"]]
    if show_all:
        out.append(f"--- nem kérésnek sorolt, pár nélküli üzenetek ({len(r['unpaired_other'])}):")
        out += [f"{m['class']}: {line(m)}" for m in r["unpaired_other"]]
    return "\n".join(out)


def render_json(r: dict, show_all: bool) -> str:
    def slim(m: dict) -> dict:
        return {
            "tg": m["tg"],
            "chat": m["chat"],
            "owner": m["owner"],
            "utc": iso(m["created_at"]),
            "kind": m["kind"],
            "class": m["class"],
            "text": " ".join(m["text"].split())[:TEXT_WIDTH],
            "comment_cards": m.get("comment_cards") or [],
            "comma_cards": m.get("comma_cards") or [],
        }

    out = {k: r[k] for k in ("window", "board", "counts", "warnings")}
    out["unpaired"] = [slim(m) for m in r["unpaired"]]
    out["comment_only"] = [slim(m) for m in r["comment_only"]]
    out["comma_only"] = [slim(m) for m in r["comma_only"]]
    if show_all:
        out["unpaired_other"] = [slim(m) for m in r["unpaired_other"]]
    return json.dumps(out, ensure_ascii=False, indent=2)


def parse_ts(s: str) -> int:
    """ISO date or date-time; a value without an offset is UTC."""
    d = datetime.fromisoformat(s.replace("Z", "+00:00"))
    if d.tzinfo is None:
        d = d.replace(tzinfo=timezone.utc)
    return int(d.timestamp())


def main(argv: list[str] | None = None) -> int:
    root = find_root()
    ap = argparse.ArgumentParser(description="Owner requests without a kanban card (read-only).")
    ap.add_argument("--db", type=Path, default=root / "store" / "claudeclaw.db")
    ap.add_argument("--principals", type=Path, default=root / "store" / "principals.json")
    ap.add_argument("--hours", type=float, default=24.0, help="window length before --until (default 24)")
    ap.add_argument("--since", help="window start, ISO (UTC when no offset); overrides --hours")
    ap.add_argument("--until", help="window end, ISO (default: now)")
    ap.add_argument("--asof", help="the board as it stood at this time (default: --until)")
    ap.add_argument(
        "--pair-in",
        choices=PAIR_IN,
        default="any",
        help="any: a title, a description or a comment pairs, the comment-only ones listed apart (default); "
        "description: only a title or a description pairs",
    )
    ap.add_argument("--format", choices=("text", "json"), default="text")
    ap.add_argument("--all", action="store_true", help="also list the unpaired messages that are not requests")
    args = ap.parse_args(argv)
    try:
        until = parse_ts(args.until) if args.until else int(time.time())
        since = parse_ts(args.since) if args.since else int(until - args.hours * 3600)
        asof = parse_ts(args.asof) if args.asof else until
        if since >= until:
            raise InputError(f"empty window: {iso(since)} .. {iso(until)}")
        owners = load_owners(args.principals)
        con = open_ro(args.db)
        try:
            report = build(con, owners, since, until, asof, args.pair_in)
        finally:
            con.close()
    except (InputError, ValueError, sqlite3.Error, json.JSONDecodeError) as e:
        print(f"HIBA: {e}", file=sys.stderr)
        return 2
    print(render_json(report, args.all) if args.format == "json" else render_text(report, args.all))
    return 0


if __name__ == "__main__":
    sys.exit(main())
