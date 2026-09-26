import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { execFile } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// scripts/agent-msg.sh prints the receiver's queue depth on its OK line (card
// a509fdf6): an id proves the row was CREATED, not that it was delivered, and a
// sender reading a bare "OK id=..." cannot tell a 0-deep queue from an 81-deep
// one. This runs the REAL script end to end against a stub server -- what the
// sender SEES on stdout/stderr, not what the source contains.
//
// Two things are pinned here, because the port of that change onto develop had
// to merge with #1334 (the router's `warning` field):
//  - BOTH success lines carry the note: the plain one and the "(warning)" one,
//    and the WARNING itself still goes to stderr, unchanged;
//  - the backlog request follows MARVEEN_API_BASE like the send does. The note
//    was written against a hardcoded localhost:<port>; MARVEEN_WEB_PORT=1 below
//    makes that address dead, so a regression shows up as "NEM MERHETO".

const SCRIPT = fileURLToPath(new URL('../../scripts/agent-msg.sh', import.meta.url))
const TOKEN = 'queue-note-test-token'

type Reply = { status: number; body: string }
let postReply: Reply
let backlogReply: Reply
const seen: { method: string; url: string; auth: string | undefined }[] = []

let server: Server
let apiBase = ''
let tokenFile = ''

beforeAll(async () => {
  server = createServer((req, res) => {
    seen.push({ method: req.method ?? '', url: req.url ?? '', auth: req.headers.authorization })
    req.resume()
    req.on('end', () => {
      const r: Reply =
        req.method === 'POST' && req.url === '/api/messages' ? postReply
        : req.method === 'GET' && req.url === '/api/messages/backlog' ? backlogReply
        : { status: 404, body: '{"error":"not found"}' }
      res.writeHead(r.status, { 'Content-Type': 'application/json' })
      res.end(r.body)
    })
  })
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', () => ok()))
  apiBase = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  tokenFile = join(mkdtempSync(join(tmpdir(), 'agentmsg-queue-')), 'token')
  writeFileSync(tokenFile, TOKEN)
})

afterAll(() => new Promise<void>((ok) => server.close(() => ok())))

// execFile, not execFileSync: the stub lives in THIS process, and a blocked
// event loop would never answer the script's curl.
function send(): Promise<{ code: number; stdout: string; stderr: string }> {
  seen.length = 0
  return new Promise((ok) => {
    execFile(
      'bash',
      [SCRIPT, 'kuldo', 'cimzett', 'teszt uzenet'],
      {
        env: { ...process.env, MARVEEN_API_BASE: apiBase, MARVEEN_TOKEN_FILE: tokenFile, MARVEEN_WEB_PORT: '1' },
        timeout: 30000,
      },
      (err, stdout, stderr) => ok({ code: err ? Number(err.code ?? -1) : 0, stdout, stderr }),
    )
  })
}

const ACCEPTED: Reply = { status: 200, body: '{"id":41,"status":"pending"}' }
const backlog = (rows: unknown): Reply => ({ status: 200, body: JSON.stringify(rows) })
// Another agent's deep queue in the same answer: the note must pick the receiver's row.
const OTHER = { agent: 'mas-ugynok', pending: 90, oldestAgeSeconds: 99999 }

describe('agent-msg.sh: receiver queue depth on the OK line', () => {
  it('a short queue is reported quietly, from the receiver row only', async () => {
    postReply = ACCEPTED
    backlogReply = backlog([OTHER, { agent: 'cimzett', pending: 2, oldestAgeSeconds: 185 }])
    const r = await send()
    expect(r.code).toBe(0)
    expect(r.stdout).toBe('OK id=41 (sor: 2, legregebbi 3m)\n')
    // The backlog is read from the SAME base as the send, with the same token.
    expect(seen.map((s) => `${s.method} ${s.url}`)).toEqual(['POST /api/messages', 'GET /api/messages/backlog'])
    expect(seen.every((s) => s.auth === `Bearer ${TOKEN}`)).toBe(true)
  })

  it('turns loud at 5 queued messages', async () => {
    postReply = ACCEPTED
    backlogReply = backlog([{ agent: 'cimzett', pending: 5, oldestAgeSeconds: 30 }])
    const r = await send()
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('OK id=41 (FIGYELEM: 5 uzenet all a(z) cimzett soraban, a legregebbi 0m ota')
    expect(r.stdout).toContain('EZ NEM FOG HAMAR MEGERKEZNI')
  })

  it('turns loud at a 10 minute old head, and stays quiet one second before', async () => {
    postReply = ACCEPTED
    backlogReply = backlog([{ agent: 'cimzett', pending: 1, oldestAgeSeconds: 599 }])
    expect((await send()).stdout).toBe('OK id=41 (sor: 1, legregebbi 9m)\n')

    backlogReply = backlog([{ agent: 'cimzett', pending: 1, oldestAgeSeconds: 600 }])
    expect((await send()).stdout).toContain('(FIGYELEM: 1 uzenet all a(z) cimzett soraban, a legregebbi 10m ota')
  })

  it('prints hours for an old head (the measured 3h31m case)', async () => {
    postReply = ACCEPTED
    backlogReply = backlog([{ agent: 'cimzett', pending: 81, oldestAgeSeconds: 3 * 3600 + 31 * 60 }])
    expect((await send()).stdout).toContain('81 uzenet all a(z) cimzett soraban, a legregebbi 3h31m ota')
  })

  it('adds nothing when the receiver has no queue', async () => {
    postReply = ACCEPTED
    backlogReply = backlog([OTHER])
    const r = await send()
    expect(r.code).toBe(0)
    expect(r.stdout).toBe('OK id=41\n')
  })

  it("says so when the backlog cannot be read -- the note's own failure is visible, the send still counts", async () => {
    postReply = ACCEPTED
    backlogReply = { status: 500, body: '{"error":"boom"}' }
    let r = await send()
    expect(r.code).toBe(0)
    expect(r.stdout).toBe('OK id=41 [SORHOSSZ NEM MERHETO: /api/messages/backlog http=500]\n')

    backlogReply = { status: 200, body: 'not json' }
    r = await send()
    expect(r.code).toBe(0)
    expect(r.stdout).toBe('OK id=41 [SORHOSSZ NEM MERHETO: a backlog valasza nem JSON]\n')
  })

  it('the router warning (#1334) is unchanged, and its OK line carries the note too', async () => {
    postReply = { status: 200, body: '{"id":41,"status":"pending","warning":"cimzett is not running;  the message is LOST"}' }
    backlogReply = backlog([{ agent: 'cimzett', pending: 2, oldestAgeSeconds: 185 }])
    const r = await send()
    expect(r.code).toBe(0)
    expect(r.stdout).toBe('OK id=41 (warning) (sor: 2, legregebbi 3m)\n')
    // Whitespace-collapsed, on stderr, exactly as #1334 prints it.
    expect(r.stderr).toContain('OK id=41  WARNING: cimzett is not running; the message is LOST\n')
  })
})
