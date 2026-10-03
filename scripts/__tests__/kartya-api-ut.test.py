#!/usr/bin/env python3
"""APIUT1003: a komment-mod valaszthato API-utja (KARTYA_KANBAN_API).

A STUB a dashboard szemantikajat koveti (src/db.ts, src/web/routes/kanban.ts): a komment-POST
lepteti a kartya updated_at-jet es a #hex8 hivatkozast #sorszamra irhatja; a PUT egy UPDATE, es
statusz-valtasnal EGY kanban_card_events sort ir az actorral; ismeretlen mezore 400, rossz
tokenre 401. AMIT A SUITE ROGZIT: (1) mozgatasonkent pontosan egy esemeny-sor a felado actorral,
a teljes sor csak a kert oszlopban valtozik; (2) rossz tokenre HANGOS bukas a komment-, a
mozgato- es a leiras-agon, iras nelkul, a dry-runban is; (3) a DB-ut negativ kontrollja: 0
esemeny-sor, kimondva a kimeneten es a --help-ben; (4) a szerver #hivatkozas-atirasa FIGYELEM,
a valodi tartalom-serules es a mas tarolo HIBA; (5) minden iras az API-n at ment.

Futtatas:  python3 scripts/__tests__/kartya-api-ut.test.py
"""
import json, os, re, sqlite3, subprocess, sys, tempfile, threading, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
SCRIPT = os.path.join(ROOT, 'scripts', 'kartya-es-ertesites.py')
SANDBOX_ROOT = tempfile.mkdtemp(prefix='kartya-apiut-sandbox-')
DB_PATH = MASIK_DB = None
IRASOK = {'POST': 0, 'PUT': 0}
FAILS = []
IRHATO = ('title', 'description', 'status', 'assignee', 'priority', 'project', 'parent_id', 'due_date',
          'sort_order', 'archived_at')
OSZLOPOK = ('title', 'description', 'status', 'assignee', 'priority', 'project', 'due_date', 'sort_order',
            'created_at', 'archived_at', 'parent_id', 'dispatched_at')


class Stub(BaseHTTPRequestHandler):
    def _valasz(self, kod, obj):
        out = json.dumps(obj).encode()
        self.send_response(kod); self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(out))); self.end_headers(); self.wfile.write(out)

    def _auth(self):
        if self.headers.get('Authorization') != 'Bearer teszt-token':
            self._valasz(401, {'error': 'Unauthorized'})
            return False
        return True

    def do_GET(self):
        if not self._auth():
            return
        m = re.fullmatch(r'/api/kanban/([^/]+)/comments', self.path)
        db = sqlite3.connect(DB_PATH)
        sorok = db.execute('SELECT id, author FROM kanban_comments WHERE card_id=?', (m.group(1),)).fetchall() if m else []
        db.close()
        self._valasz(200 if m else 404, [{'id': i, 'author': w} for i, w in sorok])

    def do_POST(self):
        if not self._auth():
            return
        m = re.fullmatch(r'/api/kanban/([^/]+)/comments', self.path)
        body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        db = sqlite3.connect(DB_PATH)
        try:
            if not m or not db.execute('SELECT 1 FROM kanban_cards WHERE id=?', (m.group(1),)).fetchone():
                return self._valasz(404, {'error': 'Kartya nem talalhato'})
            cid, now = m.group(1), int(time.time())
            if not body.get('author') or not body.get('content'):
                return self._valasz(400, {'error': 'Szerzo es tartalom kotelezo'})
            IRASOK['POST'] += 1

            def sorszam(mm):
                r = db.execute('SELECT rowid FROM kanban_cards WHERE lower(id) LIKE ?', (mm.group(1).lower() + '%',)).fetchone()
                return f'#{r[0]}' if r else mm.group(0)
            content = re.sub(r'#([a-fA-F0-9]{8})\b', sorszam, body['content'])
            if cid == 'RONT1003':
                content = content[:-1]
            auto = 1 if body.get('automated') is True else 0
            if cid == 'MASIK1003':
                m2 = sqlite3.connect(MASIK_DB)
                cur = m2.execute('INSERT INTO kanban_comments (id,card_id,author,content,created_at,automated)'
                                 ' VALUES (900000+abs(random()%1000),?,?,?,?,?)', (cid, body['author'], content, now, auto))
                m2.commit(); uj = cur.lastrowid; m2.close()
                return self._valasz(200, {'id': uj})
            cur = db.execute('INSERT INTO kanban_comments (card_id,author,content,created_at,automated) VALUES (?,?,?,?,?)',
                             (cid, body['author'], content, now, auto))
            db.execute('UPDATE kanban_cards SET updated_at=? WHERE id=?', (now, cid))
            db.commit()
            self._valasz(200, {'id': cur.lastrowid, 'card_id': cid, 'author': body['author'], 'content': content,
                               'created_at': now, 'automated': auto})
        finally:
            db.close()

    def do_PUT(self):
        if not self._auth():
            return
        m = re.fullmatch(r'/api/kanban/([^/]+)', self.path)
        body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        actor = body.pop('actor', None)
        ismeretlen = [k for k in body if k not in IRHATO]
        if ismeretlen:
            return self._valasz(400, {'error': 'Unknown field(s): ' + ', '.join(ismeretlen)})
        db = sqlite3.connect(DB_PATH)
        try:
            cur = db.execute('SELECT * FROM kanban_cards WHERE id=?', (m.group(1) if m else '',))
            row = cur.fetchone()
            if not row:
                return self._valasz(404, {'error': 'Kartya nem talalhato'})
            IRASOK['PUT'] += 1
            card = {d[0]: v for d, v in zip(cur.description, row)}
            now = int(time.time())
            f = dict(card, **body)
            if any(f[k] != card[k] for k in IRHATO):
                db.execute('UPDATE kanban_cards SET ' + ', '.join(f'{k}=?' for k in IRHATO) + ', updated_at=? WHERE id=?',
                           (*[f[k] for k in IRHATO], now, card['id']))
                if f['status'] != card['status']:
                    db.execute('INSERT INTO kanban_card_events (card_id,from_status,to_status,actor,created_at)'
                               ' VALUES (?,?,?,?,?)', (card['id'], card['status'], f['status'], actor, now))
                db.commit()
            self._valasz(200, {'ok': True})
        finally:
            db.close()

    def log_message(self, *a):
        pass


def check(name, cond, detail=''):
    print(('PASS  ' if cond else 'FAIL  ') + name + (('  -- ' + detail[:400]) if detail and not cond else ''))
    if not cond:
        FAILS.append(name)


SEMA = '''
  CREATE TABLE kanban_cards (id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT,
    status TEXT NOT NULL DEFAULT 'planned', assignee TEXT, priority TEXT NOT NULL DEFAULT 'normal',
    project TEXT, due_date INTEGER, sort_order REAL NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, archived_at INTEGER,
    parent_id TEXT, dispatched_at INTEGER);
  CREATE TABLE kanban_comments (id INTEGER PRIMARY KEY AUTOINCREMENT, card_id TEXT NOT NULL,
    author TEXT NOT NULL, content TEXT NOT NULL, created_at INTEGER NOT NULL, automated INTEGER DEFAULT 0);
  CREATE TABLE kanban_card_events (id INTEGER PRIMARY KEY AUTOINCREMENT, card_id TEXT NOT NULL,
    from_status TEXT, to_status TEXT NOT NULL, actor TEXT, created_at INTEGER NOT NULL);
  CREATE TABLE agent_messages (id INTEGER PRIMARY KEY AUTOINCREMENT, from_agent TEXT NOT NULL,
    to_agent TEXT NOT NULL, content TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
    result TEXT, created_at INTEGER NOT NULL, delivered_at INTEGER, completed_at INTEGER);
'''


def fresh_db(path, kartyak):
    db = sqlite3.connect(path)
    db.executescript(SEMA)
    regi = int(time.time()) - 3600
    for cid in kartyak:
        db.execute("INSERT INTO kanban_cards (id,title,description,assignee,project,due_date,sort_order,created_at,"
                   "updated_at,parent_id) VALUES (?,?,'regi leiras','kulso-szerzo','proj-x',1793275200,2.5,?,?,'SZULO1003')",
                   (cid, f'{cid} teszt', regi, regi))
    db.commit(); db.close()


def futtat(port, args, api=True, token='teszt-token', stdin=b''):
    e = dict(os.environ)
    for k in ('KARTYA_FLEET', 'KARTYA_KOORDINATOR', 'KARTYA_GAZDA', 'KARTYA_KANBAN_API'):
        e.pop(k, None)
    e.update(KARTYA_DB=DB_PATH, CLAUDECLAW_ROOT=SANDBOX_ROOT, KARTYA_TOKEN=token,
             KARTYA_API=f'http://127.0.0.1:{port}/api/messages')
    if api:
        e['KARTYA_KANBAN_API'] = f'http://127.0.0.1:{port}/api/kanban'
    p = subprocess.run([sys.executable, SCRIPT] + args, capture_output=True, env=e, timeout=30, input=stdin)
    return p.returncode, p.stdout.decode('utf-8', 'replace') + p.stderr.decode('utf-8', 'replace')


def q(sql, args=()):
    db = sqlite3.connect(DB_PATH)
    try:
        return db.execute(sql, args).fetchall()
    finally:
        db.close()


def sor(cid):
    r = q(f'SELECT {",".join(OSZLOPOK)} FROM kanban_cards WHERE id=?', (cid,))
    return dict(zip(OSZLOPOK, r[0])) if r else None


def allapot(cid):
    return (sor(cid), q('SELECT COUNT(*) FROM kanban_comments WHERE card_id=?', (cid,))[0][0],
            q('SELECT COUNT(*) FROM kanban_card_events WHERE card_id=?', (cid,))[0][0])


def fajl(szoveg):
    fd, p = tempfile.mkstemp(prefix='kartya-apiut-', suffix='.txt'); os.close(fd)
    with open(p, 'w', encoding='utf-8') as f:
        f.write(szoveg)
    return p


def main():
    global DB_PATH, MASIK_DB
    fd, DB_PATH = tempfile.mkstemp(suffix='.db', prefix='kartya-apiut-'); os.close(fd); os.remove(DB_PATH)
    fd, MASIK_DB = tempfile.mkstemp(suffix='.db', prefix='kartya-apiut-masik-'); os.close(fd); os.remove(MASIK_DB)
    fresh_db(DB_PATH, ('MOZG1003', 'LEIR1003', 'TOKEN1003', 'DBUT1003', 'abcdef1234', 'HIVAT1003', 'RONT1003',
                       'MASIK1003', 'ACTOR1003'))
    fresh_db(MASIK_DB, ('MASIK1003',))
    srv = ThreadingHTTPServer(('127.0.0.1', 0), Stub)
    port = srv.server_address[1]
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    gonosz = 'Idezojel " aposztrof \' backtick ` $(echo x) {"k": "v: 1"}\nmasodik sor, árvíztűrő.'
    cf = fajl(gonosz)
    df = fajl('Új leírás az API-úton, ékezettel.')

    # 1. komment + statusz-mozgatas az API-n at
    elotte = sor('MOZG1003'); irasok = dict(IRASOK)
    rc, out = futtat(port, ['--id', 'MOZG1003', '--author', 'alfa', '--comment-file', cf, '--status', 'in_progress'])
    utana = sor('MOZG1003')
    check('1 rc=0, KOMMENT OK (API-ut), MEZOMOZGATAS OK, ESEMENY OK, TELJES SOR OK',
          rc == 0 and 'KOMMENT OK (API-ut' in out and 'MEZOMOZGATAS OK' in out and 'ESEMENY OK' in out
          and 'TELJES SOR OK' in out, out)
    ev = q("SELECT from_status, to_status, actor FROM kanban_card_events WHERE card_id='MOZG1003'")
    check('1 pontosan egy esemeny-sor, actor alfa', ev == [('planned', 'in_progress', 'alfa')], str(ev))
    check('1 a teljes sorbol csak a status valtozott',
          [k for k in OSZLOPOK if elotte[k] != utana[k]] == ['status'], f'{elotte} -> {utana}')
    km = q("SELECT author, content, automated FROM kanban_comments WHERE card_id='MOZG1003' ORDER BY id")
    check('1 a komment a fejlec utan BAJTRA a kuldott, a nyom-sor automated=1',
          len(km) == 2 and km[0][1].split('\n', 1)[1] == gonosz and km[1][0] == 'kartya-es-ertesites' and km[1][2] == 1,
          str(km)[:300])
    check('1 minden iras az API-n at ment (2 POST, 1 PUT)',
          (IRASOK['POST'] - irasok['POST'], IRASOK['PUT'] - irasok['PUT']) == (2, 1), str(IRASOK))

    # 2. leiras-csere az API-n at: csak a description, esemeny-sor nelkul
    elotte = sor('LEIR1003')
    rc, out = futtat(port, ['--id', 'LEIR1003', '--author', 'alfa', '--comment-file', cf, '--desc-file', df])
    utana = sor('LEIR1003')
    check('2 leiras-csere rc=0 es TELJES SOR OK', rc == 0 and 'TELJES SOR OK' in out, out)
    check('2 csak a description valtozott, esemeny-sor 0',
          [k for k in OSZLOPOK if elotte[k] != utana[k]] == ['description']
          and q("SELECT COUNT(*) FROM kanban_card_events WHERE card_id='LEIR1003'")[0][0] == 0, f'{elotte} -> {utana}')

    # 3. rossz token: HANGOS bukas mindharom agon, iras nelkul; dry-run is piros
    for nev, extra in (('komment', []), ('mozgatas', ['--status', 'waiting']), ('leiras', ['--desc-file', df])):
        elotte = allapot('TOKEN1003')
        rc, out = futtat(port, ['--id', 'TOKEN1003', '--author', 'alfa', '--comment-file', cf] + extra, token='rossz')
        check(f'3 rossz token ({nev}): rc!=0, HIBA HTTP 401', rc != 0 and 'HIBA' in out and 'HTTP 401' in out, out)
        check(f'3 rossz token ({nev}): semmi nem irodott', allapot('TOKEN1003') == elotte)
    rc, out = futtat(port, ['--id', 'TOKEN1003', '--author', 'alfa', '--comment-file', cf, '--status', 'waiting',
                            '--dry-run'], token='rossz')
    check('3 rossz token dry-runban is piros', rc != 0 and 'HTTP 401' in out and 'dry-run' in out, out)
    elotte = allapot('TOKEN1003')
    rc, out = futtat(port, ['--id', 'TOKEN1003', '--author', 'alfa', '--comment-file', cf, '--status', 'waiting',
                            '--dry-run'])
    check('3 jo token dry-runban zold, API-ut kiirva, semmi nem irodott',
          rc == 0 and 'DRY-RUN OK' in out and 'API-ut' in out and allapot('TOKEN1003') == elotte, out)

    # 4. NEGATIV KONTROLL: a DB-uton a mozgatas esemeny-sor nelkul megy, es ezt kimondja
    rc, out = futtat(port, ['--id', 'DBUT1003', '--author', 'alfa', '--comment-file', cf, '--status', 'done'], api=False)
    check('4 DB-ut: rc=0, a statusz atment', rc == 0 and sor('DBUT1003')['status'] == 'done', out)
    check('4 DB-ut: 0 esemeny-sor', q("SELECT COUNT(*) FROM kanban_card_events WHERE card_id='DBUT1003'")[0][0] == 0)
    check('4 DB-ut: a kimenet kimondja', 'FIGYELEM (DB-ut)' in out and 'kanban_card_events' in out, out)
    rc, out = futtat(port, ['--help'], api=False)
    check('4 a --help kimondja a DB-ut esemeny-hianyat', rc == 0 and 'kanban_card_events sor NELKUL' in out, out[:300])

    # 5. a szerver #hex8 -> #sorszam atirasa FIGYELEM; a valodi serules es a mas tarolo HIBA
    rc, out = futtat(port, ['--id', 'HIVAT1003', '--author', 'alfa', '--comment-file', fajl('Lasd #abcdef12 kartyat.')])
    check('5 #hivatkozas-atiras: rc=0 es FIGYELEM', rc == 0 and 'normalizeKanbanRefs' in out, out)
    rc, out = futtat(port, ['--id', 'RONT1003', '--author', 'alfa', '--comment-file', cf])
    check('5 serult tartalom: rc!=0, HIBA', rc != 0 and 'NEM a kuldott' in out, out)
    rc, out = futtat(port, ['--id', 'MASIK1003', '--author', 'alfa', '--comment-file', cf])
    check('5 mas tarolo: rc!=0, HIBA', rc != 0 and 'NEM OLVASHATO' in out, out)

    # 6. az actor nev-alaku kell; --automated az API-n at is beirodik
    elotte = allapot('ACTOR1003')
    rc, out = futtat(port, ['--id', 'ACTOR1003', '--author', 'Teszt Iro', '--comment-file', cf, '--status', 'waiting'])
    check('6 nem nev-alaku actor: MEGTAGADVA, semmi nem irodott',
          rc != 0 and '--from' in out and allapot('ACTOR1003') == elotte, out)
    rc, out = futtat(port, ['--id', 'ACTOR1003', '--author', 'alfa', '--comment-file', cf, '--automated'])
    km = q("SELECT automated FROM kanban_comments WHERE card_id='ACTOR1003' ORDER BY id DESC LIMIT 1")
    check('6 --automated az API-n at: rc=0, automated=1', rc == 0 and km == [(1,)], f'{km} {out}')

    srv.shutdown()
    print('---')
    print(f'FAILS: {len(FAILS)}' + (': ' + ', '.join(FAILS) if FAILS else ''))
    return 1 if FAILS else 0


if __name__ == '__main__':
    sys.exit(main())
