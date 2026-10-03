// Functional test for ensureSkillsPathTrapSection() -- mirrors
// autonomy-section.test.ts. SKILLUTCSAPDA822: the `.claude-config/skills`
// path IS the shared global dir (symlink), reads as "my own config", and five
// third-party skills landed fleet-wide through it on 2026-08-22. This proves
// the warning block actually reaches the agent file on respawn, idempotently.
import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, symlinkSync, rmSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const tmpRoot = mkdtempSync(join(tmpdir(), 'marveen-skilltrap-test-'))

vi.mock('../config.js', () => ({
  // agent-scaffold imports settings-store (MCPOROKLES923), which derives a path from
  // STORE_DIR at import time. A never-created dir: nothing here reads the store.
  STORE_DIR: '/nonexistent/claudeclaw-test-store',
  PROJECT_ROOT: tmpRoot,
  OWNER_NAME: 'TestOwner',
  MAIN_AGENT_ID: 'agent-a',
  BOT_NAME: 'agent-a',
  CHANNEL_PROVIDER: 'telegram',
  WEB_PORT: 3420,
  OWNER_DRIVE_FOLDER: '',
  DASHBOARD_PUBLIC_URL: '',
  // Empty = the resolver falls through to the public URL, then to
  // localhost -- i.e. exactly the behaviour these tests asserted
  // before AGENT_API_ORIGIN existed.
  AGENT_API_ORIGIN: '',
  APP_TZ: 'Europe/Budapest',
}))

vi.mock('../web/agent-config.js', () => ({
  agentDir: (name: string) => join(tmpRoot, 'agents', name),
  agentConfigRoot: () => join(tmpRoot, 'agents'),
  listAgentNames: () => ['agent-a', 'agent-b'],
  readAgentCapabilities: () => [],
}))

vi.mock('../web/atomic-write.js', () => ({
  atomicWriteFileSync: (path: string, content: string) => writeFileSync(path, content, 'utf-8'),
}))

const { ensureSkillsPathTrapSection } = await import('../web/agent-scaffold.js')

const MARKER_BEGIN = '<!-- BEGIN GENERATED: skills-path-trap (auto-generated, do not edit by hand) -->'
const MARKER_END = '<!-- END GENERATED: skills-path-trap -->'

function setup(agentName: string, content: string) {
  const dir = join(tmpRoot, 'agents', agentName)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'CLAUDE.md'), content, 'utf-8')
}

function read(agentName: string): string {
  return readFileSync(join(tmpRoot, 'agents', agentName, 'CLAUDE.md'), 'utf-8')
}

describe('ensureSkillsPathTrapSection', () => {
  it('appends the warning block to a CLAUDE.md that lacks it', () => {
    setup('agent-b', '# Agent B\n\nSome persona.\n')
    ensureSkillsPathTrapSection('agent-b')
    const out = read('agent-b')
    expect(out).toContain(MARKER_BEGIN)
    expect(out).toContain(MARKER_END)
    expect(out).toContain('.claude-config/skills')
    expect(out).toContain('NEM a saját mappád')
    expect(out).toContain('.claude/skills/')
    // Existing content untouched.
    expect(out).toContain('Some persona.')
  })

  it('is idempotent: a second call changes nothing', () => {
    setup('agent-b', '# Agent B\n')
    ensureSkillsPathTrapSection('agent-b')
    const first = read('agent-b')
    ensureSkillsPathTrapSection('agent-b')
    expect(read('agent-b')).toBe(first)
    // Exactly one block, not stacked.
    expect(first.split(MARKER_BEGIN).length - 1).toBe(1)
  })

  it('replaces ONLY the marked block, preserving hand-written text around it', () => {
    setup('agent-b', `# Agent B\n\n${MARKER_BEGIN}\nRÉGI SZÖVEG\n${MARKER_END}\n\nKézzel írt lábjegyzet.\n`)
    ensureSkillsPathTrapSection('agent-b')
    const out = read('agent-b')
    expect(out).not.toContain('RÉGI SZÖVEG')
    expect(out).toContain('Kézzel írt lábjegyzet.')
    expect(out).toContain('.claude-config/skills')
  })

  it('skips silently when there is no CLAUDE.md', () => {
    expect(() => ensureSkillsPathTrapSection('agent-nonexistent')).not.toThrow()
  })

  it('the main agent path targets PROJECT_ROOT/CLAUDE.md', () => {
    writeFileSync(join(tmpRoot, 'CLAUDE.md'), '# Main\n', 'utf-8')
    ensureSkillsPathTrapSection('agent-a')
    const out = readFileSync(join(tmpRoot, 'CLAUDE.md'), 'utf-8')
    expect(out).toContain(MARKER_BEGIN)
  })
})

// MEMCSAPDAMERT1003 (kanban e2c5e112): the memory paragraph states what the generation MEASURED for THIS agent's
// .claude-config/projects (a symlink and its target, a real directory, or no such path), never one install's old fact.
describe('MEMCSAPDAMERT1003: the memory paragraph is measured per agent', () => {
  const block = (out: string) => out.slice(out.indexOf(MARKER_BEGIN), out.indexOf(MARKER_END))
  const skillsPart = (out: string) => block(out).split('A MEMÓRIÁRA')[0]
  const projects = (agentName: string) => join(tmpRoot, 'agents', agentName, '.claude-config', 'projects')
  const OLD_FIXED_CLAIM = ['Lean Chief', 'leanarchivist', 'szintén symlink a `~/.claude/projects`-re']

  it('a REAL projects directory: says so, and claims no symlink and no foreign owner', () => {
    setup('agent-real', '# Real\n')
    mkdirSync(join(projects('agent-real'), '-x', 'memory'), { recursive: true })
    ensureSkillsPathTrapSection('agent-real')
    const b = block(read('agent-real'))
    expect(b).toContain('VALÓDI könyvtár, nem symlink')
    expect(b).toContain('a te session-öd Claude Code-memóriája')
    expect(b).not.toContain('SYMLINK, célja')
    for (const s of OLD_FIXED_CLAIM) expect(b).not.toContain(s)
  })

  it('a SYMLINKED projects directory: names the link target and its resolved path, and warns', () => {
    setup('agent-link', '# Link\n')
    const shared = join(tmpRoot, 'shared-projects')
    mkdirSync(shared, { recursive: true })
    mkdirSync(join(tmpRoot, 'agents', 'agent-link', '.claude-config'), { recursive: true })
    symlinkSync(shared, projects('agent-link'))
    ensureSkillsPathTrapSection('agent-link')
    const b = block(read('agent-link'))
    expect(b).toContain('SYMLINK, célja `' + shared + '`')
    expect(b).toContain('(feloldva `' + realpathSync(shared) + '`)')
    expect(b).toContain('nem csak a tiéd')
    expect(b).not.toContain('VALÓDI könyvtár')
    for (const s of OLD_FIXED_CLAIM) expect(b).not.toContain(s)
  })

  it('a dangling symlink: the target is named and marked unreachable', () => {
    setup('agent-dangling', '# Dangling\n')
    mkdirSync(join(tmpRoot, 'agents', 'agent-dangling', '.claude-config'), { recursive: true })
    symlinkSync(join(tmpRoot, 'no-such-target'), projects('agent-dangling'))
    ensureSkillsPathTrapSection('agent-dangling')
    const b = block(read('agent-dangling'))
    expect(b).toContain('SYMLINK, célja `' + join(tmpRoot, 'no-such-target') + '`, és a cél NEM ÉRHETŐ EL.')
  })

  it('no such path, and a plain file in its place: each says what it found', () => {
    setup('agent-none', '# None\n')
    ensureSkillsPathTrapSection('agent-none')
    expect(block(read('agent-none'))).toContain('ezen az úton nem létezik')
    setup('agent-file', '# File\n')
    mkdirSync(join(tmpRoot, 'agents', 'agent-file', '.claude-config'), { recursive: true })
    writeFileSync(projects('agent-file'), 'x', 'utf-8')
    ensureSkillsPathTrapSection('agent-file')
    expect(block(read('agent-file'))).toContain('se nem könyvtár, se nem symlink')
  })

  it('the two installs get DIFFERENT memory text and the SAME skills paragraph', () => {
    setup('agent-real2', '# Real2\n')
    mkdirSync(projects('agent-real2'), { recursive: true })
    setup('agent-link2', '# Link2\n')
    mkdirSync(join(tmpRoot, 'shared-projects2'), { recursive: true })
    mkdirSync(join(tmpRoot, 'agents', 'agent-link2', '.claude-config'), { recursive: true })
    symlinkSync(join(tmpRoot, 'shared-projects2'), projects('agent-link2'))
    ensureSkillsPathTrapSection('agent-real2')
    ensureSkillsPathTrapSection('agent-link2')
    const real = read('agent-real2')
    const link = read('agent-link2')
    expect(block(real)).not.toBe(block(link))
    expect(skillsPart(real)).toBe(skillsPart(link))
    expect(skillsPart(real)).toContain('NEM a saját mappád')
  })

  it('a respawn re-measures: a real directory replaced by a symlink rewrites the block, once', () => {
    setup('agent-switch', '# Switch\n')
    mkdirSync(projects('agent-switch'), { recursive: true })
    ensureSkillsPathTrapSection('agent-switch')
    expect(block(read('agent-switch'))).toContain('VALÓDI könyvtár')
    rmSync(projects('agent-switch'), { recursive: true })
    mkdirSync(join(tmpRoot, 'shared-projects3'), { recursive: true })
    symlinkSync(join(tmpRoot, 'shared-projects3'), projects('agent-switch'))
    ensureSkillsPathTrapSection('agent-switch')
    const out = read('agent-switch')
    expect(block(out)).toContain('SYMLINK, célja')
    expect(block(out)).not.toContain('VALÓDI könyvtár')
    expect(out.split(MARKER_BEGIN).length - 1).toBe(1)
  })

  it('the main agent is measured on PROJECT_ROOT, not on an agents/ directory', () => {
    writeFileSync(join(tmpRoot, 'CLAUDE.md'), '# Main\n', 'utf-8')
    ensureSkillsPathTrapSection('agent-a')
    expect(block(readFileSync(join(tmpRoot, 'CLAUDE.md'), 'utf-8'))).toContain('ezen az úton nem létezik')
    mkdirSync(join(tmpRoot, '.claude-config', 'projects'), { recursive: true })
    ensureSkillsPathTrapSection('agent-a')
    expect(block(readFileSync(join(tmpRoot, 'CLAUDE.md'), 'utf-8'))).toContain('VALÓDI könyvtár')
    rmSync(join(tmpRoot, '.claude-config'), { recursive: true })
  })
})

describe('wiring contracts', () => {
  it('startAgentProcess calls the ensure on every (re)spawn', () => {
    const src = readFileSync(join(__dirname, '../../src/web/agent-process.ts'), 'utf-8')
    const roster = src.indexOf('ensureFleetRosterSection(name)')
    const trap = src.indexOf('ensureSkillsPathTrapSection(name)')
    expect(roster).toBeGreaterThan(0)
    expect(trap).toBeGreaterThan(roster)
  })

  it('the generated template names the trap inline too', () => {
    const src = readFileSync(join(__dirname, '../../src/web/agent-scaffold.ts'), 'utf-8')
    expect(src).toContain('CSAPDA: a .claude-config/skills NEM a tiéd')
  })
})
