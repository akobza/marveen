import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const SCRIPT = join(REPO_ROOT, 'scripts', 'skill-index.sh')

function makeSkillMd(name: string, description: string): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`
}

function runScript(args: string[], env: Record<string, string>): { stdout: string; exitCode: number } {
  try {
    const stdout = execSync(`bash "${SCRIPT}" ${args.map(a => `"${a}"`).join(' ')}`, {
      encoding: 'utf-8',
      env: { ...process.env, ...env },
    })
    return { stdout, exitCode: 0 }
  } catch (err: unknown) {
    const e = err as { stdout?: string; status?: number }
    return { stdout: e.stdout ?? '', exitCode: e.status ?? 1 }
  }
}

describe('skill-index.sh -- no-arg mode (backward compat)', () => {
  let tmpHome: string

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'skill-index-test-'))
    mkdirSync(join(tmpHome, '.claude', 'skills', 'skill-alpha'), { recursive: true })
    writeFileSync(
      join(tmpHome, '.claude', 'skills', 'skill-alpha', 'SKILL.md'),
      makeSkillMd('skill-alpha', 'Global skill alpha description'),
    )
  })

  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true })
  })

  it('writes the index to ~/.claude/skills/.skill-index.md', () => {
    runScript([], { HOME: tmpHome })
    const indexPath = join(tmpHome, '.claude', 'skills', '.skill-index.md')
    expect(existsSync(indexPath)).toBe(true)
  })

  it('includes global skill in the index', () => {
    runScript([], { HOME: tmpHome })
    const content = readFileSync(join(tmpHome, '.claude', 'skills', '.skill-index.md'), 'utf-8')
    expect(content).toContain('skill-alpha')
    expect(content).toContain('Global skill alpha description')
  })

  it('uses the two-column table format (no Scope column)', () => {
    runScript([], { HOME: tmpHome })
    const content = readFileSync(join(tmpHome, '.claude', 'skills', '.skill-index.md'), 'utf-8')
    expect(content).toContain('| Skill | Leírás |')
    expect(content).not.toContain('| Scope |')
  })

  it('does NOT create an index in any other directory', () => {
    const agentDir = join(tmpHome, 'agents', 'agent-a')
    mkdirSync(join(agentDir, '.claude', 'skills', 'skill-beta'), { recursive: true })
    writeFileSync(
      join(agentDir, '.claude', 'skills', 'skill-beta', 'SKILL.md'),
      makeSkillMd('skill-beta', 'Agent-specific skill beta'),
    )
    runScript([], { HOME: tmpHome })
    const agentIndex = join(agentDir, '.claude', 'skills', '.skill-index.md')
    expect(existsSync(agentIndex)).toBe(false)
  })
})

describe('skill-index.sh -- AGENT_DIR mode (merged index)', () => {
  let tmpHome: string
  let agentDir: string

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'skill-index-test-'))
    // Global skill
    mkdirSync(join(tmpHome, '.claude', 'skills', 'skill-global'), { recursive: true })
    writeFileSync(
      join(tmpHome, '.claude', 'skills', 'skill-global', 'SKILL.md'),
      makeSkillMd('skill-global', 'A global skill visible to all agents'),
    )
    // Agent-specific skill
    agentDir = join(tmpHome, 'agents', 'agent-a')
    mkdirSync(join(agentDir, '.claude', 'skills', 'skill-local'), { recursive: true })
    writeFileSync(
      join(agentDir, '.claude', 'skills', 'skill-local', 'SKILL.md'),
      makeSkillMd('skill-local', 'An agent-local skill for agent-a only'),
    )
  })

  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true })
  })

  it('writes the merged index to <AGENT_DIR>/.claude/skills/.skill-index.md', () => {
    runScript([agentDir], { HOME: tmpHome })
    const indexPath = join(agentDir, '.claude', 'skills', '.skill-index.md')
    expect(existsSync(indexPath)).toBe(true)
  })

  it('includes global skill in the merged index', () => {
    runScript([agentDir], { HOME: tmpHome })
    const content = readFileSync(join(agentDir, '.claude', 'skills', '.skill-index.md'), 'utf-8')
    expect(content).toContain('skill-global')
    expect(content).toContain('A global skill visible to all agents')
  })

  it('includes agent-specific skill in the merged index', () => {
    // This is the core regression test: fails when AGENT_DIR handling is removed
    runScript([agentDir], { HOME: tmpHome })
    const content = readFileSync(join(agentDir, '.claude', 'skills', '.skill-index.md'), 'utf-8')
    expect(content).toContain('skill-local')
    expect(content).toContain('An agent-local skill for agent-a only')
  })

  it('labels global and agent-specific skills with scope', () => {
    runScript([agentDir], { HOME: tmpHome })
    const content = readFileSync(join(agentDir, '.claude', 'skills', '.skill-index.md'), 'utf-8')
    expect(content).toContain('| global |')
    expect(content).toContain('| agent |')
  })

  it('does NOT modify the global index when running in agent mode', () => {
    const globalIndexPath = join(tmpHome, '.claude', 'skills', '.skill-index.md')
    // Ensure there is no stale global index before the run
    expect(existsSync(globalIndexPath)).toBe(false)
    runScript([agentDir], { HOME: tmpHome })
    expect(existsSync(globalIndexPath)).toBe(false)
  })

  it('creates agent .claude/skills/ directory if it does not exist yet', () => {
    const freshAgentDir = join(tmpHome, 'agents', 'agent-b')
    // Only the agent dir exists, no .claude/skills/ inside
    mkdirSync(freshAgentDir, { recursive: true })
    runScript([freshAgentDir], { HOME: tmpHome })
    expect(existsSync(join(freshAgentDir, '.claude', 'skills', '.skill-index.md'))).toBe(true)
  })

  it('two different agents get independent indexes with their own agent-local skills', () => {
    // agent-b has a different local skill
    const agentBDir = join(tmpHome, 'agents', 'agent-b')
    mkdirSync(join(agentBDir, '.claude', 'skills', 'skill-b-only'), { recursive: true })
    writeFileSync(
      join(agentBDir, '.claude', 'skills', 'skill-b-only', 'SKILL.md'),
      makeSkillMd('skill-b-only', 'Only for agent-b'),
    )

    runScript([agentDir], { HOME: tmpHome })
    runScript([agentBDir], { HOME: tmpHome })

    const indexA = readFileSync(join(agentDir, '.claude', 'skills', '.skill-index.md'), 'utf-8')
    const indexB = readFileSync(join(agentBDir, '.claude', 'skills', '.skill-index.md'), 'utf-8')

    // agent-a sees skill-local but not skill-b-only
    expect(indexA).toContain('skill-local')
    expect(indexA).not.toContain('skill-b-only')

    // agent-b sees skill-b-only but not skill-local
    expect(indexB).toContain('skill-b-only')
    expect(indexB).not.toContain('skill-local')

    // both see the global skill
    expect(indexA).toContain('skill-global')
    expect(indexB).toContain('skill-global')
  })
})

describe('skill-index.sh -- graceful handling of missing global dir', () => {
  it('exits cleanly when ~/.claude/skills does not exist', () => {
    const emptyHome = mkdtempSync(join(tmpdir(), 'skill-index-test-'))
    try {
      const { exitCode } = runScript([], { HOME: emptyHome })
      expect(exitCode).toBe(0)
    } finally {
      rmSync(emptyHome, { recursive: true, force: true })
    }
  })
})

describe('skill-index.sh -- the 120-byte description cut stays valid UTF-8 (SKILLINDEXUTF8)', () => {
  // The description is cut at 120 BYTES. GNU `cut -c` counts bytes, so a multibyte character straddling
  // byte 120 used to keep only its first byte(s), and a strict UTF-8 read of the whole index failed.
  const strict = new TextDecoder('utf-8', { fatal: true })
  const STRADDLE_2 = 'a'.repeat(119) + 'é' + ' tail' // é = C3 A9 at bytes 120-121
  const STRADDLE_3 = 'a'.repeat(118) + '€' + ' tail' // € = E2 82 AC at bytes 119-121
  const STRADDLE_4 = 'a'.repeat(117) + '😀' + ' tail' // 😀 = F0 9F 98 80 at bytes 118-121
  const FITS_2 = 'a'.repeat(118) + 'é' + ' tail' // é ends exactly at byte 120: kept whole
  const LONG_ASCII = 'b'.repeat(130)
  const SHORT_ACCENTED = 'Rövid leírás ékezettel, a vágás alatt'
  let tmpHome: string

  function addSkill(root: string, name: string, description: string): void {
    mkdirSync(join(root, '.claude', 'skills', name), { recursive: true })
    writeFileSync(join(root, '.claude', 'skills', name, 'SKILL.md'), makeSkillMd(name, description))
  }

  function indexBytes(path: string): Buffer {
    return readFileSync(path)
  }

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'skill-index-utf8-'))
    addSkill(tmpHome, 'straddle-two', STRADDLE_2)
    addSkill(tmpHome, 'straddle-three', STRADDLE_3)
    addSkill(tmpHome, 'straddle-four', STRADDLE_4)
    addSkill(tmpHome, 'fits-two', FITS_2)
    addSkill(tmpHome, 'long-ascii', LONG_ASCII)
    addSkill(tmpHome, 'short-accented', SHORT_ACCENTED)
  })

  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true })
  })

  it('NEGATIVE: the global index is strict UTF-8 even when a character straddles byte 120', () => {
    runScript([], { HOME: tmpHome })
    const bytes = indexBytes(join(tmpHome, '.claude', 'skills', '.skill-index.md'))
    expect(() => strict.decode(bytes)).not.toThrow()
  })

  it('NEGATIVE: the incomplete character is dropped whole, so each cut ends on a character boundary', () => {
    runScript([], { HOME: tmpHome })
    const content = strict.decode(indexBytes(join(tmpHome, '.claude', 'skills', '.skill-index.md')))
    expect(content).toContain('| `straddle-two` | ' + 'a'.repeat(119) + ' |')
    expect(content).toContain('| `straddle-three` | ' + 'a'.repeat(118) + ' |')
    expect(content).toContain('| `straddle-four` | ' + 'a'.repeat(117) + ' |')
  })

  it('CONTROL: a character ending exactly at byte 120, a long ASCII text and a short accented text are unchanged', () => {
    // Read leniently on purpose: this test is about ITS OWN lines, which old and new code must write identically.
    // (The straddling lines in the same index would make a strict read fail on the old code for another reason.)
    runScript([], { HOME: tmpHome })
    const content = readFileSync(join(tmpHome, '.claude', 'skills', '.skill-index.md'), 'utf-8')
    expect(content).toContain('| `fits-two` | ' + 'a'.repeat(118) + 'é |')
    expect(content).toContain('| `long-ascii` | ' + 'b'.repeat(120) + ' |')
    expect(content).toContain('| `short-accented` | ' + SHORT_ACCENTED + ' |')
  })

  it('NEGATIVE: the merged per-agent index uses the same cut and is strict UTF-8 too', () => {
    const agentDir = join(tmpHome, 'agents', 'agent-utf8')
    addSkill(agentDir, 'agent-straddle', STRADDLE_2)
    runScript([agentDir], { HOME: tmpHome })
    const content = strict.decode(indexBytes(join(agentDir, '.claude', 'skills', '.skill-index.md')))
    expect(content).toContain('| `agent-straddle` | ' + 'a'.repeat(119) + ' | agent |')
    expect(content).toContain('| `straddle-two` | ' + 'a'.repeat(119) + ' | global |')
  })
})
