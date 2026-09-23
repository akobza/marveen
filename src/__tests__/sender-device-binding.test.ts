// 32156973 -- the sender is proven by its device KEY, not by the from field.
//
// Measured 2026-09-23 (infra 31578/31617): /api/messages accepted from=cloud-bridge and
// from=codex-proxy on ANY credential, the shared dashboard token included, because both ids
// sit in SYSTEM_SENDER_IDS -- a list whose only job is to exempt an id from the known-agent
// check. Every sub-agent can read that token, so a "cloud-bridge" row proved nothing about the
// Cloud. The voice channel already had the answer (HANGCSATORNA918: the device-key lane); this
// makes it per sender, in both directions, and switchable sender by sender, because the gate
// may only go live for a sender whose client already holds a key of its own.

import { describe, it, expect, afterAll, vi } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Readable } from 'node:stream'
import { parseSenderDeviceKeys } from '../config.js'
import { senderDeviceKeyDenial } from '../web/sender-device-binding.js'
import { sanitizeAgentIdent } from '../prompt-safety.js'

type Auth = { kind: string; device?: string; deviceId?: number }
const TOKEN: Auth = { kind: 'token' }
const SESSION: Auth = { kind: 'session' }
const dev = (deviceId: number): Auth => ({ kind: 'device', device: `key-${deviceId}`, deviceId })

describe('parseSenderDeviceKeys', () => {
  it('binds nothing by default', () => {
    expect(parseSenderDeviceKeys(undefined, sanitizeAgentIdent).bindings.size).toBe(0)
    expect(parseSenderDeviceKeys('', sanitizeAgentIdent).bindings.size).toBe(0)
  })

  it('binds a sender to one or more keys, normalized like the route', () => {
    const { bindings, invalid } = parseSenderDeviceKeys(' cloud-bridge:5, @cloud-bridge.:9 ,codex-proxy:7', sanitizeAgentIdent)
    expect(invalid).toEqual([])
    expect([...bindings.keys()].sort()).toEqual(['cloud-bridge', 'codex-proxy'])
    expect([...bindings.get('cloud-bridge')!].sort()).toEqual([5, 9])
    expect([...bindings.get('codex-proxy')!]).toEqual([7])
  })

  it('reports a malformed entry instead of dropping it silently', () => {
    const { bindings, invalid } = parseSenderDeviceKeys('cloud-bridge,x:abc,:5,y:0,z:-1,ok:3', sanitizeAgentIdent)
    expect(invalid).toEqual(['cloud-bridge', 'x:abc', ':5', 'y:0', 'z:-1'])
    expect([...bindings.keys()]).toEqual(['ok'])
  })
})

describe('senderDeviceKeyDenial', () => {
  const B = parseSenderDeviceKeys('cloud-bridge:5', sanitizeAgentIdent).bindings

  it('refuses a bound sender on the shared token, a session, no credential and another device key', () => {
    for (const auth of [TOKEN, SESSION, undefined, dev(4)]) {
      expect(senderDeviceKeyDenial('cloud-bridge', auth, B), JSON.stringify(auth)).toMatch(/bound to its own device key/)
    }
  })

  it('lets a bound sender through on its own key', () => {
    expect(senderDeviceKeyDenial('cloud-bridge', dev(5), B)).toBeNull()
  })

  it('refuses a bound key writing as anyone else (the reverse direction)', () => {
    expect(senderDeviceKeyDenial('ugyvezeto', dev(5), B)).toMatch(/bound to 'cloud-bridge'/)
  })

  it('leaves an unbound sender and an unbound key exactly as they were', () => {
    expect(senderDeviceKeyDenial('codex-proxy', TOKEN, B)).toBeNull()
    expect(senderDeviceKeyDenial('ugyvezeto', dev(4), B)).toBeNull()
    expect(senderDeviceKeyDenial('ugyvezeto', TOKEN, B)).toBeNull()
  })
})

// ROUTE WIRING. The function above can be perfect while the route never calls it, or feeds it
// the wrong value; so these go through tryHandleMessages with a real install .env, the way the
// voice-channel test does. A POST that passes every guard runs on to the insert, which throws
// here (/prepare/: this harness has no DB) -- that throw is the proof of passage.
const savedEnvDir = process.env.CLAUDECLAW_ENV_DIR
afterAll(() => {
  if (savedEnvDir === undefined) delete process.env.CLAUDECLAW_ENV_DIR
  else process.env.CLAUDECLAW_ENV_DIR = savedEnvDir
  vi.resetModules()
})

async function loadWith(envText: string) {
  const dir = mkdtempSync(join(tmpdir(), 'sender-device-binding-'))
  writeFileSync(join(dir, '.env'), envText)
  process.env.CLAUDECLAW_ENV_DIR = dir
  vi.resetModules()
  const route = await import('../web/routes/messages.js')
  const config = await import('../config.js')
  return { handle: route.tryHandleMessages, mainAgent: config.MAIN_AGENT_ID }
}

async function postAs(handle: (ctx: any) => Promise<boolean>, from: string, auth?: Auth) {
  const payload = JSON.stringify({ from, to: 'marveen', content: 'teszt' })
  const req = Readable.from([Buffer.from(payload)]) as any
  let status = 0
  let body = ''
  const res = {
    writeHead(s: number) { status = s },
    end(b?: string) { body = b ?? '' },
  } as any
  const handled = await handle({ req, res, path: '/api/messages', method: 'POST', url: new URL('http://x/api/messages'), auth })
  expect(handled).toBe(true)
  return { status, body: body ? JSON.parse(body) : null }
}

const SENDERS = 'SYSTEM_SENDER_IDS=codex-proxy,cloud-bridge\n'

describe('the route, with only cloud-bridge bound (its bridge key exists, the proxy has none yet)', () => {
  it('refuses cloud-bridge on the shared token and on another device key', async () => {
    const { handle } = await loadWith(SENDERS + 'SENDER_DEVICE_KEYS=cloud-bridge:5\n')
    for (const auth of [TOKEN, dev(4)]) {
      const { status, body } = await postAs(handle, 'cloud-bridge', auth)
      expect(status, JSON.stringify(auth)).toBe(403)
      expect(String(body?.error)).toMatch(/bound to its own device key/)
    }
  })

  it('lets cloud-bridge through on its own key', async () => {
    const { handle } = await loadWith(SENDERS + 'SENDER_DEVICE_KEYS=cloud-bridge:5\n')
    await expect(postAs(handle, 'cloud-bridge', dev(5))).rejects.toThrow(/prepare/)
  })

  it('does NOT cut the codex channel: unbound codex-proxy still passes on the token', async () => {
    const { handle } = await loadWith(SENDERS + 'SENDER_DEVICE_KEYS=cloud-bridge:5\n')
    await expect(postAs(handle, 'codex-proxy', TOKEN)).rejects.toThrow(/prepare/)
  })

  it('refuses the bridge key speaking as the main agent; an unbound key still may (control)', async () => {
    const { handle, mainAgent } = await loadWith(SENDERS + 'SENDER_DEVICE_KEYS=cloud-bridge:5\n')
    const refused = await postAs(handle, mainAgent, dev(5))
    expect(refused.status).toBe(403)
    expect(String(refused.body?.error)).toMatch(/bound to 'cloud-bridge'/)
    await expect(postAs(handle, mainAgent, dev(4))).rejects.toThrow(/prepare/)
  })
})

describe('the route, once codex-proxy is bound too', () => {
  it('refuses the proxy while it still posts on the shared token -- loudly, which is why the binding waits for its own key', async () => {
    const { handle } = await loadWith(SENDERS + 'SENDER_DEVICE_KEYS=cloud-bridge:5,codex-proxy:7\n')
    const { status, body } = await postAs(handle, 'codex-proxy', TOKEN)
    expect(status).toBe(403)
    expect(String(body?.error)).toMatch(/codex-proxy.*bound to its own device key/)
    await expect(postAs(handle, 'codex-proxy', dev(7))).rejects.toThrow(/prepare/)
  })
})

describe('the default: nothing bound', () => {
  it('keeps today\'s behaviour -- cloud-bridge passes on the shared token (the gap this card closes when configured)', async () => {
    const { handle } = await loadWith(SENDERS)
    await expect(postAs(handle, 'cloud-bridge', TOKEN)).rejects.toThrow(/prepare/)
  })
})
