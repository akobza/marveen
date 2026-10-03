// Card b2cd0f43 (5), decision (c): with an invalid WEB_PORT and no --web-port the enroll CLI refuses BEFORE anything
// is written: no authorized_keys line, no bundle, a non-zero exit. With an explicit, valid --web-port it keeps the old
// behaviour. The CLI runs as a real process (tsx) on a sandboxed ssh dir (MARVEEN_SSH_DIR) and an empty .env dir
// (CLAUDECLAW_ENV_DIR), so nothing here touches the operator's ~/.ssh or the install's .env.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes, randomUUID } from 'node:crypto'
import { decodeBundle, HOST_KEY_PUB_CANDIDATES } from '../remote-enroll-core.js'

const ROOT = join(__dirname, '..', '..')
const TSX = join(ROOT, 'node_modules', '.bin', 'tsx')
const CLI = join(ROOT, 'scripts', 'remote-access-enroll.ts')
// The bundle step needs this machine's host key; without a key file the CLI stops there (after the key write), which
// is the CLI's own documented failure, not this card's. The bundle assertion is skipped visibly in that case.
const HOST_KEY_FILE = HOST_KEY_PUB_CANDIDATES.some((p) => existsSync(p))

function keyBlob(): string {
  const type = Buffer.from('ssh-ed25519', 'utf8')
  return Buffer.concat([
    Buffer.from([0, 0, 0, type.length]), type,
    Buffer.from([0, 0, 0, 32]), randomBytes(32),
  ]).toString('base64')
}

function deviceKey(): { line: string; installId: string } {
  const installId = randomUUID()
  return { line: `ssh-ed25519 ${keyBlob()} marveen-remote:${installId}`, installId }
}

// An unrelated line already in authorized_keys: the measurement is "unchanged bytes", not "no file".
const EXISTING = `ssh-ed25519 ${keyBlob()} existing@test\n`

let sshDir: string
let envDir: string

beforeEach(() => {
  sshDir = mkdtempSync(join(tmpdir(), 'enroll-refuse-ssh-'))
  envDir = mkdtempSync(join(tmpdir(), 'enroll-refuse-env-'))
  writeFileSync(join(sshDir, 'authorized_keys'), EXISTING, { mode: 0o600 })
})

afterEach(() => {
  rmSync(sshDir, { recursive: true, force: true })
  rmSync(envDir, { recursive: true, force: true })
})

function runCli(webPortEnv: string | undefined, args: string[]) {
  const env: NodeJS.ProcessEnv = { ...process.env, MARVEEN_SSH_DIR: sshDir, CLAUDECLAW_ENV_DIR: envDir }
  delete env.WEB_PORT
  delete env.WEB_HOST
  delete env.DASHBOARD_TOKEN
  if (webPortEnv !== undefined) env.WEB_PORT = webPortEnv
  const r = spawnSync(TSX, [CLI, ...args], { env, encoding: 'utf-8', timeout: 60_000 })
  return { status: r.status, stdout: r.stdout, stderr: r.stderr }
}

function authorizedKeys(): string {
  return readFileSync(join(sshDir, 'authorized_keys'), 'utf-8')
}

function linesFor(installId: string): string[] {
  return authorizedKeys().split('\n').filter((l) => l.includes(`marveen-remote:${installId}`))
}

describe('enroll CLI: an invalid WEB_PORT stops it before any write (b2cd0f43 (5), decision (c))', () => {
  it('invalid WEB_PORT, no --web-port: exit 1, no bundle, authorized_keys byte-identical, no new file', () => {
    const before = authorizedKeys()
    const filesBefore = readdirSync(sshDir).sort()
    const r = runCli('nope', [deviceKey().line])
    expect(r.status).toBe(1)
    expect(r.stdout).toBe('')
    expect(r.stderr).toMatch(/WEB_PORT is unusable/)
    expect(r.stderr).toMatch(/"nope"/)
    expect(r.stderr).toMatch(/--web-port/)
    expect(r.stderr).not.toMatch(/restricted entry/)
    expect(authorizedKeys()).toBe(before)
    expect(readdirSync(sshDir).sort()).toEqual(filesBefore)
  })

  it('invalid WEB_PORT, explicit valid --web-port: the old behaviour, the key line is written on that port', () => {
    const { line, installId } = deviceKey()
    const r = runCli('nope', ['--web-port', '39876', '--no-dashboard-token', line])
    expect(r.stderr).not.toMatch(/WEB_PORT is unusable/)
    expect(authorizedKeys().startsWith(EXISTING)).toBe(true)
    const added = linesFor(installId)
    expect(added).toHaveLength(1)
    expect(added[0]).toContain('permitopen="127.0.0.1:39876"')
  })

  it.skipIf(!HOST_KEY_FILE)('invalid WEB_PORT, explicit valid --web-port: exit 0 and the bundle carries that port', () => {
    const { line } = deviceKey()
    const r = runCli('nope', ['--web-port', '39876', '--no-dashboard-token', line])
    expect(r.status).toBe(0)
    const m = r.stdout.match(/----- BEGIN CONNECTION BUNDLE -----\n(.+)\n----- END CONNECTION BUNDLE -----\n/)
    expect(m).not.toBeNull()
    expect(decodeBundle(m![1]).remotePort).toBe(39876)
  })

  it('CONTROL: a valid WEB_PORT without --web-port is not refused (the gate fires on invalid only)', () => {
    const { line, installId } = deviceKey()
    const r = runCli('39876', ['--no-dashboard-token', line])
    expect(r.stderr).not.toMatch(/WEB_PORT is unusable/)
    const added = linesFor(installId)
    expect(added).toHaveLength(1)
    expect(added[0]).toContain('permitopen="127.0.0.1:39876"')
  })
})
