// MSGSENDKEY1012: a 'message-send' scoped device key reaches POST /api/messages
// and nothing else, decided before any handler (the operator gate's pattern).
// The recipient binding itself is checked in the route (message-send-scope.test.ts).
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { messageSendGateDecision } from '../web/message-send-gate.js'

// Every /api path the server handles, enumerated from the source (not a hand
// list), the same scanner as operator-scope-gate.test.ts.
function enumerateApiPaths(): string[] {
  const root = join(__dirname, '..')
  const files = [join(root, 'web.ts'), ...readdirSync(join(root, 'web', 'routes')).filter(f => f.endsWith('.ts')).map(f => join(root, 'web', 'routes', f))]
  const out = new Set<string>()
  for (const f of files) {
    const src = readFileSync(f, 'utf-8')
    for (const m of src.matchAll(/'(\/api\/[A-Za-z0-9/_.-]*)'/g)) out.add(m[1]!)
    for (const m of src.matchAll(/\/\^(\\\/api\\\/[^\n]*?)\$\//g)) {
      const p = m[1]!
        .replace(/\([^)]*\)/g, 'x')
        .replace(/\[[^\]]*\][+*]?/g, 'x')
        .replace(/\\\//g, '/')
        .replace(/[?+*\\]/g, '')
      if (p.startsWith('/api/')) out.add(p)
    }
  }
  return [...out].sort()
}

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']
const sender = { kind: 'device', scope: 'message-send' }

describe('messageSendGateDecision over every enumerated /api path', () => {
  const paths = enumerateApiPaths()

  it('the enumeration is not trivially small (the scanner works)', () => {
    expect(paths.length).toBeGreaterThan(150)
    expect(paths).toContain('/api/messages')
    expect(paths).toContain('/api/auth/device-keys')
    expect(paths).toContain('/api/memories')
  })

  it('a message-send key is refused on every path and method except POST /api/messages', () => {
    const allowed: string[] = []
    for (const p of paths) {
      for (const m of METHODS) {
        if (messageSendGateDecision(sender, p, m) === null) allowed.push(`${m} ${p}`)
      }
    }
    expect(allowed).toEqual(['POST /api/messages'])
  })

  it('the neighbours of the one allowed route are outside it', () => {
    for (const [m, p] of [['GET', '/api/messages'], ['POST', '/api/messages/'], ['POST', '/api/messages/1'], ['PUT', '/api/messages/1'], ['POST', '/api/messagesx'], ['POST', '/api/auth/device-keys']]) {
      expect(messageSendGateDecision(sender, p!, m!), `${m} ${p}`).not.toBeNull()
    }
  })

  it('every other credential is untouched by this gate', () => {
    for (const auth of [{ kind: 'token' }, { kind: 'session' }, { kind: 'federation' }, { kind: 'none' }, { kind: 'device', scope: 'full' }, { kind: 'device', scope: 'operator' }]) {
      expect(messageSendGateDecision(auth, '/api/vault', 'GET'), JSON.stringify(auth)).toBeNull()
    }
  })
})

describe('the gate binding in web.ts', () => {
  const SRC = readFileSync(join(__dirname, '../web.ts'), 'utf-8')
  it('runs after the 401 check and before ANY handler (network-info and the route chain)', () => {
    const unauthorized = SRC.indexOf("res.end(JSON.stringify({ error: 'Unauthorized' }))")
    const gate = SRC.indexOf('messageSendGateDecision(auth, path, method)')
    const networkInfo = SRC.indexOf("if (path === '/api/network-info' && method === 'GET')")
    const firstHandler = SRC.indexOf('if (await tryHandleAuth(routeCtx)) return')
    expect(unauthorized).toBeGreaterThan(0)
    expect(gate).toBeGreaterThan(unauthorized)
    expect(gate).toBeLessThan(networkInfo)
    expect(gate).toBeLessThan(firstHandler)
    // Inside the same `if (requiresAuth(path, method)) {` block as the operator gate: no line closing that block
    // (four-space indent) stands between the block's opening and this call.
    const blockStart = SRC.lastIndexOf('if (requiresAuth(path, method)) {', gate)
    expect(blockStart).toBeGreaterThan(unauthorized)
    expect(SRC.slice(blockStart, gate)).not.toMatch(/\n    \}\n/)
  })
})
