# tulajdonosi-keres-par: owner requests without a kanban card

From an owner request (owner-b tg 2575, owner-a tg 2558). Coder: fejleszto-3. The main agent takes it
into the marveen framework and schedules the evening run.

## Files

| File | What it is |
|------|------------|
| `tulajdonosi_keres_par.py` | the script (Python 3 standard library only) |
| `test_tulajdonosi_keres_par.py` | scenario tests on a throwaway database, made-up data only |
| `mutation_check.py` | negative controls: 17 mutants, each must fail a check (a crash does not count), after a green control run |

## Run

```bash
python3 tulajdonosi_keres_par.py                 # last 24 hours, the board as it is now
python3 tulajdonosi_keres_par.py --format json   # the same as JSON
python3 tulajdonosi_keres_par.py --since 2026-09-17T00:00Z --until 2026-09-28T14:19Z --asof 2026-09-28T14:19Z
python3 test_tulajdonosi_keres_par.py            # 13 scenarios, exit 1 on a failure
python3 mutation_check.py                        # 17 mutants, exit 1 if one survives or crashes
```

The project root comes from `CLAUDECLAW_ROOT`, else the nearest parent holding `store/claudeclaw.db`. The database is opened with
`mode=ro`, so SQLite refuses any write, and a missing file is an error (exit 2) instead of a new empty database. The owners are
the `store/principals.json` entries with role `owner` or `sysadmin_owner`.

Exit codes: 0 the list was built (it may be empty), 2 input problem (missing database or principals file, bad arguments).

## Output

A header (window, board state), a line with the three numbers (unpaired, comment-only, comma-only) and the pairing rule, a count
line, warnings, then one line per unpaired request:

```
2026-09-28 13:31Z (15:31 Bp) | <owner> | tg <id> | <first 120 characters of the message>
```

Then two separate sections: requests named only in a comment of some card (`| kommentben: <card>`), and requests named only
comma-joined (`| vesszővel: <card>`, see below). `--all` also lists the unpaired messages classified as acknowledgement or
statement.

Warnings say when an empty list proves nothing: 0 inbound rows in the window (quiet, or the logging stopped; the last inbound row
is named), 0 references on the board (the pairing is blind), or one message id in two owner chats.

## Pairing (decided: fejlesztes-vezeto, 2026-09-28T18:36Z)

A request is paired when its id stands in a card TITLE or DESCRIPTION, open or archived (the main list lists the rest). A request
named only in a COMMENT of some card goes to a separate section, "CSAK KOMMENTBEN EMLÍTVE, ELLENŐRIZENDŐ", with the card ids: a
mention in another card's comment is not an owning card, but it must not vanish either. The header carries both numbers and the
rule. This is `--pair-in any` (the default); `--pair-in description` puts the comment-only requests on the main list.

Comma-joined numbers (v3, fejlesztes-vezeto): from the first comma of a reference on, a number never pairs, in both modes.
A request named nowhere explicitly but comma-joined somewhere goes to a third section, "CSAK VESSZŐVEL CSATOLVA, KÉTÉRTELMŰ,
ELLENŐRIZENDŐ", with the card ids. Why: a comma also joins internal ids (`tg 2491, 90150`, an inter-agent message id), and no
property of the number tells the two apart for good. v2 accepted a comma-joined number within 1000 of the item before it; that
wears out as the Telegram counter climbs into the range of old internal ids (from about 2026-10-03 at the measured pace, teszter-2),
after which a NEW text naming a fresh tg id and an old internal id pairs the wrong message and hides a request. The v3 rule has
no threshold and no date, so it cannot wear out; an ambiguous number is not paired, and what falls out stays on the list.

Why the separate section: the brief's own positive control. On 2026-09-28 before 14:20Z, tg 1295/1315 and tg 1742
stood in comments of OTHER cards, so "description or comment" would have hidden them; now they show in
the section. tg 1235 had its own card, archived as done the next day: no mention-based pairing sees a card closed
with a different delivery, that needs a person reading the card.

## What counts as a request

Question (`?`), voice message or document, a request word (kérlek, kell, kellene, szeretném, fontos, mehet ...), an irregular
imperative (legyen, gyere, menj ...), or a word with an informal imperative ending (nézd, csináld, írj, csináljátok, menjen,
haladjunk, javíts), the first person included (lássam, nézzem, írjam; the third person, lássa, írja, is left out because for
many verbs it is the indicative too). Not a request: only acknowledgement words or emoji, a one-word message, or a statement without the above.
The matching ignores case and accents (the lexicon in the script is written folded: kerlek, nezd).

Known limits, measured on 2026-09-28 over one day of traffic:

- Voice messages have no transcript in `conversation_log` (the text is `(voice message)`), so they are always listed as
  requests; a noticeable share of the main list.
- Status and conversational questions ("mikor lesz kész?", "mi történt?") count as requests, as the brief says.
  They are the main noise.
- A few text items were not requests: a complaint whose indicative verb form looks imperative, and a bug report
  caught by "kell".
- `reply_to_message_id` is empty in every row, so a request cannot be paired through the answer to it.
- Any mention pairs, the tool's own card included: on 2026-09-28 the tool's card description and its tester report named
  tg 2315 as an example, which pairs it (the main agent had classified it DONE by hand). Excluding that card would be
  a switch; not built, the decision is the main agent's.

## References the script reads

`tg 2575`, `TG 2575`, `tg:2575`, `tg #2575`; lists `tg 2375/2380/2385`, `tg 1680 + 1682`, `tg 2563, 2572, 2580`, `tg 2375 és 2380`;
ranges `tg 2253-2255` (widened over the first end's chat, a span over 50 gives its two ends); `tg-1802`; `Telegram 486`. These
pair; so do the items joined to the first one by `/`, `+` or "és" (on the board nearly all such continuations were near,
one was a real list). From the first comma on, every number is comma-joined and only listed (see Pairing): in `tg 2563, 2572, 2580`
the 2563 pairs, the 2572 and 2580 do not; `tg 2563, tg 2572` pairs both, since each has its own "tg".
Not references: `tg800` (no separator), `msg 90255` (inter-agent ids), and a date or time after a list: in
`tg 2575, 2026-09-28T15:11Z` the 2026 is a year (a naive reader paired it with the outbound message 2026).

## Acceptance, measured 2026-09-28

1. Positive control: as of 2026-09-28T14:19Z, tg 1295/1315 and 1742 are in the separate section (default) or on the main
   list (`--pair-in description`); tg 1235 is paired in both (see Pairing).
2. Negative control: tg 2575 (in the title of the originating card) is not listed.
3. Acknowledgements: 11 test cases; also filtered on the day's real data.
4. No write: `mode=ro` (the read-write mutant fails a test); on a snapshot copy the sha256, the mtime and the row counts of the
   three tables were equal before and after. The database file itself stays byte-identical in every case, but a `mode=ro`
   open of a WAL-mode database creates the `-shm` and `-wal` files when they are missing (teszter-2;
   the `scenario_wal_readonly` test pins it). Next to the live database they always exist, so there no new file appears.
5. Run time 0.90 to 1.34 s.
6. Tests: 13 scenarios, 156 checks; 17 of 17 mutants caught (fix round: the comma rule, the first person, the WAL note).
7. v3 against v2 on the same frozen window (until = asof = 2026-09-28T19:35:51Z, teszter-2's): the main list is unchanged, over
   one day and since 09-17. Some requests move from paired to the comment-only or the comma section, and some from the
   comment-only to the comma section. Nothing leaves the lists; a synthetic 2026-10-10 text "tg X, Y" (Y an old
   internal id within 1000 of X) pairs Y in v2 and lists it in v3 (`scenario_future_comma`).

## Suggested tester path

Run the test file and `mutation_check.py`; then, on a snapshot copy of the database (sqlite3 backup API from a `mode=ro` source,
deleted afterwards), the positive control above with `--asof 2026-09-28T14:19Z` in both pairing modes and the negative control
(tg 2575), and a hand check of one day's list against the board.
