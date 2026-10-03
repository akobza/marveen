#!/usr/bin/env python3
"""TELJESREKORD1003: minden iras utan a kartya TELJES sora vissza, nem csak az irt mezo.

AMIERT: a mozgato ag korabban 5 mezot olvasott vissza (status, priority, title, assignee,
description). Egy iras, ami mellesleg a parent_id-t, a project-et vagy a due_date-et is atirja,
zold kimenettel ment volna at -- pont azokon a mezokon, amelyek csak a ritka kartyakon allnak.

A NEGATIV KONTROLLOK egy-egy SQLite-triggerrel allitjak elo a "nem kert oszlop is valtozott" esetet
(a mozgato agon, a komment-agon es a letrehozo agon), es az eszkoznek mindharom esetben HANGOSAN kell
bukni, a valtozott oszlop nevevel. A regi, 5 mezos visszaolvasas mindharmat zoldnek latta volna.

Futtatas:  python3 scripts/__tests__/kartya-teljes-rekord.test.py
"""
import os, sqlite3, subprocess, sys, tempfile, time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
SCRIPT = os.path.join(ROOT, 'scripts', 'kartya-es-ertesites.py')
SANDBOX_ROOT = tempfile.mkdtemp(prefix='kartya-teljes-sandbox-')
FAILS = []
OSZLOPOK = ('title', 'description', 'status', 'assignee', 'priority', 'project', 'due_date', 'sort_order',
            'created_at', 'archived_at', 'parent_id', 'dispatched_at')


def check(name, cond, detail=''):
    print(('PASS  ' if cond else 'FAIL  ') + name + (('  -- ' + detail[:400]) if detail and not cond else ''))
    if not cond:
        FAILS.append(name)


def fresh_db(path):
    db = sqlite3.connect(path)
    db.executescript('''
      CREATE TABLE kanban_cards (id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT,
        status TEXT NOT NULL DEFAULT 'planned', assignee TEXT, priority TEXT NOT NULL DEFAULT 'normal',
        project TEXT, due_date INTEGER, sort_order REAL NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, archived_at INTEGER,
        parent_id TEXT, dispatched_at INTEGER);
      CREATE TABLE kanban_comments (id INTEGER PRIMARY KEY AUTOINCREMENT, card_id TEXT NOT NULL,
        author TEXT NOT NULL, content TEXT NOT NULL, created_at INTEGER NOT NULL, automated INTEGER DEFAULT 0);
      CREATE TABLE agent_messages (id INTEGER PRIMARY KEY AUTOINCREMENT, from_agent TEXT NOT NULL,
        to_agent TEXT NOT NULL, content TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
        result TEXT, created_at INTEGER NOT NULL, delivered_at INTEGER, completed_at INTEGER);
    ''')
    now = int(time.time()) - 3600
    for cid in ('GAZDAG1003', 'CSUSZ1003', 'KOMCSUSZ1003'):
        db.execute('INSERT INTO kanban_cards (id,title,description,status,assignee,priority,project,due_date,'
                   'sort_order,created_at,updated_at,parent_id,dispatched_at)'
                   " VALUES (?,?,'regi leiras','planned','kulso-szerzo','normal','proj-x',1793275200,3.5,?,?,"
                   "'SZULO1003',?)", (cid, f'{cid} teszt', now, now, now))
    # NEGATIV KONTROLL-TRIGGEREK: mindegyik egy NEM KERT oszlopot ir at a sajat kartyajan.
    db.executescript('''
      CREATE TRIGGER csusz_mozgatas AFTER UPDATE OF status ON kanban_cards
        WHEN NEW.id = 'CSUSZ1003' BEGIN UPDATE kanban_cards SET project = 'elcsuszott' WHERE id = NEW.id; END;
      CREATE TRIGGER csusz_komment AFTER INSERT ON kanban_comments
        WHEN NEW.card_id = 'KOMCSUSZ1003' AND NEW.author != 'kartya-es-ertesites'
        BEGIN UPDATE kanban_cards SET parent_id = 'MASIK1003' WHERE id = NEW.card_id; END;
      CREATE TRIGGER csusz_letrehozas AFTER INSERT ON kanban_cards
        WHEN NEW.id = 'UJCSUSZ1003' BEGIN UPDATE kanban_cards SET priority = 'low' WHERE id = NEW.id; END;
    ''')
    db.commit(); db.close()


def futtat(db_path, args):
    e = dict(os.environ)
    e.update(KARTYA_DB=db_path, CLAUDECLAW_ROOT=SANDBOX_ROOT, KARTYA_TOKEN='teszt-token',
             KARTYA_API='http://127.0.0.1:9/api/messages')
    for k in ('KARTYA_FLEET', 'KARTYA_KOORDINATOR', 'KARTYA_GAZDA'):
        e.pop(k, None)
    p = subprocess.run([sys.executable, SCRIPT] + args, capture_output=True, text=True, env=e, timeout=30)
    return p.returncode, p.stdout + p.stderr


def sor(db_path, cid):
    db = sqlite3.connect(db_path)
    try:
        r = db.execute(f'SELECT {",".join(OSZLOPOK)} FROM kanban_cards WHERE id=?', (cid,)).fetchone()
        return dict(zip(OSZLOPOK, r)) if r else None
    finally:
        db.close()


def kommentek(db_path, cid):
    db = sqlite3.connect(db_path)
    try:
        return [r[0] for r in db.execute('SELECT author FROM kanban_comments WHERE card_id=? ORDER BY id', (cid,))]
    finally:
        db.close()


def main():
    fd, d = tempfile.mkstemp(suffix='.db', prefix='kartya-teljes-'); os.close(fd); os.remove(d)
    fresh_db(d)
    fd, cf = tempfile.mkstemp(prefix='kartya-teljes-', suffix='.txt'); os.close(fd)
    with open(cf, 'w', encoding='utf-8') as f:
        f.write('Allapot-mozgatas a teljes sor visszaolvasasahoz.')
    fd, df = tempfile.mkstemp(prefix='kartya-teljes-leiras-', suffix='.txt'); os.close(fd)
    with open(df, 'w', encoding='utf-8') as f:
        f.write('Uj leírás, rövid, ékezettel.')
    alap = ['--author', 'alfa', '--comment-file', cf]

    # 1. statusz-mozgatas a "gazdag" kartyan: csak a status (+ updated_at) valtozik
    elotte = sor(d, 'GAZDAG1003')
    rc, out = futtat(d, ['--id', 'GAZDAG1003', '--status', 'in_progress'] + alap)
    utana = sor(d, 'GAZDAG1003')
    check('1 rc=0, MEZOMOZGATAS OK es TELJES SOR OK',
          rc == 0 and 'MEZOMOZGATAS OK' in out and 'TELJES SOR OK' in out, out)
    check('1 a teszt oldalan is: csak a status valtozott',
          [k for k in OSZLOPOK if elotte[k] != utana[k]] == ['status'], f'{elotte} -> {utana}')

    # 2. leiras-csere ugyanott: csak a description valtozik
    elotte = sor(d, 'GAZDAG1003')
    rc, out = futtat(d, ['--id', 'GAZDAG1003', '--desc-file', df] + alap)
    utana = sor(d, 'GAZDAG1003')
    check('2 leiras-csere rc=0 es TELJES SOR OK', rc == 0 and 'TELJES SOR OK' in out, out)
    check('2 a teszt oldalan is: csak a description valtozott',
          [k for k in OSZLOPOK if elotte[k] != utana[k]] == ['description'], f'{elotte} -> {utana}')

    # 3. NEGATIV KONTROLL, mozgato ag: a trigger a project-et is atirja -> HANGOS HIBA a nevevel
    rc, out = futtat(d, ['--id', 'CSUSZ1003', '--status', 'in_progress'] + alap)
    check('3 nem kert oszlop a mozgatasnal: rc!=0 es HIBA a project nevevel',
          rc != 0 and 'HIBA' in out and 'project' in out, out)
    check('3 a mozgatas nyoma ettol meg a kartyan all',
          'kartya-es-ertesites' in kommentek(d, 'CSUSZ1003'), str(kommentek(d, 'CSUSZ1003')))

    # 4. NEGATIV KONTROLL, komment-ag: a trigger a parent_id-t irja -> HANGOS HIBA a nevevel
    rc, out = futtat(d, ['--id', 'KOMCSUSZ1003'] + alap)
    check('4 nem kert oszlop a kommentnel: rc!=0 es HIBA a parent_id nevevel',
          rc != 0 and 'HIBA' in out and 'parent_id' in out, out)
    check('4 a komment beirodott (a HIBA kimondja, mi tortent)', 'alfa' in kommentek(d, 'KOMCSUSZ1003'))

    # 5. letrehozo ag: teljes sor vissza; NEGATIV KONTROLL: a trigger a prioritast atirja -> HIBA
    rc, out = futtat(d, ['--id', 'UJ1003', '--assignee', 'kulso-szerzo', '--title', 'UJ1003 teszt', '--author', 'boni'])
    check('5 letrehozas: teljes sor visszaolvasva, a tobbi oszlop kiirva',
          rc == 0 and 'teljes sor visszaolvasva' in out and 'a tobbi:' in out and 'parent_id=None' in out, out)
    rc, out = futtat(d, ['--id', 'UJCSUSZ1003', '--assignee', 'kulso-szerzo', '--title', 'UJCSUSZ1003 teszt',
                         '--author', 'boni'])
    check('5 nem kert oszlop a letrehozasnal: rc!=0 es HIBA a priority nevevel',
          rc != 0 and 'HIBA' in out and 'priority' in out, out)

    print('---')
    print(f'FAILS: {len(FAILS)}' + (': ' + ', '.join(FAILS) if FAILS else ''))
    return 1 if FAILS else 0


if __name__ == '__main__':
    sys.exit(main())
