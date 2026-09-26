import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { execFile } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// scripts/agent-msg.sh reports the receiver's queue depth after a successful
// send (card a509fdf6): an id proves the row was CREATED, not that it was
// delivered, and a sender reading a bare "OK id=..." cannot tell a 0-deep queue
// from an 81-deep one. This runs the REAL script end to end against a stub
// server -- what the sender SEES on stdout/stderr, not what the source contains.
//
// Pinned here, per the acceptance of card 940dfe31 (the port onto develop,
// which already had #1334, the router's `warning` field):
//  (a) without a warning, stdout is byte-identical to "OK id=N"; the note is a
//      line of its own on STDERR;
//  (b) with a warning (the message is LOST), there is no queue note at all, and
//      the backlog is not even asked; the WARNING line on stderr is unchanged;
//  (c) an unreadable backlog is visible, and the send still exits 0;
//  (d) a backlog slower than 200 ms is cut off and the note is skipped;
//  - and the backlog request follows MARVEEN_API_BASE like the send does:
//    MARVEEN_WEB_PORT=1 below makes a hardcoded localhost address dead, so a
//    regression to it shows up as "NEM MERHETO".

const SCRIPT = fileURLToPath(new URL('../../scripts/agent-msg.sh', import.meta.url))
const TOKEN = 'queue-note-test-token'

type Reply = { status: number; body: string; delayMs?: number }
let postReply: Reply
let backlogReply: Reply
/** Set when the client hung up on a delayed backlog reply before it was written, in ms after the request. */
let backlogAbortedAfterMs: number | null = null
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
      const reply = () => { res.writeHead(r.status, { 'Content-Type': 'application/json' }); res.end(r.body) }
      if (!r.delayMs) return reply()
      const t0 = Date.now()
      res.on('close', () => { if (!res.writableEnded) backlogAbortedAfterMs = Date.now() - t0 })
      setTimeout(() => { if (!res.destroyed) reply() }, r.delayMs)
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
  backlogAbortedAfterMs = null
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

describe('agent-msg.sh: receiver queue depth after the OK line', () => {
  it('(a) stdout stays byte-identical; a short queue is reported quietly on stderr, from the receiver row only', async () => {
    postReply = ACCEPTED
    backlogReply = backlog([OTHER, { agent: 'cimzett', pending: 2, oldestAgeSeconds: 185 }])
    const r = await send()
    expect(r.code).toBe(0)
    expect(r.stdout).toBe('OK id=41\n')
    expect(r.stderr).toBe('OK id=41  QUEUE: (sor: 2, legregebbi 3m)\n')
    // The backlog is read from the SAME base as the send, with the same token.
    expect(seen.map((s) => `${s.method} ${s.url}`)).toEqual(['POST /api/messages', 'GET /api/messages/backlog'])
    expect(seen.every((s) => s.auth === `Bearer ${TOKEN}`)).toBe(true)
  })

  it('turns loud at 5 queued messages', async () => {
    postReply = ACCEPTED
    backlogReply = backlog([{ agent: 'cimzett', pending: 5, oldestAgeSeconds: 30 }])
    const r = await send()
    expect(r.code).toBe(0)
    expect(r.stdout).toBe('OK id=41\n')
    expect(r.stderr).toContain('OK id=41  QUEUE: (FIGYELEM: 5 uzenet all a(z) cimzett soraban, a legregebbi 0m ota')
    expect(r.stderr).toContain('EZ NEM FOG HAMAR MEGERKEZNI')
  })

  it('turns loud at a 10 minute old head, and stays quiet one second before', async () => {
    postReply = ACCEPTED
    backlogReply = backlog([{ agent: 'cimzett', pending: 1, oldestAgeSeconds: 599 }])
    expect((await send()).stderr).toBe('OK id=41  QUEUE: (sor: 1, legregebbi 9m)\n')

    backlogReply = backlog([{ agent: 'cimzett', pending: 1, oldestAgeSeconds: 600 }])
    expect((await send()).stderr).toContain('(FIGYELEM: 1 uzenet all a(z) cimzett soraban, a legregebbi 10m ota')
  })

  it('prints hours for an old head (the measured 3h31m case)', async () => {
    postReply = ACCEPTED
    backlogReply = backlog([{ agent: 'cimzett', pending: 81, oldestAgeSeconds: 3 * 3600 + 31 * 60 }])
    expect((await send()).stderr).toContain('81 uzenet all a(z) cimzett soraban, a legregebbi 3h31m ota')
  })

  it('adds nothing when the receiver has no queue', async () => {
    postReply = ACCEPTED
    backlogReply = backlog([OTHER])
    const r = await send()
    expect(r.code).toBe(0)
    expect(r.stdout).toBe('OK id=41\n')
    expect(r.stderr).toBe('')
  })

  it("(c) says so when the backlog cannot be read -- the note's own failure is visible, the send still counts", async () => {
    postReply = ACCEPTED
    backlogReply = { status: 500, body: '{"error":"boom"}' }
    let r = await send()
    expect(r.code).toBe(0)
    expect(r.stdout).toBe('OK id=41\n')
    expect(r.stderr).toBe('OK id=41  QUEUE: [SORHOSSZ NEM MERHETO: /api/messages/backlog http=500]\n')

    backlogReply = { status: 200, body: 'not json' }
    r = await send()
    expect(r.code).toBe(0)
    expect(r.stdout).toBe('OK id=41\n')
    expect(r.stderr).toBe('OK id=41  QUEUE: [SORHOSSZ NEM MERHETO: a backlog valasza nem JSON]\n')
  })

  it('(b) a LOST message (#1334 warning) gets no queue note, and the backlog is not even asked', async () => {
    postReply = { status: 200, body: '{"id":41,"status":"pending","warning":"cimzett is not running;  the message is LOST"}' }
    backlogReply = backlog([{ agent: 'cimzett', pending: 2, oldestAgeSeconds: 185 }])
    const r = await send()
    expect(r.code).toBe(0)
    expect(r.stdout).toBe('OK id=41 (warning)\n')
    // Whitespace-collapsed, on stderr, exactly as #1334 prints it -- and nothing else.
    expect(r.stderr).toBe('OK id=41  WARNING: cimzett is not running; the message is LOST\n')
    expect(seen.map((s) => `${s.method} ${s.url}`)).toEqual(['POST /api/messages'])
  })

  it('(d) a backlog slower than 200 ms is cut off: no note, and curl hangs up long before the reply', async () => {
    postReply = ACCEPTED
    backlogReply = { ...backlog([{ agent: 'cimzett', pending: 81, oldestAgeSeconds: 12660 }]), delayMs: 1500 }
    const r = await send()
    expect(r.code).toBe(0)
    expect(r.stdout).toBe('OK id=41\n')
    expect(r.stderr).toBe('')
    // The stub held the reply for 1500 ms; the client left well before that (the 200 ms limit, with margin).
    expect(backlogAbortedAfterMs).not.toBeNull()
    expect(backlogAbortedAfterMs!).toBeLessThan(1000)
  })

  it('(d) CONTROL: a backlog that answers within the limit still gets its note (the cut-off does not eat normal replies)', async () => {
    postReply = ACCEPTED
    backlogReply = { ...backlog([{ agent: 'cimzett', pending: 2, oldestAgeSeconds: 185 }]), delayMs: 30 }
    const r = await send()
    expect(r.stderr).toBe('OK id=41  QUEUE: (sor: 2, legregebbi 3m)\n')
    expect(backlogAbortedAfterMs).toBeNull()
  })
})
