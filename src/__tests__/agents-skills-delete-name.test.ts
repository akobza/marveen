// card ad37090b (the c6f4c052 follow-up): DELETE /api/agents/<name>/skills/<skill> ran the name through
// sanitizeSkillName, which drops a dot and lowercases: ".git" became "git" and targeted that skill, and a listed name with a
// dot inside ("v1.2-notes") or an upper-case letter could not be deleted. The DELETE now targets exactly the folder name
// the list shows; a name the list never shows (a leading dot, a path separator) is not found. Drives the real handler on a
// sandbox home and agent folder, as agents-skills-dotdirs.test.ts (c6f4c052) does.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

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
const { MAIN_AGENT_ID } = await import('../config.js')

type Listed = { name: string; source: string; deletable: boolean }
const GLOBAL = () => join(SANDBOX, 'home', '.claude', 'skills')
const LOCAL = (agent: string) => join(SANDBOX, 'agents', agent, '.claude', 'skills')

function skill(root: string, name: string) {
  mkdirSync(join(root, name), { recursive: true })
  writeFileSync(join(root, name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name} desc\n---\n`)
}
function gitRepo(root: string) {
  mkdirSync(join(root, '.git', 'objects'), { recursive: true })
  writeFileSync(join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n')
}
async function call(method: 'GET' | 'DELETE', path: string) {
  let status = 0
  let body = ''
  const res = { writeHead: (s: number) => { status = s }, end: (b: string) => { body = b } }
  const handled = await tryHandleAgentsSkills({
    req: {} as never,
    res: res as never,
    path,
    method,
    url: new URL(`http://localhost${path}`),
  })
  return { handled, status, body: body ? JSON.parse(body) : null }
}
const del = (agent: string, rawSegment: string) => call('DELETE', `/api/agents/${agent}/skills/${rawSegment}`)

beforeEach(() => {
  SANDBOX = mkdtempSync(join(tmpdir(), 'agents-skills-delete-name-'))
  gitRepo(GLOBAL())
  skill(GLOBAL(), 'git')
  skill(GLOBAL(), 'v1.2-notes')
  gitRepo(LOCAL('demo'))
  skill(LOCAL('demo'), 'git')
  skill(LOCAL('demo'), 'v1.2-notes')
  skill(LOCAL('demo'), 'My_Skill')
  skill(LOCAL('demo'), 'mine')
  mkdirSync(join(SANDBOX, 'agents', 'demo', '.claude', 'escape'), { recursive: true })
})
afterEach(() => { if (SANDBOX) rmSync(SANDBOX, { recursive: true, force: true }) })

describe('DELETE /api/agents/<name>/skills/<skill> targets exactly the listed folder name (ad37090b)', () => {
  it('".git" next to a "git" skill: not found, and neither "git" nor the repo .git is touched (sub-agent)', async () => {
    const r = await del('demo', '.git')
    expect(r.status).toBe(404)
    expect(existsSync(join(LOCAL('demo'), 'git'))).toBe(true)
    expect(existsSync(join(LOCAL('demo'), '.git', 'HEAD'))).toBe(true)
  })
  it('the same for the main agent, whose root is the global folder', async () => {
    const r = await del(MAIN_AGENT_ID, '.git')
    expect(r.status).toBe(404)
    expect(existsSync(join(GLOBAL(), 'git'))).toBe(true)
    expect(existsSync(join(GLOBAL(), '.git', 'HEAD'))).toBe(true)
  })
  it('a listed name with a dot inside is deleted, and only that one', async () => {
    const r = await del('demo', 'v1.2-notes')
    expect(r.status).toBe(200)
    expect(existsSync(join(LOCAL('demo'), 'v1.2-notes'))).toBe(false)
    expect(existsSync(join(GLOBAL(), 'v1.2-notes'))).toBe(true)
    expect(existsSync(join(LOCAL('demo'), 'mine'))).toBe(true)
  })
  it('a listed name with an upper-case letter and an underscore is deleted (the sanitizer made it "myskill")', async () => {
    const r = await del('demo', 'My_Skill')
    expect(r.status).toBe(200)
    expect(existsSync(join(LOCAL('demo'), 'My_Skill'))).toBe(false)
  })
  it('the traversal ..%2F is still not found and leaves the folder above the skills untouched (unchanged)', async () => {
    const r = await del('demo', '..%2Fescape')
    expect(r.status).toBe(404)
    expect(existsSync(join(SANDBOX, 'agents', 'demo', '.claude', 'escape'))).toBe(true)
  })
  it('a path inside a skill (mine%2FSKILL.md) is no skill name: not found, and the file stays', async () => {
    const r = await del('demo', 'mine%2FSKILL.md')
    expect(r.status).toBe(404)
    expect(existsSync(join(LOCAL('demo'), 'mine', 'SKILL.md'))).toBe(true)
  })
  it('a bare ".." is not found and leaves the skills folder in place (it was a 400: the sanitizer emptied the name)', async () => {
    const r = await del('demo', '..')
    expect(r.status).toBe(404)
    expect(existsSync(LOCAL('demo'))).toBe(true)
  })
  it('KONTROLL: "git" itself is deletable, and a name that does not exist is 404', async () => {
    expect((await del('demo', 'git')).status).toBe(200)
    expect(existsSync(join(LOCAL('demo'), 'git'))).toBe(false)
    expect((await del('demo', 'nincs-ilyen')).status).toBe(404)
  })
  it('every name the list shows as deletable (no leading dot) deletes exactly its own folder', async () => {
    const listed = (await call('GET', '/api/agents/demo/skills')).body as Listed[]
    const targets = listed.filter((s) => s.deletable && !s.name.startsWith('.')).map((s) => s.name).sort()
    expect(targets).toEqual(['My_Skill', 'git', 'mine', 'v1.2-notes'])
    for (const t of targets) {
      const r = await del('demo', encodeURIComponent(t))
      expect(r.status, t).toBe(200)
      expect(existsSync(join(LOCAL('demo'), t)), t).toBe(false)
    }
    expect(existsSync(join(LOCAL('demo'), '.git', 'HEAD'))).toBe(true)
    expect(existsSync(join(GLOBAL(), 'git'))).toBe(true)
  })
})
