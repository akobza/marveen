// 8c338dc4: the continue variant of the main agent's plan rotation -- the pure decision
// (can --continue find the same conversation after the switch?) and the restart runner
// (resume first, fresh as the fallback), both without tmux or a real config dir.
// 962faa19: the conversation is a transcript, not the folder (hasClaudeTranscript, on real
// temp dirs), and the resumed session has to survive its first seconds (continueSurvived).
import { describe, it, expect, vi, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { encodeClaudeProjectDir } from '../claude-project-dir.js'
import {
  mainRotationContinueVerdict, runMainContinueRestart, hasClaudeTranscript, continueSurvived,
  CONTINUE_SURVIVAL_READS, CONTINUE_SURVIVAL_GAP_MS, type SurvivalVerdict,
} from '../web/main-rotation-continue.js'

const ROOT = '/srv/marveen'
const SHARED = '/srv/marveen/.channels-config'
const transcriptsIn = (dir: string) => join(dir, 'projects', encodeClaudeProjectDir(ROOT))

function verdict(over: Partial<Parameters<typeof mainRotationContinueVerdict>[0]> = {}, present: string[] = [transcriptsIn(SHARED)]) {
  return mainRotationContinueVerdict({
    explicitDir: null,
    activeRotatedDir: null,
    activeIsTokenPlan: false,
    fleetToken: true,
    targetConfigDir: null,
    sharedDir: SHARED,
    projectRoot: ROOT,
    hasTranscript: (p) => present.includes(p),
    ...over,
  })
}

describe('mainRotationContinueVerdict', () => {
  it('token plan to token plan: the shared dir stays, its transcripts are there -> ok', () => {
    expect(verdict({ activeIsTokenPlan: true })).toEqual({ ok: true })
  })

  it('first plan assignment with the fleet token: the plain isolated dir is the shared one -> ok', () => {
    expect(verdict()).toEqual({ ok: true })
  })

  it('first plan assignment without the fleet token: the main agent runs on the shared ~/.claude -> config-dir-changes', () => {
    expect(verdict({ fleetToken: false })).toEqual({ ok: false, reason: 'config-dir-changes' })
  })

  it('an active token plan without the fleet token still runs in the shared dir -> ok', () => {
    expect(verdict({ activeIsTokenPlan: true, fleetToken: false })).toEqual({ ok: true })
  })

  it('the dirs are compared resolved: a configDir plan that IS the shared dir, to a token plan -> ok', () => {
    expect(verdict({ activeRotatedDir: `${SHARED}/` })).toEqual({ ok: true })
  })

  it('no prior conversation in the dir -> no-prior-session (claude --continue would exit at once)', () => {
    expect(verdict({}, [])).toEqual({ ok: false, reason: 'no-prior-session' })
  })

  it('the transcript dir is the encoded PROJECT dir, not the project path itself', () => {
    expect(verdict({}, [join(SHARED, 'projects', ROOT)])).toEqual({ ok: false, reason: 'no-prior-session' })
  })

  it('to a plan with its own configDir -> config-dir-changes (that dir has other transcripts)', () => {
    expect(verdict({ targetConfigDir: '/opt/claude-team' })).toEqual({ ok: false, reason: 'config-dir-changes' })
  })

  it('from a plan with its own configDir to a token plan -> config-dir-changes', () => {
    expect(verdict({ activeRotatedDir: '/opt/claude-pro' })).toEqual({ ok: false, reason: 'config-dir-changes' })
  })

  it('between two plans on the same configDir: the transcripts of THAT dir are checked', () => {
    expect(verdict({ activeRotatedDir: '/opt/claude-pro', targetConfigDir: '/opt/claude-pro/' }, [transcriptsIn('/opt/claude-pro')]))
      .toEqual({ ok: true })
    expect(verdict({ activeRotatedDir: '/opt/claude-pro', targetConfigDir: '/opt/claude-pro' }))
      .toEqual({ ok: false, reason: 'no-prior-session' })
  })

  it('an explicit MAIN_AGENT_CONFIG_DIR wins before and after: the dir cannot change, its transcripts count', () => {
    expect(verdict({ explicitDir: '/opt/explicit', targetConfigDir: '/opt/claude-team' }, [transcriptsIn('/opt/explicit')]))
      .toEqual({ ok: true })
  })
})

describe('hasClaudeTranscript (962faa19, on real dirs)', () => {
  const made: string[] = []
  const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'mrc-transcript-')); made.push(d); return d }
  afterEach(() => { while (made.length) rmSync(made.pop() as string, { recursive: true, force: true }) })

  it('a dir with only memory/ and a session folder is not a conversation', () => {
    const d = tmp()
    mkdirSync(join(d, 'memory'))
    writeFileSync(join(d, 'memory', 'MEMORY.md'), '- a note\n')
    mkdirSync(join(d, '0f0f0f0f-aaaa-bbbb-cccc-000000000001'))
    expect(hasClaudeTranscript(d)).toBe(false)
  })

  it('an empty .jsonl is not a conversation', () => {
    const d = tmp()
    writeFileSync(join(d, 'a.jsonl'), '')
    expect(hasClaudeTranscript(d)).toBe(false)
  })

  it('a folder named like a transcript is not one', () => {
    const d = tmp()
    mkdirSync(join(d, 'b.jsonl'))
    expect(hasClaudeTranscript(d)).toBe(false)
  })

  it('a transcript only below the top level does not count (claude reads the top level)', () => {
    const d = tmp()
    mkdirSync(join(d, 'memory'))
    writeFileSync(join(d, 'memory', 'c.jsonl'), '{"type":"user"}\n')
    expect(hasClaudeTranscript(d)).toBe(false)
  })

  it('a non-empty .jsonl at the top is a conversation', () => {
    const d = tmp()
    mkdirSync(join(d, 'memory'))
    writeFileSync(join(d, 'c.jsonl'), '{"type":"user"}\n')
    expect(hasClaudeTranscript(d)).toBe(true)
  })

  it('a dir that cannot be read (here: missing) counts as none', () => {
    expect(hasClaudeTranscript(join(tmp(), 'nope'))).toBe(false)
  })

  it('the verdict uses it by default: memory/ only -> no-prior-session, a transcript -> ok', () => {
    const shared = tmp()
    const dir = join(shared, 'projects', encodeClaudeProjectDir(ROOT))
    mkdirSync(join(dir, 'memory'), { recursive: true })
    const input = {
      explicitDir: null, activeRotatedDir: null, activeIsTokenPlan: true, fleetToken: true,
      targetConfigDir: null, sharedDir: shared, projectRoot: ROOT,
    }
    expect(mainRotationContinueVerdict(input)).toEqual({ ok: false, reason: 'no-prior-session' })
    writeFileSync(join(dir, 'conv.jsonl'), '{"type":"user"}\n')
    expect(mainRotationContinueVerdict(input)).toEqual({ ok: true })
  })
})

describe('continueSurvived (962faa19)', () => {
  function probe(sessionReads: boolean[], pid: number | null) {
    let i = 0
    const p = {
      sessionExists: vi.fn(() => sessionReads[Math.min(i++, sessionReads.length - 1)]),
      claudePid: vi.fn(() => pid),
      wait: vi.fn(async (_ms: number) => {}),
    }
    return p
  }

  it('the session is there at every read and the pane runs claude: survived', async () => {
    const p = probe([true], 4242)
    expect(await continueSurvived(p)).toEqual({ ok: true })
    expect(p.wait).toHaveBeenCalledTimes(CONTINUE_SURVIVAL_READS)
    expect(p.wait).toHaveBeenCalledWith(CONTINUE_SURVIVAL_GAP_MS)
    expect(p.sessionExists).toHaveBeenCalledTimes(CONTINUE_SURVIVAL_READS)
  })

  it('the session is gone at a read ("No conversation found" exits the pane): not survived, no further reads', async () => {
    const p = probe([true, false], 4242)
    expect(await continueSurvived(p)).toEqual({ ok: false, reason: 'the main session is gone' })
    expect(p.wait).toHaveBeenCalledTimes(2)
    expect(p.claudePid).not.toHaveBeenCalled()
  })

  it('the session stays but no claude runs in the pane at the end: not survived', async () => {
    const p = probe([true], null)
    expect(await continueSurvived(p)).toEqual({ ok: false, reason: 'no claude process in the main pane' })
  })

  it('reads and gap are configurable', async () => {
    const p = probe([true], 1)
    await continueSurvived({ ...p, reads: 1, gapMs: 10 })
    expect(p.wait).toHaveBeenCalledTimes(1)
    expect(p.wait).toHaveBeenCalledWith(10)
  })
})

describe('runMainContinueRestart', () => {
  function steps(resumeOk: boolean, freshResult: { ok: boolean; error?: string } = { ok: true },
    alive: SurvivalVerdict = { ok: true }) {
    const order: string[] = []
    const s = {
      stampConsent: vi.fn(() => { order.push('stamp') }),
      resume: vi.fn(async () => { order.push('resume'); return resumeOk }),
      survived: vi.fn(async (): Promise<SurvivalVerdict> => { order.push('survived'); return alive }),
      fresh: vi.fn(() => { order.push('fresh'); return freshResult }),
      standDownResumeGuard: vi.fn(() => { order.push('standDown') }),
      warn: vi.fn((_m: string) => {}),
    }
    return { s, order }
  }

  it('resume succeeds and the session survives: the consent stamp, the --continue resume, the survival read; no fresh restart', async () => {
    const { s, order } = steps(true)
    expect(await runMainContinueRestart(s)).toEqual({ ok: true, mode: 'continue' })
    expect(order).toEqual(['stamp', 'resume', 'survived'])
    expect(s.fresh).not.toHaveBeenCalled()
    expect(s.standDownResumeGuard).not.toHaveBeenCalled()
    expect(s.warn).not.toHaveBeenCalled()
  })

  it('962faa19: resume "succeeds" but the session is gone: fresh restart, the reason in the log line, the pending guard retired', async () => {
    const { s, order } = steps(true, { ok: true }, { ok: false, reason: 'the main session is gone' })
    expect(await runMainContinueRestart(s)).toEqual({ ok: true, mode: 'fresh-fallback' })
    expect(order).toEqual(['stamp', 'resume', 'survived', 'fresh', 'standDown'])
    expect(s.warn).toHaveBeenCalledTimes(1)
    expect(s.warn.mock.calls[0][0]).toContain('did not survive (the main session is gone)')
  })

  it('962faa19: a throwing survival probe counts as not survived: fresh restart', async () => {
    const { s, order } = steps(true)
    s.survived.mockImplementation(async () => { order.push('survived'); throw new Error('tmux boom') })
    expect(await runMainContinueRestart(s)).toEqual({ ok: true, mode: 'fresh-fallback' })
    expect(order).toEqual(['stamp', 'resume', 'survived', 'fresh', 'standDown'])
    expect(s.warn.mock.calls[0][0]).toContain('the survival probe failed')
  })

  it('962faa19: not survived and the fresh restart fails too: not ok, and the guard stays (the next chance)', async () => {
    const { s } = steps(true, { ok: false, error: 'respawn-pane boom' }, { ok: false, reason: 'no claude process in the main pane' })
    expect(await runMainContinueRestart(s)).toEqual({ ok: false, mode: 'fresh-fallback', error: 'respawn-pane boom' })
    expect(s.standDownResumeGuard).not.toHaveBeenCalled()
  })

  it('resume fails: the fresh restart is the fallback (no survival read), and the result says so', async () => {
    const { s, order } = steps(false)
    expect(await runMainContinueRestart(s)).toEqual({ ok: true, mode: 'fresh-fallback' })
    expect(order).toEqual(['stamp', 'resume', 'fresh', 'standDown'])
    expect(s.survived).not.toHaveBeenCalled()
    expect(s.warn).toHaveBeenCalledTimes(1)
    expect(s.warn.mock.calls[0][0]).toContain('the --continue resume failed')
  })

  it('both fail: not ok, with the fresh restart error', async () => {
    const { s } = steps(false, { ok: false, error: 'respawn-pane boom' })
    expect(await runMainContinueRestart(s)).toEqual({ ok: false, mode: 'fresh-fallback', error: 'respawn-pane boom' })
    expect(s.standDownResumeGuard).not.toHaveBeenCalled()
  })

  it('both fail without an error text: a generic one, never an empty error', async () => {
    const { s } = steps(false, { ok: false })
    const r = await runMainContinueRestart(s)
    expect(r.ok).toBe(false)
    expect(r.ok ? '' : r.error).toBe('Main agent restart failed')
  })

  it('a throwing consent stamp does not stop the restart', async () => {
    const { s, order } = steps(true)
    s.stampConsent.mockImplementation(() => { order.push('stamp'); throw new Error('stamp boom') })
    expect(await runMainContinueRestart(s)).toEqual({ ok: true, mode: 'continue' })
    expect(order).toEqual(['stamp', 'resume', 'survived'])
  })
})
