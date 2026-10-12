// MSGSENDKEY1012: a 'message-send' scoped device key for an out-of-process
// notifier (a public-facing service that only ever posts one kind of message).
// It is bound at mint time to ONE sender and ONE recipient: POST /api/messages
// with that pair works, any other sender or recipient is a 403 with nothing
// written, and the gate (message-send-gate.test.ts) keeps it off every other
// endpoint. Before this scope such a service had to hold the fleet's full token.
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { agentDir } from '../web/agent-config.js'
import { initDatabase, getDb, listAgentMessages } from '../db.js'
import { createDeviceKey, resolveDeviceKey, listDeviceKeys, _clearDeviceKeyCacheForTest } from '../web/auth-device-keys.js'
import { resolveAuth, requiresAuth, routeAuthOf } from '../web/auth-gate.js'
import { messageSendGateDecision } from '../web/message-send-gate.js'
import { operatorGateDecision } from '../web/operator-gate.js'
import { readOperatorAccess } from '../web/operator-access.js'
import { tryHandleMessages } from '../web/routes/messages.js'
import { tryHandleAuth } from '../web/routes/auth.js'
import { logger } from '../logger.js'
import type { RouteContext } from '../web/routes/types.js'
import { MAIN_AGENT_ID } from '../config.js'

// config.ts reads SYSTEM_SENDER_IDS from .env, which a test tree does not have: one entry for this
// file, so a system sender's binding is exercised (nothing else here uses that id).
vi.mock('../config.js', async (importOriginal) => ({ ...(await importOriginal<typeof import('../config.js')>()), SYSTEM_SENDER_IDS: 'msgkey-rendszer-1012' }))
const SYSTEM_SENDER = 'msgkey-rendszer-1012'

type Auth = RouteContext['auth']

// Real, known fleet agents (an agents/<id>/ directory each), so a refusal below
// is the binding's and never the unknown-sender or unknown-recipient rule's.
const SENDER = 'msgkey-kuldo-1012'
const RECIPIENT = 'msgkey-cimzett-1012'
const OTHER = 'msgkey-masik-1012'

beforeAll(() => {
  process.env.NODE_ENV = 'test'
  initDatabase(':memory:')
  for (const a of [SENDER, RECIPIENT, OTHER]) mkdirSync(agentDir(a), { recursive: true })
})
afterAll(() => {
  for (const a of [SENDER, RECIPIENT, OTHER]) rmSync(agentDir(a), { recursive: true, force: true })
})
beforeEach(() => { _clearDeviceKeyCacheForTest() })

const rowCount = () => listAgentMessages(10_000).length

function messagesCtx(body: unknown, auth: Auth): { ctx: RouteContext; res: { statusCode: number; body: string } } {
  const req = new EventEmitter() as unknown as RouteContext['req'] & { destroy(): void }
  ;(req as unknown as { headers: Record<string, string> }).headers = {}
  ;(req as { destroy(): void }).destroy = () => { /* readBody over-limit hook */ }
  const state = { statusCode: 0, body: '' }
  const res = {
    writeHead(code: number) { state.statusCode = code; return res },
    end(data?: unknown) { state.body = String(data ?? '') },
    setHeader() { /* not used by json() */ },
    getHeader() { return undefined },
  } as unknown as RouteContext['res']
  process.nextTick(() => {
    ;(req as unknown as EventEmitter).emit('data', Buffer.from(JSON.stringify(body)))
    ;(req as unknown as EventEmitter).emit('end')
  })
  return { ctx: { req, res, path: '/api/messages', method: 'POST', url: new URL('http://localhost/api/messages'), fedPeer: null, auth } as RouteContext, res: state }
}

async function post(body: unknown, auth: Auth): Promise<{ statusCode: number; json: Record<string, unknown> }> {
  const { ctx, res } = messagesCtx(body, auth)
  expect(await tryHandleMessages(ctx)).toBe(true)
  return { statusCode: res.statusCode, json: JSON.parse(res.body) }
}

function authCtx(method: string, path: string, body: unknown, auth: Auth) {
  const out: { status: number; body: any } = { status: 0, body: null }
  const res: any = { setHeader() { return res }, writeHead(s: number) { out.status = s; return res }, end(c?: string) { if (c) out.body = JSON.parse(c) } }
  const req: any = Readable.from([Buffer.from(body === undefined ? '' : JSON.stringify(body))])
  req.headers = { 'content-type': 'application/json' }
  return { ctx: { req, res, path, method, url: new URL(`http://localhost${path}`), auth } as RouteContext, out }
}

const BOUND: Auth = { kind: 'device', device: 'belepo', deviceId: 1, scope: 'message-send', messageFrom: SENDER, messageTo: RECIPIENT } as Auth

describe('message-send device keys', () => {
  it('a message-send key is minted with its sender and recipient, and both travel from the stored row', () => {
    const k = createDeviceKey('belepo', { scope: 'message-send', messageFrom: SENDER, messageTo: RECIPIENT })
    expect(k).toMatchObject({ scope: 'message-send', messageFrom: SENDER, messageTo: RECIPIENT })
    _clearDeviceKeyCacheForTest() // force the DB path
    expect(resolveDeviceKey(k.key)).toMatchObject({ scope: 'message-send', messageFrom: SENDER, messageTo: RECIPIENT })
    expect(listDeviceKeys().find(x => x.id === k.id)).toMatchObject({ scope: 'message-send', messageFrom: SENDER, messageTo: RECIPIENT })
  })

  it('a message-send key cannot be minted without its recipient or its sender', () => {
    expect(() => createDeviceKey('belepo', { scope: 'message-send', messageFrom: SENDER })).toThrow(/recipient/)
    expect(() => createDeviceKey('belepo', { scope: 'message-send', messageFrom: SENDER, messageTo: '' })).toThrow(/recipient/)
    expect(() => createDeviceKey('belepo', { scope: 'message-send', messageTo: RECIPIENT })).toThrow(/sender/)
  })

  it('a binding belongs to a message-send key only: a full or operator key with one is refused', () => {
    expect(() => createDeviceKey('phone', { messageTo: RECIPIENT })).toThrow(/message-send/)
    expect(() => createDeviceKey('phone', { messageFrom: SENDER })).toThrow(/message-send/)
    expect(() => createDeviceKey('it-op', { scope: 'operator', expiresInDays: 30, messageTo: RECIPIENT })).toThrow(/message-send/)
  })

  it('a key without a binding keeps exactly its old shape (no binding fields at all)', () => {
    const k = createDeviceKey('phone')
    _clearDeviceKeyCacheForTest()
    // toStrictEqual: a binding field present with an undefined value is a changed shape too.
    expect(resolveDeviceKey(k.key)).toStrictEqual({ id: k.id, name: 'phone', scope: 'full' })
    const listed = listDeviceKeys().find(r => r.id === k.id)!
    for (const shape of [k, listed]) {
      expect(Object.keys(shape)).not.toContain('messageTo')
      expect(Object.keys(shape)).not.toContain('messageFrom')
    }
  })

  it('the bearer resolves to the scope and both bindings', () => {
    const k = createDeviceKey('belepo', { scope: 'message-send', messageFrom: SENDER, messageTo: RECIPIENT })
    _clearDeviceKeyCacheForTest()
    const req: any = { headers: { authorization: `Bearer ${k.key}` } }
    const auth = resolveAuth(req, new URL('http://x/api/messages'), '/api/messages', 'POST', 'a'.repeat(64))
    expect(auth).toMatchObject({ kind: 'device', scope: 'message-send', messageFrom: SENDER, messageTo: RECIPIENT })
  })

  it('an unexpected stored scope still reads as operator (fail closed); only the literals are themselves', () => {
    const k = createDeviceKey('odd')
    getDb().prepare("UPDATE device_keys SET scope = 'MESSAGE-SEND' WHERE id = ?").run(k.id)
    _clearDeviceKeyCacheForTest()
    expect(resolveDeviceKey(k.key)?.scope).toBe('operator')
  })
})

describe('POST /api/auth/device-keys with scope message-send', () => {
  const owner = { kind: 'token' } as Auth
  const mint = async (body: unknown) => {
    const { ctx, out } = authCtx('POST', '/api/auth/device-keys', body, owner)
    await tryHandleAuth(ctx)
    return out
  }

  it('without message_to or message_from: 400, and the error names the missing field (not a scope refusal)', async () => {
    const noTo = await mint({ name: 'belepo', scope: 'message-send', message_from: SENDER })
    expect(noTo.status).toBe(400)
    expect(String(noTo.body.error)).toMatch(/message_to/)
    const noFrom = await mint({ name: 'belepo', scope: 'message-send', message_to: RECIPIENT })
    expect(noFrom.status).toBe(400)
    expect(String(noFrom.body.error)).toMatch(/message_from/)
  })

  it('an unknown recipient, a near-miss of a known one, or a federated address: 400 on message_to', async () => {
    for (const to of ['nincs-ilyen-ugynok-1012', `${RECIPIENT}.`, 'peer/agent']) {
      const out = await mint({ name: 'belepo', scope: 'message-send', message_from: SENDER, message_to: to })
      expect(out.status, to).toBe(400)
      expect(String(out.body.error), to).toMatch(/message_to/)
    }
  })

  it('an unknown sender, a near-miss of a known one, or a federated address: 400 on message_from', async () => {
    for (const from of ['nincs-ilyen-kuldo-1012', `${SENDER}.`, 'peer/agent']) {
      const out = await mint({ name: 'belepo', scope: 'message-send', message_from: from, message_to: RECIPIENT })
      expect(out.status, from).toBe(400)
      expect(String(out.body.error), from).toMatch(/message_from/)
    }
  })

  it('a channel-framing id is refused as sender and as recipient even when it names a real agents/ directory', async () => {
    // The directories make both ids "known agents", so only the channel-framing rule can refuse them here.
    const framing = ['telegram-coordinator', 'hanna']
    for (const id of framing) mkdirSync(agentDir(id), { recursive: true })
    try {
      for (const id of framing) {
        const asFrom = await mint({ name: 'belepo', scope: 'message-send', message_from: id, message_to: RECIPIENT })
        expect(asFrom.status, id).toBe(400)
        expect(String(asFrom.body.error), id).toMatch(/message_from/)
        const asTo = await mint({ name: 'belepo', scope: 'message-send', message_from: SENDER, message_to: id })
        expect(asTo.status, id).toBe(400)
        expect(String(asTo.body.error), id).toMatch(/message_to/)
      }
    } finally {
      for (const id of framing) rmSync(agentDir(id), { recursive: true, force: true })
    }
  })

  it('a nested path under a real agent directory is refused: isKnownAgent alone would accept it, exactness does not', async () => {
    mkdirSync(join(agentDir(SENDER), 'sub'), { recursive: true })
    mkdirSync(join(agentDir(RECIPIENT), 'sub'), { recursive: true })
    const asTo = await mint({ name: 'belepo', scope: 'message-send', message_from: SENDER, message_to: `${RECIPIENT}/sub` })
    expect(asTo.status).toBe(400)
    expect(String(asTo.body.error)).toMatch(/message_to/)
    const asFrom = await mint({ name: 'belepo', scope: 'message-send', message_from: `${SENDER}/sub`, message_to: RECIPIENT })
    expect(asFrom.status).toBe(400)
    expect(String(asFrom.body.error)).toMatch(/message_from/)
  })

  it('the main agent may be the bound recipient', async () => {
    const out = await mint({ name: 'belepo', scope: 'message-send', message_from: SENDER, message_to: MAIN_AGENT_ID })
    expect(out.status).toBe(201)
    expect(out.body).toMatchObject({ message_from: SENDER, message_to: MAIN_AGENT_ID })
  })

  it('a SYSTEM_SENDER_IDS entry may be the bound sender (no agents/ directory needed), never the bound recipient', async () => {
    const asFrom = await mint({ name: 'belepo', scope: 'message-send', message_from: SYSTEM_SENDER, message_to: RECIPIENT })
    expect(asFrom.status).toBe(201)
    expect(asFrom.body).toMatchObject({ message_from: SYSTEM_SENDER, message_to: RECIPIENT })
    const asTo = await mint({ name: 'belepo', scope: 'message-send', message_from: SENDER, message_to: SYSTEM_SENDER })
    expect(asTo.status).toBe(400)
    expect(String(asTo.body.error)).toMatch(/message_to/)
  })

  it('a known pair: 201, the response names both, and the key resolves to them', async () => {
    const out = await mint({ name: 'belepo', scope: 'message-send', message_from: SENDER, message_to: RECIPIENT })
    expect(out.status).toBe(201)
    expect(out.body).toMatchObject({ scope: 'message-send', message_from: SENDER, message_to: RECIPIENT })
    _clearDeviceKeyCacheForTest()
    expect(resolveDeviceKey(out.body.key)).toMatchObject({ scope: 'message-send', messageFrom: SENDER, messageTo: RECIPIENT })
  })

  it('message_to or message_from on a full or an operator key: 400', async () => {
    expect((await mint({ name: 'phone', message_to: RECIPIENT })).status).toBe(400)
    expect((await mint({ name: 'phone', message_from: SENDER })).status).toBe(400)
    expect((await mint({ name: 'it-op', scope: 'operator', message_to: RECIPIENT })).status).toBe(400)
  })
})

describe('POST /api/messages with a message-send key', () => {
  it('the bound pair: written, the row carries it, and the log names the key (name and id, never the secret)', async () => {
    const info = vi.spyOn(logger, 'info')
    const before = rowCount()
    const r = await post({ from: SENDER, to: RECIPIENT, content: 'uj bemutato-link kerese' }, BOUND)
    expect(r.statusCode).toBe(200)
    expect(typeof r.json.id).toBe('number')
    expect(r.json).toMatchObject({ from_agent: SENDER, to_agent: RECIPIENT })
    expect(rowCount()).toBe(before + 1)
    const keyLine = info.mock.calls.find(c => c[1] === 'Agent message created by a message-send key')
    expect(keyLine?.[0]).toMatchObject({ id: r.json.id, device: 'belepo', deviceId: 1 })
    info.mockRestore()
  })

  it('any other recipient: 403 and nothing is written', async () => {
    for (const to of [OTHER, `${RECIPIENT}.`, `x${RECIPIENT}`, 'peer/agent']) {
      const before = rowCount()
      const r = await post({ from: SENDER, to, content: 'masnak' }, BOUND)
      expect(r.statusCode, to).toBe(403)
      expect(rowCount(), to).toBe(before)
    }
  })

  it('any other sender: 403 and nothing is written', async () => {
    for (const from of [OTHER, `${SENDER}.`, ` ${SENDER}x`]) {
      const before = rowCount()
      const r = await post({ from, to: RECIPIENT, content: 'mas nevében' }, BOUND)
      expect(r.statusCode, from).toBe(403)
      expect(rowCount(), from).toBe(before)
    }
  })

  it('a message-send key whose stored row lacks either binding: 403 for every message', async () => {
    for (const auth of [{ ...BOUND, messageTo: null }, { ...BOUND, messageFrom: null }] as unknown as Auth[]) {
      const before = rowCount()
      const r = await post({ from: SENDER, to: RECIPIENT, content: 'kotes nelkul' }, auth)
      expect(r.statusCode).toBe(403)
      expect(rowCount()).toBe(before)
    }
  })

  it('urgent stays refused for it (only a listed full key may send one)', async () => {
    const before = rowCount()
    const r = await post({ from: SENDER, to: RECIPIENT, content: 'surgos', urgent: true }, BOUND)
    expect(r.statusCode).toBe(403)
    expect(rowCount()).toBe(before)
  })

  it('every other credential keeps writing to any recipient (unchanged)', async () => {
    for (const auth of [{ kind: 'token' }, { kind: 'device', device: 'phone', deviceId: 2, scope: 'full' }] as Auth[]) {
      const r = await post({ from: SENDER, to: OTHER, content: 'valtozatlan' }, auth)
      expect(r.statusCode, JSON.stringify(auth)).toBe(200)
    }
  })
})

// One request the way startWebServer takes it (resolveAuth, the 401, the operator gate, the
// message-send gate, routeAuthOf), then the message route: the binding proven from the Bearer
// header to the written row, not only from a hand-built principal.
async function throughServer(bearer: string, method: string, path: string, body: unknown): Promise<{ statusCode: number; json: Record<string, unknown> }> {
  const req = { headers: { authorization: `Bearer ${bearer}` } } as unknown as RouteContext['req']
  const auth = resolveAuth(req, new URL(`http://localhost${path}`), path, method, 'a'.repeat(64))
  if (requiresAuth(path, method) && auth.kind === 'none') return { statusCode: 401, json: {} }
  const denied = operatorGateDecision(auth, path, () => readOperatorAccess()) ?? messageSendGateDecision(auth, path, method)
  if (denied) return { statusCode: 403, json: { reason: denied } }
  return post(body, routeAuthOf(auth))
}

describe('one request through the server chain with a message-send Bearer key', () => {
  let key = ''
  beforeAll(() => {
    key = createDeviceKey('belepo-chain', { scope: 'message-send', messageFrom: SENDER, messageTo: RECIPIENT }).key
  })

  it('the bound pair: 200, and the row is written as that pair', async () => {
    const before = rowCount()
    const r = await throughServer(key, 'POST', '/api/messages', { from: SENDER, to: RECIPIENT, content: 'chain: bound pair' })
    expect(r.statusCode).toBe(200)
    expect(r.json).toMatchObject({ from_agent: SENDER, to_agent: RECIPIENT })
    expect(rowCount()).toBe(before + 1)
  })

  it('another sender or another recipient: 403, and nothing is written', async () => {
    for (const pair of [{ from: OTHER, to: RECIPIENT }, { from: SENDER, to: OTHER }]) {
      const before = rowCount()
      const r = await throughServer(key, 'POST', '/api/messages', { ...pair, content: 'chain: other pair' })
      expect(r.statusCode, JSON.stringify(pair)).toBe(403)
      expect(rowCount(), JSON.stringify(pair)).toBe(before)
    }
  })

  it('any other endpoint: 403 at the gate, before a handler runs', async () => {
    for (const [method, path] of [['GET', '/api/messages'], ['PUT', '/api/messages/1'], ['POST', '/api/kanban'], ['GET', '/api/memories'], ['POST', '/api/auth/device-keys']]) {
      const before = rowCount()
      const r = await throughServer(key, method!, path!, { from: SENDER, to: RECIPIENT, content: 'chain: other endpoint' })
      expect(r.statusCode, `${method} ${path}`).toBe(403)
      expect(r.json.reason, `${method} ${path}`).toBe('message-send credential: only POST /api/messages')
      expect(rowCount(), `${method} ${path}`).toBe(before)
    }
  })

  it('the SSE pane-stream lane resolves the key with its bindings too, and the gate refuses that path', () => {
    const path = `/api/agents/${RECIPIENT}/pane/stream`
    const req = { headers: {} } as unknown as RouteContext['req']
    const auth = resolveAuth(req, new URL(`http://localhost${path}?token=${key}`), path, 'GET', 'a'.repeat(64))
    expect(auth).toMatchObject({ kind: 'device', scope: 'message-send', messageFrom: SENDER, messageTo: RECIPIENT })
    expect(messageSendGateDecision(auth, path, 'GET')).not.toBeNull()
  })

  it('a key bound to a SYSTEM_SENDER_IDS sender writes as it: 200', async () => {
    const sys = createDeviceKey('belepo-chain-sys', { scope: 'message-send', messageFrom: SYSTEM_SENDER, messageTo: RECIPIENT }).key
    const before = rowCount()
    const r = await throughServer(sys, 'POST', '/api/messages', { from: SYSTEM_SENDER, to: RECIPIENT, content: 'chain: system sender' })
    expect(r.statusCode).toBe(200)
    expect(r.json).toMatchObject({ from_agent: SYSTEM_SENDER, to_agent: RECIPIENT })
    expect(rowCount()).toBe(before + 1)
  })

  it('routeAuthOf hands the route both bindings of a message-send key', () => {
    const req = { headers: { authorization: `Bearer ${key}` } } as unknown as RouteContext['req']
    const auth = resolveAuth(req, new URL('http://localhost/api/messages'), '/api/messages', 'POST', 'a'.repeat(64))
    expect(routeAuthOf(auth)).toMatchObject({ kind: 'device', scope: 'message-send', messageFrom: SENDER, messageTo: RECIPIENT })
  })
})
