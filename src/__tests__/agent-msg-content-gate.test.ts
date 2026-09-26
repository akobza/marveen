import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { execFile } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SECRET_PATTERNS } from '../security/secret-gate.js'

// Card d49acca6. On 2026-09-05 a double-quoted message body with a backtick in
// it did not lose a word: the CALLER's shell ran the command and pasted its
// output into the message -- 38 420 characters, a work-tree diff and a settings
// file, into the durable queue. scripts/agent-msg.sh cannot see the expansion
// (it happens before the script runs), but it can see the result, and now
// checks it: a long body on argv is refused, a secret-shaped value is refused,
// command output warns. The REAL script runs against a stub server; a refused
// send must not reach the server at all.
//
// The card's own condition comes first: a deliberately broken send that the
// control makes FAIL. Green on the good sends counts only after that.

const SCRIPT = fileURLToPath(new URL('../../scripts/agent-msg.sh', import.meta.url))
const TOKEN = 'content-gate-test-token-d49acca6'

const posts: string[] = []
let server: Server
let apiBase = ''
let dir = ''
let tokenFile = ''

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = ''
    req.on('data', (d) => { body += d })
    req.on('end', () => {
      if (req.method === 'POST' && req.url === '/api/messages') {
        posts.push(body)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end('{"id":77,"status":"pending"}')
        return
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end('[]')
    })
  })
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', () => ok()))
  apiBase = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  dir = mkdtempSync(join(tmpdir(), 'agentmsg-gate-'))
  tokenFile = join(dir, 'token')
  writeFileSync(tokenFile, TOKEN)
})

afterAll(() => new Promise<void>((ok) => server.close(() => ok())))

type Run = { code: number; stdout: string; stderr: string; posted: number }
const env = () => ({ ...process.env, MARVEEN_API_BASE: apiBase, MARVEEN_TOKEN_FILE: tokenFile, MARVEEN_WEB_PORT: '1' })

// execFile, not execFileSync: the stub answers from THIS process's event loop.
function run(file: string, args: string[], stdin?: string): Promise<Run> {
  const before = posts.length
  return new Promise((ok) => {
    const child = execFile(file, args, { env: env(), timeout: 30000, maxBuffer: 1 << 24 }, (err, stdout, stderr) =>
      ok({ code: err ? Number(err.code ?? -1) : 0, stdout, stderr, posted: posts.length - before }))
    if (stdin !== undefined) child.stdin!.end(stdin)
  })
}
const sendArgv = (body: string) => run('bash', [SCRIPT, 'kuldo', 'cimzett', body])
const sendStdin = (body: string) => run('bash', [SCRIPT, 'kuldo', 'cimzett', '-'], body)

// A work-tree diff, the kind of output the 2026-09-05 expansion pasted in.
function bigDiff(): string {
  const head = 'diff --git a/src/x.ts b/src/x.ts\nindex 1234567..89abcde 100644\n--- a/src/x.ts\n+++ b/src/x.ts\n@@ -1,3 +1,3 @@\n'
  return head + Array.from({ length: 400 }, (_, i) => `+const line${i} = ${i} // work-tree change`).join('\n')
}

describe('the deliberately broken send is refused (the 2026-09-05 shape)', () => {
  it("a caller's double-quoted $(...) expands into a huge argv body: REFUSED, exit 2, nothing sent", async () => {
    const diffFile = join(dir, 'worktree.diff')
    writeFileSync(diffFile, bigDiff())
    // The caller's shell does the damage, exactly as it happened: the body is
    // double-quoted, so $(cat ...) runs BEFORE agent-msg.sh starts.
    const r = await run('bash', ['-c', 'bash "$0" kuldo cimzett "Jelentes a kartyarol: $(cat "$1")"', SCRIPT, diffFile])
    expect(r.code).toBe(2)
    expect(r.stdout).toContain('REFUSED:')
    expect(r.stdout).toMatch(/\d+ characters on the command line \(limit 8000\)/)
    expect(r.stdout).toContain('nothing was sent')
    // and it says what the shell pasted in -- without claiming it was sent
    expect(r.stderr).toContain('WARNING: the body carries command output (a hunk header)')
    expect(r.stderr).not.toContain('sent anyway')
    expect(r.posted).toBe(0)
  })
})

describe('a long body belongs on STDIN, not on argv', () => {
  it('argv at the limit is sent, one character over is refused', async () => {
    const ok = await sendArgv('a'.repeat(8000))
    expect(ok.code).toBe(0)
    expect(ok.stdout).toBe('OK id=77\n')
    expect(ok.posted).toBe(1)

    const over = await sendArgv('a'.repeat(8001))
    expect(over.code).toBe(2)
    expect(over.stdout).toContain('8001 characters on the command line')
    expect(over.posted).toBe(0)
  })

  it('POZITÍV KONTROLL: the same long body from STDIN goes through', async () => {
    const r = await sendStdin('a'.repeat(20000))
    expect(r.code).toBe(0)
    expect(r.posted).toBe(1)
  })
})

// Built at run time: a literal secret shape in this file would trip the commit
// gate this list mirrors.
const SAMPLES: Record<string, string> = {
  'private key block': '-----BEGIN ' + 'RSA PRIVATE KEY-----',
  'Stripe secret/restricted key': 'sk' + '_live_' + 'a1B2'.repeat(5),
  'ElevenLabs key header': 'xi-api-key' + ': ' + 'abcd'.repeat(5),
  'ElevenLabs key literal': 'sk' + '_' + 'ab12'.repeat(9),
  'bearer token literal': 'Bearer' + ' ' + 'x1Y2'.repeat(8),
  'JWT': 'ey' + 'J' + 'a'.repeat(10) + '.ey' + 'J' + 'b'.repeat(20) + '.' + 'c'.repeat(20),
  'GitHub token': 'gh' + 'p_' + 'A1b2'.repeat(9),
  'Slack token': 'xo' + 'xb-' + '1234567890ab',
  'OpenAI project key': 'sk' + '-proj-' + 'Ab12'.repeat(6),
  'generic vendor secret key (sk_ or sk-)': 'sk' + '-' + 'q'.repeat(30),
  'AWS access key id': 'AK' + 'IA' + 'ABCDEFGH12345678',
  'Supabase service_role JWT hint': 'service_role' + '": "' + 'ey' + 'J',
  'Supabase personal access token': 'sb' + 'p_' + 'a1'.repeat(20),
}

describe('a secret-shaped value is refused: the shapes of src/security/secret-gate.ts', () => {
  it('every canonical pattern has a sample here, and every sample is one of its shapes', () => {
    // A pattern added to the commit gate without a sample here turns this red,
    // which is what keeps the two lists from drifting apart.
    expect(Object.keys(SAMPLES).sort()).toEqual(SECRET_PATTERNS.map((p) => p.name).sort())
    for (const { name, pattern } of SECRET_PATTERNS) expect(pattern.test(SAMPLES[name]), name).toBe(true)
  })

  it('agent-msg.sh refuses each of them, names the shape, and sends nothing', async () => {
    for (const [name, sample] of Object.entries(SAMPLES)) {
      const r = await sendStdin(`Rovid uzenet, benne: ${sample} -- ennyi.`)
      expect(r.code, name).toBe(2)
      expect(r.stdout, name).toContain(`(${name})`)
      expect(r.posted, name).toBe(0)
    }
  })

  it("the dashboard token's own value is refused", async () => {
    const r = await sendStdin(`a token: ${TOKEN}`)
    expect(r.code).toBe(2)
    expect(r.stdout).toContain("the dashboard token's value")
    expect(r.posted).toBe(0)
  })
})

describe('KONTROLL: the legitimate shapes measured in the queue still go through, silently', () => {
  it('commit SHAs, sha256 hashes, SSH fingerprints and public keys, timestamped paths, a curl recipe', async () => {
    const legit = [
      'merge: 1e8d4b4d0f2a9c3b7e6d5a4f3e2d1c0b9a8f7e6d',
      'BE: 5a8b3b9f20421d95' + 'c'.repeat(48),
      'ujjlenyomat: SHA256:' + 'Ab1/Cd2+Ef3G'.repeat(3) + 'Hi4Jk5L',
      'ssh-ed25519 ' + 'AAAAC3NzaC1lZDI1NTE5AAAAI' + 'Qm9ub3Jhc3RvcmVkUHVibGljS2V5' + ' teszt@gep',
      'fajl: top-gyartok-20260915T201500Z/app/dashboard/top-gyartok-panel.tsx',
      'curl -H "Authorization: Bearer $(cat store/.dashboard-token)" http://localhost:3420/api/kanban',
    ]
    for (const body of legit) {
      const r = await sendStdin(body)
      expect(r.code, body).toBe(0)
      expect(r.posted, body).toBe(1)
      expect(r.stderr, body).toBe('')
    }
  })
})

describe('command output warns but is sent: a message may quote a diff on purpose', () => {
  it('a quoted diff goes through with a WARNING on stderr', async () => {
    const r = await sendStdin('A javitas diffje:\n' + bigDiff().split('\n').slice(0, 8).join('\n'))
    expect(r.code).toBe(0)
    expect(r.posted).toBe(1)
    expect(r.stdout).toBe('OK id=77\n')
    expect(r.stderr).toContain('WARNING: the body carries command output (a diff header); sent anyway')
    expect(r.stderr).toContain('(a hunk header)')
    expect(r.stderr).toContain('(an index line)')
  })
})
