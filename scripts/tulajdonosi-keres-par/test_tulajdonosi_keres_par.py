#!/usr/bin/env python3
"""Scenario tests for tulajdonosi_keres_par against a throwaway database.

Every chat id, name, message id and text below is made up; nothing here reads store/claudeclaw.db or
store/principals.json. The scenario that matters most is `scenario_reference_forms`: a year after a
list ("tg 2575, 2026-09-28T15:11Z") paired the outbound message 2026 on the live board, and a false
pair HIDES a request, which is the one failure this list exists to prevent.

Run: python3 test_tulajdonosi_keres_par.py
"""

from __future__ import annotations

import contextlib
import importlib.util
import io
import json
import sqlite3
import sys
import tempfile
from pathlib import Path

SPEC = importlib.util.spec_from_file_location(
    "tulajdonosi_keres_par", Path(__file__).resolve().parent / "tulajdonosi_keres_par.py"
)
kp = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(kp)

FAILURES: list[str] = []

# 2026-09-28T12:00:00Z and friends, in unix seconds.
T0 = 1790596800
HOUR = 3600
OWNERS = {"1001": "Tulaj A", "1002": "Tulaj B", "1003": "Rendszergazda"}


def check_eq(name: str, got, want) -> None:
    if got == want:
        print(f"  ok   {name}: {got!r}")
    else:
        print(f"  FAIL {name}: got {got!r}, want {want!r}")
        FAILURES.append(name)


def build_db(path: Path) -> sqlite3.Connection:
    con = sqlite3.connect(path)
    con.executescript(
        """
        CREATE TABLE conversation_log (id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT NOT NULL,
          chat_id TEXT NOT NULL, direction TEXT NOT NULL, message_id TEXT, text TEXT, ts TEXT,
          created_at INTEGER NOT NULL, attachment_kind TEXT, attachment_file_id TEXT, reply_to_message_id TEXT);
        CREATE TABLE kanban_cards (id TEXT PRIMARY KEY, title TEXT, description TEXT, status TEXT,
          assignee TEXT, priority TEXT, project TEXT, due_date INTEGER, sort_order REAL, created_at INTEGER,
          updated_at INTEGER, archived_at INTEGER, parent_id TEXT, dispatched_at INTEGER);
        CREATE TABLE kanban_comments (id INTEGER PRIMARY KEY AUTOINCREMENT, card_id TEXT, author TEXT,
          content TEXT, created_at INTEGER, automated INTEGER);
        """
    )
    con.commit()
    return con


def msg(con, mid, chat, text, at, direction="in", kind=None, agent="ugyvezeto") -> None:
    con.execute(
        "INSERT INTO conversation_log (agent_id, chat_id, direction, message_id, text, created_at, attachment_kind) "
        "VALUES (?, ?, ?, ?, ?, ?, ?)",
        (agent, chat, direction, str(mid), text, at, kind),
    )


def card(con, cid, title, desc, at, archived=None) -> None:
    con.execute(
        "INSERT INTO kanban_cards (id, title, description, status, created_at, archived_at) VALUES (?, ?, ?, 'planned', ?, ?)",
        (cid, title, desc, at, archived),
    )


def comment(con, cid, content, at) -> None:
    con.execute(
        "INSERT INTO kanban_comments (card_id, author, content, created_at) VALUES (?, 'x', ?, ?)", (cid, content, at)
    )


def scenario_acknowledgements() -> None:
    print("scenario: acknowledgements are not requests")
    for text in ("ok", "Oké, köszi!", "👍", "Rendben, mehet.", "Szuper", "Köszönöm szépen", "!!!", "Igen", "[#P32 Téma (PR #7)] köszi"):
        check_eq(f"ack {text!r}", kp.classify(text, None), "ack")
    check_eq("voice ack", kp.classify("Oké, köszönöm", "voice"), "ack")
    check_eq("one word", kp.classify("Holnap", None), "ack")


def scenario_requests() -> None:
    print("scenario: questions, instructions, voice and files are requests")
    for text in (
        "Mikor lesz kész?",
        "Nézd meg holnap a számlákat",
        "Csináljátok meg ma",
        "Menjen ki ma",
        "Legyen kész 16-ra",
        "Kérlek küldd át a listát",
        "Mehet ki élesbe",
        "javíts rajta, mert rossz",
        "Haladjunk a számlázással",
        "Fontos, hogy ma meglegyen",
        "Hadd lássam a listát",  # teszter-2, the tg 2315 case
        "Ezt még nézzem meg holnap",
    ):
        check_eq(f"request {text!r}", kp.classify(text, None), "request")
    check_eq("voice without transcript", kp.classify("(voice message)", "voice"), "request")
    check_eq("bare document", kp.classify("", "document"), "request")


def scenario_statements() -> None:
    print("scenario: statements are counted, not listed")
    for text in (
        "Holnap 10-kor jön a könyvelő",
        "Tudod, a múlt héten ez már működött",
        "Látom, hogy a lista rendben megjött",
        "Megkaptad a tegnapi táblát, láttam",
        "Látom a listát, rendben van",
    ):
        check_eq(f"statement {text!r}", kp.classify(text, None), "statement")
    for word in ("tudod", "latod", "kezeled", "megkaptad", "neked", "szerinted", "rend", "mind", "kuld", "rajuk", "elejen",
                 "latom", "nezem", "lattam", "mentem", "kertem", "lassa", "hozzam", "hajam", "fejem"):
        check_eq(f"not imperative {word}", kp.is_imperative(word), False)
    for word in ("nezd", "csinald", "irj", "csinaljatok", "menjen", "maradjon", "haladjunk", "javits", "keress", "legyen",
                 "lassam", "nezzem", "irjam", "tudjam", "mentsem"):
        check_eq(f"imperative {word}", kp.is_imperative(word), True)


def scenario_reference_forms() -> None:
    print("scenario: what counts as a reference on the board (explicit ids pair, comma-joined ones do not)")
    chat = {"2253": "A", "2254": "B", "2255": "A", "1386": "A", "1387": "A"}
    cases = {  # text -> (explicit ids, comma-joined ids)
        "tg 2575": ({"2575"}, set()),
        "TG 2575.": ({"2575"}, set()),
        "(tg:2575)": ({"2575"}, set()),
        "tg #2575": ({"2575"}, set()),
        "tg 2375/2380/2385": ({"2375", "2380", "2385"}, set()),
        "tg 1680 + 1682, 2026-09-21": ({"1680", "1682"}, set()),
        "tg 2375 és 2380": ({"2375", "2380"}, set()),
        # the false pair seen on the live board: the year after the list is not an id
        "tg 2575, 2026-09-28T15:11Z": ({"2575"}, set()),
        "tg 2575, 15:10Z": ({"2575"}, set()),
        "tg 2575, 3. pont": ({"2575"}, set()),
        "tg 2026-09-28": (set(), set()),
        "Telegram 486-ban": ({"486"}, set()),
        "Telegram 21:38": (set(), set()),
        "owner-a-tg-1802": ({"1802"}, set()),
        "tg800": (set(), set()),
        "msg 90255": (set(), set()),
        "tg 1104, a 1100/1102 kérdésre": ({"1104"}, set()),
        # from the first comma on a number may be an INTERNAL id (teszter-2, fejlesztes-vezeto): it never pairs
        "tg 2491, 90150": ({"2491"}, {"90150"}),
        "tg 1565, 90013": ({"1565"}, {"90013"}),
        "tg 2563, 2572, 2580;": ({"2563"}, {"2572", "2580"}),
        "tg 1862, 2563, 2572": ({"1862"}, {"2563", "2572"}),
        "tg 2244-2246, 643": ({"2244", "2246"}, {"643"}),
        "tg 1210, 2569/2572": ({"1210"}, {"2569", "2572"}),
        "tg 2563, tg 2572": ({"2563", "2572"}, set()),
        "tg 2572, 2563; tg 2563": ({"2572", "2563"}, set()),
        # after +, / and "és" only the three-digit rule keeps a short number out
        "tg 2575 + 12 perc": ({"2575"}, set()),
        "tg 2575 és 12 darab": ({"2575"}, set()),
        # a range widens over the chat of its first end only; a wide span gives its ends
        "Előzmény tg 2253-2255: a": ({"2253", "2255"}, set()),
        "Telegram 1375-1460, 13 darab": ({"1375", "1460"}, set()),
        "tg 1385-1388": ({"1385", "1388"}, set()),
    }
    for text, want in cases.items():
        check_eq(f"refs {text!r}", kp.references(text, chat), want)
    check_eq("referenced_ids = the explicit part", kp.referenced_ids("tg 2491, 90150", chat), {"2491"})
    check_eq("range, same chat widened", kp.referenced_ids("tg 1386-1388", {"1386": "A", "1387": "A", "1388": "B"}), {"1386", "1387", "1388"})
    check_eq("range without a chat map", kp.referenced_ids("tg 2253-2255"), {"2253", "2255"})
    check_eq(
        "a span wider than RANGE_MAX gives its ends, even in one chat",
        kp.referenced_ids("tg 1386-1486", {"1386": "A", "1446": "A", "1486": "A"}),
        {"1386", "1486"},
    )


def scenario_future_comma() -> None:
    print("scenario: a future 'tg X, Y' with Y an old internal id within 1000 of X makes no silent pair (fejlesztes-vezeto)")
    # X: a Telegram level some days ahead; Y: an old internal id within 1000 of X (made-up values, the same gaps as
    # measured). Y is also an owner REQUEST here, which a silent pair would hide.
    t10 = 1791590400  # 2026-10-10T00:00:00Z
    for x, y, y_at in ((5426, 5957, t10 + 86400), (8179, 8000, t10 - 86400)):
        with tempfile.TemporaryDirectory() as d:
            db = Path(d) / "t.db"
            con = build_db(db)
            msg(con, x, "1001", "Nézd meg a számlákat", t10 + 3600)
            msg(con, y, "1001", "Küldd át a listát", y_at)
            card(con, "c-fut", f"Tulajdonosi kérés: tg {x}, {y} (belső üzenet-azonosító)", "", t10 + 7200)
            con.commit()
            con.close()
            con = kp.open_ro(db)
            try:
                r = kp.build(con, OWNERS, t10 - 2 * 86400, t10 + 3 * 86400, t10 + 3 * 86400)
            finally:
                con.close()
        check_eq(f"X={x} paired", [m["tg"] for m in r["unpaired"] + r["comma_only"] + r["comment_only"] if m["tg"] == str(x)], [])
        check_eq(f"Y={y} not silently paired: listed as comma-joined", [(m["tg"], m["comma_cards"]) for m in r["comma_only"]], [(str(y), ["c-fut"])])
        check_eq(f"Y={y} visible, counts", (r["counts"]["paired"], r["counts"]["comma_only"], r["counts"]["unpaired"]), (1, 1, 0))


def pairing_db(tmp: Path) -> Path:
    db = tmp / "t.db"
    con = build_db(db)
    until = T0 + 24 * HOUR
    msg(con, 101, "1001", "Nézd meg a számlákat", T0 + 1 * HOUR)  # paired on an open card title
    msg(con, 102, "1002", "Mikor lesz kész?", T0 + 2 * HOUR)  # paired in an archived card's description
    msg(con, 103, "1001", "Csináld meg ma", T0 + 3 * HOUR)  # paired in a comment on an archived card
    msg(con, 104, "1003", "Küldd át a listát", T0 + 4 * HOUR)  # only on a card created after asof
    msg(con, 105, "1001", "Legyen kész holnapra", T0 + 5 * HOUR)  # only in a comment written after asof
    msg(con, 106, "1002", "Írd meg a választ", T0 + 6 * HOUR)  # nowhere
    msg(con, 107, "1001", "(voice message)", T0 + 7 * HOUR, kind="voice")  # nowhere
    msg(con, 108, "1001", "Oké, köszi", T0 + 8 * HOUR)  # ack, nowhere
    msg(con, 109, "1002", "Holnap 10-kor jön a könyvelő", T0 + 9 * HOUR)  # statement, nowhere
    msg(con, 110, "1001", "Nézd meg ezt is", T0 + 10 * HOUR, direction="out")  # outbound
    msg(con, 111, "9999", "Nézd meg ezt is", T0 + 11 * HOUR)  # not an owner
    msg(con, 112, "1001", "Nézd meg ezt is", T0 - 2 * HOUR)  # before the window
    msg(con, 113, "1001", "Nézd meg ezt is", until + HOUR)  # after the window
    msg(con, 114, "1001", "Nézd meg ezt is", T0 + 12 * HOUR, agent="masik")  # another agent's log
    msg(con, 115, "1002", "Nézd meg a 2026-os tervet", T0 + 13 * HOUR)  # only "near" a reference
    msg(con, 116, "1001", "Küldd át a táblát", T0 + 14 * HOUR)  # only comma-joined on a card
    card(con, "c-open", "TULAJ A tg 101: számlák", "leírás, tg 101, 116", T0)
    card(con, "c-arch", "régi", "Kérés: tg 102, 2026-09-28", T0, archived=T0 + HOUR)
    card(con, "c-late", "késői lap tg 104", "", until + 60)
    comment(con, "c-arch", "megcsinálva (tg 103)", T0 + 2 * HOUR)
    comment(con, "c-open", "tg 105 is ide tartozik", until + 60)
    comment(con, "c-open", "tg 1104, a 115/116 kérdésre", T0)
    con.commit()
    con.close()
    return db


def scenario_pairing() -> None:
    print("scenario: pairing on open and archived cards, as of a time")
    with tempfile.TemporaryDirectory() as d:
        db = pairing_db(Path(d))
        con = kp.open_ro(db)
        try:
            r = kp.build(con, OWNERS, T0, T0 + 24 * HOUR, T0 + 24 * HOUR)
            later = kp.build(con, OWNERS, T0, T0 + 24 * HOUR, T0 + 25 * HOUR)
            strict = kp.build(con, OWNERS, T0, T0 + 24 * HOUR, T0 + 24 * HOUR, pair_in="description")
            try:
                kp.build(con, OWNERS, T0, T0 + 24 * HOUR, T0 + 24 * HOUR, pair_in="barhol")
                bad = "no error"
            except kp.InputError:
                bad = "InputError"
        finally:
            con.close()
    check_eq("unpaired", [m["tg"] for m in r["unpaired"]], ["104", "105", "106", "107", "115"])
    check_eq("comment only, with its card", [(m["tg"], m["comment_cards"]) for m in r["comment_only"]], [("103", ["c-arch"])])
    check_eq("comma only, with its card, not paired", [(m["tg"], m["comma_cards"], m["paired"]) for m in r["comma_only"]], [("116", ["c-open"], False)])
    check_eq(
        "counts",
        r["counts"],
        {"inbound": 11, "request": 9, "paired": 2, "comment_only": 1, "comma_only": 1, "unpaired": 5, "ack": 1, "statement": 1},
    )
    check_eq("other unpaired", [(m["tg"], m["class"]) for m in r["unpaired_other"]], [("108", "ack"), ("109", "statement")])
    check_eq("board as of the window end", {k: r["board"][k] for k in ("cards", "comments")}, {"cards": 2, "comments": 2})
    check_eq("a later asof sees the late card and comment", [m["tg"] for m in later["unpaired"]], ["106", "107", "115"])
    check_eq("a later asof: the late comment is comment-only", [m["tg"] for m in later["comment_only"]], ["103", "105"])
    check_eq("description mode lists the comment-only one", [m["tg"] for m in strict["unpaired"]], ["103", "104", "105", "106", "107", "115"])
    check_eq("description mode keeps the card hint", strict["unpaired"][0]["comment_cards"] if strict["unpaired"] else None, ["c-arch"])
    check_eq(
        "description mode counts",
        tuple(strict["counts"][k] for k in ("paired", "comment_only", "comma_only", "unpaired")),
        (2, 0, 1, 6),
    )
    check_eq("unknown pair_in", bad, "InputError")
    check_eq("no warning", r["warnings"], [])


def scenario_read_only() -> None:
    print("scenario: the database is opened read-only, and a missing one is not created")
    with tempfile.TemporaryDirectory() as d:
        db = pairing_db(Path(d))
        before = db.read_bytes()
        con = kp.open_ro(db)
        try:
            con.execute("INSERT INTO kanban_comments (card_id, content, created_at) VALUES ('x', 'y', 0)")
            got = "write went through"
        except sqlite3.OperationalError as e:
            got = "readonly" if "readonly" in str(e) else str(e)
        finally:
            con.close()
        check_eq("write refused", got, "readonly")
        principals = Path(d) / "p.json"
        principals.write_text(json.dumps({"principals": {"1001": {"name": "Tulaj A", "role": "owner"}}}))
        with contextlib.redirect_stdout(io.StringIO()):
            rc = kp.main(["--db", str(db), "--principals", str(principals), "--since", "2026-09-28T12:00Z", "--until", "2026-09-29T12:00Z"])
        check_eq("run rc", rc, 0)
        check_eq("database bytes unchanged", db.read_bytes() == before, True)
        missing = Path(d) / "nincs.db"
        err = io.StringIO()
        with contextlib.redirect_stderr(err), contextlib.redirect_stdout(io.StringIO()):
            rc = kp.main(["--db", str(missing), "--principals", str(principals)])
        check_eq("missing database rc", rc, 2)
        check_eq("missing database not created", missing.exists(), False)


def scenario_wal_readonly() -> None:
    print("scenario: a WAL-mode database stays byte-identical; the only files a read-only open may add are -wal and -shm")
    with tempfile.TemporaryDirectory() as d:
        db = pairing_db(Path(d))
        con = sqlite3.connect(db)
        check_eq("wal mode on", con.execute("PRAGMA journal_mode=WAL").fetchone()[0], "wal")
        con.close()
        principals = Path(d) / "p.json"
        principals.write_text(json.dumps({"principals": {"1001": {"name": "Tulaj A", "role": "owner"}}}))
        before_files = sorted(p.name for p in Path(d).iterdir())
        before = db.read_bytes()
        with contextlib.redirect_stdout(io.StringIO()):
            rc = kp.main(["--db", str(db), "--principals", str(principals), "--since", "2026-09-28T12:00Z", "--until", "2026-09-29T12:00Z"])
        check_eq("run rc", rc, 0)
        check_eq("database bytes unchanged", db.read_bytes() == before, True)
        added = sorted(set(p.name for p in Path(d).iterdir()) - set(before_files))
        check_eq("files added: only -wal and -shm, if any", set(added) <= {"t.db-wal", "t.db-shm"}, True)
    readme = (Path(__file__).resolve().parent / "README.md").read_text(encoding="utf-8")
    check_eq("README states the -shm/-wal behaviour", "-shm" in readme and "byte-identical" in readme, True)
    check_eq("README no longer claims no WAL file", "no journal or WAL file appeared" in readme, False)


def scenario_warnings() -> None:
    print("scenario: an empty result says when it proves nothing")
    with tempfile.TemporaryDirectory() as d:
        db = Path(d) / "t.db"
        con = build_db(db)
        msg(con, 201, "1001", "Nézd meg", T0 - 10 * HOUR)
        msg(con, 301, "1001", "Nézd meg", T0 + HOUR)
        msg(con, 301, "1002", "Nézd meg ezt", T0 + 2 * HOUR)  # the same id in two chats
        con.commit()
        con.close()
        con = kp.open_ro(db)
        try:
            quiet = kp.build(con, OWNERS, T0 + 3 * HOUR, T0 + 4 * HOUR, T0 + 4 * HOUR)
            busy = kp.build(con, OWNERS, T0, T0 + 4 * HOUR, T0 + 4 * HOUR)
        finally:
            con.close()
    check_eq("empty window warns", any("0 bejövő" in w for w in quiet["warnings"]), True)
    check_eq("empty window names the last inbound row", any("2026-09-28T14:00Z" in w for w in quiet["warnings"]), True)
    check_eq("empty board warns", any("vak" in w for w in busy["warnings"]), True)
    check_eq("collision warns", any("301" in w and "több tulajdonosi chatben" in w for w in busy["warnings"]), True)


def scenario_output() -> None:
    print("scenario: one line per request, UTC and Budapest time, 120 characters")
    long = "Nézd meg\n  a számlákat " + "x" * 200
    summer = kp.line({"created_at": T0, "owner": "Tulaj A", "tg": "101", "kind": None, "text": long})
    winter = kp.line({"created_at": 1768478400, "owner": "Tulaj B", "tg": "102", "kind": "voice", "text": "(voice message)"})
    check_eq("summer line head", summer[:49], "2026-09-28 12:00Z (14:00 Bp) | Tulaj A | tg 101 |")
    check_eq("text one line, 120 chars", len(summer.split(" | ", 3)[3]), 120)
    check_eq("no newline", "\n" in summer, False)
    check_eq("winter line", winter, "2026-01-15 12:00Z (13:00 Bp) | Tulaj B | tg 102 [hang] | (voice message)")
    hint = kp.line({"created_at": T0, "owner": "Tulaj A", "tg": "103", "kind": None, "text": "Csináld meg", "comment_cards": ["abcdef012345", "c-arch"]})
    check_eq("comment hint, 8-character card ids", hint.endswith(" | Csináld meg | kommentben: abcdef01, c-arch"), True)


def scenario_text_header() -> None:
    print("scenario: the text header carries both numbers and the rule (fejlesztes-vezeto)")
    with tempfile.TemporaryDirectory() as d:
        db = pairing_db(Path(d))
        con = kp.open_ro(db)
        try:
            any_mode = kp.render_text(kp.build(con, OWNERS, T0, T0 + 24 * HOUR, T0 + 24 * HOUR), False).splitlines()
            desc_mode = kp.render_text(
                kp.build(con, OWNERS, T0, T0 + 24 * HOUR, T0 + 24 * HOUR, pair_in="description"), False
            ).splitlines()
        finally:
            con.close()
    check_eq(
        "numbers first",
        any_mode[1].split(" | ")[:3],
        ["PÁR NÉLKÜL 5", "CSAK KOMMENTBEN EMLÍTVE, ELLENŐRIZENDŐ 1", "CSAK VESSZŐVEL CSATOLVA, KÉTÉRTELMŰ, ELLENŐRIZENDŐ 1"],
    )
    check_eq("the comma rule in the header", "a vesszővel csatolt szám nem pároz" in any_mode[1], True)
    comma_section = [i for i, ln in enumerate(any_mode) if ln.startswith("--- CSAK VESSZŐVEL CSATOLVA, KÉTÉRTELMŰ, ELLENŐRIZENDŐ (1)")]
    after_comma = any_mode[comma_section[0] + 1] if comma_section and comma_section[0] + 1 < len(any_mode) else ""
    check_eq("comma section line names the card", after_comma.endswith("| vesszővel: c-open"), True)
    check_eq("rule in the header", "címében vagy leírásában" in any_mode[1] and "külön szakaszban" in any_mode[1], True)
    section = [i for i, ln in enumerate(any_mode) if ln.startswith("--- CSAK KOMMENTBEN EMLÍTVE, ELLENŐRIZENDŐ (1)")]
    check_eq("section header", len(section), 1)
    after_header = any_mode[section[0] + 1] if section and section[0] + 1 < len(any_mode) else ""
    check_eq("section line names the card", after_header.endswith("| kommentben: c-arch"), True)
    check_eq("description mode numbers", desc_mode[1].split(" | ")[:2], ["PÁR NÉLKÜL 6", "CSAK KOMMENTBEN EMLÍTVE, ELLENŐRIZENDŐ 0"])
    check_eq("description mode rule", "a csak kommentben említett is a fő listán" in desc_mode[1], True)
    check_eq("description mode has no section", any(ln.startswith("--- CSAK KOMMENTBEN") for ln in desc_mode), False)


def scenario_cli_json() -> None:
    print("scenario: the JSON output")
    with tempfile.TemporaryDirectory() as d:
        db = pairing_db(Path(d))
        principals = Path(d) / "p.json"
        principals.write_text(
            json.dumps(
                {
                    "principals": {
                        "1001": {"name": "Tulaj A", "role": "owner"},
                        "1002": {"name": "Tulaj B", "role": "owner"},
                        "1003": {"name": "Rendszergazda", "role": "sysadmin_owner"},
                        "1004": {"name": "Munkatárs", "role": "staff"},
                    }
                }
            )
        )
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            rc = kp.main(
                ["--db", str(db), "--principals", str(principals), "--since", "2026-09-28T12:00Z", "--until", "2026-09-29T12:00Z", "--format", "json"]
            )
    r = json.loads(out.getvalue())
    check_eq("rc", rc, 0)
    check_eq("unpaired ids", [m["tg"] for m in r["unpaired"]], ["104", "105", "106", "107", "115"])
    check_eq(
        "fields",
        sorted(r["unpaired"][0]) if r["unpaired"] else [],
        ["chat", "class", "comma_cards", "comment_cards", "kind", "owner", "text", "tg", "utc"],
    )
    check_eq("comma only in json", [(m["tg"], m["comma_cards"]) for m in r["comma_only"]], [("116", ["c-open"])])
    check_eq("comment only in json", [(m["tg"], m["comment_cards"]) for m in r["comment_only"]], [("103", ["c-arch"])])
    check_eq(
        "window",
        r["window"],
        {"since": "2026-09-28T12:00Z", "until": "2026-09-29T12:00Z", "asof": "2026-09-29T12:00Z", "pair_in": "any"},
    )


def scenario_owners() -> None:
    print("scenario: the owners come from principals.json")
    with tempfile.TemporaryDirectory() as d:
        p = Path(d) / "p.json"
        p.write_text(
            json.dumps(
                {
                    "principals": {
                        "1001": {"name": "Tulaj A", "role": "owner"},
                        "1003": {"name": "Rendszergazda", "role": "sysadmin_owner"},
                        "1004": {"name": "Munkatárs", "role": "staff"},
                    }
                }
            )
        )
        check_eq("owner roles only", kp.load_owners(p), {"1001": "Tulaj A", "1003": "Rendszergazda"})
        p.write_text(json.dumps({"principals": {"1004": {"name": "Munkatárs", "role": "staff"}}}))
        try:
            kp.load_owners(p)
            got = "no error"
        except kp.InputError:
            got = "InputError"
        check_eq("no owner is an error", got, "InputError")
        try:
            kp.load_owners(Path(d) / "nincs.json")
            got = "no error"
        except kp.InputError:
            got = "InputError"
        check_eq("missing file is an error", got, "InputError")


if __name__ == "__main__":
    for scenario in (
        scenario_acknowledgements,
        scenario_requests,
        scenario_statements,
        scenario_reference_forms,
        scenario_future_comma,
        scenario_pairing,
        scenario_read_only,
        scenario_wal_readonly,
        scenario_warnings,
        scenario_output,
        scenario_text_header,
        scenario_cli_json,
        scenario_owners,
    ):
        scenario()
        print()

    if FAILURES:
        print(f"FAILED: {', '.join(FAILURES)}")
        sys.exit(1)
    print("all scenarios passed")
