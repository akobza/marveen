// Since the per-agent skill folders became git repos, GET /api/agents/<name>/skills listed the repo's .git folder as a
// skill (scanSkillDir took every subfolder, with a delete button). A folder whose name starts with a dot is no skill:
// the global Skills route (skills.ts) already skips such names, this one now does the same. Drives the real handler on
// a sandbox home and agent folder.
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
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

type Listed = { name: string; source: string; deletable: boolean; hasSkillMd: boolean }
const GLOBAL = () => join(SANDBOX, 'home', '.claude', 'skills')
const LOCAL = (agent: string) => join(SANDBOX, 'agents', agent, '.claude', 'skills')

function skill(root: string, name: string, withMd = true) {
  mkdirSync(join(root, name), { recursive: true })
  if (withMd) writeFileSync(join(root, name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name} desc\n---\n`)
}
function gitRepo(root: string) {
  mkdirSync(join(root, '.git', 'objects'), { recursive: true })
  writeFileSync(join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n')
}
async function get(agent: string) {
  let status = 0
  let body = ''
  const res = { writeHead: (s: number) => { status = s }, end: (b: string) => { body = b } }
  const handled = await tryHandleAgentsSkills({
    req: {} as never,
    res: res as never,
    path: `/api/agents/${agent}/skills`,
    method: 'GET',
    url: new URL(`http://localhost/api/agents/${agent}/skills`),
  })
  return { handled, status, list: JSON.parse(body) as Listed[] }
}

beforeAll(() => {
  SANDBOX = mkdtempSync(join(tmpdir(), 'agents-skills-dotdirs-'))
  gitRepo(GLOBAL())
  skill(GLOBAL(), 'global-one')
  skill(GLOBAL(), 'v1.2-notes')
  mkdirSync(join(GLOBAL(), '.cache'), { recursive: true })
  gitRepo(LOCAL('demo'))
  skill(LOCAL('demo'), 'mine')
  skill(LOCAL('demo'), 'draft', false)
  skill(LOCAL('demo'), '.hidden')
})
afterAll(() => { if (SANDBOX) rmSync(SANDBOX, { recursive: true, force: true }) })

describe('GET /api/agents/<name>/skills does not list dot-folders (the skill repo .git)', () => {
  it('a sub-agent: neither its own .git nor the global .git is listed; its skills and the inherited ones are', async () => {
    const r = await get('demo')
    expect(r.handled).toBe(true)
    expect(r.status).toBe(200)
    expect(r.list.filter((s) => s.name.startsWith('.'))).toEqual([])
    expect(r.list.map((s) => `${s.source}:${s.name}`).sort()).toEqual(['agent:draft', 'agent:mine', 'global:global-one', 'global:v1.2-notes'])
  })
  it('the main agent, whose root is the global folder: no .git, so no delete offered for it', async () => {
    const r = await get(MAIN_AGENT_ID)
    expect(r.status).toBe(200)
    expect(r.list.map((s) => s.name).sort()).toEqual(['global-one', 'v1.2-notes'])
    expect(r.list.every((s) => s.deletable && s.source === 'global')).toBe(true)
  })
  it('only a LEADING dot hides a folder: a name with a dot inside is still a skill', async () => {
    const r = await get('demo')
    expect(r.list.some((s) => s.name === 'v1.2-notes' && s.hasSkillMd)).toBe(true)
  })
  it('any leading-dot folder is hidden, not only .git (a .cache, a .hidden one even with a SKILL.md)', async () => {
    const r = await get('demo')
    expect(r.list.some((s) => s.name === '.cache' || s.name === '.hidden')).toBe(false)
  })
})
