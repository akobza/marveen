// POST /api/messages logs WHERE a request came from, on every way out of the handler (card 4ab5252a).
//
// The shared bearer token lets any local process or tailnet peer send with any EXISTING agent's `from`: only
// an unknown name is refused. On 2026-09-20 a message arrived as from=ugyvezeto after two refused attempts as
// an unknown name, and the log could not say where either came from -- no address, no port on those lines.
// This pins the observation: each branch writes one line with the socket's address and port (plus what a
// proxy says, when it says it), and none of them carries the token or the message body. It also pins what the
// card forbids changing: every status and answer stays what develop gives today.
// Addresses are from the IPv6 documentation prefix (2001:db8::/32): they identify nothing, unlike a made-up
// address in the tailnet range, which could be a real peer's.

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { EventEmitter } from 'node:events'

type Line = { level: string; obj: Record<string, unknown>; msg: string }
const lines: Line[] = []
vi.mock('../logger.js', async (orig) => {
  const actual = await orig<Record<string, unknown>>()
  const record = (level: string) => (obj: unknown, msg?: unknown) => {
    if (obj && typeof obj === 'object') lines.push({ level, obj: obj as Record<string, unknown>, msg: String(msg ?? '') })
    else lines.push({ level, obj: {}, msg: String(obj ?? '') })
  }
  const fake: Record<string, unknown> = { info: record('info'), warn: record('warn'), error: record('error'), debug: record('debug') }
  fake.child = () => fake
  return { ...actual, logger: fake }
})

const { initDatabase } = await import('../db.js')
const { MAIN_AGENT_ID } = await import('../config.js')
const { COORDINATOR_AGENT_ID, VOICE_CHANNEL_AGENT_ID } = await import('../channel-coordinator/ingest.js')
const { SYSTEM_DIRECTIVE_SENDER } = await import('../web/system-directive.js')
const { tryHandleMessages } = await import('../web/routes/messages.js')
type Ctx = Parameters<typeof tryHandleMessages>[0]

const SECRET = 'bearer-token-that-must-not-be-logged'
const BODY_TEXT = 'body text that must not be logged'

function fakeCtx(raw: string, opts: { remote?: string; port?: number; headers?: Record<string, string> } = {}) {
  const req = new EventEmitter() as unknown as Ctx['req'] & { destroy(): void }
  ;(req as unknown as { headers: Record<string, string> }).headers = { authorization: `Bearer ${SECRET}`, ...(opts.headers ?? {}) }
  ;(req as unknown as { socket: { remoteAddress?: string; remotePort?: number } }).socket =
    { remoteAddress: opts.remote ?? '2001:db8::9', remotePort: opts.port ?? 51234 }
  ;(req as { destroy(): void }).destroy = () => {}
  const state = { statusCode: 0, body: '' }
  const res = {
    writeHead(code: number) { state.statusCode = code; return res },
    end(data?: unknown) { state.body = String(data ?? '') },
    setHeader() {},
  } as unknown as Ctx['res']
  process.nextTick(() => {
    ;(req as unknown as EventEmitter).emit('data', Buffer.from(raw))
    ;(req as unknown as EventEmitter).emit('end')
  })
  const path = '/api/messages'
  return { ctx: { req, res, path, method: 'POST', url: new URL(`http://localhost${path}`), fedPeer: null } as Ctx, state }
}

async function post(body: unknown, opts?: Parameters<typeof fakeCtx>[1]) {
  const { ctx, state } = fakeCtx(JSON.stringify(body), opts)
  expect(await tryHandleMessages(ctx)).toBe(true)
  return state
}

beforeAll(() => {
  process.env.NODE_ENV = 'test'
  initDatabase(':memory:')
})
beforeEach(() => { lines.length = 0 })

// Every branch of the handler, with the status develop gives it today.
const CASES: Array<[string, Record<string, unknown>, number]> = [
  ['400 a missing field', { from: MAIN_AGENT_ID, to: MAIN_AGENT_ID, content: '' }, 400],
  ['403 a forged coordinator', { from: COORDINATOR_AGENT_ID, to: MAIN_AGENT_ID, content: BODY_TEXT }, 403],
  ['403 a forged system directive', { from: SYSTEM_DIRECTIVE_SENDER, to: MAIN_AGENT_ID, content: BODY_TEXT }, 403],
  ['403 the voice channel without a device key', { from: VOICE_CHANNEL_AGENT_ID, to: MAIN_AGENT_ID, content: BODY_TEXT }, 403],
  ['403 a qualified from', { from: 'peer/agent', to: MAIN_AGENT_ID, content: BODY_TEXT }, 403],
  ['403 an unregistered sender', { from: 'not-a-real-agent', to: MAIN_AGENT_ID, content: BODY_TEXT }, 403],
  ['400 an invalid federated address', { from: MAIN_AGENT_ID, to: 'x/', content: BODY_TEXT }, 400],
  ['400 federation disabled', { from: MAIN_AGENT_ID, to: 'peer/agent', content: BODY_TEXT }, 400],
  ['400 the federation:x:y source form', { from: MAIN_AGENT_ID, to: 'federation:x:y', content: BODY_TEXT }, 400],
  ['200 created', { from: MAIN_AGENT_ID, to: MAIN_AGENT_ID, content: BODY_TEXT }, 200],
]

describe('every branch keeps its status (the card forbids a behaviour change)', () => {
  for (const [name, body, status] of CASES) {
    it(name, async () => {
      expect((await post(body)).statusCode).toBe(status)
    })
  }
})

// The answer body of every refusal, byte for byte as develop gives it (the same file runs on develop as the
// control). The created answer carries an id and a time, so it is compared field by field.
const REFUSAL_BODY: Record<string, string> = {
  '400 a missing field': '{"error":"from, to, and content are required"}',
  '403 a forged coordinator': '{"error":"from is reserved for the in-process channel coordinator"}',
  '403 a forged system directive': `{"error":"from '${SYSTEM_DIRECTIVE_SENDER}' is reserved for in-process system directives and can never be POSTed"}`,
  '403 the voice channel without a device key': `{"error":"from '${VOICE_CHANNEL_AGENT_ID}' requires an enrolled device key, not the shared dashboard token"}`,
  '403 a qualified from': '{"error":"from must be a local agent id without \\"/\\" -- federated senders are only accepted via /api/federation/inbox"}',
  '403 an unregistered sender': `{"error":"unknown agent 'not-a-real-agent' -- from must be a registered fleet agent id"}`,
  '400 an invalid federated address': '{"error":"Invalid federated address in to (expected \\"<system>/<agent>\\")"}',
  '400 federation disabled': '{"error":"Federation is disabled on this system"}',
  '400 the federation:x:y source form': '{"error":"Invalid recipient: use \\"<system>/<agent>\\" (slash) for a federated address, not the \\"federation:x:y\\" source form"}',
}

describe('every answer stays what develop gives (measured, not claimed)', () => {
  for (const [name, body] of CASES) {
    it(name, async () => {
      const r = await post(body)
      if (name in REFUSAL_BODY) {
        expect(r.body).toBe(REFUSAL_BODY[name])
      } else {
        expect(JSON.parse(r.body)).toMatchObject({ from_agent: MAIN_AGENT_ID, to_agent: MAIN_AGENT_ID, content: BODY_TEXT, status: 'pending' })
      }
    })
  }
})

describe('every branch writes a line with the client address and port', () => {
  for (const [name, body] of CASES) {
    it(name, async () => {
      await post(body, { remote: '2001:db8::9', port: 51234 })
      const mine = lines.filter((l) => l.obj.remote === '2001:db8::9' && l.obj.remotePort === 51234)
      expect(mine.length).toBeGreaterThanOrEqual(1)
    })
  }

  it('a body that is not JSON: logged with the address, and the error still goes up unchanged (the 500 stays)', async () => {
    const { ctx } = fakeCtx('{not json', { remote: '2001:db8::10', port: 40000 })
    await expect(tryHandleMessages(ctx)).rejects.toThrow(SyntaxError)
    expect(lines.some((l) => l.obj.remote === '2001:db8::10' && l.obj.remotePort === 40000)).toBe(true)
  })
})

describe('what a proxy in front says is logged when present, and only then', () => {
  it('X-Forwarded-For and the tailscale identity header', async () => {
    await post({ from: MAIN_AGENT_ID, to: MAIN_AGENT_ID, content: BODY_TEXT }, {
      remote: '127.0.0.1', port: 40001,
      headers: { 'x-forwarded-for': '2001:db8::103', 'tailscale-user-login': 'someone@example.invalid' },
    })
    const l = lines.find((x) => x.msg === 'Agent message created')!
    expect(l.obj).toMatchObject({ remote: '127.0.0.1', remotePort: 40001, xff: '2001:db8::103', tailnetUser: 'someone@example.invalid' })
  })

  it('without a proxy, no empty xff / tailnetUser fields', async () => {
    await post({ from: MAIN_AGENT_ID, to: MAIN_AGENT_ID, content: BODY_TEXT })
    const l = lines.find((x) => x.msg === 'Agent message created')!
    expect('xff' in l.obj).toBe(false)
    expect('tailnetUser' in l.obj).toBe(false)
  })
})

describe('the observation never changes an answer', () => {
  it('a request object without headers (as some callers build it) still gets its answer and its line', async () => {
    const { ctx, state } = fakeCtx(JSON.stringify({ from: MAIN_AGENT_ID, to: MAIN_AGENT_ID, content: BODY_TEXT }), { remote: '2001:db8::11', port: 40002 })
    delete (ctx.req as unknown as { headers?: unknown }).headers
    expect(await tryHandleMessages(ctx)).toBe(true)
    expect(state.statusCode).toBe(200)
    expect(lines.some((l) => l.obj.remote === '2001:db8::11' && l.obj.remotePort === 40002)).toBe(true)
  })
})

describe('no line carries the token or the body', () => {
  it('across every branch', async () => {
    for (const [, body] of CASES) await post(body)
    const all = JSON.stringify(lines)
    expect(lines.length).toBeGreaterThanOrEqual(CASES.length)
    expect(all).not.toContain(SECRET)
    expect(all).not.toContain(BODY_TEXT)
  })
})
