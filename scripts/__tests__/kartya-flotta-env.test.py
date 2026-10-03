#!/usr/bin/env python3
"""FLOTTAENV1003: a flotta-nevsor felulbiralhato (KARTYA_FLEET, KARTYA_KOORDINATOR, KARTYA_GAZDA).

AMIERT: a beepitett FLEET egy telepites nevsora. Egy masik telepitesen (2026-10-03: 30 agens, egyik sem
a halmazban) az ertesites-ag minden ottani agens kartyajan megtagadott, a felado-kapu minden ottani nevet
elutasitott. AMIT A SUITE ROGZIT: (1) felulbiralas nelkul a regi viselkedes (kontroll); (2) a kimondott
lista es az elo lista (@api) UGYANUGY hat a kapukra es a cimzettre; (3) az onhurok a megadott
koordinatorhoz megy; (4) minden hibas, hianyos vagy elerhetetlen nevsor MEGTAGADAS, iras nelkul, es
a beepitett nevsorra NINCS csendes visszaeses.

Futtatas:  python3 scripts/__tests__/kartya-flotta-env.test.py
"""
import json, os, sqlite3, subprocess, sys, tempfile, threading, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
SCRIPT = os.path.join(ROOT, 'scripts', 'kartya-es-ertesites.py')
SANDBOX_ROOT = tempfile.mkdtemp(prefix='kartya-flottaenv-sandbox-')
DB_PATH = None
FAILS = []


class Stub(BaseHTTPRequestHandler):
    def _valasz(self, kod, obj):
        out = json.dumps(obj).encode()
        self.send_response(kod); self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(out))); self.end_headers(); self.wfile.write(out)

    def do_GET(self):
        if self.path != '/api/agents':
            return self._valasz(404, {'error': 'nincs'})
        if self.headers.get('Authorization') != 'Bearer teszt-token':
            return self._valasz(401, {'error': 'Unauthorized'})
        self._valasz(200, [{'name': 'alfa'}, {'name': 'beta'}])

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        db = sqlite3.connect(DB_PATH)
        cur = db.execute('INSERT INTO agent_messages (from_agent,to_agent,content,status,created_at)'
                         ' VALUES (?,?,?,?,?)', (body['from'], body['to'], body['content'], 'pending', int(time.time())))
        db.commit(); mid = cur.lastrowid; db.close()
        self._valasz(200, {'id': mid})

    def log_message(self, *a):
        pass


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
    now = int(time.time())
    db.execute("INSERT INTO kanban_cards (id,title,assignee,created_at,updated_at)"
               " VALUES ('BETA1003','BETA1003 teszt','beta',?,?)", (now, now))
    db.commit(); db.close()


def futtat(port, args, **nevsor):
    e = dict(os.environ)
    for k in ('KARTYA_FLEET', 'KARTYA_KOORDINATOR', 'KARTYA_GAZDA'):
        e.pop(k, None)
    e.update(KARTYA_DB=DB_PATH, CLAUDECLAW_ROOT=SANDBOX_ROOT, KARTYA_TOKEN=nevsor.pop('token', 'teszt-token'),
             KARTYA_API=f'http://127.0.0.1:{port}/api/messages',
             KARTYA_AGENTS_API=nevsor.pop('agents_api', f'http://127.0.0.1:{port}/api/agents'))
    e.update({'KARTYA_' + k.upper(): v for k, v in nevsor.items()})
    p = subprocess.run([sys.executable, SCRIPT] + args, capture_output=True, text=True, env=e, timeout=30)
    return p.returncode, p.stdout + p.stderr


def fajl(szoveg):
    fd, p = tempfile.mkstemp(prefix='kartya-flottaenv-', suffix='.txt'); os.close(fd)
    with open(p, 'w', encoding='utf-8') as f:
        f.write(szoveg)
    return p


def szamok():
    db = sqlite3.connect(DB_PATH)
    try:
        return (db.execute('SELECT COUNT(*) FROM kanban_comments').fetchone()[0],
                db.execute('SELECT COUNT(*) FROM agent_messages').fetchone()[0],
                db.execute('SELECT COUNT(*) FROM kanban_cards').fetchone()[0])
    finally:
        db.close()


def uzenetek():
    db = sqlite3.connect(DB_PATH)
    try:
        return db.execute('SELECT from_agent, to_agent FROM agent_messages ORDER BY id').fetchall()
    finally:
        db.close()


def main():
    global DB_PATH
    fd, DB_PATH = tempfile.mkstemp(suffix='.db', prefix='kartya-flottaenv-'); os.close(fd); os.remove(DB_PATH)
    fresh_db(DB_PATH)
    srv = ThreadingHTTPServer(('127.0.0.1', 0), Stub)
    port = srv.server_address[1]
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    cf = fajl('Komment a nevsor-teszthez.')
    mf = fajl('Ertesites a BETA1003 kartyarol.')
    komment = ['--id', 'BETA1003', '--author', 'alfa', '--comment-file', cf]
    lista = dict(fleet='alfa, Beta', koordinator='koord')

    # 1. KONTROLL: felulbiralas nelkul a beta kulso nev, ertesites nelkul atmegy
    rc, out = futtat(port, komment)
    check('1 beepitett nevsorral a beta kulso: atmegy, nincs FLOTTA-sor',
          rc == 0 and 'KOMMENT OK' in out and 'FLOTTA FELULBIRALVA' not in out, out)

    # 2. kimondott lista: a beta flotta-tag, ertesites nelkul MEGTAGADVA, iras nelkul
    elotte = szamok()
    rc, out = futtat(port, komment, **lista)
    check('2 KARTYA_FLEET-tel a beta flotta-tag: ertesites nelkul MEGTAGADVA',
          rc != 0 and 'MEGTAGADVA' in out and 'beta' in out, out)
    check('2 semmi nem irodott', szamok() == elotte, f'{elotte} -> {szamok()}')

    # 3. kimondott lista --msg-file-lal: az ertesites a betanak megy, alfa nevevel
    rc, out = futtat(port, komment + ['--msg-file', mf], **lista)
    check('3 KARTYA_FLEET + --msg-file: rc=0, FLOTTA FELULBIRALVA (KARTYA_FLEET) a kimeneten',
          rc == 0 and 'FLOTTA FELULBIRALVA (KARTYA_FLEET): 3 nev' in out, out)
    check('3 az uzenet alfa -> beta', uzenetek()[-1:] == [('alfa', 'beta')], str(uzenetek()))

    # 4. onhurok: alfa a sajat magara nyitott kartyarol -> a megadott koordinatorhoz
    rc, out = futtat(port, ['--id', 'ALFA1003', '--assignee', 'alfa', '--title', 'ALFA1003 teszt',
                            '--author', 'alfa', '--msg-file', fajl('Uj kartya: ALFA1003')], **lista)
    check('4 onhurok a koordinatorhoz (koord) megy', rc == 0 and uzenetek()[-1:] == [('alfa', 'koord')],
          f'{uzenetek()} {out}')

    # 5. elo lista (@api) ugyanigy hat
    rc, out = futtat(port, komment + ['--msg-file', mf], fleet='@api', koordinator='koord')
    check('5 @api: rc=0, a nevsor az elo listabol', rc == 0 and 'FLOTTA FELULBIRALVA (@api' in out, out)
    check('5 @api: az uzenet alfa -> beta', uzenetek()[-1:] == [('alfa', 'beta')], str(uzenetek()))

    # 6-11. MEGTAGADASOK, mind iras nelkul, visszaeses nelkul
    esetek = (
        ('6 @api rossz tokennel', dict(fleet='@api', koordinator='koord', token='rossz'), 'nem olvashato'),
        ('7 @api elerhetetlen', dict(fleet='@api', koordinator='koord', agents_api='http://127.0.0.1:9/api/agents'),
         'nem olvashato'),
        ('8 KARTYA_FLEET koordinator nelkul', dict(fleet='alfa,beta'), 'KARTYA_KOORDINATOR is kell'),
        ('9 ervenytelen nev (szokoz)', dict(fleet='alfa,be ta', koordinator='koord'), 'ervenytelen nev'),
        ('9b ervenytelen nev (cirill betu)', dict(fleet='alfa,b' + chr(0x0435) + 'ta', koordinator='koord'),
         'ervenytelen nev'),
        ('10 a gazda a flottaban', dict(fleet='alfa,beta', koordinator='koord', gazda='beta'), 'flotta-listaban is'),
        ('11 ures lista', dict(fleet=' , ', koordinator='koord'), 'ures nev-lista'),
    )
    for nev, nevsor, jel in esetek:
        elotte = szamok()
        rc, out = futtat(port, komment + ['--msg-file', mf], **nevsor)
        check(nev + ': MEGTAGADVA', rc != 0 and jel in out, out)
        check(nev + ': semmi nem irodott', szamok() == elotte, f'{elotte} -> {szamok()}')

    srv.shutdown()
    print('---')
    print(f'FAILS: {len(FAILS)}' + (': ' + ', '.join(FAILS) if FAILS else ''))
    return 1 if FAILS else 0


if __name__ == '__main__':
    sys.exit(main())
