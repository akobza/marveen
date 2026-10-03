// Card b2cd0f43: when WEB_PORT came from process.env, taking the port over must not stop a process that is
// not this install's dashboard. An inherited variable can name another node service's port, and both
// takeover paths (the boot-time port lock and the listen-time reclaim) stop own-UID node processes on the
// port without a project-root check. With the port from the environment, the boot stops loudly instead.
//
// Nothing here touches a real port: the port lock runs on a context that records every signal instead of
// sending it, and the listen-time reclaim is asserted at its source (it needs a real EADDRINUSE).

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { acquirePortLock, type ProcessLockContext } from '../process-lock.js'

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..')
const ROOT = '/test/install'
const PID = 424242

// A context with one port holder. `ownBinary` decides whether it is also this install's dashboard binary
// (matched by the binary pattern, running from this project root) or something else on the port.
function recordingCtx(signals: string[], ownBinary: boolean): ProcessLockContext {
  return {
    currentPid: process.pid,
    uid: 1000,
    selfProjectRoot: ROOT,
    listPortHolders: () => [PID],
    listOwnProcessesMatching: () => (ownBinary ? [PID] : []),
    getProcessCommand: () => 'node',
    getProcessUid: () => 1000,
    getProcessCwd: () => ROOT,
    signal: (pid, sig) => { signals.push(`${pid}:${sig}`); return 'gone' },
    sleep: async () => {},
    log: { info: () => {}, warn: () => {}, error: () => {} },
  }
}

const BINARY = /dist\/index\.js/

describe('the port lock refuses a foreign holder when asked to', () => {
  it('a holder that is not this install\'s dashboard: it throws, naming the pid and the reason, and sends no signal', async () => {
    const signals: string[] = []
    await expect(acquirePortLock(39876, recordingCtx(signals, false), {
      binaryPattern: BINARY, refuseForeignPortHolders: 'WEB_PORT came from process.env',
    })).rejects.toThrow(/held by pid\(s\) 424242.*not this install's dashboard.*WEB_PORT came from process\.env/)
    expect(signals).toEqual([])
  })

  it('this install\'s own dashboard on the port is still taken over (a restart must keep working)', async () => {
    const signals: string[] = []
    await acquirePortLock(39876, recordingCtx(signals, true), {
      binaryPattern: BINARY, refuseForeignPortHolders: 'WEB_PORT came from process.env',
      postKillDrainMs: 0,
    })
    expect(signals).toContain(`${PID}:SIGTERM`)
  })

  it('CONTROL: without the option the same foreign holder is stopped, as before (the refusal is the option\'s)', async () => {
    const signals: string[] = []
    await acquirePortLock(39876, recordingCtx(signals, false), { binaryPattern: BINARY, postKillDrainMs: 0 })
    expect(signals).toContain(`${PID}:SIGTERM`)
  })
})

describe('the dashboard asks for the refusal exactly when WEB_PORT came from process.env', () => {
  // Raw source on purpose: a block-comment stripper eats code in web.ts, where '/*' stands inside route
  // strings. The anchors below are code shapes (an `if (` condition, a call) that no comment repeats.
  const code = (file: string) => readFileSync(join(SRC, file), 'utf-8')

  it('index.ts: the boot-time port lock gets the option on the process.env source only', () => {
    const src = code('index.ts')
    const call = src.slice(src.indexOf('await acquirePortLock(WEB_PORT'))
    const args = call.slice(0, call.indexOf('})') + 2)
    expect(args).toMatch(/BOOT_KEY_SOURCES\.WEB_PORT === 'process\.env' \? \{ refuseForeignPortHolders: /)
  })

  it('web.ts: the listen-time reclaim exits on the process.env source BEFORE its kill loop', () => {
    const src = code('web.ts')
    const branch = src.slice(src.indexOf("if (err.code === 'EADDRINUSE')"))
    const check = branch.indexOf("if (BOOT_KEY_SOURCES.WEB_PORT === 'process.env')")
    const exit = branch.indexOf('process.exit(1)')
    const kill = branch.indexOf("process.kill(pid, 'SIGTERM')")
    expect(check).toBeGreaterThan(-1)
    expect(exit).toBeGreaterThan(check)
    expect(kill).toBeGreaterThan(exit)
  })
})
