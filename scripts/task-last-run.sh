#!/bin/bash
# Utemezett feladatok futasanak lekerdezese HELYES ido-kezelessel.
#
# Miert letezik ez a szkript: a task_runs.ts oszlop MILLISZEKUNDUM epoch, a
# store/claudeclaw.db tobbi timestampje viszont MASODPERC. Ha valaki kezzel ir
# ido-szurot (strftime('%s','2026-08-19 08:00')*1000), az SQLite a stringet
# UTC-nek veszi -> CEST alatt ket oraval a jovobe csuszik az ablak, es a
# lekerdezes URES halmazt ad. Az ures halmaz pontosan ugy nez ki, mint "a task
# nem futott". 2026-08-19-en ez ketszer sult el egy koron belul.
#
# A masik csapda, amit ez kivalt: "SELECT name, max(ts) ... GROUP BY name
# HAVING ts=max(ts)" NEM megbizhatoan a legutolso sort adja vissza.
#
# Hasznalat:
#   scripts/task-last-run.sh                 # minden task utolso futasa
#   scripts/task-last-run.sh pr-figyeles     # egy task utolso 10 futasa
#   scripts/task-last-run.sh pr-figyeles 24  # az utolso 24 oraban
#   scripts/task-last-run.sh --stats 24      # fired/skipped bontas + kimaradasi rata
#
# A --stats azert kerult ide (2026-08-21): a heartbeat "9 fired, 1 skipped"
# sorat akartam ellenorizni, ami NEM frissesseg-kerdes, ezert nem jutott
# eszembe ez a szkript, es kezzel irt SQL-t hasznaltam -- amiben a ts/1000
# osztas kimaradt, tehat a "24 oras" szuro a TELJES tablat adta vissza
# (9012 sor 24 orakent). Nem ures halmaz jott, hanem TULZO szam, ami sokkal
# csendesebb hiba. A tanulsag: minden task_runs-kerdes ide tartozik, nem csak
# az "utoljara mikor futott".

set -euo pipefail
DB="$(cd "$(dirname "$0")/.." && pwd)/store/claudeclaw.db"

# Query helpers on python3 instead of the sqlite3 CLI. The CLI is not an install
# dependency (ffmpeg, git, tmux, lsof, curl, python3, pipx, unzip), so under
# `set -e` every call below killed this script outright on a normal install --
# a diagnostic that exits 127 tells you nothing about the thing you came to check.
# (Card 252ab361.)
#
# sqlq reproduces `sqlite3 -header -column`: header row, a dashed rule, and
# left-aligned columns padded to the widest value, NULL shown as empty. The output
# is read by a person, so the shape is part of the contract, not decoration.
sqlq() {
  python3 - "$1" "$2" <<'PYQ'
import sqlite3, sys
db, sql = sys.argv[1], sys.argv[2]
con = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
try:
    cur = con.execute(sql)
    fejlec = [d[0] for d in cur.description or []]
    sorok = [["" if v is None else str(v) for v in r] for r in cur.fetchall()]
finally:
    con.close()
if not fejlec:
    sys.exit(0)
szel = [len(h) for h in fejlec]
for r in sorok:
    for i, v in enumerate(r):
        if i < len(szel):
            szel[i] = max(szel[i], len(v))
print("  ".join(h.ljust(w) for h, w in zip(fejlec, szel)).rstrip())
print("  ".join("-" * w for w in szel))
for r in sorok:
    print("  ".join(v.ljust(w) for v, w in zip(r, szel)).rstrip())
PYQ
}

# Single value, printed bare -- the callers compare or echo it directly.
sqlscalar() {
  python3 - "$1" "$2" <<'PYS'
import sqlite3, sys
con = sqlite3.connect(f"file:{sys.argv[1]}?mode=ro", uri=True)
try:
    r = con.execute(sys.argv[2]).fetchone()
    print("" if r is None or r[0] is None else r[0])
finally:
    con.close()
PYS
}
NAME="${1:-}"
HOURS="${2:-}"

if [ "$NAME" = "--stats" ]; then
  # Kimaradasi rata task-onkent. Az ablak relativ epoch-on, a ts/1000 osztas
  # KOTELEZO -- nelkule minden sor atmegy a szuron, es a szam a tabla eleteben
  # mert osszeget adja vissza az ablak helyett.
  W="${HOURS:-24}"
  echo "-- ablak: utolso ${W} ora | MA=$(date '+%Y-%m-%d %H:%M:%S') --"
  sqlq "$DB" "
    SELECT name,
           sum(status='fired')   AS fired,
           sum(status='skipped') AS skipped,
           CASE WHEN count(*)=0 THEN NULL
                ELSE round(100.0*sum(status='skipped')/count(*),1) END AS skip_pct,
           datetime(max(ts)/1000,'unixepoch','localtime') AS utolso
      FROM task_runs
     WHERE ts/1000 > strftime('%s','now') - ($W * 3600)
     GROUP BY name
     ORDER BY skipped DESC, name;"
  echo
  echo "-- pozitiv kontroll: az ablakon KIVULI sorok szama (ha 0, az ablak gyanusan tag) --"
  sqlscalar "$DB" "SELECT count(*) FROM task_runs WHERE ts/1000 <= strftime('%s','now') - ($W * 3600);"
  exit 0
fi

if [ -z "$NAME" ]; then
  # Minden task utolso futasa. A rendezes az epoch-on tortenik, a kiiras
  # localtime-ban -- a datum MINDIG benne van, hogy a frissesseg-itelet ne
  # egy csupasz ora-percbol szulessen.
  sqlq "$DB" "
    SELECT name,
           agent,
           datetime(max(ts)/1000,'unixepoch','localtime') AS utolso_futas,
           round((strftime('%s','now') - max(ts)/1000)/60.0, 1) AS perce,
           count(*) AS futasok_osszesen
      FROM task_runs
     GROUP BY name, agent
     ORDER BY max(ts) DESC;"
  exit 0
fi

WHERE="name = '$NAME'"
if [ -n "$HOURS" ]; then
  # Relativ ablak epoch-on: sem a timezone, sem az off-by-one-hour nem merul fel.
  WHERE="$WHERE AND ts/1000 > strftime('%s','now') - ($HOURS * 3600)"
fi

sqlq "$DB" "
  SELECT datetime(ts/1000,'unixepoch','localtime') AS futas,
         status,
         agent
    FROM task_runs
   WHERE $WHERE
   ORDER BY ts DESC
   LIMIT 40;"

# POZITIV KONTROLL: ha a fenti ures, ez megmutatja, hogy a NEV rossz-e, vagy
# tenyleg nem futott. Ures szuro nelkuli szamlalas -- ha ez is 0, a task neve
# nem letezik a tablaban.
echo
echo "-- pozitiv kontroll (szuro nelkul, ugyanerre a nevre) --"
sqlq "$DB" "
  SELECT count(*) AS osszes_futas,
         datetime(max(ts)/1000,'unixepoch','localtime') AS legutolso
    FROM task_runs WHERE name = '$NAME';"
