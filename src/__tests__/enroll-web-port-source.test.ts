// Card bc3f8fb0 (b): the enroll CLI takes WEB_PORT in the dashboard's own order (process.env > config-overrides.json >
// .env > default), prints the port it writes into the key line and its source, and warns, with both values, when a
// shell export disagrees with the install's files: a dashboard started as a service does not inherit the operator's
// shell, so a stale export would put a dead port into the key line. First the pure decision (describeWebPortChoice),
// then the real CLI as a process (tsx) on a sandboxed ssh dir (MARVEEN_SSH_DIR) and a sandboxed install dir
// (CLAUDECLAW_ENV_DIR: its .env and, since bc3f8fb0, its store/config-overrides.json), so nothing here reads or
// writes the operator's ~/.ssh or the install's own files.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes, randomUUID } from 'node:crypto'
import { describeWebPortChoice } from '../remote-enroll-core.js'

const ROOT = join(__dirname, '..', '..')
const TSX = join(ROOT, 'node_modules', '.bin', 'tsx')
const CLI = join(ROOT, 'scripts', 'remote-access-enroll.ts')

describe('describeWebPortChoice: the port, its source, and a warning when a shell export disagrees', () => {
  const ENV = { value: '39876', source: '.env' }

  it('names every source the dashboard order can give, and --web-port when it was explicit', () => {
    const line = (source: string, explicit = false) =>
      describeWebPortChoice({ webPort: 39876, explicit, source, shellValue: undefined, install: ENV }).line
    expect(line('process.env')).toBe('dashboard port: 39876 (source: shell (exported WEB_PORT))')
    expect(line('config-overrides.json')).toBe('dashboard port: 39876 (source: config-overrides.json)')
    expect(line('.env')).toBe('dashboard port: 39876 (source: .env)')
    expect(line('default')).toBe('dashboard port: 39876 (source: default)')
    expect(line('process.env', true)).toBe('dashboard port: 39876 (source: --web-port)')
  })

  it('⛔ a shell export that differs from the install: the warning names both values, the file, and the way out', () => {
    const c = describeWebPortChoice({ webPort: 3421, explicit: false, source: 'process.env', shellValue: '3421', install: ENV })
    expect(c.warning).toMatch(/the shell exports WEB_PORT=3421, but this install's \.env says 39876/)
    expect(c.warning).toMatch(/this run uses 3421/)
    expect(c.warning).toMatch(/unset the export or pass --web-port 39876/)
    const ov = describeWebPortChoice({
      webPort: 3421, explicit: false, source: 'process.env', shellValue: '3421', install: { value: '3500', source: 'config-overrides.json' },
    })
    expect(ov.warning).toMatch(/this install's config-overrides\.json says 3500/)
  })

  it('⛔ files that set no WEB_PORT: the export is compared with the default the service takes', () => {
    const c = describeWebPortChoice({
      webPort: 3421, explicit: false, source: 'process.env', shellValue: '3421', install: { value: '3420', source: 'default' },
    })
    expect(c.warning).toMatch(/this install's files set no WEB_PORT, so the default 3420 applies/)
    expect(c.warning).toMatch(/pass --web-port 3420/)
  })

  it('no warning: the same port (also written with a leading zero), a whitespace-only export, an explicit --web-port', () => {
    const w = (shellValue: string | undefined, explicit = false) =>
      describeWebPortChoice({ webPort: 39876, explicit, source: explicit ? '.env' : 'process.env', shellValue, install: ENV }).warning
    expect(w('39876')).toBeUndefined()
    expect(w('039876')).toBeUndefined()
    expect(w('   ')).toBeUndefined()
    expect(w(undefined)).toBeUndefined()
    expect(w('3421', true)).toBeUndefined()
  })
})

function keyBlob(): string {
  const type = Buffer.from('ssh-ed25519', 'utf8')
  return Buffer.concat([
    Buffer.from([0, 0, 0, type.length]), type,
    Buffer.from([0, 0, 0, 32]), randomBytes(32),
  ]).toString('base64')
}

let sshDir: string
let installDir: string

beforeEach(() => {
  sshDir = mkdtempSync(join(tmpdir(), 'enroll-port-ssh-'))
  installDir = mkdtempSync(join(tmpdir(), 'enroll-port-install-'))
})

afterEach(() => {
  rmSync(sshDir, { recursive: true, force: true })
  rmSync(installDir, { recursive: true, force: true })
})

// One CLI run in the sandbox. The bundle step needs this machine's host key and may stop the CLI after the key write;
// these cases measure what happens before it (the printed lines and the written key line), so the exit is not asserted.
function runCli(o: { env?: string; override?: Record<string, unknown>; shell?: string; args?: string[] }) {
  writeFileSync(join(installDir, '.env'), o.env ?? '')
  if (o.override) {
    mkdirSync(join(installDir, 'store'), { recursive: true })
    writeFileSync(join(installDir, 'store', 'config-overrides.json'), JSON.stringify(o.override))
  }
  const env: NodeJS.ProcessEnv = { ...process.env, MARVEEN_SSH_DIR: sshDir, CLAUDECLAW_ENV_DIR: installDir }
  delete env.WEB_PORT
  delete env.WEB_HOST
  delete env.DASHBOARD_TOKEN
  if (o.shell !== undefined) env.WEB_PORT = o.shell
  const installId = randomUUID()
  const line = `ssh-ed25519 ${keyBlob()} marveen-remote:${installId}`
  const r = spawnSync(TSX, [CLI, ...(o.args ?? []), '--no-dashboard-token', line], { env, encoding: 'utf-8', timeout: 60_000 })
  let keys = ''
  try { keys = readFileSync(join(sshDir, 'authorized_keys'), 'utf-8') } catch { /* nothing written */ }
  return { stderr: r.stderr, written: keys.split('\n').filter((l) => l.includes(`marveen-remote:${installId}`)) }
}

describe('enroll CLI: the printed port and source, and the shell-export warning (bc3f8fb0 (b))', () => {
  it('⛔ a stale shell export: the run names the port and the shell as its source, and warns with both values BEFORE the write', () => {
    const r = runCli({ env: 'WEB_PORT=39876\n', shell: '3421' })
    expect(r.stderr).toContain('dashboard port: 3421 (source: shell (exported WEB_PORT))')
    expect(r.stderr).toContain("warning: the shell exports WEB_PORT=3421, but this install's .env says 39876")
    // the sandbox notice is printed right before the authorized_keys write
    const sandboxNotice = r.stderr.indexOf('MARVEEN_SSH_DIR override active')
    expect(sandboxNotice).toBeGreaterThan(-1)
    expect(r.stderr.indexOf('dashboard port: 3421')).toBeLessThan(sandboxNotice)
    expect(r.stderr.indexOf('warning: the shell exports')).toBeLessThan(sandboxNotice)
    // the run keeps the dashboard's order (process.env wins); the warning is how the operator learns of it
    expect(r.written).toHaveLength(1)
    expect(r.written[0]).toContain('permitopen="127.0.0.1:3421"')
  })

  it('no export: the .env port, named as such, without a warning', () => {
    const r = runCli({ env: 'WEB_PORT=39876\n' })
    expect(r.stderr).toContain('dashboard port: 39876 (source: .env)')
    expect(r.stderr).not.toContain('warning: the shell exports')
    expect(r.written[0]).toContain('permitopen="127.0.0.1:39876"')
  })

  it('⛔ the override layer is named config-overrides.json, and it is the sandbox file, not the install\'s own', () => {
    const r = runCli({ env: 'WEB_PORT=39876\n', override: { WEB_PORT: '3500' } })
    expect(r.stderr).toContain('dashboard port: 3500 (source: config-overrides.json)')
    expect(r.written[0]).toContain('permitopen="127.0.0.1:3500"')
  })

  it('⛔ a whitespace-only override falls through to .env on the CLI path too (the same order as the dashboard, (a))', () => {
    const r = runCli({ env: 'WEB_PORT=39876\n', override: { WEB_PORT: '   ' } })
    expect(r.stderr).toContain('dashboard port: 39876 (source: .env)')
    expect(r.written[0]).toContain('permitopen="127.0.0.1:39876"')
  })

  it('an explicit --web-port is named as the source and needs no warning, whatever the shell exports', () => {
    const r = runCli({ env: 'WEB_PORT=39876\n', shell: '3421', args: ['--web-port', '4000'] })
    expect(r.stderr).toContain('dashboard port: 4000 (source: --web-port)')
    expect(r.stderr).not.toContain('warning: the shell exports')
    expect(r.written[0]).toContain('permitopen="127.0.0.1:4000"')
  })
})
