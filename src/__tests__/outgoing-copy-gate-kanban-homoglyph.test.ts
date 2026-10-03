import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawn, spawnSync } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// KANBANHOMOGLIF927 (fbca08d6; decision of 2026-09-26): the three
// kanban WRITES get the inter-agent gate's homoglyph-only check, on the fields the
// decision names:
//   POST /api/kanban -> title, description; PUT /api/kanban/<id> -> title,
//   description; POST /api/kanban/<id>/comments -> content.
// Measured before the change: the server only LOGS a lookalike in a comment or a
// card title (AFTER INSERT triggers), NOTHING guards the description, and a comment
// cannot be edited afterwards. Same failure direction as the message branch:
// found -> BLOCK; uninterpretable body -> PASS, loudly, logged as NEM MERHETO.
// Both branches now log a block too (code points and the route, not the word).

const ROOT = join(__dirname, '..', '..')
const GATE = join(ROOT, 'scripts', 'hooks', 'outgoing-copy-gate.py')

// Built from code points so this file never carries a literal lookalike.
const CYR_A = String.fromCodePoint(0x430)
const HOMO_WORD = `k${CYR_A}rtya`
const HOMO = `a ${HOMO_WORD} kesz, reszletek a lapon`
const CLEAN = 'a kartya kesz, reszletek a lapon -- koszonom'
const TOK = 'Authorization: Bearer $(cat store/.dashboard-token)'
const H = `-H "Content-Type: application/json" -H "${TOK}"`
const BASE = 'http://localhost:3420/api/kanban'
const CREATE = `curl -s -X POST ${BASE} ${H}`
const UPDATE = `curl -s -X PUT ${BASE}/abcd1234 ${H}`
const COMMENT = `curl -s -X POST ${BASE}/abcd1234/comments ${H}`

let dir: string
beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'kbhomo-')) })
afterAll(() => { rmSync(dir, { recursive: true, force: true }) })

function file(name: string, content: string): string {
  const p = join(dir, name)
  writeFileSync(p, content)
  return p
}
const input = (cmd: string) =>
  JSON.stringify({ tool_name: 'Bash', tool_input: { command: cmd }, hook_event_name: 'PreToolUse' })
// hermetic: rules path (and so the gate log and the token file) inside the test dir
const env = () => ({ ...process.env, CLAUDE_PROJECT_DIR: ROOT, OUTGOING_COPY_GATE_RULES: join(dir, 'rules.json') })

function gate(cmd: string): { code: number | null; out: string; err: string } {
  const r = spawnSync('python3', [GATE], { input: input(cmd), encoding: 'utf-8', env: env() })
  return { code: r.status, out: r.stdout, err: r.stderr }
}
// The stub dashboard below lives in THIS process, so the gate must run without
// blocking the event loop, or the stub could never answer it.
function gateAsync(cmd: string, extra: Record<string, string> = {}): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve) => {
    const p = spawn('python3', [GATE], { env: { ...env(), ...extra } })
    let out = ''
    let err = ''
    p.stdout.on('data', (d) => { out += d })
    p.stderr.on('data', (d) => { err += d })
    p.on('close', (code) => resolve({ code, out, err }))
    p.stdin.end(input(cmd))
  })
}
const heredoc = (head: string, body: string) => `${head} --data-binary @- <<'JSON'\n${body}\nJSON`
const log = () => {
  const p = join(dir, 'outgoing-copy-gate.log')
  return existsSync(p) ? readFileSync(p, 'utf-8') : ''
}

describe('kanban writes: a homoglyph BLOCKS on every decided field and in every shape', () => {
  it('new card: title (heredoc), description (@file), inline -d', () => {
    const t = gate(heredoc(CREATE, JSON.stringify({ title: HOMO, description: CLEAN, assignee: 'agent-a' })))
    expect(t.code).toBe(2)
    expect(t.err).toContain('homoglifa')
    expect(t.err).toContain('(title)')
    expect(t.err).toContain('CYRILLIC SMALL LETTER A')
    const d = gate(`${CREATE} --data-binary @${file('c.json', JSON.stringify({ title: CLEAN, description: HOMO }))}`)
    expect(d.code).toBe(2)
    expect(d.err).toContain('(description)')
    expect(gate(`${CREATE} -d '${JSON.stringify({ title: HOMO })}'`).code).toBe(2)
  })
  it('card update (PUT): title and description', () => {
    expect(gate(`${UPDATE} -d '${JSON.stringify({ description: HOMO })}'`).code).toBe(2)
    expect(gate(heredoc(UPDATE, JSON.stringify({ title: HOMO, actor: 'agent-a' }))).code).toBe(2)
  })
  it('comment: content, in heredoc, @file, -d@file and the fleet S=/abs; @$S form', () => {
    const body = JSON.stringify({ author: 'agent-a', content: HOMO })
    const r = gate(heredoc(COMMENT, body))
    expect(r.code).toBe(2)
    expect(r.err).toContain('(content)')
    expect(r.err).toContain('KIMENO-SZOVEG KAPU (kanban)')
    expect(gate(`${COMMENT} --data-binary @${file('k.json', body)}`).code).toBe(2)
    expect(gate(`${COMMENT} -d@${file('k2.json', body)}`).code).toBe(2)
    file('k3.json', body)
    expect(gate(`S=${dir}; ${COMMENT} --data-binary @$S/k3.json`).code).toBe(2)
  })
  it('a \\u-escaped body is decoded before the scan', () => {
    const escaped = JSON.stringify({ author: 'agent-a', content: HOMO })
      .replace(/[^\x00-\x7f]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)
    expect(gate(`${COMMENT} --data-binary @${file('esc.json', escaped)}`).code).toBe(2)
  })
})

describe('kanban writes: clean text and the undecided calls PASS silently', () => {
  it('clean text in every shape', () => {
    for (const cmd of [
      heredoc(CREATE, JSON.stringify({ title: CLEAN, description: CLEAN })),
      `${UPDATE} -d '${JSON.stringify({ description: CLEAN })}'`,
      `${COMMENT} --data-binary @${file('ok.json', JSON.stringify({ author: 'agent-a', content: CLEAN }))}`,
    ]) {
      const r = gate(cmd)
      expect(r.code).toBe(0)
      expect(r.out).toBe('')
    }
  })
  it('only the decided fields are scanned (assignee, author, actor are not)', () => {
    expect(gate(heredoc(CREATE, JSON.stringify({ title: CLEAN, assignee: `fejl${CYR_A}szto` }))).code).toBe(0)
    expect(gate(heredoc(COMMENT, JSON.stringify({ author: `fejl${CYR_A}szto`, content: CLEAN }))).code).toBe(0)
  })
  it('move, archive and reads carry no free text: not scanned', () => {
    const mv = gate(`curl -s -X POST ${BASE}/abcd1234/move ${H} -d '${JSON.stringify({ status: 'done', actor: `fejl${CYR_A}szto` })}'`)
    expect(mv.code).toBe(0)
    expect(mv.out).toBe('')
    expect(gate(`curl -s -X POST ${BASE}/abcd1234/archive ${H}`).code).toBe(0)
    for (const cmd of [`curl -s -H "${TOK}" ${BASE}`, `curl -s -H "${TOK}" "${BASE}/abcd1234/comments"`]) {
      const r = gate(cmd)
      expect(r.code).toBe(0)
      expect(r.out).toBe('')
    }
  })
})

describe('an uninterpretable kanban body PASSES, loudly, and is logged as NEM MERHETO (the third state)', () => {
  const cases: Array<[string, string, RegExp]> = [
    ['missing @file', `${COMMENT} --data-binary @/nincs/ilyen/kb-proba.json`, /nem olvashato/],
    ['$-path', `${UPDATE} --data-binary @$X/leiras.json`, /fel nem oldhato @utvonal/],
    ['run-time -d', `${CREATE} -d "{\\"title\\":\\"$(cat x)\\"}"`, /shell-behelyettesitest/],
    ['not JSON', `${COMMENT} -d 'hello'`, /nem ervenyes JSON/],
  ]
  for (const [name, cmd, reason] of cases) {
    it(name, () => {
      const r = gate(cmd)
      expect(r.code).toBe(0)
      const sm = JSON.parse(r.out.trim()).systemMessage as string
      expect(sm).toMatch(reason)
      expect(sm).toContain('NEM MERHETO')
      expect(sm).toContain('homoglifa-ellenorzes NELKUL')
    })
  }
  it('the log line names NEM MERHETO, the route and the reason', () => {
    gate(`${COMMENT} --data-binary @/nincs/ilyen/kb-naplo.json`)
    const line = log().split('\n').find((l) => l.includes('kb-naplo.json')) ?? ''
    expect(line).toContain('NEM MERHETO')
    expect(line).toContain('kanban-komment')
    expect(line).toContain('Ut: http://localhost:3420/api/kanban/abcd1234/comments')
  })
})

describe('a block is logged on both branches (code points and route, never the word)', () => {
  it('kanban comment', () => {
    const before = log().length
    expect(gate(heredoc(COMMENT, JSON.stringify({ author: 'agent-a', content: HOMO }))).code).toBe(2)
    const added = log().slice(before)
    expect(added).toContain('BLOKK')
    expect(added).toContain('kanban-komment')
    expect(added).toContain('U+0430')
    expect(added).toContain('Ut: http://localhost:3420/api/kanban/abcd1234/comments')
    expect(added).not.toContain(HOMO_WORD)
  })
  it('inter-agent message (the INTERAGENTHOMOGLIF923 branch used to leave no trace of a block)', () => {
    const before = log().length
    const msg = `curl -s -X POST http://localhost:3420/api/messages ${H}`
    expect(gate(heredoc(msg, JSON.stringify({ from: 'samu', to: 'marveen', content: HOMO }))).code).toBe(2)
    const added = log().slice(before)
    expect(added).toContain('BLOKK')
    expect(added).toContain('inter-agent')
    expect(added).not.toContain(HOMO_WORD)
  })
  it('an unreadable message body is NEM MERHETO in the log too', () => {
    gate('curl -s -X POST http://localhost:3420/api/messages --data-binary @/nincs/ilyen/ia-naplo.json')
    const line = log().split('\n').find((l) => l.includes('ia-naplo.json')) ?? ''
    expect(line).toContain('NEM MERHETO')
    expect(line).toContain('inter-agent')
  })
})

describe('card update: the block says whether the lookalike is ALREADY STORED on the card (e)', () => {
  let server: Server
  let port = 0
  let hits = 0
  let auth: string[] = []
  let cards: Array<Record<string, string>> = []
  const TOKEN = 'teszt-token-kbhomo'
  beforeAll(async () => {
    server = createServer((req, res) => {
      hits += 1
      auth.push(String(req.headers.authorization ?? ''))
      res.setHeader('Content-Type', 'application/json')
      res.end(req.url === '/api/kanban' ? JSON.stringify(cards) : '[]')
    })
    await new Promise<void>((r) => server.listen(0, '0.0.0.0', () => r()))
    port = (server.address() as AddressInfo).port
  })
  afterAll(() => new Promise<void>((r) => server.close(() => r())))
  const put = (host: string, body: object) =>
    `curl -s -X PUT http://${host}:${port}/api/kanban/abcd1234 ${H} -d '${JSON.stringify(body)}'`

  it('stored: the word is in the card as it is now -> says so, and how to fix it', async () => {
    writeFileSync(join(dir, '.dashboard-token'), `${TOKEN}\n`)
    cards = [{ id: 'abcd1234', title: 'T', description: `regi szoveg, ${HOMO}` }]
    hits = 0
    auth = []
    const r = await gateAsync(put('127.0.0.1', { description: `regi szoveg, ${HOMO}\nuj sor` }))
    expect(r.code).toBe(2)
    expect(r.err).toContain('MAR TAROLT')
    expect(r.err).toContain('a teljes szot ird ujra')
    expect(hits).toBe(1)
    expect(auth).toEqual([`Bearer ${TOKEN}`])
  })
  it('new: the word is only in the text being sent -> says that instead', async () => {
    cards = [{ id: 'abcd1234', title: 'T', description: 'regi, tiszta szoveg' }]
    const r = await gateAsync(put('localhost', { description: `regi, tiszta szoveg\n${HOMO}` }))
    expect(r.code).toBe(2)
    expect(r.err).toContain('NEM a lap tarolt szovegeben')
  })
  it('the card is read directly, never through a proxy named in the environment', async () => {
    // Port 9 refuses: through the proxy the read would fail and the note would
    // not say MAR TAROLT. no_proxy is emptied so a CI setting cannot mask it.
    cards = [{ id: 'abcd1234', title: 'T', description: `regi szoveg, ${HOMO}` }]
    hits = 0
    const proxy = 'http://127.0.0.1:9'
    const r = await gateAsync(put('127.0.0.1', { description: HOMO }),
      { http_proxy: proxy, HTTP_PROXY: proxy, no_proxy: '', NO_PROXY: '' })
    expect(r.code).toBe(2)
    expect(r.err).toContain('MAR TAROLT')
    expect(hits).toBe(1)
  })
  it('a host that is not the loopback name is NEVER asked, so the token cannot leave', async () => {
    // 127.0.0.2 reaches this stub (it listens on every address), but it is not one
    // of the names the gate trusts: the question must not be sent at all.
    hits = 0
    const r = await gateAsync(put('127.0.0.2', { description: HOMO }))
    expect(r.code).toBe(2)
    expect(r.err).toContain('nem helyi cim')
    expect(hits).toBe(0)
  })
  it('an unreadable card still blocks, and says the check could not be made', async () => {
    unlinkSync(join(dir, '.dashboard-token'))
    const r = await gateAsync(put('127.0.0.1', { description: HOMO }))
    expect(r.code).toBe(2)
    expect(r.err).toContain('Nem tudtam megnezni')
  })
})

describe('scope: the email contract is unchanged', () => {
  it('the conformance list keeps kanban writes expected:false', () => {
    const cases = JSON.parse(readFileSync(join(ROOT, 'scripts', 'hooks', 'send-invocation-cases.json'), 'utf-8'))
    const kb = cases.cases.filter((c: { cmd: string }) => c.cmd.includes('/api/kanban'))
    expect(kb.length).toBeGreaterThanOrEqual(3)
    for (const c of kb) expect(c.expected).toBe(false)
    expect(cases._comment).toContain('KANBANHOMOGLIF927')
  })
})
