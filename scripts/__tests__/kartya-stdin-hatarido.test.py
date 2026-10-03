#!/usr/bin/env python3
"""STDINHATARIDO1003: a szoveg a STDIN-rol is jojjon ('-'), es a hatarido (due_date) irhato legyen.

AMIT ROGZIT: (1) a STDIN-rol jott gonosz szoveg (idezojel, aposztrof, ujsor, backtick, $(...),
JSON-reszlet) a komment vegen BAJTRA egyezik; (2) ket '-' egy futasban, terminal-STDIN es nem UTF-8
bemenet MEGTAGADAS, iras nelkul; (3) a --due-date harom bemeneti alakja (unix mp, ISO zonaval, none)
egesz masodpercet ir, illetve torol, a mozgatas-nyom a teljes regi erteket orzi; (4) idozona nelkuli,
ezredmasodperces es ertelmetlen ertek MEGTAGADAS; (5) due_date oszlop nelkuli DB-n MEGTAGADAS, iras nelkul;
(6) a letrehozo ag is irja, a dry-run pedig semmit nem ir.

Futtatas:  python3 scripts/__tests__/kartya-stdin-hatarido.test.py
"""
import os, sqlite3, subprocess, sys, tempfile, time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
SCRIPT = os.path.join(ROOT, 'scripts', 'kartya-es-ertesites.py')
SANDBOX_ROOT = tempfile.mkdtemp(prefix='kartya-stdin-sandbox-')
FAILS = []
GONOSZ = ('Idezojel " es aposztrof \' es backtick ` es $(echo nem-fut) es {"kulcs": "ertek: 1"}\n'
          'masodik sor, ekezettel: arvizturo tukorfurogep, árvíztűrő tükörfúrógép')


def check(name, cond, detail=''):
    print(('PASS  ' if cond else 'FAIL  ') + name + (('  -- ' + detail[:400]) if detail and not cond else ''))
    if not cond:
        FAILS.append(name)


def fresh_db(path, hatarido_oszlop=True):
    db = sqlite3.connect(path)
    db.executescript('''
      CREATE TABLE kanban_cards (id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT,
        status TEXT NOT NULL DEFAULT 'planned', assignee TEXT, priority TEXT NOT NULL DEFAULT 'normal',
        project TEXT, ''' + ('due_date INTEGER, ' if hatarido_oszlop else '') + '''sort_order REAL NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, archived_at INTEGER,
        parent_id TEXT, dispatched_at INTEGER);
      CREATE TABLE kanban_comments (id INTEGER PRIMARY KEY AUTOINCREMENT, card_id TEXT NOT NULL,
        author TEXT NOT NULL, content TEXT NOT NULL, created_at INTEGER NOT NULL, automated INTEGER DEFAULT 0);
      CREATE TABLE agent_messages (id INTEGER PRIMARY KEY AUTOINCREMENT, from_agent TEXT NOT NULL,
        to_agent TEXT NOT NULL, content TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
        result TEXT, created_at INTEGER NOT NULL, delivered_at INTEGER, completed_at INTEGER);
    ''')
    now = int(time.time())
    db.execute("INSERT INTO kanban_cards (id,title,assignee,status,priority,created_at,updated_at)"
               " VALUES ('HATAR1003','HATAR1003 teszt','kulso-szerzo','planned','normal',?,?)", (now, now))
    db.commit(); db.close()


def env(db_path):
    e = dict(os.environ)
    e.update(KARTYA_DB=db_path, CLAUDECLAW_ROOT=SANDBOX_ROOT, KARTYA_TOKEN='teszt-token',
             KARTYA_API='http://127.0.0.1:9/api/messages')
    for k in ('KARTYA_FLEET', 'KARTYA_KOORDINATOR', 'KARTYA_GAZDA'):
        e.pop(k, None)
    return e


def futtat(db_path, args, stdin=None, stdin_bytes=None):
    kw = dict(capture_output=True, env=env(db_path), timeout=30)
    if stdin is not None:
        kw.pop('capture_output'); kw.update(stdin=stdin, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    else:
        kw['input'] = stdin_bytes if stdin_bytes is not None else b''
    p = subprocess.run([sys.executable, SCRIPT] + args, **kw)
    return p.returncode, p.stdout.decode('utf-8', 'replace') + p.stderr.decode('utf-8', 'replace')


def fajl(szoveg):
    fd, p = tempfile.mkstemp(prefix='kartya-stdin-', suffix='.txt'); os.close(fd)
    with open(p, 'w', encoding='utf-8') as f:
        f.write(szoveg)
    return p


def lekerdez(db_path, sql, args=()):
    db = sqlite3.connect(db_path)
    try:
        return db.execute(sql, args).fetchall()
    finally:
        db.close()


def main():
    fd, d = tempfile.mkstemp(suffix='.db', prefix='kartya-stdin-'); os.close(fd); os.remove(d)
    fresh_db(d)
    komment = ['--id', 'HATAR1003', '--author', 'alfa', '--nincs-ertesites-szandekos']

    # (1) gonosz szoveg STDIN-rol, bajtra
    rc, out = futtat(d, komment + ['--comment-file', '-'], stdin_bytes=GONOSZ.encode('utf-8'))
    sor = lekerdez(d, "SELECT content FROM kanban_comments WHERE author='alfa' ORDER BY id DESC LIMIT 1")
    check('1 STDIN-komment rc=0 es KOMMENT OK', rc == 0 and 'KOMMENT OK' in out, out)
    check('1 a komment a fejlec utan BAJTRA a STDIN szovege',
          bool(sor) and sor[0][0].split('\n', 1)[1] == GONOSZ.strip(), repr(sor[:1])[:300])

    # (2) ket '-' egy futasban -> megtagadas, iras nelkul
    db_elotte = lekerdez(d, 'SELECT COUNT(*) FROM kanban_comments')[0][0]
    rc, out = futtat(d, komment + ['--comment-file', '-', '--desc-file', '-'], stdin_bytes=b'x')
    check('2 ket STDIN-hely MEGTAGADVA', rc != 0 and 'egyszer olvashato' in out, out)
    check('2 semmi nem irodott', lekerdez(d, 'SELECT COUNT(*) FROM kanban_comments')[0][0] == db_elotte)

    # (2b) terminal-STDIN -> megtagadas (pty), iras nelkul
    master, slave = os.openpty()
    try:
        rc, out = futtat(d, komment + ['--comment-file', '-'], stdin=slave)
    finally:
        os.close(master); os.close(slave)
    check('2b terminal-STDIN MEGTAGADVA', rc != 0 and 'terminal' in out, out)
    check('2b semmi nem irodott', lekerdez(d, 'SELECT COUNT(*) FROM kanban_comments')[0][0] == db_elotte)

    # (2c) nem UTF-8 STDIN -> megtagadas, iras nelkul
    rc, out = futtat(d, komment + ['--comment-file', '-'], stdin_bytes=b'\xff\xfe rossz')
    check('2c nem UTF-8 STDIN MEGTAGADVA', rc != 0 and 'nem UTF-8' in out, out)
    check('2c semmi nem irodott', lekerdez(d, 'SELECT COUNT(*) FROM kanban_comments')[0][0] == db_elotte)

    # (3) hatarido ISO zonaval -> egesz masodperc; a nyom a regi (NULL) erteket orzi
    cf = fajl('Hatarido beallitva a teszthez.')
    rc, out = futtat(d, komment + ['--comment-file', cf, '--due-date', '2026-10-29T12:00:00Z'])
    v = lekerdez(d, "SELECT due_date, typeof(due_date) FROM kanban_cards WHERE id='HATAR1003'")[0]
    check('3 ISO "Z" -> 1793275200 egesz', rc == 0 and v == (1793275200, 'integer'), f'{v} {out}')
    nyom = lekerdez(d, "SELECT content FROM kanban_comments WHERE author='kartya-es-ertesites'"
                       " ORDER BY id DESC LIMIT 1")
    check('3 a mozgatas-nyom a due_date regi erteket (NULL) kimondja',
          bool(nyom) and 'due_date' in nyom[0][0] and 'NULL volt' in nyom[0][0], repr(nyom)[:300])
    check('3 a teljes sor kapuja zold', 'TELJES SOR OK' in out, out)

    # (3b) +02:00 eltolassal ugyanaz a pillanat; unix mp; none = torles
    rc, out = futtat(d, komment + ['--comment-file', cf, '--due-date', '2026-10-29T14:00:00+02:00'])
    check('3b +02:00 ugyanaz a pillanat: nincs mit mozgatni', rc == 0 and 'mar ezen az erteken all' in out, out)
    rc, out = futtat(d, komment + ['--comment-file', cf, '--due-date', '1793361600'])
    v = lekerdez(d, "SELECT due_date FROM kanban_cards WHERE id='HATAR1003'")[0][0]
    check('3b unix masodperc beirva', rc == 0 and v == 1793361600, f'{v} {out}')
    rc, out = futtat(d, komment + ['--comment-file', cf, '--due-date', 'none'])
    v = lekerdez(d, "SELECT due_date FROM kanban_cards WHERE id='HATAR1003'")[0][0]
    check('3b none -> torolve (NULL)', rc == 0 and v is None, f'{v} {out}')
    nyom = lekerdez(d, "SELECT content FROM kanban_comments WHERE author='kartya-es-ertesites'"
                       " ORDER BY id DESC LIMIT 1")
    check('3b a torles nyoma a teljes regi erteket orzi (1793361600)',
          bool(nyom) and '1793361600' in nyom[0][0], repr(nyom)[:300])

    # (4) rossz alakok -> megtagadas, iras nelkul
    db_elotte = lekerdez(d, 'SELECT COUNT(*) FROM kanban_comments')[0][0]
    for nev, ertek, jel in (('idozona nelkul', '2026-10-29T12:00:00', 'idozona nelkuli'),
                            ('ezredmasodperc', '1793275200000', 'ezredmasodperc'),
                            ('ertelmetlen', 'holnap', 'se nem egesz')):
        rc, out = futtat(d, komment + ['--comment-file', cf, '--due-date', ertek])
        check(f'4 {nev} MEGTAGADVA', rc != 0 and jel in out, out)
    check('4 semmi nem irodott', lekerdez(d, 'SELECT COUNT(*) FROM kanban_comments')[0][0] == db_elotte)

    # (5) due_date oszlop nelkuli DB -> megtagadas, iras nelkul
    fd, d2 = tempfile.mkstemp(suffix='.db', prefix='kartya-stdin-nincs-'); os.close(fd); os.remove(d2)
    fresh_db(d2, hatarido_oszlop=False)
    rc, out = futtat(d2, komment + ['--comment-file', cf, '--due-date', '1793275200'])
    check('5 oszlop nelkul MEGTAGADVA', rc != 0 and 'nincs due_date oszlop' in out, out)
    check('5 semmi nem irodott', lekerdez(d2, 'SELECT COUNT(*) FROM kanban_comments')[0][0] == 0)

    # (6) letrehozo ag --due-date-tel; dry-run nem ir. A letrehozo ag a feladot a flottahoz meri, ezert
    #     itt a beepitett nevsor egy tagja a szerzo (a nevsor felulbiralasa a kartya-flotta-env tesztje).
    rc, out = futtat(d, ['--id', 'UJHATAR1003', '--assignee', 'kulso-szerzo', '--title', 'UJHATAR1003 teszt',
                         '--author', 'boni', '--due-date', '2026-11-02T08:00:00Z', '--dry-run'])
    check('6 dry-run zold es kiirja a hataridot', rc == 0 and 'hatarido=1793606400' in out, out)
    check('6 dry-run nem irt', not lekerdez(d, "SELECT 1 FROM kanban_cards WHERE id='UJHATAR1003'"))
    rc, out = futtat(d, ['--id', 'UJHATAR1003', '--assignee', 'kulso-szerzo', '--title', 'UJHATAR1003 teszt',
                         '--author', 'boni', '--due-date', '2026-11-02T08:00:00Z'])
    v = lekerdez(d, "SELECT due_date FROM kanban_cards WHERE id='UJHATAR1003'")
    check('6 a letrehozo ag a hataridot irja', rc == 0 and v == [(1793606400,)], f'{v} {out}')
    check('6 a letrehozo ag teljes sort olvas vissza', 'teljes sor visszaolvasva' in out, out)

    print('---')
    print(f'FAILS: {len(FAILS)}' + (': ' + ', '.join(FAILS) if FAILS else ''))
    return 1 if FAILS else 0


if __name__ == '__main__':
    sys.exit(main())
