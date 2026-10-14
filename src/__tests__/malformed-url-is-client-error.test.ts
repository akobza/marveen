// card 218d76b8 (found by the tester during the ad37090b round): a malformed percent-encoding in a request's path made a
// route's decodeURIComponent throw URIError, and the dashboard's top-level catch answered 500 "Szerver hiba" and logged
// an error, for the caller's own mistake. The decision: 400, in one place, so every route
// behaves the same: the top-level catch (web.ts) classifies the error with isMalformedUrlError.
// A URIError on a WELL-FORMED URL is our own bug and stays a 500.
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { isMalformedUrlError } from '../web/malformed-body.js'

// The tester's reproduction: the skill segment ends in a broken three-byte sequence.
const BROKEN = '/api/agents/demo/skills/%E0%A4%A'

const thrown = (fn: () => unknown): unknown => {
  try { fn(); return null } catch (e) { return e }
}

describe('isMalformedUrlError', () => {
  it('a URIError from a URL that does not decode is the caller\'s mistake', () => {
    const err = thrown(() => decodeURIComponent('%E0%A4%A'))
    expect(err).toBeInstanceOf(URIError)
    expect(isMalformedUrlError(err, BROKEN)).toBe(true)
    expect(isMalformedUrlError(err, '/api/x?q=%ZZ')).toBe(true)
  })

  it('a URIError on a well-formed URL is our own bug, not the caller\'s', () => {
    const own = thrown(() => encodeURIComponent('\uD800'))
    expect(own).toBeInstanceOf(URIError)
    expect(isMalformedUrlError(own, '/api/agents/demo/skills/v1.2-notes')).toBe(false)
    expect(isMalformedUrlError(own, '/api/agents/demo/skills/%C3%A9kezet')).toBe(false)
  })

  it('another error on a broken URL is not reclassified', () => {
    expect(isMalformedUrlError(new TypeError('x is not a function'), BROKEN)).toBe(false)
    expect(isMalformedUrlError(new Error('boom'), BROKEN)).toBe(false)
    expect(isMalformedUrlError(undefined, BROKEN)).toBe(false)
  })
})

// The route the finding came from, driven on a sandbox home and agent folder (as agents-skills-dotdirs.test.ts).
let SANDBOX = ''
vi.mock('node:os', async (orig) => {
  const actual = await orig<typeof import('node:os')>()
  return { ...actual, homedir: () => join(SANDBOX, 'home') }
})
vi.mock('../web/agent-config.js', async (orig) => {
  const actual = await orig<typeof import('../web/agent-config.js')>()
  return { ...actual, agentDir: (name: string) => join(SANDBOX, 'agents', name) }
})
const { tryHandleAgentsSkills } = await import('../web/routes/agents-skills.js')

beforeAll(() => {
  SANDBOX = mkdtempSync(join(tmpdir(), 'malformed-url-'))
  mkdirSync(join(SANDBOX, 'agents', 'demo', '.claude', 'skills', 'mine'), { recursive: true })
  writeFileSync(join(SANDBOX, 'agents', 'demo', '.claude', 'skills', 'mine', 'SKILL.md'), '---\nname: mine\n---\n')
})
afterAll(() => { if (SANDBOX) rmSync(SANDBOX, { recursive: true, force: true }) })

describe('the skill DELETE with the tester\'s URL', () => {
  it('the route throws URIError, the top-level catch classifies it as a client error, nothing is deleted', async () => {
    let status = 0
    const res = { writeHead: (s: number) => { status = s }, end: () => {} }
    let err: unknown = null
    try {
      await tryHandleAgentsSkills({
        req: {} as never, res: res as never, path: BROKEN, method: 'DELETE', url: new URL(`http://localhost${BROKEN}`),
      } as never)
    } catch (e) { err = e }
    expect(err).toBeInstanceOf(URIError)
    expect(status).toBe(0)
    expect(isMalformedUrlError(err, BROKEN)).toBe(true)
    expect(existsSync(join(SANDBOX, 'agents', 'demo', '.claude', 'skills', 'mine', 'SKILL.md'))).toBe(true)
  })
})

describe('web.ts: the top-level catch answers 400 for it, before the 500 (source pin: the catch lives inside startWebServer)', () => {
  // line comments only, as the other web.ts pins do: a block-comment regex would start at the "/*" of a line comment
  // ("api/* + fleet") and cut out the whole route chain, the branch with it (measured while writing this test)
  const code = readFileSync(join(__dirname, '..', 'web.ts'), 'utf-8')
    .split('\n').filter(l => !l.trim().startsWith('//')).join('\n')
  const branch = code.indexOf('if (isMalformedUrlError(err, req.url || path)) {')
  const server500 = code.indexOf("json(res, { error: 'Szerver hiba' }, 500)")

  it('the branch exists, answers 400 and returns, and stands before the 500', () => {
    expect(branch).toBeGreaterThan(0)
    expect(server500).toBeGreaterThan(branch)
    const body = code.slice(branch, server500)
    expect(body).toMatch(/json\(res, \{ error: 'Hibas szazalek-kodolas az URL-ben[^']*' \}, 400\)/)
    expect(body).toMatch(/return\s*\n\s*\}/)
  })

  it('KONTROLL: the pin reads code, not a comment (a commented-out branch is not found)', () => {
    const commented = '// if (isMalformedUrlError(err, req.url || path)) {\n'
    const stripped = commented.split('\n').filter(l => !l.trim().startsWith('//')).join('\n')
    expect(stripped.includes('isMalformedUrlError(err')).toBe(false)
  })
})
